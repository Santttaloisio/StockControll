import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import {
  InventoryBalance,
  InventoryMovement,
  Location,
  Product,
  ProductVariant,
  TiendanubeOrder,
  TiendanubeOrderLine,
  TiendanubeConnection
} from '../../../database/models/index.js';
import { sequelize } from '../../../database/sequelize.js';
import type { Transaction } from 'sequelize';
import { createInventoryMovementInTransaction } from '../../inventory/inventory.service.js';
import { TiendanubeIntegrationError } from './tiendanube-oauth.service.js';

const apiBaseUrl = 'https://api.tiendanube.com/2025-03';
const productsPerPage = 30;
const ordersPerPage = 30;
const maximumOrderRecords = 10_000;
const maximumOrderPages = Math.ceil(maximumOrderRecords / ordersPerPage);
const orderWebhookEvents = [
  'order/created',
  'order/updated',
  'order/edited',
  'order/paid',
  'order/cancelled',
  'order/voided'
] as const;

export interface TiendanubeProductPreview {
  id: string;
  name: string;
  imageUrl: string | null;
  attributes: string[];
  variants: {
    id: string;
    sku: string | null;
    values: string[];
    stock: number | null;
  }[];
}

function requiredEncryptionKey(): Buffer {
  const value = process.env.TIENDANUBE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube token encryption is not configured correctly.',
      500,
      'INVALID_TOKEN_ENCRYPTION_CONFIGURATION'
    );
  }

  return Buffer.from(value, 'hex');
}

function requiredUserAgent(): string {
  const value = process.env.TIENDANUBE_USER_AGENT?.trim();
  if (!value || value.length > 255 || /[\r\n]/.test(value)) {
    throw new TiendanubeIntegrationError(
      'Configure TIENDANUBE_USER_AGENT with the application name and a contact email or URL.',
      500,
      'INVALID_USER_AGENT_CONFIGURATION'
    );
  }

  return value;
}

