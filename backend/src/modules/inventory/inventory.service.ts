import { Op, type Transaction } from 'sequelize';
import {
  InventoryBalance,
  InventoryMovement,
  Location,
  Product,
  ProductVariant
} from '../../database/models/index.js';
import { sequelize } from '../../database/sequelize.js';

type MovementType = 'entry' | 'exit' | 'adjustment' | 'transfer' | 'return';

interface MovementBase {
  storeId: string;
  productVariantId: string;
  quantity: number;
  reference?: string | null;
  notes?: string | null;
}

export type CreateInventoryMovementInput = MovementBase & (
  | { type: 'entry' | 'return'; destinationLocationId: string }
  | { type: 'exit'; sourceLocationId: string }
  | { type: 'adjustment'; locationId: string; direction: 'increase' | 'decrease' }
  | { type: 'transfer'; sourceLocationId: string; destinationLocationId: string }
);

interface NormalizedMovement extends MovementBase {
  type: MovementType;
  sourceLocationId: string | null;
  destinationLocationId: string | null;
}

export class InventoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedFields = new Set([
  'type',
  'storeId',
  'productVariantId',
  'quantity',
  'sourceLocationId',
  'destinationLocationId',
  'locationId',
  'direction',
  'reference',
  'notes'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new InventoryError(`${field} must be a valid UUID.`, 400, 'INVALID_INPUT');
  }

  return value;
}

function optionalText(value: unknown, field: string, maximumLength: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new InventoryError(`${field} must be a string of at most ${maximumLength} characters.`, 400, 'INVALID_INPUT');
  }

  return value.trim() || null;
}

function validateInput(input: unknown): NormalizedMovement {
  if (!isRecord(input)) {
    throw new InventoryError('Request body must be an object.', 400, 'INVALID_INPUT');
  }

  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      throw new InventoryError(`Unexpected field: ${field}.`, 400, 'INVALID_INPUT');
    }
  }

  const storeId = requiredUuid(input.storeId, 'storeId');
  const productVariantId = requiredUuid(input.productVariantId, 'productVariantId');

  if (!Number.isSafeInteger(input.quantity) || (input.quantity as number) < 1 || (input.quantity as number) > 2_147_483_647) {
    throw new InventoryError('quantity must be a positive integer.', 400, 'INVALID_QUANTITY');
  }

  const common = {
    storeId,
    productVariantId,
    quantity: input.quantity as number,
    reference: optionalText(input.reference, 'reference', 150),
    notes: optionalText(input.notes, 'notes', 10_000)
  };
  const rejectFields = (...fields: string[]) => {
    if (fields.some((field) => field in input)) {
      throw new InventoryError('Location fields do not match the movement type.', 400, 'INVALID_INPUT');
    }
  };

  switch (input.type) {
    case 'entry':
    case 'return':
      rejectFields('sourceLocationId', 'locationId');
      if ('direction' in input) {
        throw new InventoryError('direction is only valid for adjustments.', 400, 'INVALID_INPUT');
      }
      return {
        ...common,
        type: input.type,
        sourceLocationId: null,
        destinationLocationId: requiredUuid(input.destinationLocationId, 'destinationLocationId')
      };
    case 'exit':
      rejectFields('destinationLocationId', 'locationId');
      if ('direction' in input) {
        throw new InventoryError('direction is only valid for adjustments.', 400, 'INVALID_INPUT');
      }
      return {
        ...common,
        type: 'exit',
        sourceLocationId: requiredUuid(input.sourceLocationId, 'sourceLocationId'),
        destinationLocationId: null
      };
    case 'adjustment':
      rejectFields('sourceLocationId', 'destinationLocationId');
      if ('direction' in input && input.direction !== 'increase' && input.direction !== 'decrease') {
        throw new InventoryError('direction must be increase or decrease.', 400, 'INVALID_INPUT');
      }
      if (input.direction !== 'increase' && input.direction !== 'decrease') {
        throw new InventoryError('Use locationId and direction for adjustments.', 400, 'INVALID_INPUT');
      }
      return {
        ...common,
        type: 'adjustment',
        sourceLocationId: input.direction === 'decrease' ? requiredUuid(input.locationId, 'locationId') : null,
        destinationLocationId: input.direction === 'increase' ? requiredUuid(input.locationId, 'locationId') : null
      };
    case 'transfer': {
      if ('locationId' in input || 'direction' in input) {
        throw new InventoryError('Transfers require source and destination locations.', 400, 'INVALID_INPUT');
      }
      const sourceLocationId = requiredUuid(input.sourceLocationId, 'sourceLocationId');
      const destinationLocationId = requiredUuid(input.destinationLocationId, 'destinationLocationId');
      if (sourceLocationId === destinationLocationId) {
        throw new InventoryError('Transfer source and destination must be different.', 400, 'INVALID_INPUT');
      }
      return { ...common, type: 'transfer', sourceLocationId, destinationLocationId };
    }
    default:
      throw new InventoryError('type must be entry, exit, adjustment, transfer, or return.', 400, 'INVALID_MOVEMENT_TYPE');
  }
}

