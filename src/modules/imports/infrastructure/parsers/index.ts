import type { Readable } from 'node:stream';
import type { ImportFormat } from '../../domain/types';
import { parseCsv } from './csv';
import type { ParsedRow } from './types';
import { parseXlsx } from './xlsx';

export type { ParsedRow } from './types';
export { parseCsv } from './csv';
export { parseXlsx } from './xlsx';

export type RowParser = (input: Readable) => AsyncIterable<ParsedRow>;

const PARSERS: Readonly<Record<ImportFormat, RowParser>> = { csv: parseCsv, xlsx: parseXlsx };

export function parseRows(format: ImportFormat, input: Readable): AsyncIterable<ParsedRow> {
  return PARSERS[format](input);
}