function decryptAccessToken(connection: TiendanubeConnection): string {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      requiredEncryptionKey(),
      Buffer.from(connection.tokenIv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(connection.tokenAuthTag, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(connection.encryptedAccessToken, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof TiendanubeIntegrationError) {
      throw error;
    }

    console.error('Could not decrypt the Tiendanube access token.');
    throw new TiendanubeIntegrationError(
      'The Tiendanube connection cannot be used. Reconnect the store.',
      500,
      'TOKEN_DECRYPTION_FAILED'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    return '';
  }

  const localized = [value['es-AR'], value.es, ...Object.values(value)]
    .find((candidate): candidate is string => typeof candidate === 'string');
  return localized ?? '';
}

function numericId(value: unknown): string | undefined {
  if ((typeof value === 'string' || typeof value === 'number') && /^[0-9]+$/.test(String(value))) {
    return String(value);
  }

  return undefined;
}

function productImageUrl(product: Record<string, unknown>): string | null {
  const images = Array.isArray(product.images) ? product.images : [];
  const image = images.find(isRecord);
  const source = image && typeof image.src === 'string' ? image.src : null;
  if (!source || source.length > 2048) {
    return null;
  }

  try {
    const url = new URL(source);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function variantStock(variant: Record<string, unknown>): number | null {
  if (Array.isArray(variant.inventory_levels)) {
    let total = 0;
    for (const level of variant.inventory_levels) {
      if (!isRecord(level) || !Number.isSafeInteger(level.stock) || (level.stock as number) < 0) {
        return null;
      }
      total += level.stock as number;
    }
    return Number.isSafeInteger(total) && total <= 2_147_483_647 ? total : null;
  }

  return Number.isSafeInteger(variant.stock) &&
    (variant.stock as number) >= 0 &&
    (variant.stock as number) <= 2_147_483_647
    ? variant.stock as number
    : null;
}

function parseProducts(payload: unknown): TiendanubeProductPreview[] {
  if (!Array.isArray(payload)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an unexpected products response.',
      502,
      'INVALID_PRODUCTS_RESPONSE'
    );
  }

  return payload.map((product) => {
    if (!isRecord(product)) {
      throw new TiendanubeIntegrationError(
        'Tiendanube returned an invalid product.',
        502,
        'INVALID_PRODUCTS_RESPONSE'
      );
    }

    const id = numericId(product.id);
    if (!id) {
      throw new TiendanubeIntegrationError(
        'Tiendanube returned a product without a valid ID.',
        502,
        'INVALID_PRODUCTS_RESPONSE'
      );
    }

    const variants = Array.isArray(product.variants) ? product.variants : [];
    const attributes = Array.isArray(product.attributes)
      ? product.attributes.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      id,
      name: textValue(product.name),
      imageUrl: productImageUrl(product),
      attributes,
      variants: variants.map((variant) => {
        if (!isRecord(variant)) {
          throw new TiendanubeIntegrationError(
            'Tiendanube returned an invalid product variant.',
            502,
            'INVALID_PRODUCTS_RESPONSE'
          );
        }

        const variantId = numericId(variant.id);
        if (!variantId) {
          throw new TiendanubeIntegrationError(
            'Tiendanube returned a product variant without a valid ID.',
            502,
            'INVALID_PRODUCTS_RESPONSE'
          );
        }

        const values = Array.isArray(variant.values)
          ? variant.values.filter((value): value is string => typeof value === 'string')
          : [];

        return {
          id: variantId,
          sku: typeof variant.sku === 'string' && variant.sku.trim().length > 0 ? variant.sku.trim() : null,
          values,
          stock: variantStock(variant)
        };
      })
    };
  });
}

export async function listTiendanubeProducts(
  storeId: string,
  page: number
): Promise<{ products: TiendanubeProductPreview[]; page: number; perPage: number; hasNextPage: boolean }> {
  const connection = await TiendanubeConnection.findOne({
    where: { storeId, isActive: true }
  });

  if (!connection) {
    throw new TiendanubeIntegrationError(
      'Connect a Tiendanube store before requesting its products.',
      409,
      'TIENDANUBE_NOT_CONNECTED'
    );
  }

  const scopes = connection.grantedScopes.split(',').map((scope) => scope.trim());
  if (!scopes.includes('read_products') && !scopes.includes('write_products')) {
    throw new TiendanubeIntegrationError(
      'The Tiendanube connection does not have permission to read products. Reauthorize the app.',
      403,
      'TIENDANUBE_SCOPE_MISSING'
    );
  }

  const url = new URL(`${apiBaseUrl}/${connection.externalStoreId}/products`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(productsPerPage));

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `bearer ${decryptAccessToken(connection)}`,
      'user-agent': requiredUserAgent(),
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(15_000)
  }).catch((error: unknown) => {
    console.error('Tiendanube products request failed:', error);
    throw new TiendanubeIntegrationError(
      'Could not reach Tiendanube to read products.',
      502,
      'TIENDANUBE_API_UNAVAILABLE'
    );
  });

  if (!response.ok) {
    const statusCode = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
    const code = response.status === 401
      ? 'TIENDANUBE_TOKEN_INVALID'
      : response.status === 403
        ? 'TIENDANUBE_API_FORBIDDEN'
        : 'TIENDANUBE_API_ERROR';
    throw new TiendanubeIntegrationError(
      response.status === 401
        ? 'Tiendanube rejected the access token. Reconnect the store.'
        : response.status === 403
          ? 'Tiendanube denied access to products. Check the app permissions.'
          : 'Tiendanube could not return products.',
      statusCode,
      code
    );
  }

  const payload: unknown = await response.json().catch((error: unknown) => {
    console.error('Tiendanube returned invalid JSON for products:', error);
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an invalid products response.',
      502,
      'INVALID_PRODUCTS_RESPONSE'
    );
  });

  return {
    products: parseProducts(payload),
    page,
    perPage: productsPerPage,
    hasNextPage: response.headers.get('link')?.includes('rel="next"') ?? false
  };
}