async function ensureBalance(
  input: NormalizedMovement,
  locationId: string,
  transaction: Transaction
): Promise<void> {
  await sequelize.query(
    `INSERT INTO inventory_balances (store_id, product_variant_id, location_id, quantity)
     VALUES (:storeId, :productVariantId, :locationId, 0)
     ON CONFLICT (store_id, product_variant_id, location_id) DO NOTHING`,
    {
      replacements: { storeId: input.storeId, productVariantId: input.productVariantId, locationId },
      transaction
    }
  );
}

async function getLockedBalance(
  input: NormalizedMovement,
  locationId: string,
  transaction: Transaction
): Promise<InventoryBalance> {
  const balance = await InventoryBalance.findOne({
    where: {
      storeId: input.storeId,
      productVariantId: input.productVariantId,
      locationId
    },
    transaction,
    lock: transaction.LOCK.UPDATE
  });

  if (!balance) {
    throw new Error('Inventory balance could not be loaded after it was initialized.');
  }

  return balance;
}

async function createValidatedInventoryMovement(
  movement: NormalizedMovement,
  transaction: Transaction
): Promise<InventoryMovement> {
  const variant = await ProductVariant.findOne({
    where: { id: movement.productVariantId, storeId: movement.storeId, isActive: true },
    transaction
  });

  if (!variant) {
    throw new InventoryError('Active product variant was not found in this store.', 404, 'VARIANT_NOT_FOUND');
  }

  const locationIds = [
    movement.sourceLocationId,
    movement.destinationLocationId
  ].filter((locationId): locationId is string => locationId !== null);
  const locations = await Location.findAll({
    where: {
      id: { [Op.in]: locationIds },
      storeId: movement.storeId,
      isActive: true
    },
    transaction
  });

  if (locations.length !== new Set(locationIds).size) {
    throw new InventoryError('Active location was not found in this store.', 404, 'LOCATION_NOT_FOUND');
  }

  const orderedLocationIds = [...new Set(locationIds)].sort();
  for (const locationId of orderedLocationIds) {
    await ensureBalance(movement, locationId, transaction);
  }

  const balances = new Map<string, InventoryBalance>();
  for (const locationId of orderedLocationIds) {
    balances.set(locationId, await getLockedBalance(movement, locationId, transaction));
  }

  const sourceBalance = movement.sourceLocationId
    ? balances.get(movement.sourceLocationId)
    : undefined;
  const destinationBalance = movement.destinationLocationId
    ? balances.get(movement.destinationLocationId)
    : undefined;

  if (sourceBalance && sourceBalance.quantity < movement.quantity) {
    throw new InventoryError('Insufficient stock at the source location.', 409, 'INSUFFICIENT_STOCK');
  }

  if (sourceBalance) {
    await sourceBalance.update(
      { quantity: sourceBalance.quantity - movement.quantity },
      { transaction }
    );
  }

  if (destinationBalance) {
    await destinationBalance.update(
      { quantity: destinationBalance.quantity + movement.quantity },
      { transaction }
    );
  }

  return InventoryMovement.create(movement, { transaction });
}

export async function createInventoryMovementInTransaction(
  input: unknown,
  transaction: Transaction
): Promise<InventoryMovement> {
  return createValidatedInventoryMovement(validateInput(input), transaction);
}

