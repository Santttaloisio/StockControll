import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Op, QueryTypes } from 'sequelize';
import { StoreMembership, TiendanubeConnection } from '../../../database/models/index.js';
import { sequelize } from '../../../database/sequelize.js';

const authorizationBaseUrl = 'https://www.tiendanube.com/apps';
const tokenUrl = 'https://www.tiendanube.com/apps/authorize/token';
const oauthStateLifetimeMs = 10 * 60 * 1000;
const allowedScopes = new Set([
  'read_products',
  'write_products',
  'read_orders'
]);

export class TiendanubeIntegrationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'TiendanubeIntegrationError';
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function clientId(): string {
  const value = requiredEnv('TIENDANUBE_CLIENT_ID');
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('TIENDANUBE_CLIENT_ID must contain only digits.');
  }
  return value;
}

function encryptionKey(): Buffer {
  const value = requiredEnv('TIENDANUBE_TOKEN_ENCRYPTION_KEY');
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('TIENDANUBE_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

export function validateTiendanubeOAuthConfiguration(): void {
  clientId();
  requiredEnv('TIENDANUBE_CLIENT_SECRET');
  const redirectUri = new URL(requiredEnv('TIENDANUBE_REDIRECT_URI'));
  if (
    redirectUri.protocol !== 'https:' ||
    redirectUri.username ||
    redirectUri.password ||
    redirectUri.pathname !== '/api/integrations/tiendanube/callback' ||
    redirectUri.search ||
    redirectUri.hash ||
    ['localhost', '127.0.0.1', '::1'].includes(redirectUri.hostname)
  ) {
    throw new Error('TIENDANUBE_REDIRECT_URI must be the public HTTPS OAuth callback URL.');
  }
  encryptionKey();
}

export async function createAuthorizationUrl(storeId: string, userId: string): Promise<string> {
  validateTiendanubeOAuthConfiguration();
  const state = randomBytes(32).toString('base64url');
  const stateHash = createHash('sha256').update(state).digest('hex');
  const expiresAt = new Date(Date.now() + oauthStateLifetimeMs);

  await sequelize.transaction(async (transaction) => {
    await sequelize.query(
      'DELETE FROM tiendanube_oauth_states WHERE expires_at <= NOW()',
      { transaction }
    );
    await sequelize.query(
      `INSERT INTO tiendanube_oauth_states (state_hash, store_id, user_id, expires_at)
       VALUES (:stateHash, :storeId, :userId, :expiresAt)`,
      { replacements: { stateHash, storeId, userId, expiresAt }, transaction }
    );
  });

  const authorizationUrl = new URL(`${authorizationBaseUrl}/${clientId()}/authorize`);
  authorizationUrl.searchParams.set('state', state);
  return authorizationUrl.toString();
}

async function consumeAuthorizationState(state: string): Promise<{ storeId: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new TiendanubeIntegrationError('OAuth state is invalid or expired. Start the connection again.', 400, 'INVALID_OAUTH_STATE');
  }

  const stateHash = createHash('sha256').update(state).digest('hex');
  return sequelize.transaction(async (transaction) => {
    const rows = await sequelize.query<{ store_id: string; user_id: string; expires_at: Date }>(
      `SELECT store_id, user_id, expires_at
       FROM tiendanube_oauth_states
       WHERE state_hash = :stateHash
       FOR UPDATE`,
      { replacements: { stateHash }, transaction, type: QueryTypes.SELECT }
    );
    const record = rows[0];

    await sequelize.query(
      'DELETE FROM tiendanube_oauth_states WHERE state_hash = :stateHash',
      { replacements: { stateHash }, transaction }
    );

    if (!record || new Date(record.expires_at).getTime() <= Date.now()) {
      throw new TiendanubeIntegrationError('OAuth state is invalid or expired. Start the connection again.', 400, 'INVALID_OAUTH_STATE');
    }

    const membership = await StoreMembership.findOne({
      where: {
        storeId: record.store_id,
        userId: record.user_id,
        role: { [Op.in]: ['owner', 'admin'] }
      },
      transaction
    });

    if (!membership) {
      throw new TiendanubeIntegrationError('The initiating user no longer has permission to connect this store.', 403, 'STORE_ACCESS_REVOKED');
    }

    return { storeId: record.store_id };
  });
}

export async function cancelAuthorization(state: string): Promise<void> {
  await consumeAuthorizationState(state);
}

async function exchangeAuthorizationCode(code: string): Promise<{
  externalStoreId: string;
  accessToken: string;
  scopes: string;
}> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: requiredEnv('TIENDANUBE_CLIENT_SECRET'),
      grant_type: 'authorization_code',
      code
    })
  }).catch((error: unknown) => {
    console.error('Tiendanube OAuth token request failed:', error);
    throw new TiendanubeIntegrationError('Could not reach Tiendanube to complete authorization.', 502, 'OAUTH_PROVIDER_UNAVAILABLE');
  });

  const payload: unknown = await response.json().catch((error: unknown) => {
    console.error('Tiendanube OAuth returned an invalid response:', error);
    throw new TiendanubeIntegrationError('Tiendanube returned an invalid authorization response.', 502, 'INVALID_OAUTH_RESPONSE');
  });

  if (
    !response.ok ||
    typeof payload !== 'object' ||
    payload === null ||
    !('access_token' in payload) ||
    typeof payload.access_token !== 'string' ||
    payload.access_token.length === 0 ||
    !('user_id' in payload) ||
    (typeof payload.user_id !== 'string' && typeof payload.user_id !== 'number') ||
    !/^[0-9]+$/.test(String(payload.user_id)) ||
    !('scope' in payload) ||
    typeof payload.scope !== 'string'
  ) {
    console.error('Tiendanube rejected the OAuth code or returned an unexpected response.', {
      status: response.status
    });
    throw new TiendanubeIntegrationError('Tiendanube rejected authorization or returned incomplete data.', 502, 'OAUTH_EXCHANGE_FAILED');
  }

  return {
    externalStoreId: String(payload.user_id),
    accessToken: payload.access_token,
    scopes: payload.scope
  };
}

