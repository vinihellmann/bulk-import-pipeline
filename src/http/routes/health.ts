import { Router } from 'express';

export type ReadinessChecks = Record<string, () => Promise<unknown>>;

const CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `/health` is liveness (the process answers); `/ready` is readiness (dependencies answer).
 * Orchestrators restart on the former and only stop routing traffic on the latter.
 */
export function healthRouter(checks: ReadinessChecks): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/ready', async (_req, res) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), CHECK_TIMEOUT_MS);
          return [name, 'ok'] as const;
        } catch {
          return [name, 'unavailable'] as const;
        }
      }),
    );
    const ready = entries.every(([, state]) => state === 'ok');
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not_ready', checks: Object.fromEntries(entries) });
  });

  return router;
}