export async function createInventoryMovement(input: unknown): Promise<InventoryMovement> {
  const movement = validateInput(input);
  return sequelize.transaction((transaction) =>
    createValidatedInventoryMovement(movement, transaction)
  );
}

export async function listInventoryBalances(
  storeId: string,
  filters: { productVariantId?: string; locationId?: string } = {}
): Promise<InventoryBalance[]> {
  const validatedStoreId = requiredUuid(storeId, 'storeId');
  const where: {
    storeId: string;
    productVariantId?: string;
    locationId?: string;
  } = { storeId: validatedStoreId };

  if (filters.productVariantId !== undefined) {
    where.productVariantId = requiredUuid(filters.productVariantId, 'productVariantId');
  }
  if (filters.locationId !== undefined) {
    where.locationId = requiredUuid(filters.locationId, 'locationId');
  }

  return InventoryBalance.findAll({
    where,
    include: [
      { model: ProductVariant, as: 'variant', attributes: ['id', 'sku', 'size', 'color'] },
      { model: Location, as: 'location', attributes: ['id', 'name', 'type'] }
    ],
    order: [['locationId', 'ASC'], ['productVariantId', 'ASC']]
  });
}

export async function listProductCatalog(storeId: string): Promise<{
  id: string;
  name: string;
  tiendanubeProductId: string | null;
  imageUrl: string | null;
  variants: {
    id: string;
    sku: string | null;
    size: string | null;
    color: string | null;
    quantity: number;
  }[];
}[]> {
  const products = await Product.findAll({
    where: { storeId: requiredUuid(storeId, 'storeId'), isActive: true },
    attributes: ['id', 'name', 'tiendanubeProductId', 'imageUrl'],
    include: [{
      model: ProductVariant,
      as: 'variants',
      where: { isActive: true },
      required: false,
      attributes: ['id', 'sku', 'size', 'color'],
      include: [{
        model: InventoryBalance,
        as: 'balances',
        attributes: ['quantity']
      }]
    }],
    order: [['name', 'ASC'], [{ model: ProductVariant, as: 'variants' }, 'sku', 'ASC']]
  });

  return products.map((product) => ({
    id: product.id,
    name: product.name,
    tiendanubeProductId: product.tiendanubeProductId,
    imageUrl: product.imageUrl,
    variants: (product.variants ?? []).map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      size: variant.size,
      color: variant.color,
      quantity: (variant.balances ?? []).reduce((total, balance) => total + balance.quantity, 0)
    }))
  }));
}

export async function listInventoryLocations(storeId: string): Promise<{
  id: string;
  name: string;
  type: Location['type'];
}[]> {
  const locations = await Location.findAll({
    where: { storeId: requiredUuid(storeId, 'storeId'), isActive: true },
    attributes: ['id', 'name', 'type'],
    order: [['createdAt', 'ASC']]
  });

  return locations.map(({ id, name, type }) => ({ id, name, type }));
}

export async function listRecentInventoryMovements(storeId: string): Promise<{
  id: string;
  type: MovementType;
  quantity: number;
  createdAt: Date;
  reference: string | null;
  notes: string | null;
  productName: string;
  sku: string | null;
  sourceLocationName: string | null;
  destinationLocationName: string | null;
}[]> {
  const movements = await InventoryMovement.findAll({
    where: { storeId: requiredUuid(storeId, 'storeId') },
    limit: 25,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    include: [
      {
        model: ProductVariant,
        as: 'variant',
        attributes: ['sku'],
        include: [{ model: Product, as: 'product', attributes: ['name'] }]
      },
      { model: Location, as: 'sourceLocation', attributes: ['name'], required: false },
      { model: Location, as: 'destinationLocation', attributes: ['name'], required: false }
    ]
  });

  return movements.map((movement) => ({
    id: movement.id,
    type: movement.type,
    quantity: movement.quantity,
    createdAt: movement.createdAt,
    reference: movement.reference,
    notes: movement.notes,
    productName: movement.variant?.product?.name ?? 'Producto',
    sku: movement.variant?.sku ?? null,
    sourceLocationName: movement.sourceLocation?.name ?? null,
    destinationLocationName: movement.destinationLocation?.name ?? null
  }));
}
