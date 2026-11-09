import { randomUUID } from 'node:crypto';
import { InventoryBalance, InventoryMovement, Location, Product, ProductVariant, Store } from '../src/database/models/index.js';
import { sequelize } from '../src/database/sequelize.js';
import {
  createInventoryMovement,
  InventoryError,
  listInventoryBalances
} from '../src/modules/inventory/inventory.service.js';

let storeId: string | undefined;
let secondStoreId: string | undefined;
let locationId: string | undefined;
let secondLocationId: string | undefined;
let foreignLocationId: string | undefined;
let variantId: string | undefined;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectInventoryError(
  action: () => Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof InventoryError && error.code === expectedCode) {
      return;
    }
    throw error;
  }

  throw new Error(`Expected inventory error ${expectedCode}.`);
}

async function readQuantity(currentStoreId: string, currentVariantId: string, currentLocationId: string): Promise<number> {
  const balance = await InventoryBalance.findOne({
    where: {
      storeId: currentStoreId,
      productVariantId: currentVariantId,
      locationId: currentLocationId
    }
  });
  return balance?.quantity ?? 0;
}

try {
  const fixture = await sequelize.transaction(async (transaction) => {
    const store = await Store.create({ name: 'Inventory service test' }, { transaction });
    const secondStore = await Store.create({ name: 'Inventory service test other store' }, { transaction });
    const product = await Product.create(
      { storeId: store.id, name: 'Inventory test product', description: null },
      { transaction }
    );
    const variant = await ProductVariant.create(
      {
        storeId: store.id,
        productId: product.id,
        sku: `INVENTORY-TEST-${randomUUID()}`,
        barcode: null,
        size: 'M',
        color: 'Black'
      },
      { transaction }
    );
    const firstLocation = await Location.create(
      { storeId: store.id, name: 'Inventory test shop', type: 'store' },
      { transaction }
    );
    const secondLocation = await Location.create(
      { storeId: store.id, name: 'Inventory test warehouse', type: 'warehouse' },
      { transaction }
    );
    const foreignLocation = await Location.create(
      { storeId: secondStore.id, name: 'Other store location', type: 'warehouse' },
      { transaction }
    );

    return {
      storeId: store.id,
      secondStoreId: secondStore.id,
      variantId: variant.id,
      locationId: firstLocation.id,
      secondLocationId: secondLocation.id,
      foreignLocationId: foreignLocation.id
    };
  });

  ({ storeId, secondStoreId, variantId, locationId, secondLocationId, foreignLocationId } = fixture);
  const base = { storeId, productVariantId: variantId };

  await expectInventoryError(
    () => createInventoryMovement({ ...base, type: 'entry', quantity: 0, destinationLocationId: locationId }),
    'INVALID_QUANTITY'
  );
  await expectInventoryError(
    () => createInventoryMovement({ ...base, type: 'entry', quantity: 1, destinationLocationId: foreignLocationId }),
    'LOCATION_NOT_FOUND'
  );

  await createInventoryMovement({ ...base, type: 'entry', quantity: 5, destinationLocationId: locationId });
  await createInventoryMovement({ ...base, type: 'exit', quantity: 2, sourceLocationId: locationId });
  assert(await readQuantity(storeId, variantId, locationId) === 3, 'Entry and exit did not update the balance.');

  await expectInventoryError(
    () => createInventoryMovement({ ...base, type: 'exit', quantity: 4, sourceLocationId: locationId }),
    'INSUFFICIENT_STOCK'
  );
  await expectInventoryError(
    () => createInventoryMovement({
      ...base,
      type: 'transfer',
      quantity: 1,
      sourceLocationId: locationId,
      destinationLocationId: locationId
    }),
    'INVALID_INPUT'
  );

  await createInventoryMovement({
    ...base,
    type: 'adjustment',
    direction: 'decrease',
    quantity: 1,
    locationId
  });
  await createInventoryMovement({
    ...base,
    type: 'adjustment',
    direction: 'increase',
    quantity: 3,
    locationId
  });
  await createInventoryMovement({
    ...base,
    type: 'transfer',
    quantity: 2,
    sourceLocationId: locationId,
    destinationLocationId: secondLocationId
  });
  await createInventoryMovement({
    ...base,
    type: 'return',
    quantity: 1,
    destinationLocationId: secondLocationId
  });

  assert(await readQuantity(storeId, variantId, locationId) === 3, 'Adjustment or transfer source balance is incorrect.');
  assert(await readQuantity(storeId, variantId, secondLocationId) === 3, 'Transfer or return destination balance is incorrect.');

  await expectInventoryError(
    () => createInventoryMovement({
      ...base,
      type: 'transfer',
      quantity: 4,
      sourceLocationId: locationId,
      destinationLocationId: secondLocationId
    }),
    'INSUFFICIENT_STOCK'
  );
  assert(await readQuantity(storeId, variantId, secondLocationId) === 3, 'Failed transfer changed the destination balance.');

  const balances = await listInventoryBalances(storeId, { productVariantId: variantId });
  assert(balances.length === 2, 'Filtered balance query returned an unexpected number of locations.');
  assert(balances.every((balance) => Boolean(balance.variant?.sku) && Boolean(balance.location?.name)), 'Balance query did not include variant and location details.');

  await createInventoryMovement({ ...base, type: 'entry', quantity: 1, destinationLocationId: locationId });
  const concurrentExits = await Promise.allSettled([
    createInventoryMovement({ ...base, type: 'exit', quantity: 3, sourceLocationId: locationId }),
    createInventoryMovement({ ...base, type: 'exit', quantity: 3, sourceLocationId: locationId })
  ]);
  const successfulExits = concurrentExits.filter((result) => result.status === 'fulfilled').length;
  const rejectedExits = concurrentExits.filter(
    (result) => result.status === 'rejected' && result.reason instanceof InventoryError &&
      result.reason.code === 'INSUFFICIENT_STOCK'
  ).length;

  assert(successfulExits === 1 && rejectedExits === 1, 'Concurrent exits did not serialize correctly.');
  assert(await readQuantity(storeId, variantId, locationId) === 1, 'Concurrent exits left an incorrect balance.');

  console.info('Inventory operations, validation, tenant isolation, rollback, balance reads, and concurrent exits passed.');
} finally {
  if (storeId && secondStoreId) {
    await sequelize.transaction(async (transaction) => {
      await InventoryMovement.destroy({ where: { storeId }, transaction });
      await InventoryBalance.destroy({ where: { storeId }, transaction });
      if (variantId) {
        await ProductVariant.destroy({ where: { id: variantId, storeId }, transaction });
      }
      await Product.destroy({ where: { storeId }, transaction });
      await Location.destroy({ where: { storeId }, transaction });
      await Location.destroy({ where: { storeId: secondStoreId }, transaction });
      await Store.destroy({ where: { id: storeId }, transaction });
      await Store.destroy({ where: { id: secondStoreId }, transaction });
    });
  }

  await sequelize.close();
}
