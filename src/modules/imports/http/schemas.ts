import { z } from 'zod';
import { IMPORT_FORMATS } from '../domain/types';

// Matching control characters is the point of this check.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PATH_SEPARATORS = /[/\\]/;

export const createImportBodySchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((v) => !CONTROL_CHARS.test(v), 'must not contain control characters')
    .refine((v) => !PATH_SEPARATORS.test(v), 'must not contain path separators'),
  format: z.enum(IMPORT_FORMATS),
  /** Exact size of the file in bytes. The upper bound is enforced by the service (config). */
  fileSize: z.number().int().min(1),
});
export type CreateImportBody = z.infer<typeof createImportBodySchema>;

export const idempotencyHeaderSchema = z.object({
  'idempotency-key': z.string().trim().min(1).max(255),
});

export const importIdParamsSchema = z.object({
  id: z.uuid(),
});

export const listErrorsQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListErrorsQuery = z.infer<typeof listErrorsQuerySchema>;
