import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors';
import { DuplicateIdempotencyKeyError } from '../domain/errors';
import type { ImportRepository, JobQueue, ObjectStorage, PresignedUpload } from '../domain/ports';
import { FORMAT_CONTENT_TYPES, type ImportFormat, type ImportRecord } from '../domain/types';
// Pragmatic exception to the layering rule: CSV line formatting lives in infrastructure.
import { toCsvLine } from '../infrastructure/csvExport';

export interface ImportServiceDeps {
  repo: ImportRepository;
  storage: ObjectStorage;
  queue: JobQueue;
  uploadUrlTtlSeconds: number;
  /** Largest accepted upload; enforced at creation (declared size) and at start (actual size). */
  maxUploadBytes: number;
  /** A QUEUED import untouched for this long is assumed to have lost its job message. */
  requeueAfterMs: number;
  now?: () => Date;
}

export interface CreateImportInput {
  clientId: string;
  idempotencyKey: string;
  fileName: string;
  format: ImportFormat;
  /** Declared size in bytes; signed into the upload URL. */
  fileSize: number;
}

export interface UploadInstructions extends PresignedUpload {
  expiresAt: string;
}

export interface CreateImportResult {
  import: ImportRecord;
  /** Null once the file is no longer expected (import already started). */
  upload: UploadInstructions | null;
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

export function createImportService(deps: ImportServiceDeps) {
  const { repo, storage, queue } = deps;
  const now = deps.now ?? (() => new Date());

  /** Tenant-scoped: another client's import is reported exactly like a missing one (404). */
  async function requireImport(clientId: string, id: string): Promise<ImportRecord> {
    const rec = await repo.findForClient(clientId, id);
    if (!rec) throw new NotFoundError(`Import ${id} not found`);
    return rec;
  }

  async function present(rec: ImportRecord, created: boolean): Promise<CreateImportResult> {
    // Legacy rows (created before sizes were declared) never get a URL: an upload without a
    // signed Content-Length would have no size limit. Their replays conflict on fileSize anyway.
    if (rec.status !== 'AWAITING_UPLOAD' || rec.fileSize === null) {
      return { import: rec, upload: null, created };
    }
    const upload = await storage.presignPut(rec.s3Key, {
      expiresInSeconds: deps.uploadUrlTtlSeconds,
      contentType: FORMAT_CONTENT_TYPES[rec.format],
      contentLength: rec.fileSize,
    });
    const expiresAt = new Date(now().getTime() + deps.uploadUrlTtlSeconds * 1000).toISOString();
    return { import: rec, upload: { ...upload, expiresAt }, created };
  }

  async function replay(existing: ImportRecord, input: CreateImportInput) {
    if (
      existing.fileName !== input.fileName ||
      existing.format !== input.format ||
      existing.fileSize !== input.fileSize
    ) {
      throw new ConflictError('Idempotency-Key was already used with a different request payload');
    }
    return present(existing, false);
  }

  /**
   * Re-enqueues a QUEUED import whose job message may have been lost (the process died between
   * the QUEUED transition and the enqueue). The conditional touch lets exactly one caller win.
   * A duplicate message is harmless: the processor's lock and status checks make it a no-op.
   */
  async function requeueIfStale(rec: ImportRecord, correlationId: string): Promise<void> {
    const threshold = new Date(now().getTime() - deps.requeueAfterMs);
    if (rec.updatedAt >= threshold) return;
    if (await repo.touchQueued(rec.id, threshold)) {
      await queue.enqueueImport(rec.id, correlationId);
    }
  }

  return {
    /** Idempotent per client on `idempotencyKey` (checked first, enforced by a unique constraint). */
    async create(input: CreateImportInput): Promise<CreateImportResult> {
      if (input.fileSize > deps.maxUploadBytes) {
        throw new ValidationError('Request validation failed', [
          {
            location: 'body',
            field: 'fileSize',
            message: `must be at most ${deps.maxUploadBytes} bytes`,
          },
        ]);
      }

      const existing = await repo.findByIdempotencyKey(input.clientId, input.idempotencyKey);
      if (existing) return replay(existing, input);

      const id = randomUUID();
      try {
        const rec = await repo.create({
          id,
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey,
          fileName: input.fileName,
          format: input.format,
          fileSize: input.fileSize,
          s3Key: `imports/${input.clientId}/${id}/source.${input.format}`,
        });
        return await present(rec, true);
      } catch (err) {
        if (err instanceof DuplicateIdempotencyKeyError) {
          // Lost a race with a concurrent request carrying the same key.
          const winner = await repo.findByIdempotencyKey(input.clientId, input.idempotencyKey);
          if (winner) return replay(winner, input);
        }
        throw err;
      }
    },

    /** Safe to call repeatedly: only the first call enqueues a job (plus stale-QUEUED recovery). */
    async start(clientId: string, id: string, correlationId: string): Promise<ImportRecord> {
      const rec = await requireImport(clientId, id);
      if (rec.status === 'QUEUED') {
        await requeueIfStale(rec, correlationId);
        return requireImport(clientId, id);
      }
      if (rec.status !== 'AWAITING_UPLOAD') return rec;

      const stored = await storage.stat(rec.s3Key);
      if (!stored) {
        throw new ConflictError('No uploaded file found for this import; upload it first');
      }
      if (
        stored.size > deps.maxUploadBytes ||
        (rec.fileSize !== null && stored.size !== rec.fileSize)
      ) {
        throw new ConflictError('Uploaded file does not match the declared size');
      }

      // The conditional update is the idempotency guard: exactly one caller wins the transition.
      const won = await repo.transitionToQueued(id);
      if (!won) return requireImport(clientId, id);

      try {
        await queue.enqueueImport(id, correlationId);
      } catch (err) {
        await repo.revertToAwaitingUpload(id);
        throw err;
      }
      return requireImport(clientId, id);
    },

    get: requireImport,

    async listErrors(
      clientId: string,
      id: string,
      cursor: string | undefined,
      limit: number,
    ): Promise<ErrorsPage> {
      await requireImport(clientId, id);
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
    async *streamErrorCsv(clientId: string, id: string): AsyncGenerator<string> {
      await requireImport(clientId, id); // ownership first: nothing is yielded for foreign ids
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
