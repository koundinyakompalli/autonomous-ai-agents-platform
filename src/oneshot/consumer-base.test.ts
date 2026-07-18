import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQSClient } from '@aws-sdk/client-sqs'
import type { Message } from '@aws-sdk/client-sqs'
import { extractTraceCarrierFromMessage, QueueConsumerBase, type TransientRetryMetadata } from './consumer-base.js'
import { resetBackoffScheduleCache } from './consumer-visibility.js'

describe('extractTraceCarrierFromMessage', () => {
  it('falls back to trace_context from the message body when SQS attributes are missing', () => {
    const carrier = extractTraceCarrierFromMessage({
      Body: JSON.stringify({
        run_id: 12,
        stage: 'planning',
        version: 1,
        expected_state: 'queued_for_planning',
        revision: false,
        emitted_at: new Date().toISOString(),
        trace_context: {
          trace_id: '0123456789abcdef0123456789abcdef',
          span_id: '0123456789abcdef',
        },
      }),
      MessageAttributes: undefined,
    })

    expect(carrier.traceparent).toBe('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01')
  })

  it('prefers explicit SQS message attributes over the body fallback', () => {
    const carrier = extractTraceCarrierFromMessage({
      Body: JSON.stringify({
        trace_context: {
          trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          span_id: 'bbbbbbbbbbbbbbbb',
        },
      }),
      MessageAttributes: {
        traceparent: {
          DataType: 'String',
          StringValue: '00-11111111111111111111111111111111-2222222222222222-01',
        },
      },
    })

    expect(carrier.traceparent).toBe('00-11111111111111111111111111111111-2222222222222222-01')
  })
})

// Minimal concrete subclass to exercise QueueConsumerBase methods
class TestableConsumer extends QueueConsumerBase {
  constructor(sqsClient: SQSClient) {
    super('https://sqs.us-east-1.amazonaws.com/test/queue', 'planning', sqsClient)
  }

  protected getVisibilityTimeoutSeconds(): number {
    return 1800
  }

  protected async handleMessage(_message: Message, _receiveCount: number): Promise<boolean> {
    return true
  }

  async callShortenVisibilityForTransientRetry(
    message: Message,
    receiveCount: number,
  ): Promise<TransientRetryMetadata | null> {
    return this.shortenVisibilityForTransientRetry(message, receiveCount)
  }
}

describe('QueueConsumerBase.shortenVisibilityForTransientRetry', () => {
  let sendMock: ReturnType<typeof vi.fn>
  let sqsClient: SQSClient
  let consumer: TestableConsumer

  beforeEach(() => {
    vi.unstubAllEnvs()
    resetBackoffScheduleCache()
    sendMock = vi.fn().mockResolvedValue({})
    sqsClient = { send: sendMock } as unknown as SQSClient
    consumer = new TestableConsumer(sqsClient)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetBackoffScheduleCache()
  })

  it('returns null when receiveCount>=4 (exhausted)', async () => {
    const message: Message = { ReceiptHandle: 'handle', MessageId: 'msg-1' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 4)
    expect(result).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('returns null when receiveCount=5 (exhausted)', async () => {
    const message: Message = { ReceiptHandle: 'handle', MessageId: 'msg-1' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 5)
    expect(result).toBeNull()
  })

  it('sends ChangeMessageVisibilityCommand with 120s for receiveCount=1', async () => {
    const message: Message = { ReceiptHandle: 'handle-rc1', MessageId: 'msg-1' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 1)
    expect(result).not.toBeNull()
    expect(result!.retryDelaySeconds).toBe(120)
    expect(result!.retryAttempt).toBe(1)
    expect(result!.maxRetryAttempts).toBe(3)
    expect(result!.visibilityChangeStatus).toBe('success')
    expect(result!.nextRetryTimestamp).toBeTruthy()
    expect(sendMock).toHaveBeenCalledOnce()
    const cmd = sendMock.mock.calls[0][0]
    expect(cmd.input.VisibilityTimeout).toBe(120)
    expect(cmd.input.ReceiptHandle).toBe('handle-rc1')
  })

  it('sends ChangeMessageVisibilityCommand with 300s for receiveCount=2', async () => {
    const message: Message = { ReceiptHandle: 'handle-rc2', MessageId: 'msg-2' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 2)
    expect(result!.retryDelaySeconds).toBe(300)
    const cmd = sendMock.mock.calls[0][0]
    expect(cmd.input.VisibilityTimeout).toBe(300)
  })

  it('sends ChangeMessageVisibilityCommand with 600s for receiveCount=3', async () => {
    const message: Message = { ReceiptHandle: 'handle-rc3', MessageId: 'msg-3' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 3)
    expect(result!.retryDelaySeconds).toBe(600)
    const cmd = sendMock.mock.calls[0][0]
    expect(cmd.input.VisibilityTimeout).toBe(600)
  })

  it('returns metadata with visibilityChangeStatus=failed on SQS error', async () => {
    sendMock.mockRejectedValueOnce(new Error('SQS visibility change failed'))
    const message: Message = { ReceiptHandle: 'handle', MessageId: 'msg-1' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 1)
    expect(result).not.toBeNull()
    expect(result!.visibilityChangeStatus).toBe('failed')
    expect(result!.retryDelaySeconds).toBe(120)
    expect(result!.retryAttempt).toBe(1)
    expect(result!.nextRetryTimestamp).toBeNull()
  })

  it('returns failed status when ReceiptHandle is missing', async () => {
    const message: Message = { MessageId: 'msg-1' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 1)
    expect(result).not.toBeNull()
    expect(result!.visibilityChangeStatus).toBe('failed')
    expect(result!.nextRetryTimestamp).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('nextRetryTimestamp is approximately now + delaySeconds', async () => {
    const before = Date.now()
    const message: Message = { ReceiptHandle: 'handle', MessageId: 'msg-1' }
    const result = await consumer.callShortenVisibilityForTransientRetry(message, 1)
    const after = Date.now()
    const nextRetryTimestamp = result!.nextRetryTimestamp
    expect(nextRetryTimestamp).not.toBeNull()
    const ts = new Date(nextRetryTimestamp!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before + 120_000)
    expect(ts).toBeLessThanOrEqual(after + 120_000 + 100)
  })
})
