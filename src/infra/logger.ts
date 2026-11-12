import winston from 'winston';
import type { Logger, LogMeta } from '../shared/logger';

function adapt(base: winston.Logger): Logger {
  return {
    error: (message: string, meta?: LogMeta) => void base.error(message, meta),
    warn: (message: string, meta?: LogMeta) => void base.warn(message, meta),
    info: (message: string, meta?: LogMeta) => void base.info(message, meta),
    debug: (message: string, meta?: LogMeta) => void base.debug(message, meta),
    child: (meta: LogMeta) => adapt(base.child(meta)),
  };
}

export function createLogger(level: string, service: string, silent = false): Logger {
  return adapt(
    winston.createLogger({
      level,
      silent,
      defaultMeta: { service },
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      transports: [new winston.transports.Console()],
    }),
  );
}
