import type { ErrorRequestHandler, RequestHandler } from 'express';
import { serializeError, type Logger } from '../../shared/logger';
import { AppError, NotFoundError } from '../../shared/errors';

/** RFC 9457 problem details. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: unknown;
}

const PROBLEM_BASE = 'https://problems.bulk-import.local';

const problem = (status: number, code: string, title: string, detail?: string): Problem => ({
  type: `${PROBLEM_BASE}/${code}`,
  title,
  status,
  ...(detail !== undefined ? { detail } : {}),
});

/** body-parser attaches `type`/`status` to its errors; they are client errors, not bugs. */
function bodyParserProblem(err: unknown): Problem | null {
  const e = err as { type?: unknown; status?: unknown } | null;
  if (typeof e?.type !== 'string' || typeof e.status !== 'number') return null;
  if (e.type === 'entity.parse.failed') {
    return problem(400, 'malformed-json', 'Malformed JSON', 'The request body is not valid JSON');
  }
  if (e.type === 'entity.too.large') {
    return problem(413, 'payload-too-large', 'Payload too large');
  }
  if (e.status >= 400 && e.status < 500) {
    return problem(e.status, 'bad-request', 'Bad request');
  }
  return null;
}

/**
 * Maps any thrown value to a problem document. Unknown errors become an opaque 500 so that
 * internals (SQL, stack traces, hostnames) never leak to clients.
 */
export function toProblem(err: unknown): Problem {
  if (err instanceof AppError) {
    return {
      ...problem(err.status, err.code, err.message),
      ...(err.details !== undefined && !(Array.isArray(err.details) && err.details.length === 0)
        ? { errors: err.details }
        : {}),
    };
  }
  return (
    bodyParserProblem(err) ??
    problem(500, 'internal-error', 'Internal server error', 'An unexpected error occurred')
  );
}

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  };
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    const body = toProblem(err);
    const log = req.log ?? logger;
    if (body.status >= 500) {
      log.error('unhandled error', serializeError(err));
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res
      .status(body.status)
      .type('application/problem+json')
      .json({ ...body, instance: req.originalUrl, requestId: req.requestId });
  };
}
