import { Readable } from 'node:stream';
import { createLogger } from '../../src/infra/logger';
import { randomUUID } from 'node:crypto';
import type {
  ImportRepository,
  JobQueue,
  Lock,
  LockManager,
  ObjectStorage,
  PresignedUpload,
  PresignPutOptions,
  ProductRepository,
  ProgressPublisher,
} from '../../src/modules/imports/domain/ports';
import { StaleRunError } from '../../src/modules/imports/domain/errors';
import { sourcesOf } from '../../src/modules/imports/domain/status';
import type {
  Counters,
  ImportErrorRecord,
  ImportRecord,
  NewImportError,
  ProductRow,
  ProgressPayload,
} from '../../src/modules/imports/domain/types';

export const silentLogger = createLogger('error', 'test', true);

/** In-memory repository with the same conditional-update and fencing semantics as MySQL. */
export class InMemoryImportRepository implements ImportRepository {
  readonly records = new Map<string, ImportRecord>();
  readonly errors: Array<ImportErrorRecord & { importId: string }> = [];
  private nextErrorId = 1;

  async create(input: Parameters<ImportRepository['create']>[0]): Promise<ImportRecord> {
    const now = new Date();
    const rec: ImportRecord = {
      ...input,
      runId: null,
      status: 'AWAITING_UPLOAD',
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.records.set(rec.id, rec);
    return { ...rec };
  }

  async findById(id: string): Promise<ImportRecord | null> {
    const rec = this.records.get(id);
    return rec ? { ...rec } : null;
  }

  async findForClient(clientId: string, id: string): Promise<ImportRecord | null> {
    const rec = this.records.get(id);
    return rec && rec.clientId === clientId ? { ...rec } : null;
  }

  async findByIdempotencyKey(clientId: string, key: string): Promise<ImportRecord | null> {
    for (const rec of this.records.values()) {
      if (rec.clientId === clientId && rec.idempotencyKey === key) return { ...rec };
    }
    return null;
  }

  async transitionToQueued(id: string): Promise<boolean> {
    return this.moveTo(id, 'QUEUED', {});
  }

  async revertToAwaitingUpload(id: string): Promise<void> {
    this.moveTo(id, 'AWAITING_UPLOAD', {});
  }

  async touchQueued(id: string, olderThan: Date): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'QUEUED' || !(rec.updatedAt < olderThan)) return false;
    rec.updatedAt = new Date();
    return true;
  }

  async markProcessing(id: string): Promise<string | null> {
    const runId = randomUUID();
    const moved = this.moveTo(id, 'PROCESSING', {
      runId,
      startedAt: new Date(),
      finishedAt: null,
      errorMessage: null,
      totalRows: 0,
      processedRows: 0,
      failedRows: 0,
    });
    if (!moved) return null;
    this.removeErrors(id);
    return runId;
  }

  async updateCounters(id: string, runId: string, counters: Counters): Promise<void> {
    this.assertCurrent(id, runId);
    this.patch(id, counters);
  }

  async finish(
    id: string,
    runId: string,
    status: 'COMPLETED' | 'COMPLETED_WITH_ERRORS',
    counters: Counters,
  ): Promise<void> {
    this.assertCurrent(id, runId);
    this.patch(id, { ...counters, status, finishedAt: new Date() });
  }

  async markFailed(id: string, message: string, runId?: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (runId !== undefined && rec?.runId !== runId) return false;
    return this.moveTo(id, 'FAILED', {
      errorMessage: message.slice(0, 1000),
      finishedAt: new Date(),
    });
  }

  async insertErrors(id: string, runId: string, errors: NewImportError[]): Promise<void> {
    this.assertCurrent(id, runId);
    for (const e of errors) this.errors.push({ id: this.nextErrorId++, importId: id, ...e });
  }

  async listErrors(id: string, afterId: number, limit: number): Promise<ImportErrorRecord[]> {
    return this.errors
      .filter((e) => e.importId === id && e.id > afterId)
      .slice(0, limit)
      .map(({ importId: _importId, ...rest }) => rest);
  }

  /** Test helper: simulates another worker taking over the import. */
  stealRun(id: string): string {
    const runId = randomUUID();
    this.patch(id, { runId });
    return runId;
  }

  private moveTo(id: string, to: ImportRecord['status'], values: Partial<ImportRecord>): boolean {
    const rec = this.records.get(id);
    if (!rec || !sourcesOf(to).includes(rec.status)) return false;
    this.patch(id, { ...values, status: to });
    return true;
  }

  private assertCurrent(id: string, runId: string): void {
    const rec = this.records.get(id);
    if (!rec || rec.runId !== runId || rec.status !== 'PROCESSING') throw new StaleRunError(id);
  }

  private removeErrors(importId: string): void {
    for (let i = this.errors.length - 1; i >= 0; i--) {
      if (this.errors[i]?.importId === importId) this.errors.splice(i, 1);
    }
  }

  private patch(id: string, values: Partial<ImportRecord>): void {
    const rec = this.records.get(id);
    if (rec) Object.assign(rec, values, { updatedAt: new Date() });
  }
}

export class RecordingProductRepository implements ProductRepository {
  readonly batches: ProductRow[][] = [];
  async upsertBatch(_importId: string, rows: ProductRow[]): Promise<void> {
    this.batches.push(rows);
  }
}

export class FakeStorage implements ObjectStorage {
  readonly objects = new Map<string, string | Buffer>();
  readonly presigned: Array<{ key: string; options: PresignPutOptions }> = [];

  async presignPut(key: string, options: PresignPutOptions): Promise<PresignedUpload> {
    this.presigned.push({ key, options });
    return {
      method: 'PUT',
      url: `https://storage.test/${key}?expires=${options.expiresInSeconds}`,
      headers: { 'Content-Type': options.contentType },
    };
  }
  async stat(key: string): Promise<{ size: number } | null> {
    const body = this.objects.get(key);
    return body === undefined ? null : { size: Buffer.byteLength(body) };
  }
  async getStream(key: string): Promise<Readable> {
    const body = this.objects.get(key);
    if (body === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    return Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  }
}

export class RecordingQueue implements JobQueue {
  readonly sent: Array<{ importId: string; correlationId: string }> = [];
  failNext = false;
  async enqueueImport(importId: string, correlationId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('queue unavailable');
    }
    this.sent.push({ importId, correlationId });
  }
}

export class RecordingPublisher implements ProgressPublisher {
  readonly events: Array<{ kind: 'progress' | 'finished'; payload: ProgressPayload }> = [];
  async progress(payload: ProgressPayload): Promise<void> {
    this.events.push({ kind: 'progress', payload });
  }
  async finished(payload: ProgressPayload): Promise<void> {
    this.events.push({ kind: 'finished', payload });
  }
}

export class FakeLockManager implements LockManager {
  readonly held = new Set<string>();
  async acquire(key: string): Promise<Lock | null> {
    if (this.held.has(key)) return null;
    this.held.add(key);
    return {
      renew: async () => this.held.has(key),
      release: async () => {
        this.held.delete(key);
      },
    };
  }
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
