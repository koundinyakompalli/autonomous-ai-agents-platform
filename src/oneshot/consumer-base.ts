import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs'
import { context } from '@opentelemetry/api'
import { createLogger } from '../utils/logger.js'
import { type OneShotQueueStage } from './contracts.js'
import { recordStageMetrics } from './telemetry/metrics.js'
import { extractTraceContext, withStageSpan } from './telemetry/tracer.js'
import { isRepoCacheLeaseTimeoutError } from './workspace-lease-errors.js'
import { getTransientRetryDelaySeconds, getTransientRetryMaxAttempts } from './consumer-visibility.js'

const logger = createLogger('oneshot-consumer')
const DEFAULT_HEALTH_STALENESS_MS = 10 * 60 * 1000

export interface TransientRetryMetadata {
  retryAttempt: number;
  maxRetryAttempts: number;
  retryDelaySeconds: number;
  nextRetryTimestamp: string | null;
  visibilityChangeStatus: 'success' | 'failed';
}

export interface QueueConsumerHealthSnapshot {
  stage: OneShotQueueStage
  isRunning: boolean
  activeHandler: boolean
  healthy: boolean
  queueUrl: string
  lastActivityAt: string | null
  staleAfterMs: number
  lastMessageId: string | null
  lastReceiveCount: number | null
  lastError: string | null
}

function buildTraceparentFromBody(body: string | undefined): string | undefined {
  if (!body) {
    return undefined
  }

  try {
    const parsed = JSON.parse(body) as {
      trace_context?: {
        trace_id?: string
        span_id?: string
      }
    }
    const traceId = parsed.trace_context?.trace_id?.trim()
    const spanId = parsed.trace_context?.span_id?.trim()
    if (!traceId || !spanId) {
      return undefined
    }

    return `00-${traceId}-${spanId}-01`
  } catch {
    return undefined
  }
}

function extractRunIdFromBody(body: string | undefined): number | undefined {
  if (!body) {
    return undefined
  }

  try {
    const parsed = JSON.parse(body) as { run_id?: unknown }
    return typeof parsed.run_id === 'number' ? parsed.run_id : undefined
  } catch {
    return undefined
  }
}

export function extractTraceCarrierFromMessage(message: Pick<Message, 'Body' | 'MessageAttributes'>): Record<string, string> {
  const carrier: Record<string, string> = {}

  if (message.MessageAttributes?.traceparent?.StringValue) {
    carrier.traceparent = message.MessageAttributes.traceparent.StringValue
  }
  if (message.MessageAttributes?.tracestate?.StringValue) {
    carrier.tracestate = message.MessageAttributes.tracestate.StringValue
  }

  if (!carrier.traceparent) {
    const bodyTraceparent = buildTraceparentFromBody(message.Body)
    if (bodyTraceparent) {
      carrier.traceparent = bodyTraceparent
    }
  }

  return carrier
}

export abstract class QueueConsumerBase {
  private isRunning = false
  private activeHandler: Promise<void> | null = null
  private lastActivityAt: number | null = null
  private lastMessageId: string | null = null
  private lastReceiveCount: number | null = null
  private lastError: string | null = null

  constructor(
    protected readonly queueUrl: string,
    protected readonly stage: OneShotQueueStage,
    protected readonly sqsClient: SQSClient,
  ) {}

