import { SequelizeStorage, Umzug } from 'umzug';
import type { QueryInterface, Sequelize } from 'sequelize';
import * as createSchema from './migrations/20250101000000-create-schema';
import * as tenancyAndFencing from './migrations/20251112000000-tenancy-and-fencing';
import * as productsPerClient from './migrations/20261112000000-products-per-client';

interface MigrationModule {
  name: string;
  up(qi: QueryInterface): Promise<void>;
  down(qi: QueryInterface): Promise<void>;
}

// Explicit registry instead of a glob: works identically under tsx, tsc output and jest.
const migrations: MigrationModule[] = [createSchema, tenancyAndFencing, productsPerClient];

export function createMigrator(sequelize: Sequelize): Umzug<QueryInterface> {
  return new Umzug<QueryInterface>({
    migrations: migrations.map((m) => ({
      name: m.name,
      up: async ({ context }) => m.up(context),
      down: async ({ context }) => m.down(context),
    })),
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: undefined,
  });
}

export async function runMigrations(sequelize: Sequelize): Promise<string[]> {
  const executed = await createMigrator(sequelize).up();
  return executed.map((m) => m.name);
}