function variantAttributes(
  product: TiendanubeProductPreview,
  values: string[]
): { size: string | null; color: string | null } {
  let size: string | null = null;
  let color: string | null = null;

  product.attributes.forEach((attribute, index) => {
    const value = values[index]?.trim();
    if (!value) {
      return;
    }

    const normalized = attribute.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!size && /\b(size|talle|tamano)\b/.test(normalized)) {
      size = value;
    } else if (!color && /\b(color|colour)\b/.test(normalized)) {
      color = value;
    }
  });

  return { size, color };
}

async function getStockLocation(storeId: string, transaction: Transaction): Promise<Location> {
  const locations = await Location.findAll({
    where: { storeId, isActive: true },
    order: [['createdAt', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  });

  if (locations.length === 1) {
    return locations[0];
  }

  if (locations.length > 1) {
    const generalLocations = locations.filter((location) => location.name === 'Stock general');
    if (generalLocations.length === 1) {
      return generalLocations[0];
    }
    throw new TiendanubeIntegrationError(
      'Choose a single active location named "Stock general" before importing opening stock.',
      409,
      'AMBIGUOUS_STOCK_LOCATION'
    );
  }

  return Location.create(
    { storeId, name: 'Stock general', type: 'other' },
    { transaction }
  );
}

export interface TiendanubeProductImportResult {
  page: number;
  importedProducts: number;
  updatedProducts: number;
  importedVariants: number;
  updatedVariants: number;
  openingStockUnits: number;
  hasNextPage: boolean;
  orderWebhooksActive: boolean;
}

export async function importTiendanubeProducts(
  storeId: string,
  page: number
): Promise<TiendanubeProductImportResult> {
  const catalogPage = await listTiendanubeProducts(storeId, page);
  const totals = await sequelize.transaction(async (transaction) => {
    let importedProducts = 0;
    let updatedProducts = 0;
    let importedVariants = 0;
    let updatedVariants = 0;
    let openingStockUnits = 0;
    let stockLocation: Location | undefined;

    for (const productData of catalogPage.products) {
      if (!productData.name.trim() || productData.name.length > 200) {
        throw new TiendanubeIntegrationError(
          `Tiendanube product ${productData.id} has a missing or too-long name.`,
          422,
          'INVALID_PRODUCT_DATA'
        );
      }

      let product = await Product.findOne({
        where: { storeId, tiendanubeProductId: productData.id },
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      if (product) {
        await product.update({
          name: productData.name,
          imageUrl: productData.imageUrl ?? product.imageUrl
        }, { transaction });
        updatedProducts += 1;
      } else {
        product = await Product.create(
          {
            storeId,
            tiendanubeProductId: productData.id,
            name: productData.name,
            description: null,
            imageUrl: productData.imageUrl
          },
          { transaction }
        );
        importedProducts += 1;
      }

      for (const variantData of productData.variants) {
        if (variantData.sku && variantData.sku.length > 100) {
          throw new TiendanubeIntegrationError(
            `Tiendanube variant ${variantData.id} has a SKU longer than 100 characters.`,
            422,
            'INVALID_PRODUCT_DATA'
          );
        }

        let variant = await ProductVariant.findOne({
          where: { storeId, tiendanubeVariantId: variantData.id },
          transaction,
          lock: transaction.LOCK.UPDATE
        });
        const attributeValues = variantAttributes(productData, variantData.values);

        if (variantData.sku) {
          const skuOwner = await ProductVariant.findOne({
            where: { storeId, sku: variantData.sku },
            transaction,
            lock: transaction.LOCK.UPDATE
          });
          if (skuOwner && skuOwner.id !== variant?.id) {
            throw new TiendanubeIntegrationError(
              `SKU "${variantData.sku}" is already assigned to another local variant.`,
              409,
              'SKU_CONFLICT'
            );
          }
        }

        if (variant) {
          if (variant.productId !== product.id) {
            throw new TiendanubeIntegrationError(
              `Tiendanube variant ${variantData.id} is linked to a different local product.`,
              409,
              'PRODUCT_MAPPING_CONFLICT'
            );
          }
          await variant.update(
            { sku: variantData.sku, ...attributeValues },
            { transaction }
          );
          updatedVariants += 1;
        } else {
          variant = await ProductVariant.create(
            {
              storeId,
              productId: product.id,
              tiendanubeVariantId: variantData.id,
              sku: variantData.sku,
              barcode: null,
              ...attributeValues
            },
            { transaction }
          );
          importedVariants += 1;

          if (variantData.stock !== null) {
            stockLocation ??= await getStockLocation(storeId, transaction);
            await InventoryBalance.create(
              {
                storeId,
                productVariantId: variant.id,
                locationId: stockLocation.id,
                quantity: variantData.stock
              },
              { transaction }
            );

            if (variantData.stock > 0) {
              await InventoryMovement.create(
                {
                  storeId,
                  productVariantId: variant.id,
                  type: 'entry',
                  quantity: variantData.stock,
                  sourceLocationId: null,
                  destinationLocationId: stockLocation.id,
                  reference: `tiendanube-initial-import:${variantData.id}`,
                  notes: `Stock inicial importado de Tiendanube para la variante ${variantData.id}.`
                },
                { transaction }
              );
              openingStockUnits += variantData.stock;
            }
          }
        }
      }
    }

    return {
      importedProducts,
      updatedProducts,
      importedVariants,
      updatedVariants,
      openingStockUnits
    };
  });

  if (!catalogPage.hasNextPage) {
    await registerTiendanubeOrderWebhooks(storeId);
  }

  return {
    page,
    hasNextPage: catalogPage.hasNextPage,
    orderWebhooksActive: !catalogPage.hasNextPage,
    ...totals
  };
}

function providerError(status: number): TiendanubeIntegrationError {
  if (status === 401) {
    return new TiendanubeIntegrationError(
      'Tiendanube rejected the access token. Reconnect the store.',
      401,
      'TIENDANUBE_TOKEN_INVALID'
    );
  }
  if (status === 403) {
    return new TiendanubeIntegrationError(
      'Tiendanube denied access. Check the app permissions.',
      403,
      'TIENDANUBE_API_FORBIDDEN'
    );
  }
  return new TiendanubeIntegrationError(
    'Tiendanube could not complete the request.',
    502,
    'TIENDANUBE_API_ERROR'
  );
}

async function tiendanubeRequest(
  connection: TiendanubeConnection,
  url: URL,
  method: 'GET' | 'POST',
  body?: Record<string, string>
): Promise<Response> {
  const headers = {
    authorization: `bearer ${decryptAccessToken(connection)}`,
    'user-agent': requiredUserAgent(),
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json' } : {})
  };
  try {
    return await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    console.error('Tiendanube API request failed:', error);
    throw new TiendanubeIntegrationError(
      'Could not reach Tiendanube.',
      502,
      'TIENDANUBE_API_UNAVAILABLE'
    );
  }
}

export async function registerTiendanubeOrderWebhooks(storeId: string): Promise<void> {
  const connection = await TiendanubeConnection.findOne({
    where: { storeId, isActive: true }
  });
  if (!connection) {
    throw new TiendanubeIntegrationError(
      'Connect a Tiendanube store before enabling order notifications.',
      409,
      'TIENDANUBE_NOT_CONNECTED'
    );
  }

  const scopes = connection.grantedScopes.split(',').map((scope) => scope.trim());
  if (!scopes.includes('read_orders')) {
    throw new TiendanubeIntegrationError(
      'The Tiendanube connection does not have permission to read orders. Reauthorize the app.',
      403,
      'TIENDANUBE_SCOPE_MISSING'
    );
  }

  const redirectUriValue = process.env.TIENDANUBE_REDIRECT_URI?.trim();
  if (!redirectUriValue) {
    throw new TiendanubeIntegrationError(
      'Configure TIENDANUBE_REDIRECT_URI before enabling order notifications.',
      500,
      'INVALID_WEBHOOK_CONFIGURATION'
    );
  }
  let redirectUri: URL;
  try {
    redirectUri = new URL(redirectUriValue);
  } catch {
    throw new TiendanubeIntegrationError(
      'TIENDANUBE_REDIRECT_URI must be a valid public HTTPS URL.',
      500,
      'INVALID_WEBHOOK_CONFIGURATION'
    );
  }
  if (
    redirectUri.protocol !== 'https:' ||
    ['localhost', '127.0.0.1', '::1'].includes(redirectUri.hostname)
  ) {
    throw new TiendanubeIntegrationError(
      'TIENDANUBE_REDIRECT_URI must use the public HTTPS host used by Tiendanube.',
      500,
      'INVALID_WEBHOOK_CONFIGURATION'
    );
  }
  const webhookUrl = new URL('/api/integrations/tiendanube/webhooks/orders', redirectUri.origin).toString();
  const endpoint = new URL(`${apiBaseUrl}/${connection.externalStoreId}/webhooks`);
  const listResponse = await tiendanubeRequest(connection, endpoint, 'GET');
  if (!listResponse.ok) {
    throw providerError(listResponse.status);
  }

  const existingPayload: unknown = await listResponse.json().catch((error: unknown) => {
    console.error('Tiendanube returned invalid webhook data:', error);
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an invalid webhook response.',
      502,
      'INVALID_WEBHOOK_RESPONSE'
    );
  });
  if (!Array.isArray(existingPayload)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an unexpected webhook response.',
      502,
      'INVALID_WEBHOOK_RESPONSE'
    );
  }

  const existingWebhooks = existingPayload.filter(isRecord);
  for (const event of orderWebhookEvents) {
    const alreadyRegistered = existingWebhooks.some(
      (webhook) => webhook.event === event && webhook.url === webhookUrl
    );
    if (alreadyRegistered) {
      continue;
    }

    const createResponse = await tiendanubeRequest(
      connection,
      endpoint,
      'POST',
      { event, url: webhookUrl }
    );
    if (!createResponse.ok) {
      throw providerError(createResponse.status);
    }
    await createResponse.body?.cancel();
  }
}

interface TiendanubeOrderItem {
  externalVariantId: string;
  quantity: number;
  unitPrice: string | null;
}

interface TiendanubeOrderSnapshot {
  id: string;
  status: string;
  paymentStatus: string;
  createdAt: Date | null;
  paidAt: Date | null;
  currency: string | null;
  total: string | null;
  isCancelled: boolean;
  items: TiendanubeOrderItem[];
}

function decimalValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9]{1,10}(?:\.[0-9]{1,2})?$/.test(text)) {
    return null;
  }
  return Number(text).toFixed(2);
}

