/**
 * OpenTelemetry SDK initialization for the oneshot pipeline.
 *
 * Must be called before any other application imports so that the global
 * TracerProvider and MeterProvider are registered before downstream modules
 * acquire Tracer / Meter handles via the `@opentelemetry/api` facade.
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray'
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('telemetry')

const SERVICE_VERSION = '2.0.0'
const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318'
const METRIC_EXPORT_INTERVAL_MS = 30_000

let sdk: NodeSDK | null = null

/**
 * Initialize the OpenTelemetry SDK for the oneshot pipeline.
 *
 * When `OTEL_ENABLED` is not `'true'`, this is a no-op and all trace / metric
 * operations fall through to the default noop providers from `@opentelemetry/api`.
 *
 * @param role - The ONESHOT_ROLE value (e.g. PLANNER, IMPLEMENTER). Used in the
 *               service name so each consumer appears as a distinct service in
 *               trace backends.
 */
export function initTelemetry(role: string): void {
  const enabled = process.env.OTEL_ENABLED?.trim().toLowerCase() === 'true'

  if (!enabled) {
    logger.info('OpenTelemetry disabled (OTEL_ENABLED != true), using noop providers')
    return
  }

  const tracesEndpoint = resolveSignalEndpoint('traces')
  const metricsEndpoint = resolveSignalEndpoint('metrics')

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: `specter-oneshot-${role.toLowerCase()}`,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    'service.instance.id': role,
    'deployment.environment': process.env.NODE_ENV || 'development',
  })

  const traceExporter = new OTLPTraceExporter({ url: tracesEndpoint })

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
  })

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new AWSXRayPropagator(),
    instrumentations: [new HttpInstrumentation()],
  })

  sdk.start()

  logger.info({
    metricsEndpoint,
    serviceName: `specter-oneshot-${role.toLowerCase()}`,
    role,
    tracesEndpoint,
  }, 'OpenTelemetry initialized')
}

/**
 * Gracefully shut down the SDK, flushing any pending spans and metrics.
 * Safe to call even when the SDK was never initialized (noop).
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) {
    return
  }

  try {
    await sdk.shutdown()
    logger.info('OpenTelemetry shut down successfully')
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : String(error),
    }, 'Error shutting down OpenTelemetry')
  } finally {
    sdk = null
  }
}

function resolveSignalEndpoint(signal: 'traces' | 'metrics'): string {
  const specificEnvName =
    signal === 'traces'
      ? 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'
      : 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'

  const specificEndpoint = process.env[specificEnvName]?.trim()
  if (specificEndpoint) {
    return normalizeSignalEndpoint(specificEndpoint, signal)
  }

  const defaultEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || DEFAULT_OTLP_ENDPOINT
  return normalizeSignalEndpoint(defaultEndpoint, signal)
}

function normalizeSignalEndpoint(endpoint: string, signal: 'traces' | 'metrics'): string {
  const trimmed = endpoint.replace(/\/+$/, '')
  if (trimmed.endsWith(`/v1/${signal}`)) {
    return trimmed
  }
  return `${trimmed}/v1/${signal}`
}
