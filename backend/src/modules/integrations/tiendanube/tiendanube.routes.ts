import { Router } from 'express';
import { authenticate } from '../../../middlewares/authenticate.js';
import {
  requireStoreAdminAccess,
  requireStoreMembership
} from '../../../middlewares/store-access.js';
import {
  cancelAuthorization,
  completeAuthorization,
  createAuthorizationUrl,
  getConnectionStatus,
  TiendanubeIntegrationError
} from './tiendanube-oauth.service.js';
import {
  importTiendanubeOrders,
  importTiendanubeProducts,
  listTiendanubeProducts
} from './tiendanube-api.client.js';

export const tiendanubeStoreRouter = Router({ mergeParams: true });

tiendanubeStoreRouter.use(authenticate, requireStoreMembership);

tiendanubeStoreRouter.get('/authorize', requireStoreAdminAccess, async (request, response, next) => {
  try {
    const storeId = request.storeAccess?.storeId;
    const userId = request.auth?.userId;
    if (!storeId || !userId) {
      throw new TiendanubeIntegrationError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }

    response.status(200).json({
      authorizationUrl: await createAuthorizationUrl(storeId, userId)
    });
  } catch (error) {
    next(error);
  }
});

tiendanubeStoreRouter.get('/status', async (request, response, next) => {
  try {
    const storeId = request.storeAccess?.storeId;
    if (!storeId) {
      throw new TiendanubeIntegrationError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }

    response.status(200).json({ data: await getConnectionStatus(storeId) });
  } catch (error) {
    next(error);
  }
});

tiendanubeStoreRouter.get('/products', async (request, response, next) => {
  try {
    const storeId = request.storeAccess?.storeId;
    const pageValue = request.query.page ?? '1';
    if (!storeId) {
      throw new TiendanubeIntegrationError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }
    if (typeof pageValue !== 'string' || !/^[1-9][0-9]*$/.test(pageValue) || Number(pageValue) > 10_000) {
      throw new TiendanubeIntegrationError('Page must be an integer between 1 and 10000.', 400, 'INVALID_INPUT');
    }

    response.status(200).json({ data: await listTiendanubeProducts(storeId, Number(pageValue)) });
  } catch (error) {
    next(error);
  }
});

tiendanubeStoreRouter.post('/products/import', requireStoreAdminAccess, async (request, response, next) => {
  try {
    const storeId = request.storeAccess?.storeId;
    const pageValue = request.query.page ?? '1';
    if (!storeId) {
      throw new TiendanubeIntegrationError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }
    if (typeof pageValue !== 'string' || !/^[1-9][0-9]*$/.test(pageValue) || Number(pageValue) > 10_000) {
      throw new TiendanubeIntegrationError('Page must be an integer between 1 and 10000.', 400, 'INVALID_INPUT');
    }

    response.status(200).json({ data: await importTiendanubeProducts(storeId, Number(pageValue)) });
  } catch (error) {
    next(error);
  }
});

tiendanubeStoreRouter.post('/orders/import', requireStoreAdminAccess, async (request, response, next) => {
  try {
    const storeId = request.storeAccess?.storeId;
    const pageValue = request.query.page ?? '1';
    if (!storeId) {
      throw new TiendanubeIntegrationError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }
    if (typeof pageValue !== 'string' || !/^[1-9][0-9]*$/.test(pageValue) || Number(pageValue) > 334) {
      throw new TiendanubeIntegrationError('Page must be an integer between 1 and 334.', 400, 'INVALID_INPUT');
    }

    response.status(200).json({ data: await importTiendanubeOrders(storeId, Number(pageValue)) });
  } catch (error) {
    next(error);
  }
});

export const tiendanubeOAuthCallbackRouter = Router();

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

tiendanubeOAuthCallbackRouter.get('/callback', async (request, response, next) => {
  try {
    const code = singleQueryValue(request.query.code);
    const state = singleQueryValue(request.query.state);
    const providerError = singleQueryValue(request.query.error);

    if (!state) {
      throw new TiendanubeIntegrationError('OAuth state is missing. Start the connection again.', 400, 'INVALID_OAUTH_STATE');
    }
    if (providerError) {
      await cancelAuthorization(state);
      throw new TiendanubeIntegrationError('Tiendanube authorization was not approved. Start the connection again.', 400, 'OAUTH_DENIED');
    }
    if (!code) {
      await cancelAuthorization(state);
      throw new TiendanubeIntegrationError('Tiendanube did not return an authorization code.', 400, 'INVALID_OAUTH_CODE');
    }

    const externalStoreId = await completeAuthorization(code, state);
    response.status(200).type('html').send(
      '<!doctype html><html lang="es"><meta charset="utf-8"><title>Tiendanube conectada</title>' +
      '<body><main><h1>Tiendanube conectada</h1><p>La autorización se completó correctamente. Ya podés cerrar esta ventana.</p></main></body></html>'
    );
    console.info('Tiendanube store connected successfully.', { externalStoreId });
  } catch (error) {
    next(error);
  }
});
