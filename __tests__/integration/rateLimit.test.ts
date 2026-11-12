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

function appWithLimit(limit: number, prefix: string) {
  const app = express();
  app.use(requestContext(logger));
  app.use(createRateLimiter(redis, { windowMs: 60_000, limit, logger, prefix }));
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
});
