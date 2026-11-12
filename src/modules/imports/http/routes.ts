import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { serializeError } from '../../../shared/logger';
import { parseInput } from '../../../http/validate';
import type { ImportService } from '../application/importService';
import { toImportDto } from './dto';
import {
  createImportBodySchema,
  idempotencyHeaderSchema,
  importIdParamsSchema,
  listErrorsQuerySchema,
} from './schemas';

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
      clientId: req.principal.clientId,
      idempotencyKey: headers['idempotency-key'],
      fileName: body.fileName,
      format: body.format,
      fileSize: body.fileSize,
    });

    res
      .status(result.created ? 201 : 200)
      .location(`/v1/imports/${result.import.id}`)
      .json({
        import: toImportDto(result.import),
        upload: result.upload,
      });
  });

  router.post('/:id/start', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    const rec = await service.start(req.principal.clientId, id, req.requestId);
    res.status(202).json({ import: toImportDto(rec) });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    res.json({ import: toImportDto(await service.get(req.principal.clientId, id)) });
  });

  router.get('/:id/errors', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    const query = parseInput(listErrorsQuerySchema, req.query, 'query');
    res.json(await service.listErrors(req.principal.clientId, id, query.cursor, query.limit));
  });

  router.get('/:id/errors.csv', async (req, res) => {
    const { id } = parseInput(importIdParamsSchema, req.params, 'path');
    const rec = await service.get(req.principal.clientId, id); // 404 before any byte is written

    res.status(200);
    res.attachment(`import-${rec.id}-errors.csv`);
    res.type('text/csv; charset=utf-8');

    // pipeline() honours backpressure and stops reading from MySQL if the client goes away.
    try {
      await pipeline(Readable.from(service.streamErrorCsv(req.principal.clientId, id)), res);
    } catch (err) {
      req.log.warn('error report stream aborted', serializeError(err));
    }
  });

  return router;
}
