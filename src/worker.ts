import { loadConfig } from './config/env';
import { createInfrastructure } from './infra/container';
import { createLogger } from './infra/logger';
import { serializeError } from './shared/logger';
import { registerShutdown } from './shared/shutdown';
import { createWorker } from './workerRuntime';

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'worker');
  for (const warning of config.warnings) logger.warn('insecure configuration', { warning });
  const infra = createInfrastructure(config);
  const worker = createWorker({ config, infra, logger });

  worker.start();

  registerShutdown(
    logger,
    async () => {
      await worker.stop();
      await infra.close();
    },
    config.import.shutdownGraceMs + 30_000,
  );
}

try {
  main();
} catch (err) {
  createLogger('error', 'worker').error('worker failed to start', serializeError(err));
  process.exit(1);
}
