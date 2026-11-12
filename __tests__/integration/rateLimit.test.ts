import express from 'express';
import Redis from 'ioredis';
import request from 'supertest';
import { errorHandler } from '../../src/http/middleware/errorHandler';
import { createRateLimiter } from '../../src/http/middleware/rateLimit';
import { requestContext } from '../../src/http/middleware/requestContext';
import { createLogger } from '../../src/infra/logger';

const logger = createLogger('error', 'integration', true);
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

afterAll(async () => {
  await redis.quit();
});

function appWithLimit(
  limit: number,
  prefix: string,
  key?: (req: express.Request) => string | undefined,
  now?: () => number,
) {
  const app = express();
  app.use(requestContext(logger));
  app.use(createRateLimiter(redis, { windowMs: 60_000, limit, logger, prefix, key, now }));
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler(logger));
  return app;
}

describe('Redis rate limiter', () => {
  it('allows requests up to the limit, then answers 429 with Retry-After', async () => {
    const app = appWithLimit(2, `rl-test-${Date.now()}`);

    const first = await request(app).get('/');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');

    expect((await request(app).get('/')).status).toBe(200);

    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.body.type).toContain('too-many-requests');
  });

  it('shares counters across instances through Redis', async () => {
    const prefix = `rl-shared-${Date.now()}`;
    const a = appWithLimit(1, prefix);
    const b = appWithLimit(1, prefix);

    expect((await request(a).get('/')).status).toBe(200);
    expect((await request(b).get('/')).status).toBe(429);
  });

  it('keeps separate buckets per key and skips limiting when the key is undefined', async () => {
    const app = appWithLimit(1, `rl-key-${Date.now()}`, (req) => {
      const id = req.get('x-client');
      return id === 'anon' ? undefined : id;
    });

    expect((await request(app).get('/').set('x-client', 'a')).status).toBe(200);
    expect((await request(app).get('/').set('x-client', 'a')).status).toBe(429);
    expect((await request(app).get('/').set('x-client', 'b')).status).toBe(200);
    expect((await request(app).get('/').set('x-client', 'anon')).status).toBe(200);
    expect((await request(app).get('/').set('x-client', 'anon')).status).toBe(200);
  });

  it('weights the previous window, so a burst across a boundary is still limited', async () => {
    const windowMs = 60_000;
    const start = Math.floor(Date.now() / windowMs) * windowMs + windowMs; // a window start
    let clock = start - 1_000; // 1s before the boundary
    const prefix = `rl-slide-${Date.now()}`;
    const app = appWithLimit(4, prefix, undefined, () => clock);

    for (let i = 0; i < 4; i++) expect((await request(app).get('/')).status).toBe(200);

    // 6s into the next window the previous 4 still weigh 90% (floor(4 * 0.9) = 3):
    // the 1st request estimates 1 + 3 = 4 (allowed), the 2nd 2 + 3 = 5 (rejected).
    clock = start + 6_000;
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(429);

    // At 50s the previous window has decayed to floor(4 * (1 - 50/60)) = 0: 3 + 0 <= 4.
    clock = start + 50_000;
    expect((await request(app).get('/')).status).toBe(200);
  });
});
