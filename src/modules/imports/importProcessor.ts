import type { Readable } from 'node:stream';
import type { Logger } from '../../infra/logger';
import { serializeError } from '../../infra/logger';
import type { LockManager } from '../../infra/lock';
import { BatchWriter } from './batchWriter';
import { InvalidFileError, LockLostError, ShutdownError } from './errors';
import { parseRows } from './parsers';
import { createProgressThrottle } from './progressThrottle';
import { validateRow } from './rowValidator';
import {
  TERMINAL_STATUSES,
  type Counters,
  type ImportRepository,
  type NewImportError,
  type ObjectStorage,
  type ProductRepository,
  type ProductRow,
  type ProgressPayload,
  type ProgressPublisher,
} from './types';

export interface ProcessorOptions {
  batchSize: number;
  maxStoredErrors: number;
  progressEveryRows: number;
  progressEveryMs: number;
  lockTtlMs: number;
  lockRenewMs: number;
}

export interface ProcessorDeps {
  imports: ImportRepository;
  products: ProductRepository;
  storage: ObjectStorage;
  publisher: ProgressPublisher;
  locks: LockManager;
  logger: Logger;
  options: ProcessorOptions;
}

export interface ProcessContext {
  correlationId?: string;
  /** Aborted by the worker on shutdown timeout. */
  signal?: AbortSignal;
}

/**
 * - completed: the file was processed (COMPLETED or COMPLETED_WITH_ERRORS)
 * - skipped:   nothing to do (already finished, unknown id, or another worker holds the lock)
 * - failed:    unrecoverable input problem; import marked FAILED, message should be acked
 * Unexpected errors are thrown so the queue redelivers the message.
 */
export type ProcessOutcome = 'completed' | 'skipped' | 'failed';

export const lockKey = (importId: string): string => `import:lock:${importId}`;

export function createImportProcessor(deps: ProcessorDeps) {
  const { imports, products, storage, publisher, locks, options } = deps;

  const safePublish = async (
    kind: 'progress' | 'finished',
    payload: ProgressPayload,
  ): Promise<void> => {
    try {
      await publisher[kind](payload);
    } catch (err) {
      // Realtime is best effort: a Redis hiccup must never fail the import itself.
      deps.logger.warn('failed to publish realtime event', {
        kind,
        importId: payload.importId,
        ...serializeError(err),
      });
    }
  };

  async function fail(importId: string, message: string): Promise<void> {
    await imports.markFailed(importId, message);
    const rec = await imports.findById(importId);
    await safePublish('finished', {
      importId,
      status: 'FAILED',
      totalRows: rec?.totalRows ?? 0,
      processedRows: rec?.processedRows ?? 0,
      failedRows: rec?.failedRows ?? 0,
      errorMessage: message,
    });
  }

  async function run(importId: string, signal: AbortSignal, log: Logger): Promise<ProcessOutcome> {
    const rec = await imports.findById(importId);
    if (!rec) {
      log.warn('import not found, dropping message');
      return 'skipped';
    }
    if (TERMINAL_STATUSES.has(rec.status)) {
      log.info('import already finished, skipping', { status: rec.status });
      return 'skipped';
    }
    if (rec.status === 'AWAITING_UPLOAD') {
      log.warn('import was never started, skipping');
      return 'skipped';
    }

    await imports.markProcessing(importId);
    await safePublish('progress', {
      importId,
      status: 'PROCESSING',
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
    });

    let stream: Readable;
    try {
      stream = await storage.getStream(rec.s3Key);
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') {
        throw new InvalidFileError('Uploaded file not found in storage');
      }
      throw err;
    }

    let totalRows = 0;
    let failedRows = 0;
    let storedErrors = 0;
    let droppedErrors = 0;
    const errorBuffer: NewImportError[] = [];

    const writer = new BatchWriter<ProductRow>(
      (batch) => products.upsertBatch(importId, batch),
      options.batchSize,
    );
    const throttle = createProgressThrottle({
      everyRows: options.progressEveryRows,
      everyMs: options.progressEveryMs,
    });

    const flushErrors = async (): Promise<void> => {
      if (errorBuffer.length === 0) return;
      await imports.insertErrors(importId, errorBuffer.splice(0, errorBuffer.length));
    };
    // Rows still sitting in the writer buffer are not durable yet, so they are not "processed".
    const snapshot = (): Counters => ({
      totalRows,
      processedRows: totalRows - writer.pending,
      failedRows,
    });

    for await (const row of parseRows(rec.format, stream)) {
      signal.throwIfAborted();
      totalRows += 1;

      const result = validateRow(row.values);
      if (result.success) {
        await writer.add(result.data);
      } else {
        failedRows += 1;
        for (const issue of result.issues) {
          if (storedErrors < options.maxStoredErrors) {
            errorBuffer.push({ rowNumber: row.rowNumber, ...issue });
            storedErrors += 1;
          } else {
            droppedErrors += 1; // still counted, just not stored
          }
        }
        if (errorBuffer.length >= options.batchSize) await flushErrors();
      }

      if (throttle.shouldEmit(totalRows)) {
        const counters = snapshot();
        await imports.updateCounters(importId, counters);
        await safePublish('progress', { importId, status: 'PROCESSING', ...counters });
      }
    }

    await writer.flush();
    await flushErrors();

    const finalCounters: Counters = { totalRows, processedRows: totalRows, failedRows };
    const status = failedRows > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    await imports.finish(importId, status, finalCounters);
    await safePublish('finished', { importId, status, ...finalCounters });

    log.info('import finished', { status, ...finalCounters, storedErrors, droppedErrors });
    return 'completed';
  }

  async function process(importId: string, ctx: ProcessContext = {}): Promise<ProcessOutcome> {
    const log = deps.logger.child({ importId, correlationId: ctx.correlationId });

    const lock = await locks.acquire(lockKey(importId), options.lockTtlMs);
    if (!lock) {
      // Another worker is on it; if that worker dies its own message is redelivered.
      log.info('import is locked by another worker, skipping');
      return 'skipped';
    }

    const abort = new AbortController();
    const onExternalAbort = (): void => abort.abort(ctx.signal?.reason ?? new ShutdownError());
    ctx.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (ctx.signal?.aborted) onExternalAbort();

    const heartbeat = setInterval(() => {
      lock
        .renew()
        .then((ok) => {
          if (!ok) abort.abort(new LockLostError(importId));
        })
        .catch((err: unknown) => log.warn('lock renewal failed', serializeError(err)));
    }, options.lockRenewMs);

    try {
      return await run(importId, abort.signal, log);
    } catch (err) {
      if (err instanceof InvalidFileError) {
        log.warn('import failed: invalid file', { reason: err.message });
        await fail(importId, err.message);
        return 'failed';
      }
      throw err;
    } finally {
      clearInterval(heartbeat);
      ctx.signal?.removeEventListener('abort', onExternalAbort);
      await lock
        .release()
        .catch((err: unknown) => log.warn('lock release failed', serializeError(err)));
    }
  }

  return { process, fail };
}

export type ImportProcessor = ReturnType<typeof createImportProcessor>;
