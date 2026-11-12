import path from 'node:path';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from '../infra/logger';
import type { ImportService } from '../modules/imports/importService';
import { apiKeyAuth } from './middleware/apiKey';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { healthRouter, type ReadinessChecks } from './routes/health';
import { importsRouter } from './routes/imports';

export interface AppDeps {
  service: ImportService;
  logger: Logger;
  apiKey: string;
  corsOrigins: string[];
  readinessChecks: ReadinessChecks;
  /** Optional: omitted in tests that do not exercise rate limiting. */
  rateLimiter?: RequestHandler;
  /**
   * Hook for routes that need a relaxed security policy (the interactive API reference loads
   * its UI bundle from a CDN). Registered before helmet so the strict CSP does not apply.
   */
  configurePublicRoutes?: (app: Express) => void;
}

export const OPENAPI_PATH = path.resolve(__dirname, '..', '..', 'openapi.yaml');

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestContext(deps.logger));
  app.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').sendFile(OPENAPI_PATH);
  });
  deps.configurePublicRoutes?.(app);

  app.use(helmet());
  app.use(
    cors({
      origin: deps.corsOrigins.length > 0 ? deps.corsOrigins : false,
      exposedHeaders: ['Location', 'X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining'],
    }),
  );
  app.use(healthRouter(deps.readinessChecks));

  const v1 = express.Router();
  v1.use(apiKeyAuth(deps.apiKey));
  if (deps.rateLimiter) v1.use(deps.rateLimiter);
  v1.use(express.json({ limit: '10kb' }));
  v1.use('/imports', importsRouter(deps.service));
  app.use('/v1', v1);

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}
