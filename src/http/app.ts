import path from 'node:path';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from '../shared/logger';
import { importsRouter, type ImportService } from '../modules/imports';
import type { ApiKeyAuthenticator } from '../shared/auth/apiKeys';
import { apiKeyAuth } from './middleware/apiKey';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { healthRouter, type ReadinessChecks } from './routes/health';

export interface AppDeps {
  service: ImportService;
  logger: Logger;
  authenticator: ApiKeyAuthenticator;
  corsOrigins: string[];
  readinessChecks: ReadinessChecks;
  /** Express `trust proxy` setting; without it every client behind a load balancer shares its IP. */
  trustProxy?: boolean | number | string;
  /**
   * Optional: omitted in tests that do not exercise rate limiting. `perIp` runs before
   * authentication (throttles key guessing), `perClient` after it, keyed by the principal.
   */
  rateLimiters?: { perIp?: RequestHandler; perClient?: RequestHandler };
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
  if (deps.trustProxy !== undefined) app.set('trust proxy', deps.trustProxy);

  app.use(requestContext(deps.logger));
  app.get('/openapi.yaml', (_req, res) => {
    res.type('application/yaml').sendFile(OPENAPI_PATH);
  });
  deps.configurePublicRoutes?.(app);

  app.use(helmet());
  app.use(
    cors({
      origin: deps.corsOrigins.length > 0 ? deps.corsOrigins : false,
      exposedHeaders: [
        'Location',
        'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
      ],
    }),
  );
  app.use(healthRouter(deps.readinessChecks));

  const v1 = express.Router();
  if (deps.rateLimiters?.perIp) v1.use(deps.rateLimiters.perIp);
  v1.use(apiKeyAuth(deps.authenticator));
  if (deps.rateLimiters?.perClient) v1.use(deps.rateLimiters.perClient);
  v1.use(express.json({ limit: '10kb' }));
  v1.use('/imports', importsRouter(deps.service));
  app.use('/v1', v1);

  app.use(notFoundHandler());
  app.use(errorHandler(deps.logger));
  return app;
}
