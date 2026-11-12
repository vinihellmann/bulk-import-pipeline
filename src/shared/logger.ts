export type LogMeta = Record<string, unknown>;

/** Framework-free logging port; infra supplies the concrete implementation. */
export interface Logger {
  error(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  child(meta: LogMeta): Logger;
}

/** Converts an unknown thrown value into a plain, JSON-safe object for structured logs. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}
