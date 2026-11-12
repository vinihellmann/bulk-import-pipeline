import type { ImportRecord } from '../domain/types';

export function toImportDto(r: ImportRecord) {
  return {
    id: r.id,
    fileName: r.fileName,
    format: r.format,
    status: r.status,
    totalRows: r.totalRows,
    processedRows: r.processedRows,
    failedRows: r.failedRows,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  };
}

export type ImportDto = ReturnType<typeof toImportDto>;
