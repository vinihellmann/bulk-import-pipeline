import express from 'express';
import type Redis from 'ioredis';
import request from 'supertest';
import { errorHandler } from '../../src/http/middleware/errorHandler';
import {
  createRateLimiter,
  slidingWindowCount,
  type RateLimitOptions,
} from '../../src/http/middleware/rateLimit';
import { requestContext } from '../../src/http/middleware/requestContext';
import { silentLogger } from './fakes';

/** Implements what SLIDING_WINDOW_SCRIPT does, so the handler logic can be tested without Redis. */
class FakeRedis {
  counters = new Map<string, number>();
  evalCalls = 0;
  fail = false;

  async eval(
    _script: string,
    _numKeys: number,
    current: string,
    previous: string,
    weight: string,
  ): Promise<number> {
    this.evalCalls++;
    if (this.fail) throw new Error('ECONNREFUSED');
    const cur = (this.counters.get(current) ?? 0) + 1;
    this.counters.set(current, cur);
    return cur + Math.floor((this.counters.get(previous) ?? 0) * Number(weight));
  }
}

function build(redis: FakeRedis, opts: Partial<RateLimitOptions> = {}) {
  const app = express();
  app.use(requestContext(silentLogger));
  app.use(
    createRateLimiter(redis as unknown as Redis, {
      windowMs: 60_000,
      limit: 2,
      logger: silentLogger,
      ...opts,
    }),
  );
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler(silentLogger));
  return app;
}

describe('slidingWindowCount', () => {
  it('weights the previous window by the remaining overlap', () => {
    expect(slidingWindowCount(1, 10, 0)).toBe(11);
    expect(slidingWindowCount(1, 10, 0.5)).toBe(6);
    expect(slidingWindowCount(1, 10, 1)).toBe(1);
  });
});

describe('createRateLimiter', () => {
  it('uses a single EVAL per request, sets headers and answers 429 over the limit', async () => {
    const redis = new FakeRedis();
    const app = build(redis, { now: () => 30_000 });

    const first = await request(app).get('/');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');
    expect(first.headers['ratelimit-reset']).toBe('30');
    expect((await request(app).get('/')).status).toBe(200);

    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('30');
    expect(redis.evalCalls).toBe(3);
  });

  it('counts the previous window proportionally', async () => {
    const redis = new FakeRedis();
    let now = 59_000;
    const app = build(redis, { limit: 3, now: () => now });
    for (let i = 0; i < 3; i++) await request(app).get('/');

    now = 66_000; // 10% into window 1: previous (3) weighs floor(3 * 0.9) = 2
    expect((await request(app).get('/')).status).toBe(200); // 1 + 2 = 3
    expect((await request(app).get('/')).status).toBe(429); // 2 + 2 = 4
  });

  it('isolates buckets by the injected key and skips limiting when it is undefined', async () => {
    const redis = new FakeRedis();
    const app = build(redis, {
      limit: 1,
      key: (req) => (req.get('x-client') === 'anon' ? undefined : req.get('x-client')),
    });
    expect((await request(app).get('/').set('x-client', 'a')).status).toBe(200);
    expect((await request(app).get('/').set('x-client', 'a')).status).toBe(429);
    expect((await request(app).get('/').set('x-client', 'b')).status).toBe(200);
    const before = redis.evalCalls;
    expect((await request(app).get('/').set('x-client', 'anon')).status).toBe(200);
    expect((await request(app).get('/').set('x-client', 'anon')).status).toBe(200);
    expect(redis.evalCalls).toBe(before);
  });

  it('fails open when Redis is unavailable', async () => {
    const redis = new FakeRedis();
    redis.fail = true;
    const res = await request(build(redis)).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });
});