function dateValue(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 64) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTiendanubeOrder(payload: unknown): TiendanubeOrderSnapshot {
  if (!isRecord(payload)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an invalid order.',
      502,
      'INVALID_ORDER_RESPONSE'
    );
  }
  const id = numericId(payload.id);
  const status = typeof payload.status === 'string' ? payload.status.trim() : '';
  const paymentStatus = typeof payload.payment_status === 'string'
    ? payload.payment_status.trim()
    : '';
  if (!id || !status || status.length > 64 || !paymentStatus || paymentStatus.length > 64) {
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an order with missing or invalid identifiers or status.',
      502,
      'INVALID_ORDER_RESPONSE'
    );
  }
  if (!Array.isArray(payload.products)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an order without its product list.',
      502,
      'INVALID_ORDER_RESPONSE'
    );
  }

  const items = new Map<string, TiendanubeOrderItem>();
  for (const rawItem of payload.products) {
    if (!isRecord(rawItem)) {
      throw new TiendanubeIntegrationError(
        'Tiendanube returned an invalid order product.',
        502,
        'INVALID_ORDER_RESPONSE'
      );
    }
    const externalVariantId = numericId(rawItem.variant_id);
    const quantity = rawItem.quantity;
    if (
      !externalVariantId ||
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 2_147_483_647
    ) {
      throw new TiendanubeIntegrationError(
        'Tiendanube returned an order product with an invalid variant or quantity.',
        502,
        'INVALID_ORDER_RESPONSE'
      );
    }

    const unitPrice = decimalValue(rawItem.price);
    const existing = items.get(externalVariantId);
    if (existing) {
      const combinedQuantity = existing.quantity + quantity;
      if (!Number.isSafeInteger(combinedQuantity) || combinedQuantity > 2_147_483_647) {
        throw new TiendanubeIntegrationError(
          'Tiendanube returned an order quantity that exceeds the supported limit.',
          422,
          'INVALID_ORDER_RESPONSE'
        );
      }
      existing.quantity = combinedQuantity;
      if (existing.unitPrice !== unitPrice) {
        existing.unitPrice = null;
      }
    } else {
      items.set(externalVariantId, {
        externalVariantId,
        quantity,
        unitPrice
      });
    }
  }

  const currency = typeof payload.currency === 'string' && /^[A-Za-z]{3}$/.test(payload.currency)
    ? payload.currency.toUpperCase()
    : null;
  const statusLowercase = status.toLowerCase();
  const paymentStatusLowercase = paymentStatus.toLowerCase();
  return {
    id,
    status,
    paymentStatus,
    createdAt: dateValue(payload.created_at),
    paidAt: dateValue(payload.paid_at),
    currency,
    total: decimalValue(payload.total),
    isCancelled: statusLowercase === 'cancelled' || statusLowercase === 'canceled' ||
      statusLowercase === 'voided' || paymentStatusLowercase === 'voided' ||
      dateValue(payload.cancelled_at) !== null,
    items: [...items.values()]
  };
}

