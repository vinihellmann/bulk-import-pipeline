import { randomUUID } from 'node:crypto';
import { Op, UniqueConstraintError, type Sequelize, type Transaction } from 'sequelize';
import type { ImportModel, Models } from '../../../infra/db/models';
import { DuplicateIdempotencyKeyError, StaleRunError } from '../domain/errors';
import type { ImportRepository, ProductRepository } from '../domain/ports';
import { sourcesOf } from '../domain/status';
import type { ImportRecord } from '../domain/types';

function toRecord(m: ImportModel): ImportRecord {
  return {
    id: m.id,
    clientId: m.clientId,
    idempotencyKey: m.idempotencyKey,
    fileName: m.fileName,
    format: m.format,
    // BIGINT arrives as a string from mysql2.
    fileSize: m.fileSize === null || m.fileSize === undefined ? null : Number(m.fileSize),
    s3Key: m.s3Key,
    runId: m.runId ?? null,
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

  // Every conditional update derives its allowed source statuses from the domain state machine
  // (domain/status.ts), so the database enforces the same transitions the domain describes.
  const from = (to: Parameters<typeof sourcesOf>[0]) => ({ [Op.in]: sourcesOf(to) });

  /** Fence condition: the run still owns an import that is still being processed. */
  const currentRun = (id: string, runId: string) => ({ id, runId, status: 'PROCESSING' as const });

  /**
   * Locks the import row and verifies the fence. Holding the row lock until commit serialises
   * the caller with `markProcessing`, so a takeover cannot slip in between check and write.
   */
  async function lockCurrentRun(id: string, runId: string, transaction: Transaction) {
    const row = await Imports.findOne({
      attributes: ['id'],
      where: currentRun(id, runId),
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) throw new StaleRunError(id);
  }

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

    async findForClient(clientId, id) {
      const m = await Imports.findOne({ where: { id, clientId } });
      return m ? toRecord(m) : null;
    },

    async findByIdempotencyKey(clientId, key) {
      const m = await Imports.findOne({ where: { clientId, idempotencyKey: key } });
      return m ? toRecord(m) : null;
    },

    async transitionToQueued(id) {
      const [affected] = await Imports.update(
        { status: 'QUEUED' },
        { where: { id, status: from('QUEUED') } },
      );
      return affected === 1;
    },

    async revertToAwaitingUpload(id) {
      await Imports.update(
        { status: 'AWAITING_UPLOAD' },
        { where: { id, status: from('AWAITING_UPLOAD') } },
      );
    },

    async touchQueued(id, olderThan) {
      // Only one concurrent caller can match `updated_at < olderThan`: the winner moves it forward.
      const [affected] = await Imports.update(
        { updatedAt: new Date() },
        { where: { id, status: 'QUEUED', updatedAt: { [Op.lt]: olderThan } } },
      );
      return affected === 1;
    },

    async markProcessing(id) {
      return sequelize.transaction(async (transaction) => {
        const runId = randomUUID();
        const [affected] = await Imports.update(
          {
            status: 'PROCESSING',
            runId,
            startedAt: new Date(),
            finishedAt: null,
            errorMessage: null,
            totalRows: 0,
            processedRows: 0,
            failedRows: 0,
          },
          { where: { id, status: from('PROCESSING') }, transaction },
        );
        if (affected === 0) return null;
        await Errors.destroy({ where: { importId: id }, transaction });
        return runId;
      });
    },

    async updateCounters(id, runId, counters) {
      await sequelize.transaction(async (transaction) => {
        // MySQL reports 0 affected rows when the values are unchanged, so a plain
        // affectedRows check could mistake "same counters" for "fenced out": verify with a lock.
        await lockCurrentRun(id, runId, transaction);
        await Imports.update(counters, { where: { id }, transaction });
      });
    },

    async finish(id, runId, status, counters) {
      const [affected] = await Imports.update(
        { ...counters, status, finishedAt: new Date() },
        { where: currentRun(id, runId) },
      );
      if (affected === 0) throw new StaleRunError(id);
    },

    async markFailed(id, message, runId) {
      const [affected] = await Imports.update(
        { status: 'FAILED', errorMessage: message.slice(0, 1000), finishedAt: new Date() },
        { where: { id, status: from('FAILED'), ...(runId ? { runId } : {}) } },
      );
      return affected > 0;
    },

    async insertErrors(id, runId, errors) {
      if (errors.length === 0) return;
      await sequelize.transaction(async (transaction) => {
        await lockCurrentRun(id, runId, transaction);
        await Errors.bulkCreate(
          errors.map((e) => ({ importId: id, ...e })),
          { transaction },
        );
      });
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

// Product upserts are intentionally not fenced by a run: they are idempotent upserts keyed by
// SKU of the same file, so a stale worker re-applying a batch is harmless (last import wins).
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
    async upsertBatch(clientId, importId, rows) {
      if (rows.length === 0) return;
      // Stable sort by SKU: a consistent lock order across concurrent batches reduces
      // deadlocks, and stability keeps "last row wins" for duplicate SKUs in one file.
      const sorted = [...rows].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

      await sequelize.transaction(async (transaction) => {
        await ProductModel.bulkCreate(
          sorted.map((r) => ({ ...r, clientId, lastImportId: importId })),
          { updateOnDuplicate: [...UPSERT_COLUMNS], transaction },
        );
      });
    },
  };
}
