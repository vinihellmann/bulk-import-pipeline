import { DataTypes, type QueryInterface } from 'sequelize';

export const name = '20261112000000-products-per-client';

export async function up(qi: QueryInterface): Promise<void> {
  // Rows created before products were scoped belong to the legacy 'default' client, matching
  // imports.client_id.
  await qi.addColumn('products', 'client_id', {
    type: DataTypes.STRING(64),
    allowNull: false,
    defaultValue: 'default',
  });
  // Backfill: a product belongs to the client of the import that last wrote it. A SKU that two
  // clients already overwrote stays with whoever wrote it last; that history is not recoverable.
  await qi.sequelize.query(
    'UPDATE products p JOIN imports i ON i.id = p.last_import_id SET p.client_id = i.client_id',
  );
  // Create the new unique index before dropping the old one so uniqueness is never unenforced.
  await qi.addIndex('products', ['client_id', 'sku'], {
    unique: true,
    name: 'uq_products_client_sku',
  });
  await qi.removeIndex('products', 'uq_products_sku');
}

export async function down(qi: QueryInterface): Promise<void> {
  // Fails if two clients now share a SKU: that data cannot be represented in the old schema and
  // must be resolved by hand.
  await qi.addIndex('products', ['sku'], { unique: true, name: 'uq_products_sku' });
  await qi.removeIndex('products', 'uq_products_client_sku');
  await qi.removeColumn('products', 'client_id');
}
