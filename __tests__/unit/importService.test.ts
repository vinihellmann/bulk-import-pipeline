import { DuplicateIdempotencyKeyError } from '../../src/modules/imports/domain/errors';
import {
  createImportService,
  encodeCursor,
} from '../../src/modules/imports/application/importService';
import { ConflictError, NotFoundError, ValidationError } from '../../src/shared/errors';
import { collect, FakeStorage, InMemoryImportRepository, RecordingQueue } from './fakes';

const MAX_UPLOAD = 1000;
const REQUEUE_AFTER_MS = 300_000;
const NOW = new Date('2025-01-01T00:00:00.000Z');

function setup(now: () => Date = () => NOW) {
  const repo = new InMemoryImportRepository();
  const storage = new FakeStorage();
  const queue = new RecordingQueue();
  const service = createImportService({
    repo,
    storage,
    queue,
    uploadUrlTtlSeconds: 900,
    maxUploadBytes: MAX_UPLOAD,
    requeueAfterMs: REQUEUE_AFTER_MS,
    now,
  });
  return { repo, storage, queue, service };
}

const CLIENT = 'client-a';
const OTHER = 'client-b';
const DATA = 'sku,name,price,stock,category\n';
const input = {
  clientId: CLIENT,
  idempotencyKey: 'key-1',
  fileName: 'catalog.csv',
  format: 'csv' as const,
  fileSize: DATA.length,
};

