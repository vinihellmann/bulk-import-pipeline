import type { Readable } from 'node:stream';

export const IMPORT_STATUSES = [
  'AWAITING_UPLOAD',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Statuses after which a job must never be processed again. */
export const TERMINAL_STATUSES: ReadonlySet<ImportStatus> = new Set<ImportStatus>([
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
]);

export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export interface ImportRecord {
  id: string;
  idempotencyKey: string;
  fileName: string;
  format: ImportFormat;
  s3Key: string;
  status: ImportStatus;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewImport {
  id: string;
  idempotencyKey: string;
  fileName: string;
  format: ImportFormat;
  s3Key: string;
}

export interface Counters {
  totalRows: number;
  processedRows: number;
  failedRows: number;
}

export interface NewImportError {
  rowNumber: number;
  field: string;
  message: string;
}

export interface ImportErrorRecord extends NewImportError {
  id: number;
}

export interface ProductRow {
  sku: string;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  category: string;
}

export interface ImportRepository {
  create(input: NewImport): Promise<ImportRecord>;
  findById(id: string): Promise<ImportRecord | null>;
  findByIdempotencyKey(key: string): Promise<ImportRecord | null>;
  /** Atomically moves AWAITING_UPLOAD -> QUEUED. Returns false if it was not in that state. */
  transitionToQueued(id: string): Promise<boolean>;
  revertToAwaitingUpload(id: string): Promise<void>;
  /** Marks PROCESSING and resets counters and previously stored errors (a run starts clean). */
  markProcessing(id: string): Promise<void>;
  updateCounters(id: string, counters: Counters): Promise<void>;
  finish(
    id: string,
    status: 'COMPLETED' | 'COMPLETED_WITH_ERRORS',
    counters: Counters,
  ): Promise<void>;
  markFailed(id: string, message: string): Promise<void>;
  insertErrors(id: string, errors: NewImportError[]): Promise<void>;
  /** Keyset pagination: errors with id > afterId, ascending. */
  listErrors(id: string, afterId: number, limit: number): Promise<ImportErrorRecord[]>;
}

export interface ProductRepository {
  /** Upserts by SKU inside a single transaction. Safe to repeat. */
  upsertBatch(importId: string, rows: ProductRow[]): Promise<void>;
}

export interface ObjectStorage {
  presignPut(key: string, expiresInSeconds: number): Promise<string>;
  exists(key: string): Promise<boolean>;
  getStream(key: string): Promise<Readable>;
}

export interface JobQueue {
  enqueueImport(importId: string, correlationId: string): Promise<void>;
}

export interface ProgressPayload {
  importId: string;
  status: ImportStatus;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errorMessage?: string | null;
}

export interface ProgressPublisher {
  progress(payload: ProgressPayload): Promise<void>;
  finished(payload: ProgressPayload): Promise<void>;
}