function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): void {
  const secret = process.env.TIENDANUBE_CLIENT_SECRET?.trim();
  if (!secret) {
    throw new TiendanubeIntegrationError(
      'Tiendanube webhook verification is not configured.',
      500,
      'INVALID_WEBHOOK_CONFIGURATION'
    );
  }
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube webhook signature is missing or invalid.',
      401,
      'INVALID_WEBHOOK_SIGNATURE'
    );
  }
  const actual = Buffer.from(signature, 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube webhook signature is invalid.',
      401,
      'INVALID_WEBHOOK_SIGNATURE'
    );
  }
}

async function fetchTiendanubeOrder(
  connection: TiendanubeConnection,
  externalOrderId: string
): Promise<TiendanubeOrderSnapshot> {
  const url = new URL(
    `${apiBaseUrl}/${connection.externalStoreId}/orders/${externalOrderId}`
  );
  const response = await tiendanubeRequest(connection, url, 'GET');
  if (!response.ok) {
    throw providerError(response.status);
  }
  const payload: unknown = await response.json().catch((error: unknown) => {
    console.error('Tiendanube returned invalid JSON for an order:', error);
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an invalid order response.',
      502,
      'INVALID_ORDER_RESPONSE'
    );
  });
  return parseTiendanubeOrder(payload);
}