function encryptAccessToken(accessToken: string): {
  encryptedAccessToken: string;
  tokenIv: string;
  tokenAuthTag: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);

  return {
    encryptedAccessToken: ciphertext.toString('base64'),
    tokenIv: iv.toString('hex'),
    tokenAuthTag: cipher.getAuthTag().toString('hex')
  };
}

export async function completeAuthorization(code: string, state: string): Promise<string> {
  if (code.length === 0 || code.length > 2048) {
    throw new TiendanubeIntegrationError('Tiendanube authorization code is invalid.', 400, 'INVALID_OAUTH_CODE');
  }

  const { storeId } = await consumeAuthorizationState(state);
  const authorization = await exchangeAuthorizationCode(code);
  const unknownScopes = authorization.scopes
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope && !allowedScopes.has(scope));

  if (unknownScopes.length > 0) {
    console.warn('Tiendanube granted scopes not yet used by this integration:', unknownScopes);
  }

  const encryptedToken = encryptAccessToken(authorization.accessToken);

  await sequelize.transaction(async (transaction) => {
    const existingExternalConnection = await TiendanubeConnection.findOne({
      where: { externalStoreId: authorization.externalStoreId },
      transaction
    });

    if (existingExternalConnection && existingExternalConnection.storeId !== storeId) {
      throw new TiendanubeIntegrationError(
        'This Tiendanube store is already connected to another StockControll store.',
        409,
        'TIENDANUBE_STORE_ALREADY_CONNECTED'
      );
    }

    const existingStoreConnection = await TiendanubeConnection.findOne({
      where: { storeId },
      transaction
    });

    if (existingStoreConnection && existingStoreConnection.externalStoreId !== authorization.externalStoreId) {
      throw new TiendanubeIntegrationError(
        'Disconnect the current Tiendanube store before connecting a different one.',
        409,
        'A_DIFFERENT_TIENDANUBE_STORE_IS_CONNECTED'
      );
    }

    if (existingStoreConnection) {
      await existingStoreConnection.update(
        {
          encryptedAccessToken: encryptedToken.encryptedAccessToken,
          tokenIv: encryptedToken.tokenIv,
          tokenAuthTag: encryptedToken.tokenAuthTag,
          grantedScopes: authorization.scopes,
          isActive: true
        },
        { transaction }
      );
      return;
    }

    await TiendanubeConnection.create(
      {
        storeId,
        externalStoreId: authorization.externalStoreId,
        ...encryptedToken,
        grantedScopes: authorization.scopes
      },
      { transaction }
    );
  });

  return authorization.externalStoreId;
}

export async function getConnectionStatus(storeId: string): Promise<{
  connected: boolean;
  externalStoreId?: string;
  grantedScopes?: string[];
}> {
  const connection = await TiendanubeConnection.findOne({
    where: { storeId, isActive: true },
    attributes: ['externalStoreId', 'grantedScopes']
  });

  if (!connection) {
    return { connected: false };
  }

  return {
    connected: true,
    externalStoreId: connection.externalStoreId,
    grantedScopes: connection.grantedScopes.split(',').map((scope) => scope.trim()).filter(Boolean)
  };
}
