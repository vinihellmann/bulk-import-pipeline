import type { AddressInfo } from 'node:net';
import { GetQueueAttributesCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { io as connectSocket, type Socket } from 'socket.io-client';
import { createApiServer, type ApiServer } from '../../src/api';
import { loadConfig, type AppConfig } from '../../src/config/env';
import { runMigrations } from '../../src/infra/db/migrator';
import { createInfrastructure, type Infrastructure } from '../../src/infra/container';
import { createLogger } from '../../src/infra/logger';
import { createWorker, type Worker } from '../../src/workerRuntime';

export interface Stack {
  config: AppConfig;
  infra: Infrastructure;
  api: ApiServer;
  worker: Worker;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Boots a real API (on an ephemeral port) and a real worker in the test process, both wired
 * to the compose services (MySQL, Redis, MinIO, ElasticMQ).
 */
export async function startStack(): Promise<Stack> {
  const config = loadConfig();
  const logger = createLogger('error', 'integration', true);
  const infra = createInfrastructure(config);

  await runMigrations(infra.sequelize);
  await resetData(infra, config);

  const api = createApiServer({ config, infra, logger });
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const { port } = api.server.address() as AddressInfo;

  const worker = createWorker({ config, infra, logger });
  worker.start();

  return {
    config,
    infra,
    api,
    worker,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await worker.stop();
      await api.close();
      await infra.close();
    },
  };
}

async function resetData(infra: Infrastructure, config: AppConfig): Promise<void> {
  // DELETE instead of TRUNCATE: no implicit commit and no FOREIGN_KEY_CHECKS juggling.
  await infra.sequelize.query('DELETE FROM import_errors');
  await infra.sequelize.query('DELETE FROM imports');
  await infra.sequelize.query('DELETE FROM products');
  await infra.sqs.send(new PurgeQueueCommand({ QueueUrl: config.sqs.queueUrl }));
}

export async function connectClient(stack: Stack): Promise<Socket> {
  const socket = connectSocket(stack.baseUrl, {
    auth: { apiKey: stack.config.apiKey },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}

export async function subscribe(socket: Socket, importId: string): Promise<void> {
  const ack = (await socket.timeout(5000).emitWithAck('subscribe', { importId })) as {
    ok: boolean;
  };
  if (!ack.ok) throw new Error('subscribe was rejected');
}

export function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 30_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, onEvent);
  });
}

/** Resolves once the queue has no visible or in-flight messages left. */
export async function waitForQueueToDrain(stack: Stack, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { Attributes } = await stack.infra.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: stack.config.sqs.queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const pending =
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    if (pending === 0) return;
    if (Date.now() > deadline) throw new Error(`queue still has ${pending} message(s)`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** PUTs a file to a presigned URL exactly like a browser or `curl -T` would. */
export async function uploadTo(url: string, body: Buffer): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
}
