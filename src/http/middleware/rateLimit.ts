import type { Request, RequestHandler } from 'express';
import type Redis from 'ioredis';
import { serializeError, type Logger } from '../../shared/logger';
import { TooManyRequestsError } from '../../shared/errors';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  logger: Logger;
  prefix?: string;
  /** Bucket identity. Returning undefined skips limiting for the request. Defaults to the IP. */
  key?: (req: Request) => string | undefined;
  now?: () => number;
}

/**
 * Approximate sliding window: estimated count = current + floor(previous * (1 - elapsed/window)).
 * Increment and read of both windows is one atomic EVAL (a single round trip); the current
 * window key expires after 2 windows so it can still serve as "previous" in the next one.
 * KEYS[1] = current window, KEYS[2] = previous window, ARGV[1] = previous weight, ARGV[2] = TTL ms.
 */
export const SLIDING_WINDOW_SCRIPT = `
local cur = redis.call('INCR', KEYS[1])
if cur == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
return cur + math.floor(prev * tonumber(ARGV[1]))
`;

/** Pure window math (what the Lua script computes); exported for tests. */
export function slidingWindowCount(
  current: number,
  previous: number,
  elapsedRatio: number,
): number {
  return current + Math.floor(previous * (1 - elapsedRatio));
}

/**
 * Sliding-window limiter shared by every API instance through Redis. It fails open: if Redis
 * is unavailable the request is served and a warning logged, because rejecting all traffic
 * would turn a cache outage into a full API outage.
 */
export function createRateLimiter(redis: Redis, options: RateLimitOptions): RequestHandler {
  const prefix = options.prefix ?? 'ratelimit';
  const now = options.now ?? Date.now;
  const keyOf = options.key ?? ((req: Request) => req.ip ?? 'unknown');

  return async (req, res, next) => {
    const id = keyOf(req);
    if (id === undefined) {
      next();
      return;
    }
    const t = now();
    const window = Math.floor(t / options.windowMs);
    const elapsed = (t - window * options.windowMs) / options.windowMs;
    const resetSeconds = Math.max(1, Math.ceil(((window + 1) * options.windowMs - t) / 1000));
    const base = `${prefix}:${id}`;

    let count: number;
    try {
      const result = await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        2,
        `${base}:${window}`,
        `${base}:${window - 1}`,
        String(1 - elapsed),
        String(options.windowMs * 2),
      );
      count = Number(result);
      if (!Number.isFinite(count)) throw new Error('unexpected rate limiter reply');
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
