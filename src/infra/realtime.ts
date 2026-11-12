import type http from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import { Server } from 'socket.io';
import { z } from 'zod';
import { serializeError, type Logger } from '../shared/logger';
import type { ProgressPublisher } from '../modules/imports/domain/ports';
import type { ProgressPayload } from '../modules/imports/domain/types';
import type { ApiKeyAuthenticator } from '../shared/auth/apiKeys';
import type { Principal } from '../shared/auth/principal';

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
  authenticator: ApiKeyAuthenticator;
  /** Tenant check: may this principal watch this import? Unknown and foreign imports are both false. */
  authorizeSubscription(principal: Principal, importId: string): Promise<boolean>;
  maxSubscriptionsPerSocket: number;
  corsOrigins: string[];
  logger: Logger;
}

declare module 'socket.io' {
  interface SocketData {
    principal: Principal;
  }
}

const importIdSchema = z.string().uuid();

type Ack = (result: { ok: boolean; error?: string }) => void;

/** API side: Socket.io server with the Redis adapter, so API instances scale horizontally. */
export function attachRealtime(httpServer: http.Server, options: RealtimeOptions): Server {
  const io = new Server(httpServer, {
    cors: { origin: options.corsOrigins.length > 0 ? options.corsOrigins : false },
    adapter: createAdapter(options.pub, options.sub),
    // Clients only ever send tiny subscribe/unsubscribe payloads (default is 1 MB).
    maxHttpBufferSize: 16 * 1024,
  });

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { apiKey?: unknown } | undefined;
    const header = socket.handshake.headers['x-api-key'];
    const provided = typeof auth?.apiKey === 'string' ? auth.apiKey : header;
    const principal = options.authenticator.authenticate(provided);
    if (principal) {
      socket.data.principal = principal;
      next();
    } else {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Subscriptions being authorized right now; counted so concurrent requests cannot beat the cap.
    const pending = new Set<string>();
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
      const room = importRoom(id);
      const reply = (result: { ok: boolean; error?: string }): void => {
        if (typeof ack === 'function') ack(result);
      };
      try {
        if (!socket.rooms.has(room) && !pending.has(room)) {
          const subscriptions =
            [...socket.rooms].filter((r) => r.startsWith('import:')).length + pending.size;
          if (subscriptions >= options.maxSubscriptionsPerSocket) {
            reply({ ok: false, error: 'too many subscriptions' });
            return;
          }
          pending.add(room);
          const allowed = await options
            .authorizeSubscription(socket.data.principal, id)
            .finally(() => pending.delete(room));
          if (!allowed) {
            reply({ ok: false, error: 'not found' });
            return;
          }
          await socket.join(room);
        }
      } catch (err) {
        options.logger.warn('socket subscribe failed', {
          socketId: socket.id,
          ...serializeError(err),
        });
        reply({ ok: false, error: 'unavailable' });
        return;
      }
      options.logger.debug('socket subscribed', { socketId: socket.id, importId: id });
      reply({ ok: true });
    });

    socket.on('unsubscribe', async (payload: unknown) => {
      const id = extractId(payload);
      if (id) await socket.leave(importRoom(id));
    });
  });

  return io;
}
