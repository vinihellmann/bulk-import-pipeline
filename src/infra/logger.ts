import winston from 'winston';

export type Logger = winston.Logger;

export function createLogger(level: string, service: string, silent = false): Logger {
  return winston.createLogger({
    level,
    silent,
    defaultMeta: { service },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console()],
  });
}

/** Converts an unknown thrown value into a plain, JSON-safe object for structured logs. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}
