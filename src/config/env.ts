import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number) => z.coerce.number().int().positive().default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  API_KEY: z.string().min(8, 'API_KEY must be at least 8 characters'),
  CORS_ORIGINS: z.string().default(''),

  DB_HOST: z.string().default('localhost'),
  DB_PORT: int(3306),
  DB_USER: z.string().default('app'),
  DB_PASSWORD: z.string().default('app'),
  DB_NAME: z.string().default('bulk_import'),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default('true'),
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

  IMPORT_BATCH_SIZE: int(500),
  IMPORT_MAX_STORED_ERRORS: int(1000),
  PROGRESS_EVERY_ROWS: int(500),
  PROGRESS_EVERY_MS: int(500),
  LOCK_TTL_MS: int(30_000),
  LOCK_RENEW_MS: int(10_000),
  SHUTDOWN_GRACE_MS: int(60_000),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  apiKey: string;
  corsOrigins: string[];
  db: { host: string; port: number; user: string; password: string; name: string };
  redisUrl: string;
  region: string;
  s3: {
    bucket: string;
    endpoint?: string;
    publicEndpoint?: string;
    forcePathStyle: boolean;
    uploadUrlTtlSeconds: number;
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
  rateLimit: { windowMs: number; limit: number };
  import: {
    batchSize: number;
    maxStoredErrors: number;
    progressEveryRows: number;
    progressEveryMs: number;
    lockTtlMs: number;
    lockRenewMs: number;
    shutdownGraceMs: number;
  };
}

/**
 * Parses and validates the environment. Empty strings are treated as "unset" so that
 * `S3_ENDPOINT=` in an env file behaves like a missing variable (real AWS).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    apiKey: e.API_KEY,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    db: {
      host: e.DB_HOST,
      port: e.DB_PORT,
      user: e.DB_USER,
      password: e.DB_PASSWORD,
      name: e.DB_NAME,
    },
    redisUrl: e.REDIS_URL,
    region: e.AWS_REGION,
    s3: {
      bucket: e.S3_BUCKET,
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      uploadUrlTtlSeconds: e.UPLOAD_URL_TTL_SECONDS,
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
    rateLimit: { windowMs: e.RATE_LIMIT_WINDOW_MS, limit: e.RATE_LIMIT_MAX },
    import: {
      batchSize: e.IMPORT_BATCH_SIZE,
      maxStoredErrors: e.IMPORT_MAX_STORED_ERRORS,
      progressEveryRows: e.PROGRESS_EVERY_ROWS,
      progressEveryMs: e.PROGRESS_EVERY_MS,
      lockTtlMs: e.LOCK_TTL_MS,
      lockRenewMs: e.LOCK_RENEW_MS,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    },
  };
}
