import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Principal } from '../../shared/auth/principal';
import type { Logger } from '../../shared/logger';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlation id: taken from `X-Request-Id` when it looks sane, generated otherwise. */
    requestId: string;
    log: Logger;
    /** Set by the API key middleware on every authenticated (`/v1`) route. */
    principal: Principal;
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns a correlation id, exposes a request-scoped child logger and writes one structured
 * access log line per request. The id travels with the SQS message to the worker.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.requestId });
    res.setHeader('X-Request-Id', req.requestId);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      req.log.info('http request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      });
    });
    next();
  };
}