export async function importTiendanubeOrders(
  storeId: string,
  page: number
): Promise<{ page: number; ordersProcessed: number; hasNextPage: boolean }> {
  if (!Number.isSafeInteger(page) || page < 1 || page > maximumOrderPages) {
    throw new TiendanubeIntegrationError(
      `Order history is limited to ${maximumOrderRecords} records per synchronization.`,
      422,
      'ORDER_HISTORY_LIMIT_EXCEEDED'
    );
  }

  const connection = await TiendanubeConnection.findOne({
    where: { storeId, isActive: true }
  });
  if (!connection) {
    throw new TiendanubeIntegrationError(
      'Connect a Tiendanube store before importing order history.',
      409,
      'TIENDANUBE_NOT_CONNECTED'
    );
  }
  const scopes = connection.grantedScopes.split(',').map((scope) => scope.trim());
  if (!scopes.includes('read_orders')) {
    throw new TiendanubeIntegrationError(
      'The Tiendanube connection does not have permission to read orders. Reauthorize the app.',
      403,
      'TIENDANUBE_SCOPE_MISSING'
    );
  }

  const url = new URL(`${apiBaseUrl}/${connection.externalStoreId}/orders`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(ordersPerPage));
  const response = await tiendanubeRequest(connection, url, 'GET');
  if (!response.ok) {
    throw providerError(response.status);
  }

  const payload: unknown = await response.json().catch((error: unknown) => {
    console.error('Tiendanube returned invalid JSON for order history:', error);
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an invalid order history response.',
      502,
      'INVALID_ORDER_RESPONSE'
    );
  });
  if (!Array.isArray(payload)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube returned an unexpected order history response.',
      502,
      'INVALID_ORDER_RESPONSE'
    );
  }

  for (const rawOrder of payload) {
    await syncTiendanubeOrder(storeId, parseTiendanubeOrder(rawOrder), false);
  }

  const hasNextPage = response.headers.get('link')?.includes('rel="next"') ?? false;
  if (page === maximumOrderPages && hasNextPage) {
    throw new TiendanubeIntegrationError(
      `This store has more than ${maximumOrderRecords} orders. Import a date range in smaller batches.`,
      422,
      'ORDER_HISTORY_LIMIT_EXCEEDED'
    );
  }

  return { page, ordersProcessed: payload.length, hasNextPage };
}

