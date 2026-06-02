import type { Request, Response, NextFunction } from 'express';
import { ulid } from '../utils/ulid';

/**
 * Injects a unique request ID (ULID) into every request.
 * Available as req.requestId.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestId(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = `req_${ulid()}`;
  next();
}
