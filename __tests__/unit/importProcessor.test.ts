import {
  createImportProcessor,
  lockKey,
  type ProcessorOptions,
} from '../../src/modules/imports/application/importProcessor';
import { StaleRunError } from '../../src/modules/imports/domain/errors';
import {
  FakeLockManager,
  FakeStorage,
  InMemoryImportRepository,
  RecordingProductRepository,
  RecordingPublisher,
  silentLogger,
} from './fakes';

const ID = '9d2b8c1a-3e4f-4a5b-9c6d-7e8f9a0b1c2d';
const KEY = `imports/client-a/${ID}/source.csv`;

async function setup(
  fileContents: string,
  status: 'QUEUED' | 'COMPLETED' = 'QUEUED',
  overrides: Partial<ProcessorOptions> = {},
) {
  const imports = new InMemoryImportRepository();
  const products = new RecordingProductRepository();
  const storage = new FakeStorage();
  const publisher = new RecordingPublisher();
  const locks = new FakeLockManager();

  await imports.create({
    id: ID,
    clientId: 'client-a',
    idempotencyKey: 'k',
    fileName: 'f.csv',
    format: 'csv',
    fileSize: Buffer.byteLength(fileContents),
    s3Key: KEY,
  });
  const rec = imports.records.get(ID);
  if (rec) rec.status = status;
  storage.objects.set(KEY, fileContents);

  const processor = createImportProcessor({
    imports,
    products,
    storage,
    publisher,
    locks,
    logger: silentLogger,
    options: {
      batchSize: 2,
      maxStoredErrors: 2,
      progressEveryRows: 1,
      progressEveryMs: 0,
      lockTtlMs: 1000,
      lockRenewMs: 500,
      maxUploadBytes: 1_000_000,
      maxRows: 1000,
      ...overrides,
    },
  });
  return { imports, products, storage, publisher, locks, processor };
}

const FILE = [
  'sku,name,price,stock,category',
  'A-1,One,1.00,1,c',
  'A-2,Two,0,1,c', // invalid price
  'A-3,Three,3.00,3,c',
  ',Four,x,1,c', // invalid sku and price (two issues)
  'A-5,Five,5.00,5,c',
].join('\n');

