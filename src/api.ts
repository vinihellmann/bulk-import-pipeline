import http from 'node:http';
import type { Express } from 'express';
import type { AppConfig } from './config/env';
import { createApp } from './http/app';
import { createRateLimiter } from './http/middleware/rateLimit';
import type { Infrastructure } from './infra/container';
import type { Logger } from './infra/logger';
import { attachRealtime } from './infra/realtime';
import { createJobQueue } from './infra/sqs';
import { createImportService } from './modules/imports/importService';

export interface ApiServerOptions {
  config: AppConfig;
  infra: Infrastructure;
  logger: Logger;
  configurePublicRoutes?: (app: Express) => void;
}

/** Wires the HTTP API and the Socket.io gateway. Used by `server.ts` and by integration tests. */
export function createApiServer({ config, infra, logger, configurePublicRoutes }: ApiServerOptions) {
  const service = createImportService({
    repo: infra.importRepository,
    storage: infra.storage,
    queue: createJobQueue(infra.sqs, config.sqs.queueUrl),
    uploadUrlTtlSeconds: config.s3.uploadUrlTtlSeconds,
  });

  const app = createApp({
    service,
    logger,
    apiKey: config.apiKey,
    corsOrigins: config.corsOrigins,
    readinessChecks: infra.readinessChecks,
    rateLimiter: createRateLimiter(infra.redis, { ...config.rateLimit, logger }),
    configurePublicRoutes,
  });

  const server = http.createServer(app);
  // The adapter needs a dedicated connection: a Redis client in subscriber mode cannot run commands.
  const subscriber = infra.redis.duplicate();
  const io = attachRealtime(server, {
    pub: infra.redis,
    sub: subscriber,
    apiKey: config.apiKey,
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
