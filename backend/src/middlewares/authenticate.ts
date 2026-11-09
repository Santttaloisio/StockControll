import type { NextFunction, Request, Response } from 'express';
import { User } from '../database/models/index.js';
import { AuthenticationError, verifyAccessToken } from '../modules/auth/auth.service.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authorization = request.get('authorization');
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);

    if (!match) {
      throw new AuthenticationError('A bearer access token is required.', 401, 'UNAUTHENTICATED');
    }

    const userId = await verifyAccessToken(match[1]);
    if (!uuidPattern.test(userId)) {
      throw new AuthenticationError('Invalid access token.', 401, 'INVALID_TOKEN');
    }

    const user = await User.findOne({ where: { id: userId, isActive: true }, attributes: ['id'] });
    if (!user) {
      throw new AuthenticationError('Invalid or inactive account.', 401, 'INVALID_TOKEN');
    }

    request.auth = { userId };
    next();
  } catch (error) {
    next(error);
  }
}
