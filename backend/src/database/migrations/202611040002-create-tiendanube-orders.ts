import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    await sequelize.query(
      `CREATE TABLE tiendanube_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
        external_order_id VARCHAR(64) NOT NULL,
        order_status VARCHAR(64) NOT NULL,
        payment_status VARCHAR(64) NOT NULL,
        created_at_provider TIMESTAMPTZ,
        paid_at_provider TIMESTAMPTZ,
        currency CHAR(3),
        total NUMERIC(12, 2),
        is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
        last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tiendanube_orders_store_id_id_unique UNIQUE (store_id, id),
        CONSTRAINT tiendanube_orders_store_external_id_unique UNIQUE (store_id, external_order_id),
        CONSTRAINT tiendanube_orders_external_id_valid CHECK (external_order_id ~ '^[0-9]+$'),
        CONSTRAINT tiendanube_orders_total_nonnegative CHECK (total IS NULL OR total >= 0),
        CONSTRAINT tiendanube_orders_currency_length CHECK (currency IS NULL OR char_length(currency) = 3)
      )`,
      { transaction }
    );
    await sequelize.query(
      `CREATE TABLE tiendanube_order_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL,
        order_id UUID NOT NULL,
        external_variant_id VARCHAR(64) NOT NULL,
        product_variant_id UUID NOT NULL,
        quantity INTEGER NOT NULL,
        stock_applied_quantity INTEGER NOT NULL DEFAULT 0,
        unit_price NUMERIC(12, 2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tiendanube_order_lines_order_fk
          FOREIGN KEY (store_id, order_id) REFERENCES tiendanube_orders(store_id, id) ON DELETE RESTRICT,
        CONSTRAINT tiendanube_order_lines_variant_fk
          FOREIGN KEY (store_id, product_variant_id) REFERENCES product_variants(store_id, id) ON DELETE RESTRICT,
        CONSTRAINT tiendanube_order_lines_store_order_variant_unique
          UNIQUE (store_id, order_id, external_variant_id),
        CONSTRAINT tiendanube_order_lines_external_variant_id_valid
          CHECK (external_variant_id ~ '^[0-9]+$'),
        CONSTRAINT tiendanube_order_lines_quantity_nonnegative CHECK (quantity >= 0),
        CONSTRAINT tiendanube_order_lines_stock_applied_nonnegative CHECK (stock_applied_quantity >= 0),
        CONSTRAINT tiendanube_order_lines_unit_price_nonnegative
          CHECK (unit_price IS NULL OR unit_price >= 0)
      )`,
      { transaction }
    );
    await sequelize.query(
      'CREATE INDEX tiendanube_orders_store_created_at_idx ON tiendanube_orders(store_id, created_at_provider DESC)',
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
    await sequelize.query('DROP TABLE tiendanube_order_lines', { transaction });
    await sequelize.query('DROP TABLE tiendanube_orders', { transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};
