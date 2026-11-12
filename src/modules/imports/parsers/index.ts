import type { Readable } from 'node:stream';
import type { ImportFormat } from '../types';
import { parseCsv } from './csv';
import type { ParsedRow } from './types';
import { parseXlsx } from './xlsx';

export type { ParsedRow } from './types';
export { parseCsv } from './csv';
export { parseXlsx } from './xlsx';

export function parseRows(format: ImportFormat, input: Readable): AsyncIterable<ParsedRow> {
  return format === 'csv' ? parseCsv(input) : parseXlsx(input);
}