describe('ImportService.create (idempotency)', () => {
  it('creates an import awaiting upload with signed upload instructions', async () => {
    const { service, storage } = setup();
    const result = await service.create(input);

    expect(result.created).toBe(true);
    expect(result.import.status).toBe('AWAITING_UPLOAD');
    expect(result.import.clientId).toBe(CLIENT);
    expect(result.import.fileSize).toBe(DATA.length);
    expect(result.import.s3Key).toBe(`imports/${CLIENT}/${result.import.id}/source.csv`);
    expect(result.upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      expiresAt: '2025-01-01T00:15:00.000Z',
    });
    expect(result.upload?.url).toContain(result.import.s3Key);
    expect(storage.presigned[0]?.options).toEqual({
      expiresInSeconds: 900,
      contentType: 'text/csv',
      contentLength: DATA.length,
    });
  });

  it('returns the same import when the key is replayed with the same payload', async () => {
    const { service, repo } = setup();
    const first = await service.create(input);
    const second = await service.create(input);

    expect(second.created).toBe(false);
    expect(second.import.id).toBe(first.import.id);
    expect(second.upload).not.toBeNull();
    expect(repo.records.size).toBe(1);
  });

  it('rejects a replayed key with a different format or file size', async () => {
    const { service } = setup();
    await service.create(input);
    await expect(service.create({ ...input, format: 'xlsx' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(service.create({ ...input, fileSize: input.fileSize + 1 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('resolves a lost race on the unique constraint to the winning import', async () => {
    const { service, repo } = setup();
    const winner = await repo.create({
      id: 'winner-id',
      clientId: CLIENT,
      idempotencyKey: input.idempotencyKey,
      fileName: input.fileName,
      format: input.format,
      fileSize: input.fileSize,
      s3Key: `imports/${CLIENT}/winner-id/source.csv`,
    });
    // Simulate: the pre-check ran before the winner committed, then the INSERT collided.
    jest.spyOn(repo, 'findByIdempotencyKey').mockResolvedValueOnce(null);
    jest.spyOn(repo, 'create').mockRejectedValueOnce(new DuplicateIdempotencyKeyError());

    const result = await service.create(input);
    expect(result.created).toBe(false);
    expect(result.import.id).toBe(winner.id);
  });

  it('stops handing out upload URLs once the import has started', async () => {
    const { service, storage } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, DATA);
    await service.start(CLIENT, rec.id, 'corr-1');

    const replay = await service.create(input);
    expect(replay.upload).toBeNull();
    expect(replay.import.status).toBe('QUEUED');
  });

  it('rejects a declared file size above the maximum with a field issue', async () => {
    const { service, repo } = setup();
    const err = await service
      .create({ ...input, fileSize: MAX_UPLOAD + 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details).toEqual([
      expect.objectContaining({ location: 'body', field: 'fileSize' }),
    ]);
    expect(repo.records.size).toBe(0);
    await expect(service.create({ ...input, fileSize: MAX_UPLOAD })).resolves.toBeDefined();
  });
});

describe('ImportService tenant isolation', () => {
  it('treats the same idempotency key in two clients as two independent imports', async () => {
    const { service, repo } = setup();
    const a = await service.create(input);
    const b = await service.create({ ...input, clientId: OTHER });

    expect(b.created).toBe(true);
    expect(b.import.id).not.toBe(a.import.id);
    expect(b.import.s3Key).toBe(`imports/${OTHER}/${b.import.id}/source.csv`);
    expect(repo.records.size).toBe(2);
  });

  it("answers 404 (never 403) for another client's import on every operation", async () => {
    const { service, storage, queue } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, DATA);

    await expect(service.get(OTHER, rec.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.start(OTHER, rec.id, 'c')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.listErrors(OTHER, rec.id, undefined, 10)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(collect(service.streamErrorCsv(OTHER, rec.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(queue.sent).toHaveLength(0);
    // The owner is unaffected.
    await expect(service.get(CLIENT, rec.id)).resolves.toMatchObject({ id: rec.id });
  });

  it('yields nothing from the CSV stream before ownership is verified', async () => {
    const { service } = setup();
    const { import: rec } = await service.create(input);
    const gen = service.streamErrorCsv(OTHER, rec.id);
    await expect(gen.next()).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ImportService.start (idempotency)', () => {
  it('refuses to start before the file is uploaded', async () => {
    const { service, queue } = setup();
    const { import: rec } = await service.create(input);

    await expect(service.start(CLIENT, rec.id, 'corr-1')).rejects.toBeInstanceOf(ConflictError);
    expect(queue.sent).toHaveLength(0);
  });

  it('refuses to start when the uploaded size differs from the declared size', async () => {
    const { service, storage, queue, repo } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, `${DATA}extra`);

    const err = await service.start(CLIENT, rec.id, 'c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe('Uploaded file does not match the declared size');
    expect(queue.sent).toHaveLength(0);
    expect((await repo.findById(rec.id))?.status).toBe('AWAITING_UPLOAD');
  });

  it('refuses an uploaded object above the maximum even if sizes agree (legacy rows)', async () => {
    const { service, storage, repo } = setup();
    const { import: rec } = await service.create(input);
    const stored = repo.records.get(rec.id);
    if (stored) stored.fileSize = null; // legacy row without a declared size
    storage.objects.set(rec.s3Key, 'x'.repeat(MAX_UPLOAD + 1));

    await expect(service.start(CLIENT, rec.id, 'c')).rejects.toBeInstanceOf(ConflictError);
  });

  it('enqueues exactly one job no matter how often it is called', async () => {
    const { service, storage, queue } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, DATA);

    const results = await Promise.all([
      service.start(CLIENT, rec.id, 'corr-1'),
      service.start(CLIENT, rec.id, 'corr-2'),
      service.start(CLIENT, rec.id, 'corr-3'),
    ]);

    expect(results.every((r) => r.status === 'QUEUED')).toBe(true);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.importId).toBe(rec.id);
  });

  it('rolls back to AWAITING_UPLOAD when enqueueing fails, so the client can retry', async () => {
    const { service, storage, queue, repo } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, DATA);
    queue.failNext = true;

    await expect(service.start(CLIENT, rec.id, 'corr-1')).rejects.toThrow('queue unavailable');
    expect((await repo.findById(rec.id))?.status).toBe('AWAITING_UPLOAD');

    await service.start(CLIENT, rec.id, 'corr-2');
    expect(queue.sent).toEqual([{ importId: rec.id, correlationId: 'corr-2' }]);
  });

  it('returns 404 for unknown imports', async () => {
    const { service } = setup();
    await expect(
      service.start(CLIENT, '5f1c9f9e-6a0e-4f43-9c0e-111111111111', 'c'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ImportService.start (lost enqueue recovery)', () => {
  /** Queues an import, then backdates its last update to simulate a lost job message. */
  async function queuedImport(updatedAt: Date) {
    const ctx = setup(() => new Date());
    const { import: rec } = await ctx.service.create(input);
    ctx.storage.objects.set(rec.s3Key, DATA);
    await ctx.service.start(CLIENT, rec.id, 'corr-1');
    const stored = ctx.repo.records.get(rec.id);
    if (stored) stored.updatedAt = updatedAt;
    return { ...ctx, id: rec.id };
  }

  it('does not re-enqueue a recently queued import', async () => {
    const { service, queue, id } = await queuedImport(new Date(Date.now() - 1000));

    await service.start(CLIENT, id, 'corr-2');
    expect(queue.sent).toHaveLength(1);
  });

  it('re-enqueues a stale QUEUED import exactly once', async () => {
    const { service, queue, id } = await queuedImport(
      new Date(Date.now() - REQUEUE_AFTER_MS - 60_000),
    );

    const results = await Promise.all([
      service.start(CLIENT, id, 'corr-2'),
      service.start(CLIENT, id, 'corr-3'),
    ]);

    expect(results.every((r) => r.status === 'QUEUED')).toBe(true);
    expect(queue.sent).toHaveLength(2); // the original job plus exactly one recovery job
    expect(queue.sent[1]?.importId).toBe(id);
  });
});

describe('ImportService.listErrors', () => {
  it('paginates with an opaque keyset cursor', async () => {
    const { service, repo } = setup();
    const { import: rec } = await service.create(input);
    const runId = await markRunning(repo, rec.id);
    await repo.insertErrors(
      rec.id,
      runId,
      [2, 3, 4, 5, 6].map((rowNumber) => ({ rowNumber, field: 'price', message: 'bad' })),
    );

    const page1 = await service.listErrors(CLIENT, rec.id, undefined, 2);
    expect(page1.data.map((e) => e.rowNumber)).toEqual([2, 3]);
    expect(page1.nextCursor).toBe(encodeCursor(2));

    const page3 = await service.listErrors(CLIENT, rec.id, encodeCursor(4), 2);
    expect(page3.data.map((e) => e.rowNumber)).toEqual([6]);
    expect(page3.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor', async () => {
    const { service } = setup();
    const { import: rec } = await service.create(input);
    await expect(service.listErrors(CLIENT, rec.id, 'not-a-cursor', 10)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

/** Walks an import through the real transitions so the fenced fake accepts error inserts. */
async function markRunning(repo: InMemoryImportRepository, id: string): Promise<string> {
  await repo.transitionToQueued(id);
  const runId = await repo.markProcessing(id);
  if (!runId) throw new Error('markProcessing refused');
  return runId;
}
