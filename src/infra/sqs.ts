import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { JobQueue } from '../modules/imports/types';

export interface SqsSettings {
  region: string;
  endpoint?: string;
}

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
  });
}

export function createJobQueue(client: SQSClient, queueUrl: string): JobQueue {
  return {
    async enqueueImport(importId, correlationId) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ importId }),
          MessageAttributes: {
            correlationId: { DataType: 'String', StringValue: correlationId },
          },
        }),
      );
    },
  };
}
