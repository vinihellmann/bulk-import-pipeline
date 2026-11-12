import { apiReference } from '@scalar/express-api-reference';
import type { RequestHandler } from 'express';
import { createApiServer } from './api';
import { loadConfig } from './config/env';
import { createInfrastructure } from './infra/container';
import { createLogger } from './infra/logger';
import { serializeError } from './shared/logger';
import { registerShutdown } from './shared/shutdown';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'api');
  for (const warning of config.warnings) logger.warn('insecure configuration', { warning });
  const infra = createInfrastructure(config);

  const api = createApiServer({
    config,
    infra,
    logger,
    configurePublicRoutes: (app) => {
      // The handler is typed with `never` route params; it does not read any.
      const docs = apiReference({
        url: '/openapi.yaml',
        pageTitle: 'Bulk Import API',
      }) as unknown as RequestHandler;
      app.use('/docs', docs);
    },
  });

  // Keep-alive sockets must not outlive the load balancer's idle timeout.
  api.server.keepAliveTimeout = 65_000;
  api.server.headersTimeout = 66_000;

  api.server.listen(config.port, () => {
    logger.info('api listening', { port: config.port, docs: `/docs` });
  });

  registerShutdown(
    logger,
    async () => {
      await api.close();
      await infra.close();
    },
    config.import.shutdownGraceMs,
  );
}

main().catch((err: unknown) => {
  createLogger('error', 'api').error('api failed to start', serializeError(err));
  process.exit(1);
});
