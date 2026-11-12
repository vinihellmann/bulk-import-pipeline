import type { Message } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import type { Logger } from '../../infra/logger';
import { serializeError } from '../../infra/logger';
import { ShutdownError } from './errors';
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
      if (!(err instanceof ShutdownError) && receiveCount >= deps.maxReceiveCount) {
        const reason = err instanceof Error ? err.message : String(err);
        await deps.processor
          .fail(importId, `Processing failed after ${receiveCount} attempts: ${reason}`)
          .catch((e: unknown) => log.error('failed to mark import as FAILED', serializeError(e)));
      }
      throw err;
    }
  };
}
