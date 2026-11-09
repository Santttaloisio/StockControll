import type { MigrationFn } from 'umzug';
import type { Sequelize } from 'sequelize';

export const up: MigrationFn<Sequelize> = async ({ context: sequelize }) => {
  const transaction = await sequelize.transaction();

  try {
    await sequelize.query(
      `CREATE TABLE tiendanube_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
        external_store_id VARCHAR(64) NOT NULL,
        encrypted_access_token TEXT NOT NULL,
        token_iv VARCHAR(24) NOT NULL,
        token_auth_tag VARCHAR(32) NOT NULL,
        granted_scopes TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tiendanube_connections_store_unique UNIQUE (store_id),
        CONSTRAINT tiendanube_connections_external_store_unique UNIQUE (external_store_id),
        CONSTRAINT tiendanube_connections_external_store_id_valid
          CHECK (external_store_id ~ '^[0-9]+$'),
        CONSTRAINT tiendanube_connections_token_iv_valid
          CHECK (token_iv ~ '^[0-9a-f]{24}$'),
        CONSTRAINT tiendanube_connections_token_auth_tag_valid
          CHECK (token_auth_tag ~ '^[0-9a-f]{32}$')
      )`,
      { transaction }
    );
    await sequelize.query(
      `CREATE TABLE tiendanube_oauth_states (
        state_hash CHAR(64) PRIMARY KEY,
        store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      { transaction }
    );
    await sequelize.query(
      'CREATE INDEX tiendanube_oauth_states_expires_at_idx ON tiendanube_oauth_states(expires_at)',
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
    await sequelize.query('DROP TABLE tiendanube_oauth_states', { transaction });
    await sequelize.query('DROP TABLE tiendanube_connections', { transaction });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};
