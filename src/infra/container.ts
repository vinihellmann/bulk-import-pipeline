import type { AppConfig } from '../config/env';
import { createImportRepository, createProductRepository } from '../modules/imports';
import { initModels } from './db/models';
import { createSequelize } from './db/sequelize';
import { createRedis } from './redis';
import { createObjectStorage } from './s3';
import { createSqsClient } from './sqs';

/**
 * Composition root for infrastructure shared by the API and the worker. Everything that holds
 * a socket is created here and closed by `close()`, which keeps shutdown in one place.
 */
export function createInfrastructure(config: AppConfig) {
  const sequelize = createSequelize(config.db);
  const models = initModels(sequelize);
  const redis = createRedis(config.redis.url, { tlsCa: config.redis.tlsCa });
  const storage = createObjectStorage({ ...config.s3, region: config.region });
  const sqs = createSqsClient({ region: config.region, endpoint: config.sqs.endpoint });

  return {
    sequelize,
    models,
    redis,
    storage,
    sqs,
    importRepository: createImportRepository(models, sequelize),
    productRepository: createProductRepository(models, sequelize),
    readinessChecks: {
      mysql: () => sequelize.query('SELECT 1'),
      redis: () => redis.ping(),
      s3: () => storage.checkBucket(),
    },
    async close(): Promise<void> {
      storage.destroy();
      sqs.destroy();
      await Promise.allSettled([sequelize.close(), redis.quit()]);
    },
  };
}

export type Infrastructure = ReturnType<typeof createInfrastructure>;
