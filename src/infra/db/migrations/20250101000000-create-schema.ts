import { DataTypes, type QueryInterface } from 'sequelize';

const options = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };

export const name = '20250101000000-create-schema';

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable(
    'imports',
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      idempotency_key: { type: DataTypes.STRING(255), allowNull: false },
      file_name: { type: DataTypes.STRING(255), allowNull: false },
      format: { type: DataTypes.ENUM('csv', 'xlsx'), allowNull: false },
      s3_key: { type: DataTypes.STRING(512), allowNull: false },
      status: {
        type: DataTypes.ENUM(
          'AWAITING_UPLOAD',
          'QUEUED',
          'PROCESSING',
          'COMPLETED',
          'COMPLETED_WITH_ERRORS',
          'FAILED',
        ),
        allowNull: false,
        defaultValue: 'AWAITING_UPLOAD',
      },
      total_rows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      processed_rows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      failed_rows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      error_message: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
    },
    options,
  );
  await qi.addIndex('imports', ['idempotency_key'], {
    unique: true,
    name: 'uq_imports_idempotency_key',
  });

  await qi.createTable(
    'import_errors',
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true, allowNull: false },
      import_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'imports', key: 'id' },
        onDelete: 'CASCADE',
      },
      row_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      field: { type: DataTypes.STRING(64), allowNull: false },
      message: { type: DataTypes.STRING(512), allowNull: false },
    },
    options,
  );
  await qi.addIndex('import_errors', ['import_id'], { name: 'idx_import_errors_import_id' });

  await qi.createTable(
    'products',
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true, allowNull: false },
      sku: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      stock: { type: DataTypes.INTEGER, allowNull: false },
      category: { type: DataTypes.STRING(100), allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      // Deliberately not a foreign key: keeps bulk upserts free of FK lookups.
      last_import_id: { type: DataTypes.UUID, allowNull: true },
    },
    options,
  );
  await qi.addIndex('products', ['sku'], { unique: true, name: 'uq_products_sku' });
  await qi.addIndex('products', ['category'], { name: 'idx_products_category' });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable('products');
  await qi.dropTable('import_errors');
  await qi.dropTable('imports');
}
