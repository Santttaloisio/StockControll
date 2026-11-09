import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import {
  requireInventoryWriteAccess,
  requireStoreMembership
} from '../../middlewares/store-access.js';
import {
  createInventoryMovement,
  InventoryError,
  listInventoryBalances,
  listInventoryLocations,
  listRecentInventoryMovements,
  listProductCatalog
} from './inventory.service.js';

export const inventoryRouter = Router({ mergeParams: true });

inventoryRouter.use(authenticate, requireStoreMembership);

inventoryRouter.get('/balances', async (request, response, next) => {
  try {
    const productVariantId = request.query.productVariantId;
    const locationId = request.query.locationId;
    if (
      (productVariantId !== undefined && typeof productVariantId !== 'string') ||
      (locationId !== undefined && typeof locationId !== 'string')
    ) {
      throw new InventoryError('Balance filters must be single UUID values.', 400, 'INVALID_INPUT');
    }

    const balances = await listInventoryBalances(request.storeAccess!.storeId, {
      productVariantId,
      locationId
    });
    response.status(200).json({ data: balances });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.get('/products', async (request, response, next) => {
  try {
    const products = await listProductCatalog(request.storeAccess!.storeId);
    response.status(200).json({ data: products });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.get('/locations', async (request, response, next) => {
  try {
    response.status(200).json({ data: await listInventoryLocations(request.storeAccess!.storeId) });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.get('/movements', async (request, response, next) => {
  try {
    response.status(200).json({ data: await listRecentInventoryMovements(request.storeAccess!.storeId) });
  } catch (error) {
    next(error);
  }
});

inventoryRouter.post('/movements', requireInventoryWriteAccess, async (request, response, next) => {
  try {
    if (
      typeof request.body !== 'object' ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.hasOwn(request.body, 'storeId')
    ) {
      throw new InventoryError('Request body must be an object without a storeId field.', 400, 'INVALID_INPUT');
    }

    const movement = await createInventoryMovement({
      ...request.body,
      storeId: request.storeAccess!.storeId
    });
    response.status(201).json({ data: movement });
  } catch (error) {
    next(error);
  }
});
