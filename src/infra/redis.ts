import Redis, { type RedisOptions } from 'ioredis';

export interface RedisSettings {
  /** PEM content of the CA that signed the server certificate (already resolved from a path). */
  tlsCa?: string;
}

export function createRedis(url: string, settings: RedisSettings = {}): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    connectTimeout: 10_000,
  };
  if (url.startsWith('rediss://') || settings.tlsCa) {
    options.tls = { minVersion: 'TLSv1.2', ...(settings.tlsCa ? { ca: settings.tlsCa } : {}) };
  }
  return new Redis(url, options);
}