describe('ImportProcessor', () => {
  it('upserts valid rows in batches and records row errors', async () => {
    const { processor, imports, products, publisher } = await setup(FILE);

    await expect(processor.process(ID)).resolves.toBe('completed');

    expect(products.batches.map((b) => b.map((r) => r.sku))).toEqual([['A-1', 'A-3'], ['A-5']]);
    // Products are written under the importing client, never a global namespace.
    expect(products.clientIds).toEqual(['client-a', 'client-a']);
    const rec = await imports.findById(ID);
    expect(rec).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      totalRows: 5,
      processedRows: 5,
      failedRows: 2,
    });

    const finished = publisher.events.filter((e) => e.kind === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', failedRows: 2 });
    expect(publisher.events.some((e) => e.kind === 'progress')).toBe(true);
  });

  it('caps stored errors but keeps counting failed rows', async () => {
    const { processor, imports } = await setup(FILE);
    await processor.process(ID);

    // Three issues in total (row 3 price, row 5 sku + price) but only two are stored.
    expect(imports.errors.map((e) => [e.rowNumber, e.field])).toEqual([
      [3, 'price'],
      [5, 'sku'],
    ]);
    expect((await imports.findById(ID))?.failedRows).toBe(2);
  });

  it('completes without errors when every row is valid', async () => {
    const { processor, imports } = await setup('sku,name,price,stock,category\nZ,Zed,1,0,c\n');
    await processor.process(ID);
    expect((await imports.findById(ID))?.status).toBe('COMPLETED');
  });

  it('skips imports that already finished (redelivered message)', async () => {
    const { processor, products, storage } = await setup(FILE, 'COMPLETED');
    const getStream = jest.spyOn(storage, 'getStream');

    await expect(processor.process(ID)).resolves.toBe('skipped');
    expect(getStream).not.toHaveBeenCalled();
    expect(products.batches).toHaveLength(0);
  });

  it('skips when another worker holds the lock', async () => {
    const { processor, locks, products } = await setup(FILE);
    await locks.acquire(lockKey(ID));

    await expect(processor.process(ID)).resolves.toBe('skipped');
    expect(products.batches).toHaveLength(0);
  });

  it('marks the import FAILED for an unusable file and acknowledges the message', async () => {
    const { processor, imports, publisher, locks } = await setup('sku,name\nA,B\n');

    await expect(processor.process(ID)).resolves.toBe('failed');
    const rec = await imports.findById(ID);
    expect(rec?.status).toBe('FAILED');
    expect(rec?.errorMessage).toContain('Missing required column');
    expect(publisher.events.at(-1)).toMatchObject({
      kind: 'finished',
      payload: { status: 'FAILED' },
    });
    expect(locks.held.size).toBe(0); // lock released
  });

  it('stops promptly and releases the lock when aborted', async () => {
    const { processor, locks } = await setup(FILE);
    const controller = new AbortController();
    controller.abort(new Error('shutting down'));

    await expect(processor.process(ID, { signal: controller.signal })).rejects.toThrow(
      'shutting down',
    );
    expect(locks.held.size).toBe(0);
  });

  it('fails the import when the file has more rows than allowed', async () => {
    const { processor, imports, products } = await setup(FILE, 'QUEUED', { maxRows: 3 });

    await expect(processor.process(ID)).resolves.toBe('failed');
    const rec = await imports.findById(ID);
    expect(rec).toMatchObject({
      status: 'FAILED',
      errorMessage: 'File exceeds the maximum of 3 rows',
    });
    expect(products.batches.flat().length).toBeLessThanOrEqual(2);
  });

  it('fails the import when the stored object exceeds the byte limit', async () => {
    const { processor, imports, locks } = await setup(FILE, 'QUEUED', { maxUploadBytes: 40 });

    await expect(processor.process(ID)).resolves.toBe('failed');
    expect(await imports.findById(ID)).toMatchObject({
      status: 'FAILED',
      errorMessage: 'File exceeds the maximum size of 40 bytes',
    });
    expect(locks.held.size).toBe(0);
  });

  it('assigns a fresh run id and takes over a PROCESSING import on redelivery', async () => {
    const { processor, imports } = await setup(FILE);
    const rec = imports.records.get(ID);
    if (rec) Object.assign(rec, { status: 'PROCESSING', runId: 'dead-worker-run' });

    await expect(processor.process(ID)).resolves.toBe('completed');
    const after = await imports.findById(ID);
    expect(after?.status).toBe('COMPLETED_WITH_ERRORS');
    expect(after?.runId).not.toBe('dead-worker-run');
  });

  describe('fencing', () => {
    it('stops with StaleRunError when another run took over, without publishing or finishing', async () => {
      const { processor, imports, publisher, locks } = await setup(FILE);
      // The first realtime event happens right after markProcessing: another worker takes over.
      jest.spyOn(publisher, 'progress').mockImplementationOnce(async () => {
        imports.stealRun(ID);
      });
      const before = publisher.events.length;

      await expect(processor.process(ID)).rejects.toBeInstanceOf(StaleRunError);

      const rec = await imports.findById(ID);
      expect(rec?.status).toBe('PROCESSING'); // not finished, not failed
      expect(rec?.finishedAt).toBeNull();
      expect(publisher.events.slice(before).filter((e) => e.kind === 'finished')).toHaveLength(0);
      expect(locks.held.size).toBe(0);
    });

    it('does not let a fenced-out worker overwrite the final state of the new run', async () => {
      const { processor, imports, publisher } = await setup(FILE);
      jest.spyOn(publisher, 'progress').mockImplementationOnce(async () => {
        imports.stealRun(ID);
      });
      await expect(processor.process(ID)).rejects.toBeInstanceOf(StaleRunError);

      // The new run (simulated) completes; a late stale write from the old run is rejected.
      const rec = imports.records.get(ID);
      if (rec) Object.assign(rec, { status: 'COMPLETED', totalRows: 5 });
      await expect(
        imports.finish(ID, 'old-run', 'COMPLETED', {
          totalRows: 0,
          processedRows: 0,
          failedRows: 0,
        }),
      ).rejects.toBeInstanceOf(StaleRunError);
      expect(await imports.findById(ID)).toMatchObject({ status: 'COMPLETED', totalRows: 5 });
    });

    it('does not mark FAILED a run that lost ownership while hitting an invalid file', async () => {
      const { processor, imports, publisher } = await setup('sku,name\nA,B\n');
      jest.spyOn(publisher, 'progress').mockImplementationOnce(async () => {
        imports.stealRun(ID);
      });

      await expect(processor.process(ID)).resolves.toBe('failed');
      expect((await imports.findById(ID))?.status).toBe('PROCESSING');
      expect(publisher.events.some((e) => e.kind === 'finished')).toBe(false);
    });
  });
});
