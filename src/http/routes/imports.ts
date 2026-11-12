import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { serializeError } from '../../infra/logger';
import { toImportDto, type ImportService } from '../../modules/imports/importService';
import {
  createImportBodySchema,
  idempotencyHeaderSchema,
  importIdParamsSchema,
  listErrorsQuerySchema,
} from '../../modules/imports/schemas';
import { parseInput } from '../validate';

export function importsRouter(service: ImportService): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    const headers = parseInput(
      idempotencyHeaderSchema,
      { 'idempotency-key': req.get('idempotency-key') },
      'header',
    );
    const body = parseInput(createImportBodySchema, req.body ?? {}, 'body');

    const result = await service.create({
      idempotencyKey: headers['idempotency-key'],
      fileName: body.fileName,
      format: body.format,
    });

    res
      .status(result.created ? 201 : 200)
      .location(`/v1/imports/${result.import.id}`)
      .json({
        import: toImportDto(result.import),
        upload:
          result.uploadUrl !== null
            ? { method: 'PUT', url: result.uploadUrl, expiresAt: result.expiresAt }
            : null,
      });
  });

  router.post('/:id/start', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    const rec = await service.start(id, req.requestId);
    res.status(202).json({ import: toImportDto(rec) });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    res.json({ import: toImportDto(await service.get(id)) });
  });

  router.get('/:id/errors', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    const query = parseInput(listErrorsQuerySchema, req.query, 'query');
    res.json(await service.listErrors(id, query.cursor, query.limit));
  });

  router.get('/:id/errors.csv', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    const rec = await service.get(id); // 404 before any byte is written

    res.status(200);
    res.attachment(`import-${rec.id}-errors.csv`);
    res.type('text/csv; charset=utf-8');

    // pipeline() honours backpressure and stops reading from MySQL if the client goes away.
    try {
      await pipeline(Readable.from(service.streamErrorCsv(id)), res);
    } catch (err) {
      req.log.warn('error report stream aborted', serializeError(err));
    }
  });

  return router;
}
