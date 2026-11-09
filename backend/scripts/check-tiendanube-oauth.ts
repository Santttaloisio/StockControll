import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  InventoryBalance,
  InventoryMovement,
  Location,
  Product,
  ProductVariant,
  Store,
  StoreMembership,
  TiendanubeConnection,
  TiendanubeOrder,
  TiendanubeOrderLine,
  User
} from '../src/database/models/index.js';
import { sequelize } from '../src/database/sequelize.js';
import {
  completeAuthorization,
  createAuthorizationUrl,
  getConnectionStatus,
  TiendanubeIntegrationError
} from '../src/modules/integrations/tiendanube/tiendanube-oauth.service.js';
import { createAccessToken } from '../src/modules/auth/auth.service.js';

process.env.TIENDANUBE_CLIENT_ID ||= '999000';
process.env.TIENDANUBE_CLIENT_SECRET ||= randomBytes(32).toString('hex');
process.env.TIENDANUBE_REDIRECT_URI ||= 'https://oauth-test.example.test/api/integrations/tiendanube/callback';
process.env.TIENDANUBE_TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
process.env.TIENDANUBE_USER_AGENT ||= 'StockControll (oauth-test@example.test)';
process.env.AUTH_JWT_SECRET ||= randomBytes(32).toString('hex');

const { app } = await import('../src/app.js');

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function getState(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (!state) {
    throw new Error('Authorization URL did not contain OAuth state.');
  }
  return state;
}

