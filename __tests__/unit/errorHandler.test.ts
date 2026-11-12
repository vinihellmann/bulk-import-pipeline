import express from 'express';
import request from 'supertest';
import { errorHandler, notFoundHandler, toProblem } from '../../src/http/middleware/errorHandler';
import { requestContext } from '../../src/http/middleware/requestContext';
import { csvEscape } from '../../src/modules/imports/infrastructure/csvExport';
import {
  ConflictError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../../src/shared/errors';
import { silentLogger } from './fakes';

describe('toProblem', () => {
  it('maps validation errors to 400 with field details', () => {
    const problem = toProblem(
      new ValidationError('Request validation failed', [
        { location: 'body', field: 'format', message: 'Invalid enum value' },
      ]),
    );
    expect(problem).toMatchObject({
      status: 400,
      title: 'Request validation failed',
      type: expect.stringContaining('validation-error'),
      errors: [{ location: 'body', field: 'format', message: 'Invalid enum value' }],
    });
  });

  it.each([
    [new UnauthorizedError(), 401],
    [new ConflictError('already started'), 409],
    [new TooManyRequestsError(), 429],
  ])('maps %p to its status', (err, status) => {
    const problem = toProblem(err);
    expect(problem.status).toBe(status);
    expect(problem).not.toHaveProperty('errors');
  });

  it('maps body-parser errors to client errors', () => {
    expect(toProblem({ type: 'entity.parse.failed', status: 400 }).status).toBe(400);
    expect(toProblem({ type: 'entity.too.large', status: 413 }).status).toBe(413);
  });

  it('hides internals of unexpected errors', () => {
    const problem = toProblem(new Error("ER_ACCESS_DENIED_ERROR: user 'root'@'10.0.0.5'"));
    expect(problem.status).toBe(500);
    expect(JSON.stringify(problem)).not.toContain('root');
  });
});

describe('errorHandler middleware', () => {
  const app = express();
  app.use(requestContext(silentLogger));
  app.use(express.json({ limit: '1kb' }));
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.get('/async-conflict', async () => {
    throw new ConflictError('async rejection is forwarded by Express 5');
  });
  app.use(notFoundHandler());
  app.use(errorHandler(silentLogger));

  it('responds with application/problem+json and the request id', async () => {
    const res = await request(app).get('/boom').set('X-Request-Id', 'req-123');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 500, requestId: 'req-123', instance: '/boom' });
  });

  it('handles rejected promises from async handlers', async () => {
    const res = await request(app).get('/async-conflict');
    expect(res.status).toBe(409);
    expect(res.body.title).toBe('async rejection is forwarded by Express 5');
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Malformed JSON');
  });

  it('returns 413 for oversized bodies', async () => {
    const res = await request(app)
      .post('/echo')
      .send({ blob: 'x'.repeat(2048) });
    expect(res.status).toBe(413);
  });

  it('returns 404 problems for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.type).toContain('not-found');
  });
});

describe('csvEscape', () => {
  it('quotes separators and neutralizes spreadsheet formulas', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvEscape(42)).toBe('42');
  });
});
