import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { DuplicateIdempotencyKeyError } from './errors';
import { toCsvLine } from './csvExport';
import type {
  ImportFormat,
  ImportRecord,
  ImportRepository,
  JobQueue,
  ObjectStorage,
} from './types';

export interface ImportServiceDeps {
  repo: ImportRepository;
  storage: ObjectStorage;
  queue: JobQueue;
  uploadUrlTtlSeconds: number;
  now?: () => Date;
}

export interface CreateImportInput {
  idempotencyKey: string;
  fileName: string;
  format: ImportFormat;
}

export interface CreateImportResult {
  import: ImportRecord;
  /** Null once the file is no longer expected (import already started). */
  uploadUrl: string | null;
  expiresAt: string | null;
  /** False when an existing import was returned for a repeated Idempotency-Key. */
  created: boolean;
}

export interface ErrorsPage {
  data: Array<{ id: number; rowNumber: number; field: string; message: string }>;
  nextCursor: string | null;
}

const CSV_PAGE_SIZE = 1000;

export const encodeCursor = (id: number): string => Buffer.from(String(id)).toString('base64url');

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new ValidationError('Invalid cursor');
  return Number(decoded);
}

export function toImportDto(r: ImportRecord) {
  return {
    id: r.id,
    fileName: r.fileName,
    format: r.format,
    status: r.status,
    totalRows: r.totalRows,
    processedRows: r.processedRows,
    failedRows: r.failedRows,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  };
}

export function createImportService(deps: ImportServiceDeps) {
  const { repo, storage, queue } = deps;
  const now = deps.now ?? (() => new Date());

  async function requireImport(id: string): Promise<ImportRecord> {
    const rec = await repo.findById(id);
    if (!rec) throw new NotFoundError(`Import ${id} not found`);
    return rec;
  }

  async function present(rec: ImportRecord, created: boolean): Promise<CreateImportResult> {
    if (rec.status !== 'AWAITING_UPLOAD') {
      return { import: rec, uploadUrl: null, expiresAt: null, created };
    }
    const uploadUrl = await storage.presignPut(rec.s3Key, deps.uploadUrlTtlSeconds);
    const expiresAt = new Date(now().getTime() + deps.uploadUrlTtlSeconds * 1000).toISOString();
    return { import: rec, uploadUrl, expiresAt, created };
  }

  async function replay(existing: ImportRecord, input: CreateImportInput) {
    if (existing.fileName !== input.fileName || existing.format !== input.format) {
      throw new ConflictError('Idempotency-Key was already used with a different request payload');
    }
    return present(existing, false);
  }

  return {
    /** Idempotent on `idempotencyKey` (checked first, enforced by a unique constraint). */
    async create(input: CreateImportInput): Promise<CreateImportResult> {
      const existing = await repo.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return replay(existing, input);

      const id = randomUUID();
      try {
        const rec = await repo.create({
          id,
          idempotencyKey: input.idempotencyKey,
          fileName: input.fileName,
          format: input.format,
          s3Key: `imports/${id}/source.${input.format}`,
        });
        return await present(rec, true);
      } catch (err) {
        if (err instanceof DuplicateIdempotencyKeyError) {
          // Lost a race with a concurrent request carrying the same key.
          const winner = await repo.findByIdempotencyKey(input.idempotencyKey);
          if (winner) return replay(winner, input);
        }
        throw err;
      }
    },

    /** Safe to call repeatedly: only the first call enqueues a job. */
    async start(id: string, correlationId: string): Promise<ImportRecord> {
      const rec = await requireImport(id);
      if (rec.status !== 'AWAITING_UPLOAD') return rec;

      if (!(await storage.exists(rec.s3Key))) {
        throw new ConflictError('No uploaded file found for this import; upload it first');
      }

      // The conditional update is the idempotency guard: exactly one caller wins the transition.
      const won = await repo.transitionToQueued(id);
      if (!won) return requireImport(id);

      try {
        await queue.enqueueImport(id, correlationId);
      } catch (err) {
        await repo.revertToAwaitingUpload(id);
        throw err;
      }
      return requireImport(id);
    },

    get: requireImport,

    async listErrors(id: string, cursor: string | undefined, limit: number): Promise<ErrorsPage> {
      await requireImport(id);
      const after = decodeCursor(cursor);
      const rows = await repo.listErrors(id, after, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        data: page,
        nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
      };
    },

    /** Yields the CSV error report in chunks; memory use is bounded by the page size. */
    async *streamErrorCsv(id: string): AsyncGenerator<string> {
      yield toCsvLine(['row_number', 'field', 'message']);
      let after = 0;
      for (;;) {
        const page = await repo.listErrors(id, after, CSV_PAGE_SIZE);
        if (page.length === 0) return;
        yield page.map((e) => toCsvLine([e.rowNumber, e.field, e.message])).join('');
        const last = page[page.length - 1];
        if (page.length < CSV_PAGE_SIZE || !last) return;
        after = last.id;
      }
    },
  };
}

export type ImportService = ReturnType<typeof createImportService>;
