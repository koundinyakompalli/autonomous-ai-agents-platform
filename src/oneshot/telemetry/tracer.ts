/**
 * Tracer and span helpers for the oneshot pipeline.
 *
 * All functions use the `@opentelemetry/api` facade exclusively so they
 * degrade to noop when the SDK is not initialized (OTEL_ENABLED != true).
 */

import {
  trace,
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  SpanStatusCode,
  type Span,
  type SpanOptions,
  type Context,
} from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

const TRACER_NAME = 'specter-oneshot'
const traceContextPropagator = new W3CTraceContextPropagator()

/**
 * Return the shared tracer instance for the oneshot pipeline.
 * When OTEL is disabled, the global API returns a noop tracer.
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME)
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

/**
 * Start an active span, execute `fn` inside it, and automatically record
 * success or failure before ending the span.
 *
 * Usage:
 * ```ts
 * const result = await withSpan('myOperation', { key: 'value' }, async (span) => {
 *   span.setAttribute('extra', 42)
 *   return doWork()
 * })
 * ```
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer()
  return tracer.startActiveSpan(name, { attributes } as SpanOptions, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * Create a stage-level span for a consumer (planner, reviewer, implementer, etc.).
 *
 * The span is named `oneshot.stage.<stage>` and carries standard oneshot
 * attributes so traces can be filtered by run ID, Jira key, or stage.
 */
export async function withStageSpan<T>(
  stage: string,
  runId: number | undefined,
  jiraKey: string | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const attributes: Record<string, string | number | boolean> = {
    'oneshot.stage': stage,
  }
  if (runId !== undefined) {
    attributes['oneshot.run_id'] = runId
  }
  if (jiraKey) {
    attributes['oneshot.jira_key'] = jiraKey
  }

  return withSpan(
    `oneshot.stage.${stage}`,
    attributes,
    fn,
  )
}

/**
 * Create a sub-span for a specific operation within a stage (e.g. LLM call,
 * artifact upload, workspace setup).
 */
export async function withOperationSpan<T>(
  operation: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`oneshot.${operation}`, attributes, fn)
}

// ---------------------------------------------------------------------------
// Trace context propagation helpers (for SQS message attributes)
// ---------------------------------------------------------------------------

/**
 * Serialize the current active trace context into a plain object suitable for
 * passing as SQS MessageAttributes or any other string-keyed carrier.
 *
 * Example carrier output: `{ traceparent: '00-...', tracestate: '...' }`
 */
export function serializeTraceContext(traceContext: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {}
  traceContextPropagator.inject(traceContext, carrier, defaultTextMapSetter)
  return carrier
}

/**
 * Extract a trace context from a carrier object (e.g. SQS MessageAttributes)
 * and return the resulting `Context`. Use with `context.with()` to activate it:
 *
 * ```ts
 * const parentCtx = extractTraceContext(carrier)
 * await context.with(parentCtx, async () => {
 *   // spans created here are children of the extracted context
 * })
 * ```
 */
export function extractTraceContext(carrier: Record<string, string>): Context {
  return traceContextPropagator.extract(context.active(), carrier, defaultTextMapGetter)
}
