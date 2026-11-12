import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../../shared/errors';
import { safeEqual } from '../../shared/safeEqual';

/** Machine-to-machine authentication with a static key compared in constant time. */
export function apiKeyAuth(expectedKey: string): RequestHandler {
  return (req, _res, next) => {
    const provided = req.get('x-api-key');
    if (provided !== undefined && safeEqual(provided, expectedKey)) {
      next();
      return;
    }
    next(new UnauthorizedError('Missing or invalid API key'));
  };
}
