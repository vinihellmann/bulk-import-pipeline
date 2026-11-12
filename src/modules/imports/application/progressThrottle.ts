export interface ThrottleOptions {
  /** Minimum number of rows processed since the last emission. */
  everyRows: number;
  /** Minimum milliseconds elapsed since the last emission. */
  everyMs: number;
  now?: () => number;
}

/**
 * Decides when progress should be published. Both thresholds must be satisfied, so a fast
 * parser cannot flood Redis/Socket.io and a slow one still reports at a bounded cadence.
 * The final event is emitted unconditionally by the caller.
 */
export function createProgressThrottle(options: ThrottleOptions): {
  shouldEmit(processedRows: number): boolean;
} {
  const now = options.now ?? Date.now;
  let lastRows = 0;
  let lastAt = now();

  return {
    shouldEmit(processedRows: number): boolean {
      if (processedRows - lastRows < options.everyRows) return false;
      const t = now();
      if (t - lastAt < options.everyMs) return false;
      lastRows = processedRows;
      lastAt = t;
      return true;
    },
  };
}
