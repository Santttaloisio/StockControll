import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

const statements = [
  `CREATE TABLE stores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    currency CHAR(3) NOT NULL DEFAULT 'ARS',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT stores_currency_length CHECK (char_length(currency) = 3)
  )`,
  `CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT products_store_id_id_unique UNIQUE (store_id, id)
  )`,
  `CREATE TABLE product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    product_id UUID NOT NULL,
    sku VARCHAR(100) NOT NULL,
    barcode VARCHAR(100),
    size VARCHAR(50),
    color VARCHAR(80),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT product_variants_store_product_fk
      FOREIGN KEY (store_id, product_id) REFERENCES products(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT product_variants_store_id_id_unique UNIQUE (store_id, id),
    CONSTRAINT product_variants_store_sku_unique UNIQUE (store_id, sku),
    CONSTRAINT product_variants_store_barcode_unique UNIQUE (store_id, barcode)
  )`,
  `CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    type VARCHAR(20) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT locations_type_valid CHECK (type IN ('store', 'warehouse', 'other')),
    CONSTRAINT locations_store_id_id_unique UNIQUE (store_id, id),
    CONSTRAINT locations_store_name_unique UNIQUE (store_id, name)
  )`,
  `CREATE TABLE inventory_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    product_variant_id UUID NOT NULL,
    location_id UUID NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT inventory_balances_quantity_nonnegative CHECK (quantity >= 0),
    CONSTRAINT inventory_balances_store_variant_fk
      FOREIGN KEY (store_id, product_variant_id) REFERENCES product_variants(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT inventory_balances_store_location_fk
      FOREIGN KEY (store_id, location_id) REFERENCES locations(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT inventory_balances_store_variant_location_unique
      UNIQUE (store_id, product_variant_id, location_id)
  )`,
  `CREATE TABLE inventory_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL,
    product_variant_id UUID NOT NULL,
    type VARCHAR(20) NOT NULL,
    quantity INTEGER NOT NULL,
    source_location_id UUID,
    destination_location_id UUID,
    reference VARCHAR(150),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT inventory_movements_quantity_positive CHECK (quantity > 0),
    CONSTRAINT inventory_movements_type_valid CHECK (type IN ('entry', 'exit', 'adjustment', 'transfer', 'return')),
    CONSTRAINT inventory_movements_store_variant_fk
      FOREIGN KEY (store_id, product_variant_id) REFERENCES product_variants(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT inventory_movements_store_source_location_fk
      FOREIGN KEY (store_id, source_location_id) REFERENCES locations(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT inventory_movements_store_destination_location_fk
      FOREIGN KEY (store_id, destination_location_id) REFERENCES locations(store_id, id) ON DELETE RESTRICT,
    CONSTRAINT inventory_movements_locations_valid CHECK (
      (type IN ('entry', 'return') AND source_location_id IS NULL AND destination_location_id IS NOT NULL)
      OR (type = 'exit' AND source_location_id IS NOT NULL AND destination_location_id IS NULL)
      OR (type = 'adjustment' AND
        ((source_location_id IS NULL AND destination_location_id IS NOT NULL)
        OR (source_location_id IS NOT NULL AND destination_location_id IS NULL)))
      OR (type = 'transfer' AND source_location_id IS NOT NULL
        AND destination_location_id IS NOT NULL AND source_location_id <> destination_location_id)
    )
  )`,
  `CREATE INDEX inventory_movements_store_created_at_idx ON inventory_movements(store_id, created_at)`,
  `CREATE INDEX inventory_movements_variant_created_at_idx ON inventory_movements(product_variant_id, created_at)`
];

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    for (const statement of statements) {
      await sequelize.query(statement, { transaction });
    }

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

export const down: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    await sequelize.query('DROP TABLE inventory_movements', { transaction });
    await sequelize.query('DROP TABLE inventory_balances', { transaction });
    await sequelize.query('DROP TABLE locations', { transaction });
    await sequelize.query('DROP TABLE product_variants', { transaction });
    await sequelize.query('DROP TABLE products', { transaction });
    await sequelize.query('DROP TABLE stores', { transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};
