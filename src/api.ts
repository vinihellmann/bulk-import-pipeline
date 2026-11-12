import http from 'node:http';
import type { Express } from 'express';
import type { AppConfig } from './config/env';
import { createApp } from './http/app';
import { createRateLimiter } from './http/middleware/rateLimit';
import type { Infrastructure } from './infra/container';
import type { Logger } from './shared/logger';
import { attachRealtime } from './infra/realtime';
import { createJobQueue } from './infra/sqs';
import { createApiKeyAuthenticator } from './shared/auth/apiKeys';
import { createImportService } from './modules/imports';

export interface ApiServerOptions {
  config: AppConfig;
  infra: Infrastructure;
  logger: Logger;
  configurePublicRoutes?: (app: Express) => void;
}

/** Wires the HTTP API and the Socket.io gateway. Used by `server.ts` and by integration tests. */
export function createApiServer({
  config,
  infra,
  logger,
  configurePublicRoutes,
}: ApiServerOptions) {
  const service = createImportService({
    repo: infra.importRepository,
    storage: infra.storage,
    queue: createJobQueue(infra.sqs, config.sqs.queueUrl),
    uploadUrlTtlSeconds: config.s3.uploadUrlTtlSeconds,
    maxUploadBytes: config.import.maxUploadBytes,
    requeueAfterMs: config.import.requeueAfterMs,
  });

  // One authenticator for REST and websockets: same keys, same tenant identity.
  const authenticator = createApiKeyAuthenticator(config.auth.apiKeys);

  const app = createApp({
    service,
    logger,
    authenticator,
    corsOrigins: config.corsOrigins,
    trustProxy: config.trustProxy,
    readinessChecks: infra.readinessChecks,
    rateLimiters: {
      perIp: createRateLimiter(infra.redis, {
        windowMs: config.rateLimit.windowMs,
        limit: config.rateLimit.ipLimit,
        prefix: 'rl:ip',
        logger,
      }),
      perClient: createRateLimiter(infra.redis, {
        windowMs: config.rateLimit.windowMs,
        limit: config.rateLimit.limit,
        prefix: 'rl:client',
        key: (req) => req.principal?.clientId,
        logger,
      }),
    },
    configurePublicRoutes,
  });

  const server = http.createServer(app);
  // The adapter needs a dedicated connection: a Redis client in subscriber mode cannot run commands.
  const subscriber = infra.redis.duplicate();
  const io = attachRealtime(server, {
    pub: infra.redis,
    sub: subscriber,
    authenticator,
    // Tenant isolation for live events: only the owner may join an import's room.
    authorizeSubscription: async (principal, importId) =>
      (await infra.importRepository.findForClient(principal.clientId, importId)) !== null,
    maxSubscriptionsPerSocket: config.realtime.maxSubscriptionsPerSocket,
    corsOrigins: config.corsOrigins,
    logger,
  });

  return {
    app,
    server,
    io,
    /** Stops accepting connections, closes websockets and the HTTP server. */
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      subscriber.disconnect();
    },
  };
}

export type ApiServer = ReturnType<typeof createApiServer>;
