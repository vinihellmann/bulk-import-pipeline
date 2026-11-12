import type { Readable } from 'node:stream';
import type {
  Counters,
  ImportErrorRecord,
  ImportRecord,
  NewImport,
  NewImportError,
  ProductRow,
  ProgressPayload,
} from './types';

export interface ImportRepository {
  create(input: NewImport): Promise<ImportRecord>;
  /** Unscoped lookup for the (trusted) worker. API callers must use `findForClient`. */
  findById(id: string): Promise<ImportRecord | null>;
  /** Tenant-scoped lookup: another client's import is indistinguishable from a missing one. */
  findForClient(clientId: string, id: string): Promise<ImportRecord | null>;
  /** Idempotency keys are unique per client. */
  findByIdempotencyKey(clientId: string, key: string): Promise<ImportRecord | null>;
  /** Atomically moves AWAITING_UPLOAD -> QUEUED. Returns false if it was not in that state. */
  transitionToQueued(id: string): Promise<boolean>;
  /** Rolls QUEUED back to AWAITING_UPLOAD (used when enqueueing fails). */
  revertToAwaitingUpload(id: string): Promise<void>;
  /**
   * Claims a QUEUED import whose last update is older than `olderThan` by bumping its
   * updated_at. Returns true for exactly one caller, who should then enqueue the job again.
   */
  touchQueued(id: string, olderThan: Date): Promise<boolean>;
  /**
   * Starts a run: moves the import to PROCESSING under a fresh fencing token (runId), resets
   * counters and drops errors of previous runs. Returns the runId, or null when the import
   * cannot enter PROCESSING (already finished, never started, unknown).
   */
  markProcessing(id: string): Promise<string | null>;
  /** Fenced writes: throw StaleRunError unless `runId` is still the current PROCESSING run. */
  updateCounters(id: string, runId: string, counters: Counters): Promise<void>;
  finish(
    id: string,
    runId: string,
    status: 'COMPLETED' | 'COMPLETED_WITH_ERRORS',
    counters: Counters,
  ): Promise<void>;
  insertErrors(id: string, runId: string, errors: NewImportError[]): Promise<void>;
  /**
   * Marks FAILED from any status that may move to FAILED; never overwrites a final status.
   * With `runId` the write is additionally fenced to that run. Returns whether it applied.
   */
  markFailed(id: string, message: string, runId?: string): Promise<boolean>;
  /** Keyset pagination: errors with id > afterId, ascending. Callers verify ownership first. */
  listErrors(id: string, afterId: number, limit: number): Promise<ImportErrorRecord[]>;
}

export interface ProductRepository {
  /** Upserts by SKU inside a single transaction. Safe to repeat. */
  upsertBatch(importId: string, rows: ProductRow[]): Promise<void>;
}

export interface PresignPutOptions {
  expiresInSeconds: number;
  /** Signed: the upload is rejected by the store unless the client sends this Content-Type. */
  contentType: string;
  /** Signed: the upload is rejected by the store unless the body has exactly this many bytes. */
  contentLength: number;
}

export interface PresignedUpload {
  method: 'PUT';
  url: string;
  /** Headers the uploader must send verbatim (Content-Length is set by HTTP clients itself). */
  headers: Record<string, string>;
}

export interface StoredObjectInfo {
  size: number;
  contentType?: string;
}

export interface ObjectStorage {
  presignPut(key: string, options: PresignPutOptions): Promise<PresignedUpload>;
  /** Metadata of a stored object, or null when it does not exist. */
  stat(key: string): Promise<StoredObjectInfo | null>;
  getStream(key: string): Promise<Readable>;
}

export interface JobQueue {
  enqueueImport(importId: string, correlationId: string): Promise<void>;
}

export interface ProgressPublisher {
  progress(payload: ProgressPayload): Promise<void>;
  finished(payload: ProgressPayload): Promise<void>;
}

export interface Lock {
  /** Extends the TTL. Resolves false when the lock is no longer ours (expired or stolen). */
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface LockManager {
  acquire(key: string, ttlMs: number): Promise<Lock | null>;
}
