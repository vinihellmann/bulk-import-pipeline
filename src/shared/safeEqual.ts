import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison. Both values are hashed first so that the inputs have
 * equal length (timingSafeEqual throws otherwise) and length is not leaked.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
