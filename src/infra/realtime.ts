import type http from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { Logger } from './logger';
import type { ProgressPayload, ProgressPublisher } from '../modules/imports/types';
import { safeEqual } from '../shared/safeEqual';

export const importRoom = (importId: string): string => `import:${importId}`;

export const EVENTS = {
  progress: 'import:progress',
  finished: 'import:finished',
} as const;

/**
 * Worker side: publishes events through Redis so that whichever API instance holds the
 * client's websocket (via @socket.io/redis-adapter) delivers them. The worker itself never
 * runs a Socket.io server.
 */
export function createProgressPublisher(redis: Redis): ProgressPublisher {
  const emitter = new Emitter(redis);
  const emit = async (event: string, payload: ProgressPayload): Promise<void> => {
    emitter.to(importRoom(payload.importId)).emit(event, payload);
  };
  return {
    progress: (payload) => emit(EVENTS.progress, payload),
    finished: (payload) => emit(EVENTS.finished, payload),
  };
}

export interface RealtimeOptions {
  pub: Redis;
  sub: Redis;
  apiKey: string;
  corsOrigins: string[];
  logger: Logger;
}

const importIdSchema = z.string().uuid();

type Ack = (result: { ok: boolean; error?: string }) => void;

/** API side: Socket.io server with the Redis adapter, so API instances scale horizontally. */
export function attachRealtime(httpServer: http.Server, options: RealtimeOptions): Server {
  const io = new Server(httpServer, {
    cors: { origin: options.corsOrigins.length > 0 ? options.corsOrigins : false },
    adapter: createAdapter(options.pub, options.sub),
  });

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { apiKey?: unknown } | undefined;
    const header = socket.handshake.headers['x-api-key'];
    const provided = typeof auth?.apiKey === 'string' ? auth.apiKey : header;
    if (typeof provided === 'string' && safeEqual(provided, options.apiKey)) {
      next();
    } else {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const extractId = (payload: unknown): string | undefined => {
      const raw =
        typeof payload === 'object' && payload !== null
          ? (payload as { importId?: unknown }).importId
          : payload;
      const parsed = importIdSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    };

    socket.on('subscribe', async (payload: unknown, ack?: Ack) => {
      const id = extractId(payload);
      if (!id) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid importId' });
        return;
      }
      await socket.join(importRoom(id));
      options.logger.debug('socket subscribed', { socketId: socket.id, importId: id });
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('unsubscribe', async (payload: unknown) => {
      const id = extractId(payload);
      if (id) await socket.leave(importRoom(id));
    });
  });

  return io;
}
