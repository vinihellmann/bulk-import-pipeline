import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { InvalidFileError } from '../../domain/errors';
import { assertRequiredColumns, normalizeHeader, type ParsedRow } from './types';

function wrapCsvError(err: unknown): unknown {
  if (err instanceof InvalidFileError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.startsWith('CSV_')) {
    return new InvalidFileError(`Malformed CSV: ${(err as Error).message}`);
  }
  return err;
}

/**
 * Streams rows from a CSV stream with constant memory. Backpressure is natural: the
 * source is only read as fast as the consumer pulls from this generator.
 */
export async function* parseCsv(input: Readable): AsyncGenerator<ParsedRow> {
  let headers: string[] | null = null;

  const parser = parse({
    columns: (header: string[]) => {
      headers = header.map(normalizeHeader);
      return headers;
    },
    bom: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    // Bounds memory: an unterminated quoted field would otherwise buffer the rest of the file.
    // Exceeding it raises CSV_MAX_RECORD_SIZE, mapped to InvalidFileError by wrapCsvError.
    max_record_size: 1_048_576,
  });

  // pipe() does not forward source errors, so do it explicitly.
  input.on('error', (err) => parser.destroy(err));
  input.pipe(parser);

  let count = 0;
  try {
    for await (const record of parser) {
      if (count === 0) assertRequiredColumns(headers);
      count += 1;
      yield { rowNumber: count + 1, values: record as Record<string, string> };
    }
    if (count === 0) assertRequiredColumns(headers);
  } catch (err) {
    throw wrapCsvError(err);
  } finally {
    input.unpipe(parser);
    input.destroy();
    parser.destroy();
  }
}
