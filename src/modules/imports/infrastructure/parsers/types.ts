import { InvalidFileError } from '../../domain/errors';

export interface ParsedRow {
  /** 1-based row number in the source file; the header is row 1, so data starts at 2. */
  rowNumber: number;
  values: Record<string, string>;
}

export const REQUIRED_COLUMNS = ['sku', 'name', 'price', 'stock', 'category'] as const;

export function normalizeHeader(header: unknown): string {
  return String(header ?? '')
    .trim()
    .toLowerCase();
}

export function assertRequiredColumns(headers: readonly string[] | null): void {
  if (!headers || headers.length === 0) {
    throw new InvalidFileError('File is empty or has no header row');
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new InvalidFileError(`Missing required column(s): ${missing.join(', ')}`);
  }
}
