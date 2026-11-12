import { createHash, timingSafeEqual } from 'node:crypto';
import { CLIENT_ID_PATTERN, type Principal } from './principal';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_KEY_LENGTH = 512;

/**
 * API keys are random secrets of at least 32 bytes, so their entropy is already far beyond
 * brute-force reach. A fast hash (SHA-256) is therefore the right tool: slow password hashes
 * such as bcrypt/argon2 exist to protect low-entropy human passwords and would only add
 * CPU cost (and a DoS lever) to every single request.
 */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface ApiKeyEntry {
  clientId: string;
  /** Lowercase hex SHA-256 of the raw key. */
  hash: string;
}

/**
 * Parses `clientA:<sha256hex>,clientA:<sha256hex>,clientB:<sha256hex>`. Several entries for the
 * same client allow key rotation: add the new hash, migrate callers, then drop the old one.
 */
export function parseApiKeys(spec: string): ApiKeyEntry[] {
  const entries: ApiKeyEntry[] = [];
  const seen = new Set<string>();
  for (const part of spec.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    const idx = item.indexOf(':');
    if (idx < 0) {
      throw new Error(`API_KEYS entry must have the form <clientId>:<sha256hex>, got "${item}"`);
    }
    const clientId = item.slice(0, idx).trim();
    const hash = item
      .slice(idx + 1)
      .trim()
      .toLowerCase();
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      throw new Error(
        `API_KEYS clientId "${clientId}" is invalid (lowercase letters, digits, "_" or "-", max 64 chars)`,
      );
    }
    if (!HASH_PATTERN.test(hash)) {
      throw new Error(`API_KEYS hash for client "${clientId}" must be 64 hex characters (sha256)`);
    }
    if (seen.has(hash)) {
      throw new Error(`API_KEYS contains a duplicate hash for client "${clientId}"`);
    }
    seen.add(hash);
    entries.push({ clientId, hash });
  }
  return entries;
}

export interface ApiKeyAuthenticator {
  authenticate(raw: unknown): Principal | null;
}

export function createApiKeyAuthenticator(entries: readonly ApiKeyEntry[]): ApiKeyAuthenticator {
  const prepared = entries.map((e) => ({
    clientId: e.clientId,
    keyId: e.hash.slice(0, 12),
    digest: Buffer.from(e.hash, 'hex'),
  }));

  return {
    authenticate(raw) {
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_KEY_LENGTH) {
        return null;
      }
      const candidate = createHash('sha256').update(raw, 'utf8').digest();
      let match: Principal | null = null;
      // No early exit: the time taken does not depend on which (or whether any) entry matches.
      for (const entry of prepared) {
        if (timingSafeEqual(candidate, entry.digest)) {
          match = { clientId: entry.clientId, keyId: entry.keyId };
        }
      }
      return match;
    },
  };
}
