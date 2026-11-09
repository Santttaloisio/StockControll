import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  await sequelize.query(
    `ALTER TABLE tiendanube_orders
     ADD COLUMN inventory_tracked BOOLEAN NOT NULL DEFAULT TRUE`
  );
};

export const down: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  await sequelize.query(
    'ALTER TABLE tiendanube_orders DROP COLUMN inventory_tracked'
  );
};
