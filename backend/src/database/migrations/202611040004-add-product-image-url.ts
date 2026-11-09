import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  await sequelize.query('ALTER TABLE products ADD COLUMN image_url TEXT');
};

export const down: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  await sequelize.query('ALTER TABLE products DROP COLUMN image_url');
};
