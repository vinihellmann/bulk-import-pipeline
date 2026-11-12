import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { hashApiKey, parseApiKeys, type ApiKeyEntry } from '../shared/auth/apiKeys';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().positive().default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** `clientId:<sha256hex>` entries, comma-separated. See `npm run generate:api-key`. */
  API_KEYS: z.string().optional(),
  /** Legacy single plaintext key, mapped to client `default`. Not allowed in production. */
  API_KEY: z.string().min(16, 'API_KEY must be at least 16 characters').optional(),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().default('false'),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: int(3306),
  DB_USER: z.string().default('app'),
  DB_PASSWORD: z.string().default('app'),
  DB_NAME: z.string().default('bulk_import'),
  DB_SSL: bool.default('false'),
  DB_SSL_CA: z.string().optional(),
  DB_SSL_REJECT_UNAUTHORIZED: bool.default('true'),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_TLS_CA: z.string().optional(),

  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  S3_SSE: z.enum(['AES256', 'aws:kms']).optional(),
  S3_KMS_KEY_ID: z.string().optional(),
  UPLOAD_URL_TTL_SECONDS: int(900),

  SQS_QUEUE_URL: z.string().url(),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_MAX_RECEIVE_COUNT: int(3),
  SQS_VISIBILITY_TIMEOUT_SECONDS: int(60),
  SQS_HEARTBEAT_INTERVAL_SECONDS: int(20),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_RETRY_DELAY_SECONDS: z.coerce.number().int().min(0).max(43_200).default(10),

  RATE_LIMIT_WINDOW_MS: int(60_000),
  RATE_LIMIT_MAX: int(120),
  RATE_LIMIT_IP_MAX: int(600),
  SOCKET_MAX_SUBSCRIPTIONS: int(20),

  IMPORT_BATCH_SIZE: int(500),
  IMPORT_MAX_STORED_ERRORS: int(1000),
  PROGRESS_EVERY_ROWS: int(500),
  PROGRESS_EVERY_MS: int(500),
  LOCK_TTL_MS: int(30_000),
  LOCK_RENEW_MS: int(10_000),
  SHUTDOWN_GRACE_MS: int(60_000),
  // 50 MiB. Signed into the upload URL and enforced again while streaming.
  MAX_UPLOAD_BYTES: int(52_428_800),
  IMPORT_MAX_ROWS: int(1_000_000),
  IMPORT_REQUEUE_AFTER_MS: int(300_000),
});

/** Value accepted by Express `app.set('trust proxy', ...)`. */
export type TrustProxy = boolean | number | string;

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  auth: { apiKeys: ApiKeyEntry[] };
  /**
   * The legacy plaintext `API_KEY`, kept only so the integration harness can connect.
   * Nothing in `src` authenticates with it directly: see `auth.apiKeys`.
   */
  apiKey?: string;
  corsOrigins: string[];
  trustProxy: TrustProxy;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    ssl: { enabled: boolean; ca?: string; rejectUnauthorized: boolean };
  };
  redis: { url: string; tlsCa?: string };
  region: string;
  s3: {
    bucket: string;
    endpoint?: string;
    publicEndpoint?: string;
    forcePathStyle: boolean;
    uploadUrlTtlSeconds: number;
    sse?: { mode: 'AES256' | 'aws:kms'; kmsKeyId?: string };
  };
  sqs: {
    queueUrl: string;
    endpoint?: string;
    maxReceiveCount: number;
    visibilityTimeoutSeconds: number;
    heartbeatIntervalSeconds: number;
    waitTimeSeconds: number;
    /** Visibility timeout applied to a failed message, i.e. the delay before it is retried. */
    retryDelaySeconds: number;
  };
  /** `limit` is per authenticated client, `ipLimit` per source IP (applied before auth). */
  rateLimit: { windowMs: number; limit: number; ipLimit: number };
  realtime: { maxSubscriptionsPerSocket: number };
  import: {
    batchSize: number;
    maxStoredErrors: number;
    progressEveryRows: number;
    progressEveryMs: number;
    lockTtlMs: number;
    lockRenewMs: number;
    shutdownGraceMs: number;
    maxUploadBytes: number;
    maxRows: number;
    /** A QUEUED import untouched for this long is re-enqueued by `start` (lost message). */
    requeueAfterMs: number;
  };
  /** Non-fatal configuration smells for the entrypoints to log at startup. */
  warnings: string[];
}

const PEM_MARKER = '-----BEGIN';

/** PEM content as-is, otherwise the contents of the file at that path. */
function readPemOrPath(value: string): string {
  return value.trimStart().startsWith(PEM_MARKER) ? value : readFileSync(value, 'utf8');
}

