import { Op, UniqueConstraintError, type Sequelize } from 'sequelize';
import type { ImportModel, Models } from '../../infra/db/models';
import { DuplicateIdempotencyKeyError } from './errors';
import type { ImportRecord, ImportRepository, ProductRepository } from './types';

function toRecord(m: ImportModel): ImportRecord {
  return {
    id: m.id,
    idempotencyKey: m.idempotencyKey,
    fileName: m.fileName,
    format: m.format,
    s3Key: m.s3Key,
    status: m.status,
    totalRows: Number(m.totalRows ?? 0),
    processedRows: Number(m.processedRows ?? 0),
    failedRows: Number(m.failedRows ?? 0),
    errorMessage: m.errorMessage ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    startedAt: m.startedAt ?? null,
    finishedAt: m.finishedAt ?? null,
  };
}

export function createImportRepository(models: Models, sequelize: Sequelize): ImportRepository {
  const { ImportModel: Imports, ImportErrorModel: Errors } = models;

  return {
    async create(input) {
      try {
        const created = await Imports.create({ ...input, status: 'AWAITING_UPLOAD' });
        // Re-read so defaults (counters, timestamps) come from the database, not the instance.
        const fresh = await Imports.findByPk(created.id);
        return toRecord(fresh ?? created);
      } catch (err) {
        if (err instanceof UniqueConstraintError) throw new DuplicateIdempotencyKeyError();
        throw err;
      }
    },

    async findById(id) {
      const m = await Imports.findByPk(id);
      return m ? toRecord(m) : null;
    },

    async findByIdempotencyKey(key) {
      const m = await Imports.findOne({ where: { idempotencyKey: key } });
      return m ? toRecord(m) : null;
    },

    async transitionToQueued(id) {
      const [affected] = await Imports.update(
        { status: 'QUEUED' },
        { where: { id, status: 'AWAITING_UPLOAD' } },
      );
      return affected === 1;
    },

    async revertToAwaitingUpload(id) {
      await Imports.update({ status: 'AWAITING_UPLOAD' }, { where: { id, status: 'QUEUED' } });
    },

    async markProcessing(id) {
      await sequelize.transaction(async (transaction) => {
        await Errors.destroy({ where: { importId: id }, transaction });
        await Imports.update(
          {
            status: 'PROCESSING',
            startedAt: new Date(),
            finishedAt: null,
            errorMessage: null,
            totalRows: 0,
            processedRows: 0,
            failedRows: 0,
          },
          { where: { id }, transaction },
        );
      });
    },

    async updateCounters(id, counters) {
      await Imports.update(counters, { where: { id } });
    },

    async finish(id, status, counters) {
      await Imports.update({ ...counters, status, finishedAt: new Date() }, { where: { id } });
    },

    async markFailed(id, message) {
      await Imports.update(
        { status: 'FAILED', errorMessage: message.slice(0, 1000), finishedAt: new Date() },
        { where: { id } },
      );
    },

    async insertErrors(id, errors) {
      if (errors.length === 0) return;
      await Errors.bulkCreate(errors.map((e) => ({ importId: id, ...e })));
    },

    async listErrors(id, afterId, limit) {
      const rows = await Errors.findAll({
        where: { importId: id, id: { [Op.gt]: afterId } },
        order: [['id', 'ASC']],
        limit,
      });
      return rows.map((r) => ({
        id: Number(r.id),
        rowNumber: Number(r.rowNumber),
        field: r.field,
        message: r.message,
      }));
    },
  };
}

const UPSERT_COLUMNS = [
  'name',
  'description',
  'price',
  'stock',
  'category',
  'lastImportId',
  'updatedAt',
] as const;

export function createProductRepository(models: Models, sequelize: Sequelize): ProductRepository {
  const { ProductModel } = models;

  return {
    async upsertBatch(importId, rows) {
      if (rows.length === 0) return;
      // Stable sort by SKU: a consistent lock order across concurrent batches reduces
      // deadlocks, and stability keeps "last row wins" for duplicate SKUs in one file.
      const sorted = [...rows].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

      await sequelize.transaction(async (transaction) => {
        await ProductModel.bulkCreate(
          sorted.map((r) => ({ ...r, lastImportId: importId })),
          { updateOnDuplicate: [...UPSERT_COLUMNS], transaction },
        );
      });
    },
  };
}
