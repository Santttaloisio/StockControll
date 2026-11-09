import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    await sequelize.query(
      'ALTER TABLE products ADD COLUMN tiendanube_product_id VARCHAR(64)',
      { transaction }
    );
    await sequelize.query(
      `ALTER TABLE products
       ADD CONSTRAINT products_store_tiendanube_product_unique UNIQUE (store_id, tiendanube_product_id),
       ADD CONSTRAINT products_tiendanube_product_id_valid
         CHECK (tiendanube_product_id IS NULL OR tiendanube_product_id ~ '^[0-9]+$')`,
      { transaction }
    );
    await sequelize.query(
      'ALTER TABLE product_variants ALTER COLUMN sku DROP NOT NULL',
      { transaction }
    );
    await sequelize.query(
      'ALTER TABLE product_variants ADD COLUMN tiendanube_variant_id VARCHAR(64)',
      { transaction }
    );
    await sequelize.query(
      `ALTER TABLE product_variants
       ADD CONSTRAINT product_variants_store_tiendanube_variant_unique UNIQUE (store_id, tiendanube_variant_id),
       ADD CONSTRAINT product_variants_tiendanube_variant_id_valid
         CHECK (tiendanube_variant_id IS NULL OR tiendanube_variant_id ~ '^[0-9]+$')`,
      { transaction }
    );
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

export const down: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    await sequelize.query(
      `ALTER TABLE product_variants
       DROP CONSTRAINT product_variants_tiendanube_variant_id_valid,
       DROP CONSTRAINT product_variants_store_tiendanube_variant_unique,
       DROP COLUMN tiendanube_variant_id`,
      { transaction }
    );
    await sequelize.query(
      `ALTER TABLE product_variants
       ALTER COLUMN sku SET NOT NULL`,
      { transaction }
    );
    await sequelize.query(
      `ALTER TABLE products
       DROP CONSTRAINT products_tiendanube_product_id_valid,
       DROP CONSTRAINT products_store_tiendanube_product_unique,
       DROP COLUMN tiendanube_product_id`,
      { transaction }
    );
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};
