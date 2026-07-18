/**
 * Barrel export for oneshot telemetry infrastructure.
 *
 * Usage from consumers:
 * ```ts
 * import { initTelemetry, withStageSpan, recordStageMetrics } from './telemetry/index.js'
 * ```
 */

// SDK lifecycle
export { initTelemetry, shutdownTelemetry } from "./init.js";

// Tracer and span helpers
export {
  getTracer,
  withSpan,
  withStageSpan,
  withOperationSpan,
  serializeTraceContext,
  extractTraceContext,
} from "./tracer.js";

// Metrics instruments and helpers
export {
  recordStageMetrics,
  recordLlmMetrics,
  runDurationHistogram,
  runCostHistogram,
  llmLatencyHistogram,
  llmTokensHistogram,
  runOutcomeCounter,
  reviewLoopCounter,
  verificationLoopCounter,
  workspaceReuseCounter,
  bashBlockedCounter,
} from "./metrics.js";
