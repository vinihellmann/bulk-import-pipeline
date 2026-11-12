import { DuplicateIdempotencyKeyError } from '../../src/modules/imports/errors';
import { createImportService, encodeCursor } from '../../src/modules/imports/importService';
import { ConflictError, NotFoundError, ValidationError } from '../../src/shared/errors';
import { FakeStorage, InMemoryImportRepository, RecordingQueue } from './fakes';

function setup() {
  const repo = new InMemoryImportRepository();
  const storage = new FakeStorage();
  const queue = new RecordingQueue();
  const service = createImportService({
    repo,
    storage,
    queue,
    uploadUrlTtlSeconds: 900,
    now: () => new Date('2025-01-01T00:00:00.000Z'),
  });
  return { repo, storage, queue, service };
}

const input = { idempotencyKey: 'key-1', fileName: 'catalog.csv', format: 'csv' as const };

describe('ImportService.create (idempotency)', () => {
  it('creates an import awaiting upload with a presigned URL', async () => {
    const { service } = setup();
    const result = await service.create(input);

    expect(result.created).toBe(true);
    expect(result.import.status).toBe('AWAITING_UPLOAD');
    expect(result.import.s3Key).toBe(`imports/${result.import.id}/source.csv`);
    expect(result.uploadUrl).toContain(result.import.s3Key);
    expect(result.expiresAt).toBe('2025-01-01T00:15:00.000Z');
  });

  it('returns the same import when the key is replayed with the same payload', async () => {
    const { service, repo } = setup();
    const first = await service.create(input);
    const second = await service.create(input);

    expect(second.created).toBe(false);
    expect(second.import.id).toBe(first.import.id);
    expect(second.uploadUrl).not.toBeNull();
    expect(repo.records.size).toBe(1);
  });

  it('rejects a replayed key with a different payload', async () => {
    const { service } = setup();
    await service.create(input);
    await expect(service.create({ ...input, format: 'xlsx' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('resolves a lost race on the unique constraint to the winning import', async () => {
    const { service, repo } = setup();
    const winner = await repo.create({
      id: 'winner-id',
      idempotencyKey: input.idempotencyKey,
      fileName: input.fileName,
      format: input.format,
      s3Key: 'imports/winner-id/source.csv',
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
    storage.objects.set(rec.s3Key, 'sku,name,price,stock,category\n');
    await service.start(rec.id, 'corr-1');

    const replay = await service.create(input);
    expect(replay.uploadUrl).toBeNull();
    expect(replay.import.status).toBe('QUEUED');
  });
});

describe('ImportService.start (idempotency)', () => {
  it('refuses to start before the file is uploaded', async () => {
    const { service, queue } = setup();
    const { import: rec } = await service.create(input);

    await expect(service.start(rec.id, 'corr-1')).rejects.toBeInstanceOf(ConflictError);
    expect(queue.sent).toHaveLength(0);
  });

  it('enqueues exactly one job no matter how often it is called', async () => {
    const { service, storage, queue } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, 'data');

    const results = await Promise.all([
      service.start(rec.id, 'corr-1'),
      service.start(rec.id, 'corr-2'),
      service.start(rec.id, 'corr-3'),
    ]);

    expect(results.every((r) => r.status === 'QUEUED')).toBe(true);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.importId).toBe(rec.id);
  });

  it('rolls back to AWAITING_UPLOAD when enqueueing fails, so the client can retry', async () => {
    const { service, storage, queue, repo } = setup();
    const { import: rec } = await service.create(input);
    storage.objects.set(rec.s3Key, 'data');
    queue.failNext = true;

    await expect(service.start(rec.id, 'corr-1')).rejects.toThrow('queue unavailable');
    expect((await repo.findById(rec.id))?.status).toBe('AWAITING_UPLOAD');

    await service.start(rec.id, 'corr-2');
    expect(queue.sent).toEqual([{ importId: rec.id, correlationId: 'corr-2' }]);
  });

  it('returns 404 for unknown imports', async () => {
    const { service } = setup();
    await expect(service.start('5f1c9f9e-6a0e-4f43-9c0e-111111111111', 'c')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('ImportService.listErrors', () => {
  it('paginates with an opaque keyset cursor', async () => {
    const { service, repo } = setup();
    const { import: rec } = await service.create(input);
    await repo.insertErrors(
      rec.id,
      [2, 3, 4, 5, 6].map((rowNumber) => ({ rowNumber, field: 'price', message: 'bad' })),
    );

    const page1 = await service.listErrors(rec.id, undefined, 2);
    expect(page1.data.map((e) => e.rowNumber)).toEqual([2, 3]);
    expect(page1.nextCursor).toBe(encodeCursor(2));

    const page3 = await service.listErrors(rec.id, encodeCursor(4), 2);
    expect(page3.data.map((e) => e.rowNumber)).toEqual([6]);
    expect(page3.nextCursor).toBeNull();
  });

  it('rejects a tampered cursor', async () => {
    const { service } = setup();
    const { import: rec } = await service.create(input);
    await expect(service.listErrors(rec.id, 'not-a-cursor', 10)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
