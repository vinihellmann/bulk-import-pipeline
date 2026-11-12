import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { ObjectStorage } from '../modules/imports/types';

export interface S3Settings {
  bucket: string;
  region: string;
  endpoint?: string;
  publicEndpoint?: string;
  forcePathStyle: boolean;
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
    async presignPut(key, expiresInSeconds) {
      return getSignedUrl(signer, new PutObjectCommand({ Bucket: settings.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },

    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }));
        return true;
      } catch (err) {
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
          return false;
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
