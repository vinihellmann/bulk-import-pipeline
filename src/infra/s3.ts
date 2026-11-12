import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { ObjectStorage } from '../modules/imports/domain/ports';

export interface S3Settings {
  bucket: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  forcePathStyle: boolean;
  /** Server-side encryption applied to uploads (signed into the presigned URL). */
  sse?: { mode: 'AES256' | 'aws:kms'; kmsKeyId?: string };
}

export type DestroyableObjectStorage = ObjectStorage & {
  /** Readiness probe: resolves when the bucket is reachable with the configured credentials. */
  checkBucket(): Promise<void>;
  destroy(): void;
};

/**
 * Two clients on purpose: `client` talks to the internal endpoint (e.g. http://minio:9000),
 * `signer` is only used for presigning and targets the endpoint browsers/hosts can reach
 * (e.g. http://localhost:9000). With real AWS both endpoints are unset and the default
 * regional endpoint is used.
 */
export function createObjectStorage(settings: S3Settings): DestroyableObjectStorage {
  const base = {
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    // Avoid CRC32 checksum params being baked into presigned URLs (breaks plain `curl -T`).
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    responseChecksumValidation: 'WHEN_REQUIRED' as const,
  };
  const signingEndpoint = settings.publicEndpoint ?? settings.endpoint;

  const client = new S3Client({
    ...base,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
  });
  const signer = new S3Client({
    ...base,
    ...(signingEndpoint ? { endpoint: signingEndpoint } : {}),
  });

  return {
    async presignPut(key, { expiresInSeconds, contentType, contentLength }) {
      const headers: Record<string, string> = { 'Content-Type': contentType };
      const sse = settings.sse;
      if (sse) {
        headers['x-amz-server-side-encryption'] = sse.mode;
        if (sse.mode === 'aws:kms' && sse.kmsKeyId) {
          headers['x-amz-server-side-encryption-aws-kms-key-id'] = sse.kmsKeyId;
        }
      }
      const url = await getSignedUrl(
        signer,
        new PutObjectCommand({
          Bucket: settings.bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
          ...(sse
            ? {
                ServerSideEncryption: sse.mode,
                ...(sse.mode === 'aws:kms' && sse.kmsKeyId ? { SSEKMSKeyId: sse.kmsKeyId } : {}),
              }
            : {}),
        }),
        {
          expiresIn: expiresInSeconds,
          // The presigner treats content-type as unsignable by default; sign it explicitly so
          // the store rejects an upload with a different type (content-length is signed already).
          signableHeaders: new Set(['content-type']),
          // Keep the SSE headers as signed headers (the uploader must send them) instead of
          // hoisting them into the query string, where a client could omit or change them.
          unhoistableHeaders: new Set(
            Object.keys(headers).filter((h) => h.startsWith('x-amz-server-side-encryption')),
          ),
        },
      );
      return { method: 'PUT' as const, url, headers };
    },

    async stat(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }));
        return { size: out.ContentLength ?? 0, contentType: out.ContentType };
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e.name === 'NotFound' ||
          e.name === 'NoSuchKey' ||
          e.$metadata?.httpStatusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    },

    async getStream(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: settings.bucket, Key: key }));
      if (!out.Body) throw new Error(`Empty body for object ${key}`);
      return out.Body as Readable;
    },

    async checkBucket() {
      await client.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    },

    destroy() {
      client.destroy();
      signer.destroy();
    },
  };
}
