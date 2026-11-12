export const IMPORT_STATUSES = [
  'AWAITING_UPLOAD',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

// Terminal statuses and allowed transitions live in ./status.

export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Content-Type signed into the upload URL: the uploader must send exactly this header. */
export const FORMAT_CONTENT_TYPES: Readonly<Record<ImportFormat, string>> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export interface ImportRecord {
  id: string;
  /** Owning tenant (see Principal). Every read and write is scoped by it. */
  clientId: string;
  idempotencyKey: string;
  fileName: string;
  format: ImportFormat;
  /** Size in bytes declared at creation and signed into the upload URL; null for legacy rows. */
  fileSize: number | null;
  s3Key: string;
  /**
   * Fencing token of the current processing run, set when a worker moves the import to
   * PROCESSING. Writes made on behalf of a run are conditional on it, so a worker that lost its
   * lock can no longer overwrite the outcome of the run that replaced it.
   */
  runId: string | null;
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
  clientId: string;
  idempotencyKey: string;
  fileName: string;
  format: ImportFormat;
  fileSize: number;
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

export interface ProgressPayload {
  importId: string;
  status: ImportStatus;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errorMessage?: string | null;
}
