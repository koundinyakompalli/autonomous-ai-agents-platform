import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { createLogger } from '../utils/logger.js'
import type { OneShotState } from './types.js'
import {
  ONE_SHOT_CODE_REVIEW_QUEUE_ENV,
  ONE_SHOT_IMPLEMENTATION_QUEUE_ENV,
  ONE_SHOT_PLANNING_QUEUE_ENV,
  ONE_SHOT_REVIEW_QUEUE_ENV,
  ONE_SHOT_TESTING_QUEUE_ENV,
  type OneShotQueueMessage,
  type OneShotQueueStage,
} from './contracts.js'
import { serializeTraceContext, withOperationSpan } from './telemetry/tracer.js'

const logger = createLogger('oneshot-publisher')

const STAGE_TO_ENV: Record<OneShotQueueStage, string> = {
  planning: ONE_SHOT_PLANNING_QUEUE_ENV,
  review: ONE_SHOT_REVIEW_QUEUE_ENV,
  implementation: ONE_SHOT_IMPLEMENTATION_QUEUE_ENV,
  code_review: ONE_SHOT_CODE_REVIEW_QUEUE_ENV,
  testing: ONE_SHOT_TESTING_QUEUE_ENV,
}

function getQueueUrl(stage: OneShotQueueStage): string {
  const envName = STAGE_TO_ENV[stage]
  const queueUrl = process.env[envName]
  if (!queueUrl) {
    throw new Error(`Missing required OneShot queue environment variable: ${envName}`)
  }

  return queueUrl
}

export class OneShotPublisher {
  private readonly client: SQSClient

  constructor(region = process.env.AWS_REGION || 'us-east-2') {
    this.client = new SQSClient({ region })
  }

  async publishStageMessage(
    runId: number,
    stage: OneShotQueueStage,
    version: number,
    expectedState: OneShotState,
    revision = false,
    options?: {
      dedupeToken?: string
      expectedImplementationCommitSha?: string | null
      expectedImplementationVersion?: number | null
    },
  ): Promise<void> {
    await withOperationSpan(
      'publish_stage_message',
      {
        'oneshot.run_id': runId,
        'oneshot.stage': stage,
        'oneshot.version': version,
        'oneshot.revision': revision,
      },
      async (span) => {
        const traceCarrier = serializeTraceContext()
        const traceContext = {
          trace_id: span.spanContext().traceId,
          span_id: span.spanContext().spanId,
        }

        const message: OneShotQueueMessage = {
          run_id: runId,
          stage,
          version,
          expected_state: expectedState,
          revision,
          emitted_at: new Date().toISOString(),
          ...(options?.expectedImplementationCommitSha
            ? { expected_implementation_commit_sha: options.expectedImplementationCommitSha }
            : {}),
          ...(options?.expectedImplementationVersion
            ? { expected_implementation_version: options.expectedImplementationVersion }
            : {}),
          trace_context: traceContext,
        }

        const queueUrl = getQueueUrl(stage)
        const dedupeKind = revision ? 'revision' : 'base'
        const messageDeduplicationId = [
          `${runId}:${stage}:${version}:${dedupeKind}`,
          options?.dedupeToken,
        ].filter(Boolean).join(':')
        const messageGroupId = String(runId)

        await this.client.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(message),
            MessageGroupId: messageGroupId,
            MessageDeduplicationId: messageDeduplicationId,
            MessageAttributes: {
              ...(traceCarrier.traceparent ? {
                traceparent: {
                  DataType: 'String',
                  StringValue: traceCarrier.traceparent,
                },
              } : {}),
              ...(traceCarrier.tracestate ? {
                tracestate: {
                  DataType: 'String',
                  StringValue: traceCarrier.tracestate,
                },
              } : {}),
            },
          }),
        )

        logger.info({
          runId,
          stage,
          version,
          expectedState,
          revision,
          queueUrl,
          messageGroupId,
          messageDeduplicationId,
          expectedImplementationCommitSha: options?.expectedImplementationCommitSha ?? null,
          expectedImplementationVersion: options?.expectedImplementationVersion ?? null,
        }, 'Published OneShot queue message')
      },
    )
  }
}
