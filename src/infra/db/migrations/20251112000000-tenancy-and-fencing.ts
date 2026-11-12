import { DataTypes, type QueryInterface } from 'sequelize';

export const name = '20251112000000-tenancy-and-fencing';

export async function up(qi: QueryInterface): Promise<void> {
  // Rows created before multi-tenancy belong to the legacy 'default' client.
  await qi.addColumn('imports', 'client_id', {
    type: DataTypes.STRING(64),
    allowNull: false,
    defaultValue: 'default',
  });
  // Declared upload size (signed into the presigned URL); NULL for legacy rows.
  await qi.addColumn('imports', 'file_size', {
    type: DataTypes.BIGINT.UNSIGNED,
    allowNull: true,
  });
  // Fencing token of the current processing run.
  await qi.addColumn('imports', 'run_id', { type: 'CHAR(36)', allowNull: true });

  // Create the new unique index before dropping the old one so uniqueness is never unenforced.
  await qi.addIndex('imports', ['client_id', 'idempotency_key'], {
    unique: true,
    name: 'uq_imports_client_idempotency',
  });
  await qi.removeIndex('imports', 'uq_imports_idempotency_key');
  await qi.addIndex('imports', ['client_id', 'created_at'], { name: 'idx_imports_client_created' });
}

export async function down(qi: QueryInterface): Promise<void> {
  // Fails if two clients now share an idempotency key: that data cannot be represented in the
  // old single-tenant schema and must be resolved by hand.
  await qi.addIndex('imports', ['idempotency_key'], {
    unique: true,
    name: 'uq_imports_idempotency_key',
  });
  await qi.removeIndex('imports', 'idx_imports_client_created');
  await qi.removeIndex('imports', 'uq_imports_client_idempotency');
  await qi.removeColumn('imports', 'run_id');
  await qi.removeColumn('imports', 'file_size');
  await qi.removeColumn('imports', 'client_id');
}
