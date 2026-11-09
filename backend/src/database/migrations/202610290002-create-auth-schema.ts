import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    await sequelize.query(
      `CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(254) NOT NULL,
        password_hash VARCHAR(100) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT users_email_unique UNIQUE (email),
        CONSTRAINT users_email_normalized CHECK (email = lower(trim(email)))
      )`,
      { transaction }
    );
    await sequelize.query(
      `CREATE TABLE store_memberships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        role VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT store_memberships_role_valid CHECK (role IN ('owner', 'admin', 'manager', 'staff')),
        CONSTRAINT store_memberships_store_user_unique UNIQUE (store_id, user_id)
      )`,
      { transaction }
    );
    await sequelize.query(
      'CREATE INDEX store_memberships_user_store_idx ON store_memberships(user_id, store_id)',
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
    await sequelize.query('DROP TABLE store_memberships', { transaction });
    await sequelize.query('DROP TABLE users', { transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};
