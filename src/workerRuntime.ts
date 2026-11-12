import { Consumer } from 'sqs-consumer';
import type { AppConfig } from './config/env';
import type { Infrastructure } from './infra/container';
import { createRedisLockManager } from './infra/lock';
import { serializeError, type Logger } from './infra/logger';
import { createProgressPublisher } from './infra/realtime';
import { ShutdownError } from './modules/imports/errors';
import { createImportProcessor } from './modules/imports/importProcessor';
import { createJobHandler } from './modules/imports/jobHandler';

export interface WorkerOptions {
  config: AppConfig;
  infra: Infrastructure;
  logger: Logger;
}

/**
 * Builds the SQS consumer. One message at a time per worker process: an import is already a
 * long, I/O bound stream, and horizontal scaling (more worker replicas) is simpler to reason
 * about than in-process concurrency.
 */
export function createWorker({ config, infra, logger }: WorkerOptions) {
  const shutdown = new AbortController();

  const processor = createImportProcessor({
    imports: infra.importRepository,
    products: infra.productRepository,
    storage: infra.storage,
    publisher: createProgressPublisher(infra.redis),
    locks: createRedisLockManager(infra.redis),
    logger,
    options: config.import,
  });

  const handler = createJobHandler({
    processor,
    maxReceiveCount: config.sqs.maxReceiveCount,
    logger,
    shutdownSignal: shutdown.signal,
  });

  const consumer = Consumer.create({
    queueUrl: config.sqs.queueUrl,
    sqs: infra.sqs,
    batchSize: 1,
    waitTimeSeconds: config.sqs.waitTimeSeconds,
    // Heartbeat: while a message is being handled its visibility is extended periodically,
    // so a long import is never redelivered to a second worker mid-flight.
    visibilityTimeout: config.sqs.visibilityTimeoutSeconds,
    heartbeatInterval: config.sqs.heartbeatIntervalSeconds,
    // On failure, make the message visible again after a short delay instead of waiting for
    // the full visibility timeout.
    terminateVisibilityTimeout: config.sqs.retryDelaySeconds,
    messageAttributeNames: ['All'],
    messageSystemAttributeNames: ['ApproximateReceiveCount'],
    pollingCompleteWaitTimeMs: config.import.shutdownGraceMs + 15_000,
    handleMessage: async (message) => {
      await handler(message);
      return message; // returning the message acknowledges (deletes) it
    },
  });

  consumer.on('error', (err) => logger.error('sqs consumer error', serializeError(err)));
  consumer.on('processing_error', (err) =>
    logger.warn('message will be retried', serializeError(err)),
  );

  return {
    consumer,
    processor,
    start(): void {
      consumer.start();
      logger.info('worker started', { queueUrl: config.sqs.queueUrl });
    },
    /**
     * Graceful stop: stop polling and let the in-flight import finish. If it does not finish
     * within the grace period it is aborted; its message becomes visible again and another
     * worker resumes it (upserts make the replay safe).
     */
    async stop(): Promise<void> {
      if (!consumer.status.isRunning) return;
      const stopped = new Promise<void>((resolve) => consumer.once('stopped', () => resolve()));
      const timer = setTimeout(
        () => shutdown.abort(new ShutdownError()),
        config.import.shutdownGraceMs,
      );
      consumer.stop();
      try {
        await stopped;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type Worker = ReturnType<typeof createWorker>;
