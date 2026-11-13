import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import * as ExcelJS from 'exceljs';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { createProductRepository } from '../../src/modules/imports';
import {
  apiKeyOf,
  connectClient,
  startStack,
  subscribe,
  uploadTo,
  waitForEvent,
  waitForQueueToDrain,
  type Stack,
} from './harness';

const SAMPLE = readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'products-sample.csv'));
const SAMPLE_TOTAL = 15;
const SAMPLE_INVALID = 3;

interface ImportDto {
  id: string;
  status: string;
  totalRows: number;
  processedRows: number;
  failedRows: number;
  errorMessage: string | null;
}

interface ProgressEvent {
  importId: string;
  status: string;
  totalRows: number;
  processedRows: number;
  failedRows: number;
}

let stack: Stack;
let socket: Socket;

beforeAll(async () => {
  stack = await startStack();
  socket = await connectClient(stack);
});

afterAll(async () => {
  socket?.disconnect();
  await stack?.close();
});

const auth = (): Record<string, string> => ({ 'x-api-key': apiKeyOf(stack) });

async function createImport(
  key: string,
  format: 'csv' | 'xlsx' = 'csv',
  fileSize: number = SAMPLE.length,
) {
  return request(stack.baseUrl)
    .post('/v1/imports')
    .set(auth())
    .set('Idempotency-Key', key)
    .send({ fileName: `catalog.${format}`, format, fileSize });
}

/** Creates, uploads and starts an import, then waits for `import:finished` over Socket.io. */
async function runImport(key: string, file: Buffer, format: 'csv' | 'xlsx' = 'csv') {
  const created = await createImport(key, format, file.length);
  expect(created.status).toBe(201);
  const id: string = created.body.import.id;

  await uploadTo(created.body.upload.url, file, created.body.upload.headers);
  await subscribe(socket, id);
  const finished = waitForEvent<ProgressEvent>(socket, 'import:finished');

  const started = await request(stack.baseUrl).post(`/v1/imports/${id}/start`).set(auth());
  expect(started.status).toBe(202);

  const event = await finished;
  expect(event.importId).toBe(id);
  const res = await request(stack.baseUrl).get(`/v1/imports/${id}`).set(auth());
  return res.body.import as ImportDto;
}

const productCount = (): Promise<number> => stack.infra.models.ProductModel.count();

describe('authentication and probes', () => {
  it('rejects requests without a valid API key', async () => {
    const missing = await request(stack.baseUrl).get(
      '/v1/imports/00000000-0000-0000-0000-000000000000',
    );
    expect(missing.status).toBe(401);
    expect(missing.headers['content-type']).toContain('application/problem+json');

    const wrong = await request(stack.baseUrl)
      .get('/v1/imports/00000000-0000-0000-0000-000000000000')
      .set('x-api-key', 'wrong-key-123');
    expect(wrong.status).toBe(401);
  });

  it('reports liveness and readiness of every dependency', async () => {
    expect((await request(stack.baseUrl).get('/health')).status).toBe(200);
    const ready = await request(stack.baseUrl).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ mysql: 'ok', redis: 'ok', s3: 'ok' });
  });

  it('sends rate limit headers', async () => {
    const res = await request(stack.baseUrl)
      .get('/v1/imports/00000000-0000-0000-0000-000000000000')
      .set(auth());
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});