async function expectIntegrationError(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof TiendanubeIntegrationError && error.code === code) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected Tiendanube integration error ${code}.`);
}

const originalFetch = globalThis.fetch;
const mockAccessToken = `mock-token-${randomBytes(24).toString('hex')}`;
const mockWebhooks: { event: string; url: string }[] = [];
let mockOrder: Record<string, unknown> = {
  id: 9001,
  status: 'open',
  payment_status: 'pending',
  created_at: '2026-11-04T10:00:00.000Z',
  products: [{ variant_id: 701, quantity: 2, price: '12500.00' }],
  currency: 'ARS',
  total: '25000.00'
};
const recentHistoricalDate = new Date(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth() - 1,
  15
));
const previousHistoricalDate = new Date(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth() - 4,
  15
));
const mockHistoricalOrders = [
  {
    id: 9002,
    status: 'closed',
    payment_status: 'paid',
    created_at: recentHistoricalDate.toISOString(),
    paid_at: recentHistoricalDate.toISOString(),
    products: [{ variant_id: 701, quantity: 3, price: '12500.00' }],
    currency: 'ARS',
    total: '37500.00'
  },
  {
    id: 9003,
    status: 'closed',
    payment_status: 'paid',
    created_at: previousHistoricalDate.toISOString(),
    paid_at: previousHistoricalDate.toISOString(),
    products: [{ variant_id: 702, quantity: 4, price: '10000.00' }],
    currency: 'ARS',
    total: '40000.00'
  },
  {
    id: 9004,
    status: 'open',
    payment_status: 'pending',
    created_at: recentHistoricalDate.toISOString(),
    products: [{ variant_id: 701, quantity: 9, price: '12500.00' }],
    currency: 'ARS',
    total: '112500.00'
  },
  {
    id: 9005,
    status: 'cancelled',
    payment_status: 'paid',
    created_at: recentHistoricalDate.toISOString(),
    paid_at: recentHistoricalDate.toISOString(),
    cancelled_at: recentHistoricalDate.toISOString(),
    products: [{ variant_id: 702, quantity: 8, price: '10000.00' }],
    currency: 'ARS',
    total: '80000.00'
  }
];
let storeIds: string[] = [];
let userIds: string[] = [];
let server: ReturnType<typeof app.listen> | undefined;

try {
  const fixtures = await sequelize.transaction(async (transaction) => {
    const user = await User.create(
      { email: `oauth-owner-${randomBytes(8).toString('hex')}@example.test`, passwordHash: 'test-hash' },
      { transaction }
    );
    const otherUser = await User.create(
      { email: `oauth-other-${randomBytes(8).toString('hex')}@example.test`, passwordHash: 'test-hash' },
      { transaction }
    );
    const store = await Store.create({ name: 'OAuth test store' }, { transaction });
    const otherStore = await Store.create({ name: 'OAuth other test store' }, { transaction });
    await StoreMembership.create({ storeId: store.id, userId: user.id, role: 'owner' }, { transaction });
    await StoreMembership.create({ storeId: otherStore.id, userId: otherUser.id, role: 'owner' }, { transaction });
    return { userId: user.id, otherUserId: otherUser.id, storeId: store.id, otherStoreId: otherStore.id };
  });
  storeIds = [fixtures.storeId, fixtures.otherStoreId];
  userIds = [fixtures.userId, fixtures.otherUserId];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.toString() === 'https://www.tiendanube.com/apps/authorize/token') {
      assert(init?.method === 'POST', 'OAuth token exchange did not use POST.');
      assert(
        Boolean(init?.headers) && new Headers(init?.headers).get('content-type') === 'application/json',
        'OAuth token exchange did not use JSON.'
      );
      const payload: unknown = JSON.parse(String(init.body));
      assert(typeof payload === 'object' && payload !== null, 'OAuth request body was not JSON.');
      assert('client_secret' in payload && payload.client_secret === process.env.TIENDANUBE_CLIENT_SECRET, 'OAuth token exchange omitted the configured client secret.');
      assert('grant_type' in payload && payload.grant_type === 'authorization_code', 'OAuth token exchange used an unexpected grant type.');
      assert('code' in payload && payload.code === 'mock-authorization-code', 'OAuth token exchange used an unexpected code.');

      return Response.json({
        access_token: mockAccessToken,
        token_type: 'bearer',
        scope: 'read_products,write_products,read_orders',
        user_id: '123456789'
      });
    }

    if (url.toString() === 'https://api.tiendanube.com/2025-03/123456789/webhooks') {
      const headers = new Headers(init?.headers);
      assert(headers.get('authorization') === `bearer ${mockAccessToken}`, 'Webhook registration did not use the stored access token.');
      assert(headers.get('user-agent') === process.env.TIENDANUBE_USER_AGENT, 'Webhook registration omitted the configured User-Agent.');
      if (init?.method === 'GET') {
        return Response.json(mockWebhooks);
      }
      assert(init?.method === 'POST', 'Webhook registration must use GET and POST.');
      const body = JSON.parse(String(init.body)) as { event: string; url: string };
      const expectedWebhookUrl = new URL(
        '/api/integrations/tiendanube/webhooks/orders',
        new URL(process.env.TIENDANUBE_REDIRECT_URI as string).origin
      ).toString();
      assert(body.url === expectedWebhookUrl, 'Webhook used an unexpected URL.');
      mockWebhooks.push(body);
      return Response.json({ id: mockWebhooks.length, ...body }, { status: 201 });
    }

    if (url.toString().startsWith('https://api.tiendanube.com/2025-03/123456789/products?')) {
      assert(init?.method === 'GET', 'Products endpoint must use GET.');
      const headers = new Headers(init?.headers);
      assert(headers.get('authorization') === `bearer ${mockAccessToken}`, 'Products endpoint did not decrypt and send the stored access token.');
      assert(headers.get('user-agent') === process.env.TIENDANUBE_USER_AGENT, 'Products endpoint omitted the configured User-Agent.');
      assert(url.searchParams.get('per_page') === '30', 'Products endpoint did not use the expected page size.');
      if (url.searchParams.get('page') === '2') {
        return Response.json([]);
      }
      assert(url.searchParams.get('page') === '1', 'Products endpoint did not request the chosen page.');
      return Response.json([
        {
          id: 501,
          name: { es: 'Campera de prueba' },
          images: [{ src: 'https://static.example.test/campera.jpg' }],
          attributes: ['Talle'],
          variants: [
            { id: 701, sku: 'CAM-M', values: ['M'], inventory_levels: [{ location_id: 'loc-1', stock: 5 }, { location_id: 'loc-2', stock: 2 }] },
            { id: 702, sku: 'CAM-L', values: ['L'], stock: 3 }
          ]
        }
      ], { headers: { link: '<https://api.tiendanube.com/2025-03/123456789/products?page=2&per_page=30>; rel="next"' } });
    }

    if (url.pathname === '/2025-03/123456789/orders') {
      assert(init?.method === 'GET', 'Order history endpoint must use GET.');
      assert(url.searchParams.get('per_page') === '30', 'Order history endpoint used an unexpected page size.');
      if (url.searchParams.get('page') === '2') {
        return Response.json([]);
      }
      assert(url.searchParams.get('page') === '1', 'Order history endpoint did not request the chosen page.');
      return Response.json(mockHistoricalOrders, {
        headers: {
          link: '<https://api.tiendanube.com/2025-03/123456789/orders?page=2&per_page=30>; rel="next"'
        }
      });
    }

    if (url.toString() === 'https://api.tiendanube.com/2025-03/123456789/orders/9001') {
      assert(init?.method === 'GET', 'Order endpoint must use GET.');
      const headers = new Headers(init?.headers);
      assert(headers.get('authorization') === `bearer ${mockAccessToken}`, 'Order endpoint did not use the stored access token.');
      return Response.json(mockOrder);
    }

    return originalFetch(input, init);
  };

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const initiatingToken = await createAccessToken(fixtures.userId);
  const authorizationStartResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/authorize`,
    { headers: { authorization: `Bearer ${initiatingToken}` } }
  );
  assert(authorizationStartResponse.status === 200, 'Authenticated store owner could not start OAuth.');
  const authorizationStartBody: unknown = await authorizationStartResponse.json();
  if (
    typeof authorizationStartBody !== 'object' ||
    authorizationStartBody === null ||
    !('authorizationUrl' in authorizationStartBody) ||
    typeof authorizationStartBody.authorizationUrl !== 'string'
  ) {
    throw new Error('OAuth start endpoint did not return an authorization URL.');
  }
  const authorizationUrl = authorizationStartBody.authorizationUrl;
  const parsedUrl = new URL(authorizationUrl);
  assert(parsedUrl.origin === 'https://www.tiendanube.com', 'Authorization URL must use Tiendanube HTTPS.');
  assert(parsedUrl.pathname === `/apps/${process.env.TIENDANUBE_CLIENT_ID}/authorize`, 'Authorization URL has an unexpected app ID.');
  const state = getState(authorizationUrl);
  const callbackResponse = await originalFetch(
    `${baseUrl}/api/integrations/tiendanube/callback?code=mock-authorization-code&state=${encodeURIComponent(state)}`
  );
  assert(callbackResponse.status === 200, 'OAuth callback did not return HTTP 200.');
  const callbackHtml = await callbackResponse.text();
  assert(callbackHtml.includes('Tiendanube conectada'), 'OAuth callback did not confirm connection.');
  assert(!callbackHtml.includes(mockAccessToken), 'OAuth callback exposed the access token.');

  const connection = await TiendanubeConnection.findOne({ where: { storeId: fixtures.storeId } });
  if (!connection) {
    throw new Error('OAuth exchange did not persist a connection.');
  }
  assert(connection.externalStoreId === '123456789', 'Connection persisted the wrong external store ID.');
  assert(connection.encryptedAccessToken !== mockAccessToken, 'Access token was persisted in plaintext.');
  assert(Buffer.from(connection.encryptedAccessToken, 'base64').toString('utf8') !== mockAccessToken, 'Encrypted token can be read as plaintext.');
  assert(connection.tokenIv.length === 24 && connection.tokenAuthTag.length === 32, 'AES-GCM IV or authentication tag has an invalid length.');

  const status = await getConnectionStatus(fixtures.storeId);
  assert(status.connected === true && status.externalStoreId === '123456789', 'Connection status did not report the active installation.');
  assert(status.grantedScopes?.includes('write_products') === true, 'Connection status omitted the granted scopes.');
  assert(!('accessToken' in status), 'Connection status exposed an access token.');

  const productsResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products`,
    { headers: { authorization: `Bearer ${initiatingToken}` } }
  );
  assert(productsResponse.status === 200, 'Authenticated store owner could not read Tiendanube products.');
  const productsBody: unknown = await productsResponse.json();
  assert(
    typeof productsBody === 'object' &&
      productsBody !== null &&
      'data' in productsBody &&
      typeof productsBody.data === 'object' &&
      productsBody.data !== null &&
      'products' in productsBody.data &&
      Array.isArray(productsBody.data.products),
    'Tiendanube products endpoint returned an unexpected shape.'
  );
  const productsData = productsBody.data as {
    products: {
      id: string;
      name: string;
      imageUrl: string | null;
      variants: { id: string; sku: string | null; stock: number | null }[];
    }[];
    hasNextPage: boolean;
  };
  assert(productsData.products.length === 1, 'Tiendanube products endpoint returned the wrong number of products.');
  assert(productsData.products[0].name === 'Campera de prueba', 'Tiendanube product name was not localized.');
  assert(productsData.products[0].imageUrl === 'https://static.example.test/campera.jpg', 'Tiendanube product image was not returned.');
  assert(productsData.products[0].variants[0].sku === 'CAM-M', 'Tiendanube variant SKU was not returned.');
  assert(productsData.products[0].variants[0].stock === 7, 'Location inventory levels were not summed for preview.');
  assert(productsData.products[0].variants[1].stock === 3, 'Legacy variant stock was not returned.');
  assert(productsData.hasNextPage, 'Products endpoint omitted pagination metadata.');

  const importResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products/import`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(importResponse.status === 200, 'Authenticated store owner could not import Tiendanube products.');
  const importBody: unknown = await importResponse.json();
  assert(
    typeof importBody === 'object' &&
      importBody !== null &&
      'data' in importBody &&
      typeof importBody.data === 'object' &&
      importBody.data !== null,
    'Tiendanube import endpoint returned an unexpected shape.'
  );
  const importData = importBody.data as Record<string, unknown>;
  assert(importData.importedProducts === 1, 'Import did not create one local product.');
  assert(importData.importedVariants === 2, 'Import did not create two local variants.');
  assert(importData.openingStockUnits === 10, 'Import did not report the expected opening stock.');

  const importedProduct = await Product.findOne({
    where: { storeId: fixtures.storeId, tiendanubeProductId: '501' }
  });
  assert(Boolean(importedProduct), 'Imported product mapping was not persisted.');
  assert(importedProduct?.imageUrl === 'https://static.example.test/campera.jpg', 'Tiendanube product image was not persisted.');
  const importedVariants = await ProductVariant.findAll({
    where: { storeId: fixtures.storeId, productId: importedProduct!.id },
    order: [['tiendanubeVariantId', 'ASC']]
  });
  assert(importedVariants.length === 2, 'Imported product variants were not persisted.');
  assert(importedVariants[0].size === 'M', 'Tiendanube size attribute was not mapped.');
  const importedBalances = await InventoryBalance.findAll({
    where: { storeId: fixtures.storeId },
    order: [['quantity', 'DESC']]
  });
  assert(importedBalances.length === 2, 'Opening inventory balances were not created.');
  assert(importedBalances[0].quantity === 7 && importedBalances[1].quantity === 3, 'Imported opening balances do not match Tiendanube stock.');
  assert(await InventoryMovement.count({ where: { storeId: fixtures.storeId, type: 'entry' } }) === 2, 'Opening stock movements were not recorded.');

  const historyPageOneResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/orders/import?page=1`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(historyPageOneResponse.status === 200, 'Historical order page one import failed.');
  const historyPageOne = await historyPageOneResponse.json() as {
    data: { ordersProcessed: number; hasNextPage: boolean }
  };
  assert(historyPageOne.data.ordersProcessed === 4 && historyPageOne.data.hasNextPage, 'Historical order pagination metadata was incorrect.');

  const historyPageTwoResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/orders/import?page=2`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(historyPageTwoResponse.status === 200, 'Historical order page two import failed.');
  const historyPageTwo = await historyPageTwoResponse.json() as {
    data: { ordersProcessed: number; hasNextPage: boolean }
  };
  assert(historyPageTwo.data.ordersProcessed === 0 && !historyPageTwo.data.hasNextPage, 'Historical order import did not stop at the final page.');
  assert(await TiendanubeOrder.count({ where: { storeId: fixtures.storeId } }) === 4, 'Historical import did not persist every order status.');
  assert(await InventoryMovement.count({ where: { storeId: fixtures.storeId } }) === 2, 'Historical import unexpectedly changed local stock.');
  const stockAfterHistoryImport = await InventoryBalance.findAll({
    where: { storeId: fixtures.storeId },
    order: [['quantity', 'DESC']]
  });
  assert(stockAfterHistoryImport[0].quantity === 7 && stockAfterHistoryImport[1].quantity === 3, 'Historical import changed opening stock.');

  const analyticsResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/analytics/products?months=12`,
    { headers: { authorization: 'Bearer ' + initiatingToken } }
  );
  assert(analyticsResponse.status === 200, 'Authenticated product analytics request failed.');
  const analyticsBody = await analyticsResponse.json() as {
    data: {
      products: {
        productId: string;
        unitsSold: number;
        trend: string;
        variants: { unitsSold: number }[];
        monthlySales: { month: string; unitsSold: number }[];
      }[];
    }
  };
  assert(analyticsBody.data.products.length === 1, 'Analytics did not group sales by product.');
  assert(analyticsBody.data.products[0].unitsSold === 7, 'Analytics returned an incorrect paid product quantity.');
  assert(analyticsBody.data.products[0].trend === 'falling', 'Analytics did not detect the expected product trend.');
  assert(
    analyticsBody.data.products[0].variants.reduce((total, variant) => total + variant.unitsSold, 0) === 7,
    'Analytics did not group sales by product variants.'
  );
  assert(analyticsBody.data.products[0].monthlySales.length === 12, 'Analytics did not return all 12 months in the selected range.');
  assert(
    analyticsBody.data.products[0].monthlySales.some((month) => month.unitsSold === 3) &&
      analyticsBody.data.products[0].monthlySales.some((month) => month.unitsSold === 4),
    'Analytics monthly series omitted historical product sales.'
  );

  const repeatedHistoryImport = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/orders/import?page=1`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(repeatedHistoryImport.status === 200, 'Repeated historical order import failed.');
  assert(await TiendanubeOrder.count({ where: { storeId: fixtures.storeId } }) === 4, 'Repeated historical import duplicated orders.');
  assert(await TiendanubeOrderLine.count({ where: { storeId: fixtures.storeId } }) === 4, 'Repeated historical import duplicated order lines.');
  assert(await InventoryMovement.count({ where: { storeId: fixtures.storeId } }) === 2, 'Repeated historical import changed local stock.');

  const repeatedImportResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products/import`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(repeatedImportResponse.status === 200, 'Repeating product import failed.');
  const repeatedImportBody = await repeatedImportResponse.json() as { data: Record<string, unknown> };
  assert(repeatedImportBody.data.importedProducts === 0, 'Repeating import duplicated a product.');
  assert(repeatedImportBody.data.importedVariants === 0, 'Repeating import duplicated variants.');
  assert(repeatedImportBody.data.openingStockUnits === 0, 'Repeating import added opening stock twice.');
  assert(await InventoryMovement.count({ where: { storeId: fixtures.storeId, type: 'entry' } }) === 2, 'Repeating import duplicated opening movements.');

  const finalCatalogPageResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products/import?page=2`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(finalCatalogPageResponse.status === 200, 'Final catalog page import failed.');
  const finalCatalogPage = await finalCatalogPageResponse.json() as { data: Record<string, unknown> };
  assert(finalCatalogPage.data.hasNextPage === false, 'Final catalog page still reported another page.');
  assert(finalCatalogPage.data.orderWebhooksActive === true, 'Final catalog import did not enable order webhooks.');
  assert(mockWebhooks.length === 6, 'Catalog import did not register all order lifecycle webhooks.');
  const repeatedFinalPageResponse = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products/import?page=2`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + initiatingToken }
    }
  );
  assert(repeatedFinalPageResponse.status === 200, 'Repeating final catalog import failed.');
  assert(mockWebhooks.length === 6, 'Repeating catalog import created duplicate webhooks.');

  const orderWebhookUrl = `${baseUrl}/api/integrations/tiendanube/webhooks/orders`;
  async function sendOrderEvent(event: string, signatureOverride?: string): Promise<Response> {
    const body = Buffer.from(JSON.stringify({
      store_id: '123456789',
      event,
      id: '9001'
    }));
    const signature = signatureOverride ?? createHmac(
      'sha256',
      process.env.TIENDANUBE_CLIENT_SECRET as string
    ).update(body).digest('hex');
    return originalFetch(orderWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-linkedstore-hmac-sha256': signature
      },
      body
    });
  }

  const unauthorizedWebhookResponse = await sendOrderEvent('order/created', '0'.repeat(64));
  assert(unauthorizedWebhookResponse.status === 401, 'Order webhook accepted an invalid signature.');

  const createdOrderWebhook = await sendOrderEvent('order/created');
  assert(createdOrderWebhook.status === 200, 'Order creation webhook did not process successfully.');
  const variant701 = importedVariants.find((variant) => variant.tiendanubeVariantId === '701');
  assert(Boolean(variant701), 'Imported variant 701 was not found.');
  let soldBalance = await InventoryBalance.findOne({
    where: { storeId: fixtures.storeId, productVariantId: variant701!.id }
  });
  assert(soldBalance?.quantity === 5, 'Order creation did not deduct the ordered quantity internally.');

  const repeatedOrderWebhook = await sendOrderEvent('order/created');
  assert(repeatedOrderWebhook.status === 200, 'Duplicate order webhook was not acknowledged.');
  soldBalance = await InventoryBalance.findOne({
    where: { storeId: fixtures.storeId, productVariantId: variant701!.id }
  });
  assert(soldBalance?.quantity === 5, 'Duplicate order webhook deducted stock twice.');
  assert(await TiendanubeOrder.count({ where: { storeId: fixtures.storeId, externalOrderId: '9001' } }) === 1, 'Duplicate webhook created multiple local orders.');

  mockOrder = {
    ...mockOrder,
    payment_status: 'paid',
    paid_at: '2026-11-04T10:05:00.000Z'
  };
  const paidOrderWebhook = await sendOrderEvent('order/paid');
  assert(paidOrderWebhook.status === 200, 'Order paid webhook did not process successfully.');
  const trackedOrder = await TiendanubeOrder.findOne({
    where: { storeId: fixtures.storeId, externalOrderId: '9001' }
  });
  assert(trackedOrder?.paymentStatus === 'paid', 'Paid status was not recorded for the order.');
  soldBalance = await InventoryBalance.findOne({
    where: { storeId: fixtures.storeId, productVariantId: variant701!.id }
  });
  assert(soldBalance?.quantity === 5, 'Payment notification deducted the same order stock twice.');

  mockOrder = {
    ...mockOrder,
    status: 'cancelled',
    cancelled_at: '2026-11-04T10:10:00.000Z'
  };
  const cancelledOrderWebhook = await sendOrderEvent('order/cancelled');
  assert(cancelledOrderWebhook.status === 200, 'Order cancellation webhook did not process successfully.');
  soldBalance = await InventoryBalance.findOne({
    where: { storeId: fixtures.storeId, productVariantId: variant701!.id }
  });
  assert(soldBalance?.quantity === 7, 'Order cancellation did not restore the reserved stock.');
  const cancelledOrder = await TiendanubeOrder.findOne({
    where: { storeId: fixtures.storeId, externalOrderId: '9001' }
  });
  assert(cancelledOrder?.isCancelled === true, 'Order cancellation state was not recorded.');

  const repeatedCancellationWebhook = await sendOrderEvent('order/cancelled');
  assert(repeatedCancellationWebhook.status === 200, 'Duplicate cancellation webhook was not acknowledged.');
  soldBalance = await InventoryBalance.findOne({
    where: { storeId: fixtures.storeId, productVariantId: variant701!.id }
  });
  assert(soldBalance?.quantity === 7, 'Duplicate cancellation restored stock more than once.');
  const delayedCreationWebhook = await sendOrderEvent('order/created');
  assert(delayedCreationWebhook.status === 200, 'Out-of-order order notification was not acknowledged.');
  soldBalance = await InventoryBalance.findOne({
    where: { storeId: fixtures.storeId, productVariantId: variant701!.id }
  });
  assert(soldBalance?.quantity === 7, 'An out-of-order notification re-applied stock for a cancelled order.');

  const unauthenticatedStatus = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/status`
  );
  assert(unauthenticatedStatus.status === 401, 'Connection status was accessible without authentication.');
  const unauthenticatedProducts = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products`
  );
  assert(unauthenticatedProducts.status === 401, 'Tiendanube products were accessible without authentication.');
  const unauthenticatedImport = await originalFetch(
    `${baseUrl}/api/stores/${fixtures.storeId}/integrations/tiendanube/products/import`,
    { method: 'POST' }
  );
  assert(unauthenticatedImport.status === 401, 'Tiendanube products could be imported without authentication.');

  await expectIntegrationError(
    () => completeAuthorization('mock-authorization-code', getState(authorizationUrl)),
    'INVALID_OAUTH_STATE'
  );

  const conflictUrl = await createAuthorizationUrl(fixtures.otherStoreId, fixtures.otherUserId);
  await expectIntegrationError(
    () => completeAuthorization('mock-authorization-code', getState(conflictUrl)),
    'TIENDANUBE_STORE_ALREADY_CONNECTED'
  );

  console.info('OAuth, catalog import, signed order webhooks, idempotent stock deductions, payments, and cancellations passed.');
} finally {
  globalThis.fetch = originalFetch;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }
  if (storeIds.length > 0) {
    await sequelize.transaction(async (transaction) => {
      await TiendanubeConnection.destroy({ where: { storeId: storeIds }, transaction });
      await TiendanubeOrderLine.destroy({ where: { storeId: storeIds }, transaction });
      await TiendanubeOrder.destroy({ where: { storeId: storeIds }, transaction });
      await InventoryMovement.destroy({ where: { storeId: storeIds }, transaction });
      await InventoryBalance.destroy({ where: { storeId: storeIds }, transaction });
      await ProductVariant.destroy({ where: { storeId: storeIds }, transaction });
      await Product.destroy({ where: { storeId: storeIds }, transaction });
      await Location.destroy({ where: { storeId: storeIds }, transaction });
      await sequelize.query('DELETE FROM tiendanube_oauth_states WHERE store_id IN (:storeIds)', {
        replacements: { storeIds },
        transaction
      });
      await StoreMembership.destroy({ where: { storeId: storeIds, userId: userIds }, transaction });
      await Store.destroy({ where: { id: storeIds }, transaction });
      await User.destroy({ where: { id: userIds }, transaction });
    });
  }
  await sequelize.close();
}
