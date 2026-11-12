import { Sequelize } from 'sequelize';

export interface DbSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
  ssl?: {
    enabled: boolean;
    /** PEM content (already resolved from a path by the config loader). */
    ca?: string;
    rejectUnauthorized: boolean;
  };
}

export function createSequelize(db: DbSettings): Sequelize {
  return new Sequelize(db.name, db.user, db.password, {
    host: db.host,
    port: db.port,
    dialect: 'mysql',
    logging: false,
    timezone: '+00:00',
    pool: { max: 10, min: 0, acquire: 30_000, idle: 10_000 },
    ...(db.ssl?.enabled
      ? {
          dialectOptions: {
            ssl: {
              ...(db.ssl.ca ? { ca: db.ssl.ca } : {}),
              rejectUnauthorized: db.ssl.rejectUnauthorized,
              minVersion: 'TLSv1.2',
            },
          },
        }
      : {}),
  });
}
