import {
  SpanStatusCode,
  trace,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import {
  runWithSpecFactoryCorrelation,
  specFactoryCorrelationSpanAttributes,
  type SpecFactoryCorrelationContext,
} from "./correlation.js";

const tracer = trace.getTracer("specter-spec-factory");

export function withSpecFactorySpan<T>(
  name: string,
  correlation: SpecFactoryCorrelationContext,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return runWithSpecFactoryCorrelation(correlation, () =>
    tracer.startActiveSpan(
      `spec_factory.${name}`,
      { attributes: specFactoryCorrelationSpanAttributes() } as SpanOptions,
      async (span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          span.recordException(normalized);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: normalized.message,
          });
          throw error;
        } finally {
          span.end();
        }
      },
    ),
  );
}
