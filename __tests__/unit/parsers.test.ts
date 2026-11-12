import { Readable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import { InvalidFileError } from '../../src/modules/imports/domain/errors';
import { parseCsv, parseXlsx } from '../../src/modules/imports/infrastructure/parsers';
import { collect } from './fakes';

const csv = (text: string): Readable => Readable.from([Buffer.from(text, 'utf8')]);

describe('parseCsv', () => {
  it('streams rows keyed by normalized header with 1-based file row numbers', async () => {
    const rows = await collect(
      parseCsv(
        csv(
          '﻿SKU, Name ,price,stock,category,description\n' +
            'A-1,Widget,9.99,3,tools,"Has a comma, inside"\n' +
            '\n' +
            'A-2,Gadget,5,0,tools,\n',
        ),
      ),
    );

    expect(rows).toEqual([
      {
        rowNumber: 2,
        values: {
          sku: 'A-1',
          name: 'Widget',
          price: '9.99',
          stock: '3',
          category: 'tools',
          description: 'Has a comma, inside',
        },
      },
      {
        rowNumber: 3,
        values: {
          sku: 'A-2',
          name: 'Gadget',
          price: '5',
          stock: '0',
          category: 'tools',
          description: '',
        },
      },
    ]);
  });

  it('rejects a file without the required columns', async () => {
    await expect(collect(parseCsv(csv('sku,name,price\nA-1,Widget,1\n')))).rejects.toThrow(
      new InvalidFileError('Missing required column(s): stock, category'),
    );
  });

  it('rejects an empty file', async () => {
    await expect(collect(parseCsv(csv('')))).rejects.toBeInstanceOf(InvalidFileError);
  });

  it('rejects a header-only file with missing columns even when there are no data rows', async () => {
    await expect(collect(parseCsv(csv('sku,name\n')))).rejects.toBeInstanceOf(InvalidFileError);
  });

  it('maps malformed CSV to InvalidFileError', async () => {
    const text = 'sku,name,price,stock,category\n"A-1,Widget,1,1,tools\n';
    await expect(collect(parseCsv(csv(text)))).rejects.toBeInstanceOf(InvalidFileError);
  });

  it('rejects a single record larger than 1 MiB instead of buffering the file', async () => {
    const huge = 'x'.repeat(1_100_000);
    const text = `sku,name,price,stock,category\nA-1,"${huge}",1,1,tools\n`;
    await expect(collect(parseCsv(csv(text)))).rejects.toBeInstanceOf(InvalidFileError);
  });

  it('propagates source stream errors', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    await expect(collect(parseCsv(source))).rejects.toThrow('connection reset');
  });
});

describe('parseXlsx', () => {
  async function workbook(rows: unknown[][]): Promise<Readable> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Products');
    for (const row of rows) ws.addRow(row);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return Readable.from([buffer]);
  }

  it('reads the first worksheet and stringifies cell values', async () => {
    const rows = await collect(
      parseXlsx(
        await workbook([
          ['SKU', 'Name', 'Price', 'Stock', 'Category'],
          ['X-1', 'Lamp', 19.5, 4, 'home'],
          ['X-2', 'Chair', '35.00', 0, 'home'],
        ]),
      ),
    );

    expect(rows).toEqual([
      {
        rowNumber: 2,
        values: { sku: 'X-1', name: 'Lamp', price: '19.5', stock: '4', category: 'home' },
      },
      {
        rowNumber: 3,
        values: { sku: 'X-2', name: 'Chair', price: '35.00', stock: '0', category: 'home' },
      },
    ]);
  });

  it('rejects a worksheet without the required columns', async () => {
    const input = await workbook([
      ['sku', 'name'],
      ['X-1', 'Lamp'],
    ]);
    await expect(collect(parseXlsx(input))).rejects.toBeInstanceOf(InvalidFileError);
  });
});
