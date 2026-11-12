import type { Message } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { serializeError, type Logger } from '../../../shared/logger';
import { LockLostError, ShutdownError, StaleRunError } from '../domain/errors';
import type { ImportProcessor } from './importProcessor';

const messageSchema = z.object({ importId: z.string().uuid() });

export interface JobHandlerDeps {
  processor: Pick<ImportProcessor, 'process' | 'fail'>;
  /** Must match the redrive policy's maxReceiveCount. */
  maxReceiveCount: number;
  logger: Logger;
  shutdownSignal?: AbortSignal;
}

/**
 * Adapts an SQS message to the processor.
 * - Malformed messages are logged and acknowledged (retrying a poison message is pointless).
 * - Errors are rethrown so sqs-consumer leaves the message in the queue; the broker's redrive
 *   policy moves it to the DLQ after maxReceiveCount receives.
 * - On the final receive the import is marked FAILED first, so clients see the outcome
 *   without waiting for someone to inspect the DLQ.
 */
export function createJobHandler(deps: JobHandlerDeps): (message: Message) => Promise<void> {
  return async (message) => {
    const correlationId = message.MessageAttributes?.correlationId?.StringValue;

    let importId: string;
    try {
      importId = messageSchema.parse(JSON.parse(message.Body ?? '')).importId;
    } catch {
      deps.logger.error('discarding malformed message', {
        messageId: message.MessageId,
        correlationId,
      });
      return;
    }

    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const log = deps.logger.child({
      importId,
      correlationId,
      messageId: message.MessageId,
      receiveCount,
    });

    try {
      await deps.processor.process(importId, { correlationId, signal: deps.shutdownSignal });
    } catch (err) {
      log.error('import processing failed', serializeError(err));
      // Shutdown, a lost lock and a fenced-out run all mean "someone else owns the import now":
      // rethrow so the message is redelivered (and then skipped or continued), never fail it.
      const ownedElsewhere =
        err instanceof ShutdownError ||
        err instanceof LockLostError ||
        err instanceof StaleRunError;
      if (!ownedElsewhere && receiveCount >= deps.maxReceiveCount) {
        // The stored message is returned by the API: never include err.message (SQL, driver
        // or network details). The full error is in the log above.
        await deps.processor
          .fail(importId, `Processing failed after ${receiveCount} attempts`)
          .catch((e: unknown) => log.error('failed to mark import as FAILED', serializeError(e)));
      }
      throw err;
    }
  };
}