describe('full import flow', () => {
  let importId: string;

  it('creates an import idempotently and refuses to start before the upload', async () => {
    const first = await createImport('flow-key-1');
    expect(first.status).toBe(201);
    expect(first.headers.location).toBe(`/v1/imports/${first.body.import.id}`);
    expect(first.body.import.status).toBe('AWAITING_UPLOAD');
    expect(first.body.upload).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
    });
    importId = first.body.import.id;

    const replay = await createImport('flow-key-1');
    expect(replay.status).toBe(200);
    expect(replay.body.import.id).toBe(importId);

    const conflicting = await createImport('flow-key-1', 'xlsx');
    expect(conflicting.status).toBe(409);

    const missingKey = await request(stack.baseUrl)
      .post('/v1/imports')
      .set(auth())
      .send({ fileName: 'a.csv', format: 'csv', fileSize: 10 });
    expect(missingKey.status).toBe(400);

    const early = await request(stack.baseUrl).post(`/v1/imports/${importId}/start`).set(auth());
    expect(early.status).toBe(409);

    await uploadTo(first.body.upload.url, SAMPLE, first.body.upload.headers);
  });

  it('processes the file, streams progress and reports row errors', async () => {
    await subscribe(socket, importId);
    const progress: ProgressEvent[] = [];
    const onProgress = (e: ProgressEvent): void => {
      if (e.importId === importId) progress.push(e);
    };
    socket.on('import:progress', onProgress);
    const finished = waitForEvent<ProgressEvent>(socket, 'import:finished');

    const started = await request(stack.baseUrl).post(`/v1/imports/${importId}/start`).set(auth());
    expect(started.status).toBe(202);
    expect(started.body.import.status).toBe('QUEUED');

    // Starting again is a no-op that reports the current state.
    const again = await request(stack.baseUrl).post(`/v1/imports/${importId}/start`).set(auth());
    expect(again.status).toBe(202);

    const event = await finished;
    socket.off('import:progress', onProgress);

    expect(event).toMatchObject({
      importId,
      status: 'COMPLETED_WITH_ERRORS',
      totalRows: SAMPLE_TOTAL,
      processedRows: SAMPLE_TOTAL,
      failedRows: SAMPLE_INVALID,
    });
    expect(progress.length).toBeGreaterThan(0);

    const res = await request(stack.baseUrl).get(`/v1/imports/${importId}`).set(auth());
    expect(res.body.import).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      totalRows: SAMPLE_TOTAL,
      failedRows: SAMPLE_INVALID,
    });
    expect(await productCount()).toBe(SAMPLE_TOTAL - SAMPLE_INVALID);
  });

  it('paginates errors with a cursor', async () => {
    const page1 = await request(stack.baseUrl)
      .get(`/v1/imports/${importId}/errors?limit=2`)
      .set(auth());
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(stack.baseUrl)
      .get(`/v1/imports/${importId}/errors`)
      .query({ limit: 2, cursor: page1.body.nextCursor })
      .set(auth());
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    const fields = [...page1.body.data, ...page2.body.data].map(
      (e: { rowNumber: number; field: string }) => `${e.rowNumber}:${e.field}`,
    );
    expect(fields).toEqual(['8:price', '11:stock', '13:name']);
  });

  it('streams the error report as CSV', async () => {
    const res = await request(stack.baseUrl).get(`/v1/imports/${importId}/errors.csv`).set(auth());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`import-${importId}-errors.csv`);
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('row_number,field,message');
    expect(lines).toHaveLength(1 + SAMPLE_INVALID);
  });

  it('ignores a redelivered message for a finished import', async () => {
    const before = (await request(stack.baseUrl).get(`/v1/imports/${importId}`).set(auth())).body
      .import as ImportDto & { finishedAt: string };

    await stack.infra.sqs.send(
      new SendMessageCommand({
        QueueUrl: stack.config.sqs.queueUrl,
        MessageBody: JSON.stringify({ importId }),
      }),
    );
    await waitForQueueToDrain(stack);

    const after = (await request(stack.baseUrl).get(`/v1/imports/${importId}`).set(auth())).body
      .import as ImportDto & { finishedAt: string };
    expect(after).toEqual(before);
    expect(await productCount()).toBe(SAMPLE_TOTAL - SAMPLE_INVALID);
    await expect(stack.worker.processor.process(importId)).resolves.toBe('skipped');
  });

  it('re-importing the same catalog upserts by SKU instead of duplicating', async () => {
    const result = await runImport('flow-key-2', SAMPLE);
    expect(result.status).toBe('COMPLETED_WITH_ERRORS');
    expect(await productCount()).toBe(SAMPLE_TOTAL - SAMPLE_INVALID);

    const update = Buffer.from(
      'sku,name,price,stock,category\nSKU-0001,Cordless Drill 18V (2025),179.90,30,tools\nSKU-0100,New Item,5.00,1,misc\n',
    );
    const updated = await runImport('flow-key-3', update);
    expect(updated).toMatchObject({ status: 'COMPLETED', totalRows: 2, failedRows: 0 });
    expect(await productCount()).toBe(SAMPLE_TOTAL - SAMPLE_INVALID + 1);

    const drill = await stack.infra.models.ProductModel.findOne({ where: { sku: 'SKU-0001' } });
    expect(drill?.name).toBe('Cordless Drill 18V (2025)');
    expect(Number(drill?.price)).toBe(179.9);
    expect(drill?.stock).toBe(30);
    expect(drill?.lastImportId).toBe(updated.id);
  });

  it('keeps the same SKU separate per client', async () => {
    const repo = createProductRepository(stack.infra.models, stack.infra.sequelize);
    const row = {
      sku: 'TENANT-1',
      name: 'A',
      description: null,
      price: 10,
      stock: 1,
      category: 'x',
    };

    await repo.upsertBatch('client-a', randomUUID(), [row]);
    await repo.upsertBatch('client-b', randomUUID(), [{ ...row, name: 'B' }]);
    await repo.upsertBatch('client-a', randomUUID(), [{ ...row, name: 'A2' }]);

    const rows = await stack.infra.models.ProductModel.findAll({
      where: { sku: 'TENANT-1' },
      order: [['clientId', 'ASC']],
    });
    expect(rows.map((r) => [r.clientId, r.name])).toEqual([
      ['client-a', 'A2'],
      ['client-b', 'B'],
    ]);
  });
});

describe('other formats and failures', () => {
  it('imports an XLSX workbook', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Catalog');
    ws.addRow(['sku', 'name', 'price', 'stock', 'category']);
    for (let i = 1; i <= 120; i++) ws.addRow([`XL-${i}`, `Sheet item ${i}`, i + 0.5, i, 'xlsx']);
    const file = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await runImport('xlsx-key-1', file, 'xlsx');
    expect(result).toMatchObject({ status: 'COMPLETED', totalRows: 120, failedRows: 0 });
  });

  it('marks a file with missing columns as FAILED without retrying', async () => {
    const result = await runImport('bad-header-key', Buffer.from('sku,title\nA,B\n'));
    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toContain('Missing required column');
    await waitForQueueToDrain(stack);
  });
});
