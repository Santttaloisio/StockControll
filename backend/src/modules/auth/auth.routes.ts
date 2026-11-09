import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Store, StoreMembership } from '../../database/models/index.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { login } from './auth.service.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_request, response) => {
    response.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } });
  }
});

authRouter.post('/login', loginLimiter, async (request, response, next) => {
  try {
    response.status(200).json(await login(request.body));
  } catch (error) {
    next(error);
  }
});

authRouter.get('/stores', authenticate, async (request, response, next) => {
  try {
    const memberships = await StoreMembership.findAll({
      where: { userId: request.auth!.userId },
      attributes: ['storeId', 'role'],
      include: [{ model: Store, as: 'store', attributes: ['name'] }],
      order: [['createdAt', 'ASC']]
    });

    response.status(200).json({
      data: memberships.map((membership) => ({
        id: membership.storeId,
        name: membership.store?.name ?? 'Tienda',
        role: membership.role
      }))
    });
  } catch (error) {
    next(error);
  }
});
