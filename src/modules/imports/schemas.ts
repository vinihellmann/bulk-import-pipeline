import { z } from 'zod';
import { IMPORT_FORMATS } from './types';

export const createImportBodySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  format: z.enum(IMPORT_FORMATS),
});
export type CreateImportBody = z.infer<typeof createImportBodySchema>;

export const idempotencyHeaderSchema = z.object({
  'idempotency-key': z.string().trim().min(1).max(255),
});

export const importIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const listErrorsQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListErrorsQuery = z.infer<typeof listErrorsQuerySchema>;