async function syncTiendanubeOrder(
  storeId: string,
  snapshot: TiendanubeOrderSnapshot,
  inventoryTracked = true
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      'SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))',
      {
        replacements: { key: `${storeId}:${snapshot.id}` },
        transaction
      }
    );

    let order = await TiendanubeOrder.findOne({
      where: { storeId, externalOrderId: snapshot.id },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!order) {
      order = await TiendanubeOrder.create(
        {
          storeId,
          externalOrderId: snapshot.id,
          orderStatus: snapshot.status,
          paymentStatus: snapshot.paymentStatus,
          createdAtProvider: snapshot.createdAt,
          paidAtProvider: snapshot.paidAt,
          currency: snapshot.currency,
          total: snapshot.total,
          isCancelled: snapshot.isCancelled,
          inventoryTracked
        },
        { transaction }
      );
    }
    const shouldTrackInventory = order.inventoryTracked;

    const externalVariantIds = snapshot.items.map((item) => item.externalVariantId);
    const variants = externalVariantIds.length > 0
      ? await ProductVariant.findAll({
        where: {
          storeId,
          tiendanubeVariantId: externalVariantIds,
          isActive: true
        },
        transaction,
        lock: transaction.LOCK.UPDATE
      })
      : [];
    const variantsByExternalId = new Map<string, ProductVariant>();
    for (const variant of variants) {
      if (variant.tiendanubeVariantId) {
        variantsByExternalId.set(variant.tiendanubeVariantId, variant);
      }
    }
    if (variantsByExternalId.size !== new Set(externalVariantIds).size) {
      throw new TiendanubeIntegrationError(
        'Import the Tiendanube catalog before processing orders; one or more order variants are not linked.',
        409,
        'ORDER_VARIANT_NOT_IMPORTED'
      );
    }

    const existingLines = await TiendanubeOrderLine.findAll({
      where: { storeId, orderId: order.id },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const linesByExternalId = new Map(
      existingLines.map((line) => [line.externalVariantId, line])
    );
    const incomingItems = new Map(snapshot.items.map((item) => [item.externalVariantId, item]));
    const allExternalVariantIds = new Set([
      ...linesByExternalId.keys(),
      ...incomingItems.keys()
    ]);

    let stockLocation: Location | undefined;
    for (const externalVariantId of allExternalVariantIds) {
      const incomingItem = incomingItems.get(externalVariantId);
      const existingLine = linesByExternalId.get(externalVariantId);
      const productVariantId = incomingItem
        ? variantsByExternalId.get(externalVariantId)!.id
        : existingLine!.productVariantId;
      if (existingLine && existingLine.productVariantId !== productVariantId) {
        throw new TiendanubeIntegrationError(
          'An order variant mapping changed after it was first processed.',
          409,
          'ORDER_VARIANT_MAPPING_CHANGED'
        );
      }

      const quantity = incomingItem?.quantity ?? 0;
      const stockAppliedQuantity = shouldTrackInventory && !snapshot.isCancelled ? quantity : 0;
      const previousAppliedQuantity = existingLine?.stockAppliedQuantity ?? 0;
      const delta = stockAppliedQuantity - previousAppliedQuantity;
      if (delta !== 0) {
        stockLocation ??= await getStockLocation(storeId, transaction);
        const commonMovement = {
          storeId,
          productVariantId,
          quantity: Math.abs(delta),
          reference: `tiendanube-order:${snapshot.id}`,
          notes: snapshot.isCancelled
            ? `Cancelación del pedido Tiendanube #${snapshot.id}.`
            : `Pedido Tiendanube #${snapshot.id}.`
        };
        if (delta > 0) {
          await createInventoryMovementInTransaction(
            { ...commonMovement, type: 'exit', sourceLocationId: stockLocation.id },
            transaction
          );
        } else {
          await createInventoryMovementInTransaction(
            { ...commonMovement, type: snapshot.isCancelled ? 'return' : 'entry', destinationLocationId: stockLocation.id },
            transaction
          );
        }
      }

      if (existingLine) {
        await existingLine.update(
          {
            quantity,
            stockAppliedQuantity,
            unitPrice: incomingItem?.unitPrice ?? existingLine.unitPrice
          },
          { transaction }
        );
      } else {
        await TiendanubeOrderLine.create(
          {
            storeId,
            orderId: order.id,
            externalVariantId,
            productVariantId,
            quantity,
            stockAppliedQuantity,
            unitPrice: incomingItem?.unitPrice ?? null
          },
          { transaction }
        );
      }
    }

    await order.update(
      {
        orderStatus: snapshot.status,
        paymentStatus: snapshot.paymentStatus,
        createdAtProvider: snapshot.createdAt,
        paidAtProvider: snapshot.paidAt,
        currency: snapshot.currency,
        total: snapshot.total,
        isCancelled: snapshot.isCancelled,
        inventoryTracked: shouldTrackInventory,
        lastSyncedAt: new Date()
      },
      { transaction }
    );
  });
}

