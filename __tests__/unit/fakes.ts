import { Readable } from 'node:stream';
import type { Lock, LockManager } from '../../src/infra/lock';
import { createLogger } from '../../src/infra/logger';
import type {
  Counters,
  ImportErrorRecord,
  ImportRecord,
  ImportRepository,
  JobQueue,
  ObjectStorage,
  ProductRepository,
  ProductRow,
  ProgressPayload,
  ProgressPublisher,
} from '../../src/modules/imports/types';

export const silentLogger = createLogger('error', 'test', true);

export class InMemoryImportRepository implements ImportRepository {
  readonly records = new Map<string, ImportRecord>();
  readonly errors: ImportErrorRecord[] = [];
  private nextErrorId = 1;

  async create(input: Parameters<ImportRepository['create']>[0]): Promise<ImportRecord> {
    const now = new Date();
    const rec: ImportRecord = {
      ...input,
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

  async findByIdempotencyKey(key: string): Promise<ImportRecord | null> {
    for (const rec of this.records.values()) {
      if (rec.idempotencyKey === key) return { ...rec };
    }
    return null;
  }

  async transitionToQueued(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'AWAITING_UPLOAD') return false;
    rec.status = 'QUEUED';
    return true;
  }

  async revertToAwaitingUpload(id: string): Promise<void> {
    const rec = this.records.get(id);
    if (rec?.status === 'QUEUED') rec.status = 'AWAITING_UPLOAD';
  }

  async markProcessing(id: string): Promise<void> {
    this.patch(id, { status: 'PROCESSING', totalRows: 0, processedRows: 0, failedRows: 0 });
  }

  async updateCounters(id: string, counters: Counters): Promise<void> {
    this.patch(id, counters);
  }

  async finish(
    id: string,
    status: 'COMPLETED' | 'COMPLETED_WITH_ERRORS',
    counters: Counters,
  ): Promise<void> {
    this.patch(id, { ...counters, status, finishedAt: new Date() });
  }

  async markFailed(id: string, message: string): Promise<void> {
    this.patch(id, { status: 'FAILED', errorMessage: message, finishedAt: new Date() });
  }

  async insertErrors(_id: string, errors: Parameters<ImportRepository['insertErrors']>[1]) {
    for (const e of errors) this.errors.push({ id: this.nextErrorId++, ...e });
  }

  async listErrors(_id: string, afterId: number, limit: number): Promise<ImportErrorRecord[]> {
    return this.errors.filter((e) => e.id > afterId).slice(0, limit);
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
  async presignPut(key: string, expiresInSeconds: number): Promise<string> {
    return `https://storage.test/${key}?expires=${expiresInSeconds}`;
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
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
