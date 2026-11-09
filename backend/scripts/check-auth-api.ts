import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import {
  InventoryBalance,
  InventoryMovement,
  Location,
  Product,
  ProductVariant,
  Store,
  StoreMembership,
  User
} from '../src/database/models/index.js';
import { sequelize } from '../src/database/sequelize.js';

process.env.AUTH_JWT_SECRET ??= randomBytes(32).toString('hex');

const { app } = await import('../src/app.js');
const storeIds: string[] = [];
const userIds: string[] = [];
let variantId: string | undefined;
let locationId: string | undefined;
let server: ReturnType<typeof app.listen> | undefined;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectStatus(
  response: Response,
  status: number,
  message: string
): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert(response.status === status, `${message}: expected HTTP ${status}, received ${response.status}.`);
  assert(typeof body === 'object' && body !== null, `${message}: response body was not an object.`);
  return body as Record<string, unknown>;
}

try {
  const fixture = await sequelize.transaction(async (transaction) => {
    const manager = await User.create(
      { email: `manager-${randomBytes(8).toString('hex')}@example.test`, passwordHash: await bcrypt.hash('test-password-123', 4) },
      { transaction }
    );
    const staff = await User.create(
      { email: `staff-${randomBytes(8).toString('hex')}@example.test`, passwordHash: await bcrypt.hash('test-password-123', 4) },
      { transaction }
    );
    const store = await Store.create({ name: 'Auth API test store' }, { transaction });
    const unrelatedStore = await Store.create({ name: 'Auth API unrelated store' }, { transaction });
    const product = await Product.create(
      { storeId: store.id, name: 'Auth API test product', description: null },
      { transaction }
    );
    const variant = await ProductVariant.create(
      {
        storeId: store.id,
        productId: product.id,
        sku: `AUTH-API-${randomBytes(8).toString('hex')}`,
        barcode: null,
        size: 'M',
        color: 'Black'
      },
      { transaction }
    );
    const location = await Location.create(
      { storeId: store.id, name: 'Auth API test location', type: 'warehouse' },
      { transaction }
    );
    await StoreMembership.create({ storeId: store.id, userId: manager.id, role: 'manager' }, { transaction });
    await StoreMembership.create({ storeId: store.id, userId: staff.id, role: 'staff' }, { transaction });

    return {
      managerId: manager.id,
      staffId: staff.id,
      managerEmail: manager.email,
      staffEmail: staff.email,
      storeId: store.id,
      unrelatedStoreId: unrelatedStore.id,
      variantId: variant.id,
      locationId: location.id
    };
  });

  storeIds.push(fixture.storeId, fixture.unrelatedStoreId);
  userIds.push(fixture.managerId, fixture.staffId);
  variantId = fixture.variantId;
  locationId = fixture.locationId;

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server?.once('listening', resolve);
    server?.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const signIn = async (email: string): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'test-password-123' })
    });
    const body = await expectStatus(response, 200, 'login');
    assert(typeof body.accessToken === 'string', 'login did not return an access token.');
    return body.accessToken;
  };
  const managerToken = await signIn(fixture.managerEmail);
  const staffToken = await signIn(fixture.staffEmail);
  const staffAuthorization = 'Bearer '.concat(staffToken);

  await expectStatus(
    await fetch(`${baseUrl}/api/auth/stores`),
    401,
    'unauthenticated store listing'
  );
  const staffStores = await expectStatus(
    await fetch(`${baseUrl}/api/auth/stores`, {
      headers: { authorization: staffAuthorization }
    }),
    200,
    'staff store listing'
  );
  assert(Array.isArray(staffStores.data), 'store listing response did not contain a data array.');
  assert(
    (staffStores.data as { id: string; name: string }[]).some(
      (store) => store.id === fixture.storeId && store.name === 'Auth API test store'
    ),
    'store listing did not include the user’s store.'
  );

  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/balances`),
    401,
    'unauthenticated inventory request'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.unrelatedStoreId}/inventory/balances`, {
      headers: { authorization: `Bearer ${managerToken}` }
    }),
    404,
    'cross-store inventory request'
  );
  const staffBalances = await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/balances`, {
      headers: { authorization: `Bearer ${staffToken}` }
    }),
    200,
    'staff inventory read'
  );
  assert(Array.isArray(staffBalances.data), 'inventory response did not contain a data array.');
  const staffProducts = await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/products`, {
      headers: { authorization: staffAuthorization }
    }),
    200,
    'staff product catalog read'
  );
  assert(Array.isArray(staffProducts.data), 'product catalog response did not contain a data array.');
  assert(
    (staffProducts.data as { name: string; variants: { sku: string; quantity: number }[] }[])
      .some((product) => product.name === 'Auth API test product' && product.variants[0]?.quantity === 0),
    'product catalog did not include variants with zero stock.'
  );
  const staffLocations = await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/locations`, {
      headers: { authorization: 'Bearer '.concat(staffToken) }
    }),
    200,
    'staff location read'
  );
  assert(
    Array.isArray(staffLocations.data) &&
      (staffLocations.data as { id: string; name: string }[]).some(
        (location) => location.id === fixture.locationId
      ),
    'location listing did not include the store location.'
  );

  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/analytics/products`),
    401,
    'unauthenticated product analytics request'
  );
  const staffAnalytics = await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/analytics/products?months=12`, {
      headers: { authorization: staffAuthorization }
    }),
    200,
    'staff product analytics read'
  );
  assert(
    typeof staffAnalytics.data === 'object' &&
      staffAnalytics.data !== null &&
      Array.isArray((staffAnalytics.data as { products: unknown[] }).products),
    'product analytics did not return a product list.'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.unrelatedStoreId}/analytics/products`, {
      headers: { authorization: `Bearer ${staffToken}` }
    }),
    404,
    'cross-store product analytics request'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/analytics/products?months=7`, {
      headers: { authorization: staffAuthorization }
    }),
    400,
    'invalid product analytics period'
  );

  const managerHeaders = { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' };
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/movements`, {
      method: 'POST',
      headers: managerHeaders,
      body: JSON.stringify({ type: 'entry', quantity: 3, productVariantId: fixture.variantId, destinationLocationId: fixture.locationId })
    }),
    201,
    'manager inventory entry'
  );
  const recentMovements = await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/movements`, {
      headers: { authorization: `Bearer ${managerToken}` }
    }),
    200,
    'manager recent movement read'
  );
  assert(
    Array.isArray(recentMovements.data) &&
      (recentMovements.data as { type: string; quantity: number; productName: string }[]).some(
        (movement) =>
          movement.type === 'entry' &&
          movement.quantity === 3 &&
          movement.productName === 'Auth API test product'
      ),
    'recent movement list omitted its product and movement details.'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/movements`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'entry', quantity: 1, productVariantId: fixture.variantId, destinationLocationId: fixture.locationId })
    }),
    403,
    'staff inventory write'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/movements`, {
      method: 'POST',
      headers: managerHeaders,
      body: JSON.stringify({
        type: 'entry',
        quantity: 1,
        storeId: fixture.unrelatedStoreId,
        productVariantId: fixture.variantId,
        destinationLocationId: fixture.locationId
      })
    }),
    400,
    'client-supplied store id'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/stores/${fixture.storeId}/inventory/movements`, {
      method: 'POST',
      headers: managerHeaders,
      body: '{invalid'
    }),
    400,
    'malformed JSON'
  );
  await expectStatus(
    await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: fixture.managerEmail, password: 'incorrect-password' })
    }),
    401,
    'invalid credentials'
  );

  console.info('Login, JWT authentication, store isolation, role authorization, input validation, and inventory API checks passed.');
} finally {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
  }

  if (storeIds.length > 0) {
    await sequelize.transaction(async (transaction) => {
      await InventoryMovement.destroy({ where: { storeId: storeIds }, transaction });
      await InventoryBalance.destroy({ where: { storeId: storeIds }, transaction });
      if (variantId) {
        await ProductVariant.destroy({ where: { id: variantId }, transaction });
      }
      await Product.destroy({ where: { storeId: storeIds }, transaction });
      await Location.destroy({ where: { storeId: storeIds }, transaction });
      await StoreMembership.destroy({ where: { userId: userIds }, transaction });
      await Store.destroy({ where: { id: storeIds }, transaction });
      await User.destroy({ where: { id: userIds }, transaction });
    });
  }

  await sequelize.close();
}