export async function processTiendanubeOrderWebhook(
  rawBody: Buffer,
  signature: string | undefined
): Promise<void> {
  verifyWebhookSignature(rawBody, signature);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new TiendanubeIntegrationError(
      'Tiendanube webhook body must be valid JSON.',
      400,
      'INVALID_WEBHOOK_PAYLOAD'
    );
  }
  if (!isRecord(payload)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube webhook body must be an object.',
      400,
      'INVALID_WEBHOOK_PAYLOAD'
    );
  }

  const externalStoreId = numericId(payload.store_id);
  const externalOrderId = numericId(payload.id);
  const event = payload.event;
  if (!externalStoreId || !externalOrderId || typeof event !== 'string' ||
    !orderWebhookEvents.some((supportedEvent) => supportedEvent === event)) {
    throw new TiendanubeIntegrationError(
      'Tiendanube webhook is missing a valid store, order, or event identifier.',
      400,
      'INVALID_WEBHOOK_PAYLOAD'
    );
  }

  const connection = await TiendanubeConnection.findOne({
    where: { externalStoreId, isActive: true }
  });
  if (!connection) {
    throw new TiendanubeIntegrationError(
      'No active Tiendanube connection matches this webhook store.',
      404,
      'TIENDANUBE_NOT_CONNECTED'
    );
  }
  const scopes = connection.grantedScopes.split(',').map((scope) => scope.trim());
  if (!scopes.includes('read_orders')) {
    throw new TiendanubeIntegrationError(
      'The Tiendanube connection does not have permission to read orders. Reauthorize the app.',
      403,
      'TIENDANUBE_SCOPE_MISSING'
    );
  }

  const snapshot = await fetchTiendanubeOrder(connection, externalOrderId);
  await syncTiendanubeOrder(connection.storeId, snapshot);
}
