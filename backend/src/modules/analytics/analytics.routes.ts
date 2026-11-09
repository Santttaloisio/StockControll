import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { requireStoreMembership } from '../../middlewares/store-access.js';
import { getProductSalesAnalytics, ProductAnalyticsError } from './product-analytics.service.js';

export const analyticsRouter = Router({ mergeParams: true });

analyticsRouter.use(authenticate, requireStoreMembership);

analyticsRouter.get('/products', async (request, response, next) => {
  try {
    const storeId = request.storeAccess?.storeId;
    const monthsValue = request.query.months ?? '12';
    if (!storeId) {
      throw new ProductAnalyticsError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }
    if (typeof monthsValue !== 'string' || !/^(6|12|24)$/.test(monthsValue)) {
      throw new ProductAnalyticsError('Months must be 6, 12, or 24.', 400, 'INVALID_INPUT');
    }

    response.status(200).json({
      data: await getProductSalesAnalytics(storeId, Number(monthsValue))
    });
  } catch (error) {
    next(error);
  }
});
