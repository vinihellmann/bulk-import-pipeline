import { loadConfig } from '../../config/env';
import { createLogger, serializeError } from '../logger';
import { runMigrations } from './migrator';
import { createSequelize } from './sequelize';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, 'migrate');
  const sequelize = createSequelize(config.db);
  try {
    await sequelize.authenticate();
    const applied = await runMigrations(sequelize);
    logger.info('migrations applied', { applied });
  } finally {
    await sequelize.close();
  }
}

main().catch((err: unknown) => {
  const logger = createLogger('error', 'migrate');
  logger.error('migration failed', serializeError(err));
  process.exit(1);
});
