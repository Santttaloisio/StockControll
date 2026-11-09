import express from 'express';
import { sequelize } from './database/sequelize.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { ProductAnalyticsError } from './modules/analytics/product-analytics.service.js';
import { AuthenticationError } from './modules/auth/auth.service.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { InventoryError } from './modules/inventory/inventory.service.js';
import { tiendanubeOAuthCallbackRouter, tiendanubeStoreRouter } from './modules/integrations/tiendanube/tiendanube.routes.js';
import { TiendanubeIntegrationError } from './modules/integrations/tiendanube/tiendanube-oauth.service.js';
import { processTiendanubeOrderWebhook } from './modules/integrations/tiendanube/tiendanube-api.client.js';

export const app = express();

app.post(
  '/api/integrations/tiendanube/webhooks/orders',
  express.raw({ type: 'application/json', limit: '64kb' }),
  async (request, response, next) => {
    try {
      if (!Buffer.isBuffer(request.body)) {
        response.status(400).json({
          error: { code: 'INVALID_WEBHOOK_PAYLOAD', message: 'Webhook body must be JSON.' }
        });
        return;
      }

      await processTiendanubeOrderWebhook(
        request.body,
        request.get('x-linkedstore-hmac-sha256')
      );
      response.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  }
);

app.use(express.json({ limit: '16kb' }));

app.get('/health', async (_request, response) => {
  try {
    await sequelize.authenticate();
    response.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('Health check could not connect to PostgreSQL:', error);
    response.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/stores/:storeId/inventory', inventoryRouter);
app.use('/api/stores/:storeId/analytics', analyticsRouter);
app.use('/api/stores/:storeId/integrations/tiendanube', tiendanubeStoreRouter);
app.use('/api/integrations/tiendanube', tiendanubeOAuthCallbackRouter);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (
    error instanceof AuthenticationError ||
    error instanceof InventoryError ||
    error instanceof ProductAnalyticsError ||
    error instanceof TiendanubeIntegrationError
  ) {
    response.status(error.statusCode).json({
      error: { code: error.code, message: error.message }
    });
    return;
  }

  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {
    response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
    return;
  }

  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
    return;
  }

  console.error('Unhandled API error:', error);
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
});
