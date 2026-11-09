import type { StoreMembership } from '../database/models/index.js';

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string };
      storeAccess?: { storeId: string; role: StoreMembership['role'] };
    }
  }
}

export {};
