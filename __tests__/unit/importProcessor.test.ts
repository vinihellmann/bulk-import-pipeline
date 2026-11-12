import { createImportProcessor, lockKey } from '../../src/modules/imports/importProcessor';
import {
  FakeLockManager,
  FakeStorage,
  InMemoryImportRepository,
  RecordingProductRepository,
  RecordingPublisher,
  silentLogger,
} from './fakes';

const ID = '9d2b8c1a-3e4f-4a5b-9c6d-7e8f9a0b1c2d';
const KEY = `imports/${ID}/source.csv`;

async function setup(fileContents: string, status: 'QUEUED' | 'COMPLETED' = 'QUEUED') {
  const imports = new InMemoryImportRepository();
  const products = new RecordingProductRepository();
  const storage = new FakeStorage();
  const publisher = new RecordingPublisher();
  const locks = new FakeLockManager();

  await imports.create({
    id: ID,
    idempotencyKey: 'k',
    fileName: 'f.csv',
    format: 'csv',
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
});
