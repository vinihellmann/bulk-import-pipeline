import type { Message } from '@aws-sdk/client-sqs';
import { ShutdownError } from '../../src/modules/imports/errors';
import { createJobHandler } from '../../src/modules/imports/jobHandler';
import { silentLogger } from './fakes';

const IMPORT_ID = '0b7c3d4e-1f2a-4b5c-8d9e-0f1a2b3c4d5e';

const message = (receiveCount: number, body = JSON.stringify({ importId: IMPORT_ID })): Message => ({
  MessageId: 'm-1',
  Body: body,
  Attributes: { ApproximateReceiveCount: String(receiveCount) },
  MessageAttributes: { correlationId: { DataType: 'String', StringValue: 'corr-1' } },
});

function setup(processImpl: () => Promise<unknown>) {
  const processor = {
    process: jest.fn(processImpl),
    fail: jest.fn(async () => undefined),
  };
  const handler = createJobHandler({
    processor: processor as never,
    maxReceiveCount: 3,
    logger: silentLogger,
  });
  return { processor, handler };
}

describe('createJobHandler', () => {
  it('passes the import id and correlation id to the processor', async () => {
    const { processor, handler } = setup(async () => 'completed');
    await handler(message(1));
    expect(processor.process).toHaveBeenCalledWith(IMPORT_ID, {
      correlationId: 'corr-1',
      signal: undefined,
    });
  });

  it('acknowledges malformed messages instead of retrying them forever', async () => {
    const { processor, handler } = setup(async () => 'completed');
    await expect(handler(message(1, 'not json'))).resolves.toBeUndefined();
    await expect(handler(message(1, JSON.stringify({ importId: 42 })))).resolves.toBeUndefined();
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('rethrows unexpected errors so the message is redelivered', async () => {
    const { processor, handler } = setup(async () => {
      throw new Error('mysql gone away');
    });
    await expect(handler(message(1))).rejects.toThrow('mysql gone away');
    expect(processor.fail).not.toHaveBeenCalled();
  });

  it('marks the import FAILED on the last receive before the message goes to the DLQ', async () => {
    const { processor, handler } = setup(async () => {
      throw new Error('mysql gone away');
    });
    await expect(handler(message(3))).rejects.toThrow('mysql gone away');
    expect(processor.fail).toHaveBeenCalledWith(
      IMPORT_ID,
      'Processing failed after 3 attempts: mysql gone away',
    );
  });

  it('does not mark FAILED when the worker is shutting down', async () => {
    const { processor, handler } = setup(async () => {
      throw new ShutdownError();
    });
    await expect(handler(message(3))).rejects.toBeInstanceOf(ShutdownError);
    expect(processor.fail).not.toHaveBeenCalled();
  });
});
