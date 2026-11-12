import type { z } from 'zod';
import { ValidationError } from '../shared/errors';

export type InputLocation = 'body' | 'query' | 'path' | 'header';

/** Parses untrusted input with a zod schema and maps failures to a 400 problem response. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  data: unknown,
  location: InputLocation,
): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data as z.output<S>;
  throw new ValidationError(
    'Request validation failed',
    result.error.issues.map((issue) => ({
      location,
      field: issue.path.length > 0 ? issue.path.join('.') : location,
      message: issue.message,
    })),
  );
}
