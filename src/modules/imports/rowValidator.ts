import { z } from 'zod';
import type { ProductRow } from './types';

export interface RowIssue {
  field: string;
  message: string;
}

export type RowValidation =
  { success: true; data: ProductRow } | { success: false; issues: RowIssue[] };

const MAX_INT = 2_147_483_647;

const requiredText = (max: number) =>
  z.string().trim().min(1, 'is required').max(max, `must be at most ${max} characters`);

const price = z.string().transform((raw, ctx) => {
  const v = raw.trim();
  const fail = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  };
  if (v === '') return fail('is required');
  if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(v)) {
    return fail('must be a decimal number with at most 2 decimal places');
  }
  const n = Number(v);
  if (n <= 0) return fail('must be greater than 0');
  return n;
});

const stock = z.string().transform((raw, ctx) => {
  const v = raw.trim();
  const fail = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  };
  if (v === '') return fail('is required');
  if (!/^-?\d+$/.test(v)) return fail('must be a whole number');
  const n = Number(v);
  if (n < 0) return fail('must be greater than or equal to 0');
  if (n > MAX_INT) return fail(`must be at most ${MAX_INT}`);
  return n;
});

const productRowSchema = z.object({
  sku: requiredText(64),
  name: requiredText(255),
  description: z
    .string()
    .trim()
    .max(5000, 'must be at most 5000 characters')
    .transform((v) => (v === '' ? null : v)),
  price,
  stock,
  category: requiredText(100),
});

/** Validates one raw row (all values are strings as read from CSV/XLSX) and coerces types. */
export function validateRow(values: Record<string, string>): RowValidation {
  const result = productRowSchema.safeParse({
    sku: values.sku ?? '',
    name: values.name ?? '',
    description: values.description ?? '',
    price: values.price ?? '',
    stock: values.stock ?? '',
    category: values.category ?? '',
  });

  if (result.success) return { success: true, data: result.data };

  return {
    success: false,
    issues: result.error.issues.map((i) => ({
      field: i.path.length > 0 ? i.path.join('.') : 'row',
      message: i.message,
    })),
  };
}
