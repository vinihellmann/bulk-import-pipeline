import type { Readable } from 'node:stream';
import * as ExcelJS from 'exceljs';
import { InvalidFileError } from '../errors';
import { assertRequiredColumns, normalizeHeader, type ParsedRow } from './types';

interface SheetRow {
  number: number;
  values: unknown;
}

type Reader = AsyncIterable<AsyncIterable<SheetRow>>;

export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return o.richText.map((p) => String((p as { text?: unknown }).text ?? '')).join('');
    }
    if ('result' in o) return cellToString(o.result); // formula cell: use cached result
    if (typeof o.text === 'string') return o.text; // hyperlink cell
  }
  return '';
}

/**
 * Streams rows from the first worksheet of an XLSX stream using ExcelJS's streaming
 * WorkbookReader. Note: `sharedStrings: 'cache'` keeps the shared-string table in memory
 * (required to resolve text cells); row data itself is never buffered.
 */
export async function* parseXlsx(input: Readable): AsyncGenerator<ParsedRow> {
  let sourceError: unknown;
  // The ExcelJS reader does not reliably surface errors of the input stream, so we race
  // every pull against a promise that rejects when the source fails (otherwise: a hang).
  const failed = new Promise<never>((_, reject) => {
    input.once('error', (err) => {
      sourceError = err;
      reject(err);
    });
  });
  failed.catch(() => undefined);

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
  }) as unknown as Reader;

  try {
    const sheets = reader[Symbol.asyncIterator]();
    const firstSheet = await Promise.race([sheets.next(), failed]);
    if (firstSheet.done) throw new InvalidFileError('Workbook contains no worksheets');

    const rows = firstSheet.value[Symbol.asyncIterator]();
    let headers: string[] | null = null;

    for (;;) {
      const next = await Promise.race([rows.next(), failed]);
      if (next.done) break;

      const row = next.value;
      // ExcelJS row.values is 1-based: index 0 is always empty.
      const cells = (Array.isArray(row.values) ? (row.values as unknown[]) : [])
        .slice(1)
        .map(cellToString);
      if (cells.every((c) => c.trim() === '')) continue;

      if (headers === null) {
        headers = cells.map(normalizeHeader);
        assertRequiredColumns(headers);
        continue;
      }

      const values: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h !== '') values[h] = cells[i] ?? '';
      });
      yield { rowNumber: row.number, values };
    }

    if (headers === null) assertRequiredColumns(null);
  } catch (err) {
    if (sourceError !== undefined) throw sourceError;
    if (err instanceof InvalidFileError) throw err;
    throw new InvalidFileError(`Unable to read XLSX file: ${(err as Error).message}`);
  } finally {
    input.destroy();
  }
}