function parseTrustProxy(value: string): TrustProxy {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Parses and validates the environment. Empty strings are treated as "unset" so that
 * `S3_ENDPOINT=` in an env file behaves like a missing variable (real AWS).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const problems: string[] = [];
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    for (const i of parsed.error.issues) problems.push(`${i.path.join('.')}: ${i.message}`);
  }
  const e = parsed.success ? parsed.data : undefined;
  const isProd = (e?.NODE_ENV ?? cleaned.NODE_ENV) === 'production';

  const apiKeys: ApiKeyEntry[] = [];
  if (e?.API_KEYS) {
    try {
      apiKeys.push(...parseApiKeys(e.API_KEYS));
    } catch (err) {
      problems.push(`API_KEYS: ${(err as Error).message}`);
    }
  }
  if (e?.API_KEY) {
    if (isProd) {
      problems.push('API_KEY: plaintext API_KEY is not allowed in production, use API_KEYS hashes');
    } else {
      apiKeys.push({ clientId: 'default', hash: hashApiKey(e.API_KEY) });
    }
  }
  if (e && apiKeys.length === 0 && !problems.some((p) => p.startsWith('API_KEY'))) {
    problems.push('API_KEYS: at least one API key must be configured (API_KEYS or API_KEY)');
  }

  if (e?.S3_KMS_KEY_ID && e.S3_SSE !== 'aws:kms') {
    problems.push('S3_KMS_KEY_ID: requires S3_SSE=aws:kms');
  }

  const readCa = (name: string, value: string | undefined): string | undefined => {
    if (!value) return undefined;
    try {
      return readPemOrPath(value);
    } catch (err) {
      problems.push(`${name}: cannot read CA file (${(err as Error).message})`);
      return undefined;
    }
  };
  const dbCa = readCa('DB_SSL_CA', e?.DB_SSL_CA);
  const redisCa = readCa('REDIS_TLS_CA', e?.REDIS_TLS_CA);

  const warnings: string[] = [];
  const corsOrigins = (e?.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (isProd) {
    // Check the raw source: the schema default ('app') must not satisfy this.
    if (!cleaned.DB_PASSWORD) {
      problems.push('DB_PASSWORD: must be set explicitly in production');
    }
    if (corsOrigins.includes('*')) {
      problems.push('CORS_ORIGINS: wildcard "*" is not allowed in production');
    }
    if (e && !e.DB_SSL) warnings.push('DB_SSL is disabled: MySQL traffic is not encrypted');
    if (e && !e.REDIS_URL.startsWith('rediss://') && !redisCa) {
      warnings.push('Redis connection is not using TLS (use a rediss:// URL)');
    }
  }
  if (e?.DB_SSL && !e.DB_SSL_REJECT_UNAUTHORIZED) {
    warnings.push(
      'DB_SSL_REJECT_UNAUTHORIZED is false: the MySQL server certificate is not verified',
    );
  }

  if (!e || problems.length > 0) {
    const details = problems.map((p) => `  - ${p}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    auth: { apiKeys },
    apiKey: e.API_KEY,
    corsOrigins,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      name: e.DB_NAME,
      ssl: { enabled: e.DB_SSL, ca: dbCa, rejectUnauthorized: e.DB_SSL_REJECT_UNAUTHORIZED },
    },
    redis: { url: e.REDIS_URL, tlsCa: redisCa },
    region: e.AWS_REGION,
    s3: {
      bucket: e.S3_BUCKET,
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      uploadUrlTtlSeconds: e.UPLOAD_URL_TTL_SECONDS,
      sse: e.S3_SSE ? { mode: e.S3_SSE, kmsKeyId: e.S3_KMS_KEY_ID } : undefined,
    },
    sqs: {
      queueUrl: e.SQS_QUEUE_URL,
      endpoint: e.SQS_ENDPOINT,
      maxReceiveCount: e.SQS_MAX_RECEIVE_COUNT,
      visibilityTimeoutSeconds: e.SQS_VISIBILITY_TIMEOUT_SECONDS,
      heartbeatIntervalSeconds: e.SQS_HEARTBEAT_INTERVAL_SECONDS,
      waitTimeSeconds: e.SQS_WAIT_TIME_SECONDS,
      retryDelaySeconds: e.SQS_RETRY_DELAY_SECONDS,
    },
    rateLimit: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      limit: e.RATE_LIMIT_MAX,
      ipLimit: e.RATE_LIMIT_IP_MAX,
    },
    realtime: { maxSubscriptionsPerSocket: e.SOCKET_MAX_SUBSCRIPTIONS },
    import: {
      batchSize: e.IMPORT_BATCH_SIZE,
      maxStoredErrors: e.IMPORT_MAX_STORED_ERRORS,
      progressEveryRows: e.PROGRESS_EVERY_ROWS,
      progressEveryMs: e.PROGRESS_EVERY_MS,
      lockTtlMs: e.LOCK_TTL_MS,
      lockRenewMs: e.LOCK_RENEW_MS,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
      maxUploadBytes: e.MAX_UPLOAD_BYTES,
      maxRows: e.IMPORT_MAX_ROWS,
      requeueAfterMs: e.IMPORT_REQUEUE_AFTER_MS,
    },
    warnings,
  };
}
