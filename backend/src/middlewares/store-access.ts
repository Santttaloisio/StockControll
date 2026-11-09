import type { NextFunction, Request, Response } from 'express';
import { StoreMembership } from '../database/models/index.js';
import { AuthenticationError } from '../modules/auth/auth.service.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireStoreMembership(
  request: Request,
  _response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const storeId = request.params.storeId;
    if (typeof storeId !== 'string' || !request.auth || !uuidPattern.test(storeId)) {
      throw new AuthenticationError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }

    const membership = await StoreMembership.findOne({
      where: { storeId, userId: request.auth.userId },
      attributes: ['role']
    });

    if (!membership) {
      throw new AuthenticationError('Store access is not available.', 404, 'STORE_NOT_FOUND');
    }

    request.storeAccess = { storeId, role: membership.role };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireInventoryWriteAccess(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  const role = request.storeAccess?.role;
  if (!role || !['owner', 'admin', 'manager'].includes(role)) {
    next(new AuthenticationError('This role cannot modify inventory.', 403, 'FORBIDDEN'));
    return;
  }

  next();
}

export function requireStoreAdminAccess(
  request: Request,
  _response: Response,
  next: NextFunction
): void {
  const role = request.storeAccess?.role;
  if (!role || !['owner', 'admin'].includes(role)) {
    next(new AuthenticationError('Only a store owner or administrator can connect integrations.', 403, 'FORBIDDEN'));
    return;
  }

  next();
}