  async start(): Promise<void> {
    this.isRunning = true
    this.markActivity()
    logger.info({
      stage: this.stage,
      queueUrl: this.queueUrl,
    }, 'Starting OneShot queue consumer')

    while (this.isRunning) {
      this.markActivity()
      const response = await this.sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: this.getVisibilityTimeoutSeconds(),
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          MessageAttributeNames: ['traceparent', 'tracestate'],
        }),
      )
      this.markActivity()

      const message = response.Messages?.[0]
      if (!message) {
        continue
      }

      const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '1', 10)
      logger.info({
        stage: this.stage,
        queueUrl: this.queueUrl,
        messageId: message.MessageId,
        receiveCount,
      }, 'Received OneShot queue message')
      this.lastMessageId = message.MessageId ?? null
      this.lastReceiveCount = receiveCount
      this.markActivity()

      this.activeHandler = this.processMessage(message, receiveCount)
      await this.activeHandler
      this.activeHandler = null
      this.markActivity()
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false

    if (this.activeHandler) {
      logger.info({
        stage: this.stage,
      }, 'Waiting for in-flight handler to complete before shutdown')
      const DRAIN_TIMEOUT_MS = 25_000
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS))
      await Promise.race([this.activeHandler, timeout])
    }
  }

  private async processMessage(message: Message, receiveCount: number): Promise<void> {
    const startedAt = Date.now()
    const carrier = extractTraceCarrierFromMessage(message)
    const parentContext = extractTraceContext(carrier)
    const runId = extractRunIdFromBody(message.Body)
    const heartbeatIntervalSeconds = this.getHeartbeatIntervalSeconds(this.getVisibilityTimeoutSeconds())
    const stopVisibilityHeartbeat = message.ReceiptHandle
      ? this.startVisibilityHeartbeat(
          message.ReceiptHandle,
          this.getVisibilityTimeoutSeconds(),
          heartbeatIntervalSeconds,
          message.MessageId,
          receiveCount,
        )
      : () => undefined
    const stopRunHeartbeat = runId !== undefined
      ? this.startRunHeartbeat(runId, heartbeatIntervalSeconds)
      : () => undefined

    try {
      const shouldDelete = await context.with(parentContext, () =>
        withStageSpan(this.stage, runId, undefined, async (span) => {
          if (message.MessageId) {
            span.setAttribute('messaging.message.id', message.MessageId)
          }
          span.setAttribute('oneshot.receive_count', receiveCount)
          return this.handleMessage(message, receiveCount)
        }),
      )
      recordStageMetrics(this.stage, shouldDelete ? 'success' : 'failed', Date.now() - startedAt, undefined, undefined, {
        acknowledged: shouldDelete,
      })
      this.lastError = null
      this.markActivity()
      if (shouldDelete && message.ReceiptHandle) {
        await this.deleteMessage(message.ReceiptHandle)
        logger.info({
          stage: this.stage,
          messageId: message.MessageId,
          receiveCount,
        }, 'Acknowledged OneShot queue message')
      } else {
        logger.info({
          stage: this.stage,
          messageId: message.MessageId,
          receiveCount,
        }, 'Leaving OneShot queue message for retry or redelivery')
      }
    } catch (error) {
      recordStageMetrics(this.stage, 'failed', Date.now() - startedAt)
      this.lastError = error instanceof Error ? error.message : String(error)
      this.markActivity()
      logger.error({
        stage: this.stage,
        messageId: message.MessageId,
        receiveCount,
        error: error instanceof Error ? error.message : String(error),
      }, 'Queue consumer failed to process message')
    } finally {
      stopRunHeartbeat()
      stopVisibilityHeartbeat()
      this.markActivity()
    }
  }

  protected async extendVisibilityTimeout(
    receiptHandle: string,
    timeoutSeconds: number,
    messageId?: string,
    receiveCount?: number,
  ): Promise<void> {
    await this.sqsClient.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    )
    logger.info({
      stage: this.stage,
      messageId,
      receiveCount,
      timeoutSeconds,
    }, 'Extended OneShot queue message visibility timeout')
    this.markActivity()
  }

  protected async deleteMessage(receiptHandle: string): Promise<void> {
    await this.sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    )
  }

  protected async shortenVisibilityForRepoCacheContention(
    error: unknown,
    message: Message,
    receiveCount: number,
  ): Promise<void> {
    if (!isRepoCacheLeaseTimeoutError(error) || !message.ReceiptHandle) {
      return
    }

    try {
      await this.extendVisibilityTimeout(
        message.ReceiptHandle,
        30,
        message.MessageId,
        receiveCount,
      )
      logger.warn({
        stage: this.stage,
        messageId: message.MessageId,
        receiveCount,
        timeoutSeconds: 30,
        error: error instanceof Error ? error.message : String(error),
      }, 'Shortened OneShot queue visibility after repo-cache lease contention')
    } catch (visibilityError) {
      logger.warn({
        stage: this.stage,
        messageId: message.MessageId,
        receiveCount,
        timeoutSeconds: 30,
        error: visibilityError instanceof Error ? visibilityError.message : String(visibilityError),
      }, 'Failed to shorten OneShot queue visibility after repo-cache lease contention')
    }
  }

  protected async shortenVisibilityForTransientRetry(
    message: Message,
    receiveCount: number,
  ): Promise<TransientRetryMetadata | null> {
    const delaySeconds = getTransientRetryDelaySeconds(receiveCount)
    if (delaySeconds === null) {
      return null
    }

    const maxRetryAttempts = getTransientRetryMaxAttempts()
    const nextRetryTimestamp = new Date(Date.now() + delaySeconds * 1000).toISOString()

    if (!message.ReceiptHandle) {
      return {
        retryAttempt: receiveCount,
        maxRetryAttempts,
        retryDelaySeconds: delaySeconds,
        nextRetryTimestamp: null,
        visibilityChangeStatus: 'failed',
      }
    }

    try {
      await this.extendVisibilityTimeout(
        message.ReceiptHandle,
        delaySeconds,
        message.MessageId,
        receiveCount,
      )
      logger.info({
        stage: this.stage,
        messageId: message.MessageId,
        receiveCount,
        retryDelaySeconds: delaySeconds,
        nextRetryTimestamp,
      }, 'Shortened OneShot queue visibility for transient retry backoff')
      return {
        retryAttempt: receiveCount,
        maxRetryAttempts,
        retryDelaySeconds: delaySeconds,
        nextRetryTimestamp,
        visibilityChangeStatus: 'success',
      }
    } catch (visibilityError) {
      logger.warn({
        stage: this.stage,
        messageId: message.MessageId,
        receiveCount,
        retryDelaySeconds: delaySeconds,
        error: visibilityError instanceof Error ? visibilityError.message : String(visibilityError),
      }, 'Failed to shorten OneShot queue visibility for transient retry backoff')
      return {
        retryAttempt: receiveCount,
        maxRetryAttempts,
        retryDelaySeconds: delaySeconds,
        nextRetryTimestamp: null,
        visibilityChangeStatus: 'failed',
      }
    }
  }

  protected abstract getVisibilityTimeoutSeconds(): number

  protected abstract handleMessage(message: Message, receiveCount: number): Promise<boolean>

  protected async handleRunHeartbeat(_runId: number): Promise<void> {
    // Default no-op. OneShot stage consumers override this to touch the run row
    // while long-running work is still in flight.
  }

  getHealthSnapshot(): QueueConsumerHealthSnapshot {
    const staleAfterMs = this.getHealthStaleAfterMs()
    const ageMs = this.lastActivityAt ? Date.now() - this.lastActivityAt : Number.POSITIVE_INFINITY
    const healthy = this.isRunning && ageMs <= staleAfterMs

    return {
      stage: this.stage,
      isRunning: this.isRunning,
      activeHandler: this.activeHandler !== null,
      healthy,
      queueUrl: this.queueUrl,
      lastActivityAt: this.lastActivityAt ? new Date(this.lastActivityAt).toISOString() : null,
      staleAfterMs,
      lastMessageId: this.lastMessageId,
      lastReceiveCount: this.lastReceiveCount,
      lastError: this.lastError,
    }
  }

  private getHealthStaleAfterMs(): number {
    const visibilityMs = this.getVisibilityTimeoutSeconds() * 1000
    return Math.min(DEFAULT_HEALTH_STALENESS_MS, Math.max(90_000, Math.floor(visibilityMs / 2)))
  }

  private getHeartbeatIntervalSeconds(timeoutSeconds: number): number {
    return Math.min(300, Math.max(30, Math.floor(timeoutSeconds / 3)))
  }

  private startVisibilityHeartbeat(
    receiptHandle: string,
    timeoutSeconds: number,
    intervalSeconds = this.getHeartbeatIntervalSeconds(timeoutSeconds),
    messageId?: string,
    receiveCount?: number,
  ): () => void {
    logger.info({
      stage: this.stage,
      messageId,
      receiveCount,
      timeoutSeconds,
      intervalSeconds,
    }, 'Starting OneShot queue visibility heartbeat')
    const timer = setInterval(() => {
      void this.extendVisibilityTimeout(receiptHandle, timeoutSeconds, messageId, receiveCount).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        logger.error({
          stage: this.stage,
          messageId,
          receiveCount,
          timeoutSeconds,
          error: this.lastError,
        }, 'Failed to extend OneShot queue visibility timeout')
      })
    }, intervalSeconds * 1000)
    timer.unref?.()

    return () => {
      clearInterval(timer)
      logger.info({
        stage: this.stage,
        messageId,
        receiveCount,
      }, 'Stopped OneShot queue visibility heartbeat')
    }
  }

  private startRunHeartbeat(runId: number, intervalSeconds: number): () => void {
    const timer = setInterval(() => {
      void this.handleRunHeartbeat(runId).then(() => {
        this.markActivity()
      }).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        logger.error({
          stage: this.stage,
          runId,
          error: this.lastError,
        }, 'Failed to heartbeat OneShot run row')
      })
    }, intervalSeconds * 1000)
    timer.unref?.()

    return () => clearInterval(timer)
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now()
  }
}
