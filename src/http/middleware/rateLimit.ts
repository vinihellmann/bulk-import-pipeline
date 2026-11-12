import type { RequestHandler } from 'express';
import type Redis from 'ioredis';
import { serializeError, type Logger } from '../../infra/logger';
import { TooManyRequestsError } from '../../shared/errors';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  logger: Logger;
  prefix?: string;
  now?: () => number;
}

/**
 * Fixed-window limiter shared by every API instance through Redis (INCR + PEXPIRE in one
 * MULTI). It fails open: if Redis is unavailable the request is served and a warning logged,
 * because rejecting all traffic would turn a cache outage into a full API outage.
 */
export function createRateLimiter(redis: Redis, options: RateLimitOptions): RequestHandler {
  const prefix = options.prefix ?? 'ratelimit';
  const now = options.now ?? Date.now;

  return async (req, res, next) => {
    const t = now();
    const window = Math.floor(t / options.windowMs);
    const resetSeconds = Math.max(1, Math.ceil(((window + 1) * options.windowMs - t) / 1000));
    const key = `${prefix}:${req.ip ?? 'unknown'}:${window}`;

    let count: number;
    try {
      const result = await redis.multi().incr(key).pexpire(key, options.windowMs).exec();
      count = Number(result?.[0]?.[1] ?? 0);
    } catch (err) {
      req.log.warn('rate limiter unavailable, failing open', serializeError(err));
      next();
      return;
    }

    res.setHeader('RateLimit-Limit', String(options.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.limit - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (count > options.limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      next(new TooManyRequestsError());
      return;
    }
    next();
  };
}
