import type { Logger } from '../infra/logger';

/**
 * Registers SIGTERM/SIGINT handlers that run `cleanup` once, then exit.
 * A hard timeout guarantees the process cannot hang forever on a stuck resource.
 */
export function registerShutdown(
  logger: Logger,
  cleanup: () => Promise<void>,
  forceAfterMs = 90_000,
): void {
  let started = false;

  const handle = (signal: string): void => {
    if (started) return;
    started = true;
    logger.info('shutdown requested', { signal });

    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, forceAfterMs);
    timer.unref();

    cleanup()
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error('shutdown failed', { err: String(err) });
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
