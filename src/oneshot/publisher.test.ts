import { context, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractTraceCarrierFromMessage } from './consumer-base.js'
import { OneShotPublisher } from './publisher.js'
import { extractTraceContext } from './telemetry/tracer.js'

describe('OneShotPublisher trace propagation', () => {
  afterEach(() => {
    delete process.env.ONESHOT_PLANNING_QUEUE_URL
    delete process.env.ONESHOT_CODE_REVIEW_QUEUE_URL
    trace.disable()
    context.disable()
    vi.restoreAllMocks()
  })

  it('round-trips trace context through SQS attributes and body fallback', async () => {
    process.env.ONESHOT_PLANNING_QUEUE_URL = 'https://example.com/planning.fifo'

    trace.setGlobalTracerProvider(new BasicTracerProvider())
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

    const publisher = new OneShotPublisher('us-east-2') as any
    let capturedInput: Record<string, any> | null = null
    publisher.client = {
      send: vi.fn(async (command: { input: Record<string, any> }) => {
        capturedInput = command.input
        return {}
      }),
    }

    const tracer = trace.getTracer('oneshot-publisher-test')
    let parentTraceId = ''

    await tracer.startActiveSpan('parent', async span => {
      parentTraceId = span.spanContext().traceId
      try {
        await publisher.publishStageMessage(41, 'planning', 2, 'queued_for_planning', false)
      } finally {
        span.end()
      }
    })

    expect(capturedInput).not.toBeNull()
    expect(capturedInput?.MessageAttributes?.traceparent?.StringValue).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/,
    )

    const body = JSON.parse(capturedInput?.MessageBody ?? '{}')
    expect(body.trace_context?.trace_id).toBe(parentTraceId)

    const carrier = extractTraceCarrierFromMessage({
      Body: capturedInput?.MessageBody,
      MessageAttributes: capturedInput?.MessageAttributes,
    })
    const extracted = extractTraceContext(carrier)
    const extractedSpanContext = trace.getSpanContext(extracted)

    expect(extractedSpanContext?.traceId).toBe(parentTraceId)
  })

  it('appends an explicit dedupe token only when requested', async () => {
    process.env.ONESHOT_PLANNING_QUEUE_URL = 'https://example.com/planning.fifo'

    const publisher = new OneShotPublisher('us-east-2') as any
    let capturedInput: Record<string, any> | null = null
    publisher.client = {
      send: vi.fn(async (command: { input: Record<string, any> }) => {
        capturedInput = command.input
        return {}
      }),
    }

    await publisher.publishStageMessage(41, 'planning', 2, 'queued_for_planning', false, {
      dedupeToken: 'stale-republish:1:message-123',
    })

    expect(capturedInput?.MessageDeduplicationId).toBe(
      '41:planning:2:base:stale-republish:1:message-123',
    )
  })

  it('publishes expected implementation SHA and version when provided', async () => {
    process.env.ONESHOT_CODE_REVIEW_QUEUE_URL = 'https://example.com/code-review.fifo'

    const publisher = new OneShotPublisher('us-east-2') as any
    let capturedInput: Record<string, any> | null = null
    publisher.client = {
      send: vi.fn(async (command: { input: Record<string, any> }) => {
        capturedInput = command.input
        return {}
      }),
    }

    await publisher.publishStageMessage(41, 'code_review', 4, 'queued_for_code_review', false, {
      expectedImplementationCommitSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      expectedImplementationVersion: 3,
    })

    const body = JSON.parse(capturedInput?.MessageBody ?? '{}')
    expect(body.expected_implementation_commit_sha).toBe(
      'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    )
    expect(body.expected_implementation_version).toBe(3)
  })
})
