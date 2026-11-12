import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

export interface Lock {
  /** Extends the TTL. Resolves false when the lock is no longer ours (expired or stolen). */
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface LockManager {
  acquire(key: string, ttlMs: number): Promise<Lock | null>;
}

// Compare-and-delete / compare-and-extend so we never touch a lock owned by someone else.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export function createRedisLockManager(redis: Redis): LockManager {
  return {
    async acquire(key, ttlMs) {
      const token = randomUUID();
      const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
      if (result !== 'OK') return null;

      return {
        async renew() {
          const res = await redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
          return res === 1;
        },
        async release() {
          await redis.eval(RELEASE_SCRIPT, 1, key, token);
        },
      };
    },
  };
}
