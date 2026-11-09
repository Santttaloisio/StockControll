import { sequelize } from '../src/database/sequelize.js';
import {
  InventoryBalance,
  InventoryMovement,
  Location,
  Product,
  ProductVariant,
  Store
} from '../src/database/models/index.js';

const transaction = await sequelize.transaction();

try {
  const store = await Store.create({ name: 'Model smoke test' }, { transaction });
  const product = await Product.create(
    { storeId: store.id, name: 'Test garment', description: null },
    { transaction }
  );
  const variant = await ProductVariant.create(
    {
      storeId: store.id,
      productId: product.id,
      sku: `SMOKE-${store.id}`,
      barcode: null,
      size: 'M',
      color: 'Black'
    },
    { transaction }
  );
  const location = await Location.create(
    { storeId: store.id, name: 'Smoke warehouse', type: 'warehouse' },
    { transaction }
  );
  const balance = await InventoryBalance.create(
    {
      storeId: store.id,
      productVariantId: variant.id,
      locationId: location.id,
      quantity: 3
    },
    { transaction }
  );
  const movement = await InventoryMovement.create(
    {
      storeId: store.id,
      productVariantId: variant.id,
      type: 'entry',
      quantity: 3,
      sourceLocationId: null,
      destinationLocationId: location.id,
      reference: null,
      notes: null
    },
    { transaction }
  );

  if (balance.quantity !== 3 || movement.type !== 'entry') {
    throw new Error('Model smoke test values did not round-trip.');
  }

  await transaction.rollback();
  console.info('All inventory models created records successfully; test data was rolled back.');
} catch (error) {
  await transaction.rollback();
  throw error;
} finally {
  await sequelize.close();
}
