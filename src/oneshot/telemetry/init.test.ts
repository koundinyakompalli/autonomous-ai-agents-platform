import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

const startMock = vi.fn()
const shutdownMock = vi.fn().mockResolvedValue(undefined)
const nodeSdkMock = vi.fn()
const traceExporterMock = vi.fn()
const metricExporterMock = vi.fn()
const metricReaderMock = vi.fn()

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: vi.fn(function NodeSDK(this: object, options: unknown) {
    nodeSdkMock(options)
    return {
      start: startMock,
      shutdown: shutdownMock,
    }
  }),
}))

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: vi.fn(function OTLPTraceExporter(this: object, options: unknown) {
    traceExporterMock(options)
  }),
}))

vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: vi.fn(function OTLPMetricExporter(this: object, options: unknown) {
    metricExporterMock(options)
  }),
}))

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn((attributes: unknown) => attributes),
}))

vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: vi.fn(),
}))

vi.mock('@opentelemetry/id-generator-aws-xray', () => ({
  AWSXRayIdGenerator: vi.fn(),
}))

vi.mock('@opentelemetry/propagator-aws-xray', () => ({
  AWSXRayPropagator: vi.fn(),
}))

vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: vi.fn(function PeriodicExportingMetricReader(this: object, options: unknown) {
    metricReaderMock(options)
  }),
}))

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('telemetry init', () => {
  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV }
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('uses signal-specific OTLP endpoints when provided', async () => {
    process.env.OTEL_ENABLED = 'true'
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4317'
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:4318'

    const { initTelemetry, shutdownTelemetry } = await import('./init.js')

    initTelemetry('PLANNER')

    expect(traceExporterMock).toHaveBeenCalledWith({ url: 'http://127.0.0.1:4317/v1/traces' })
    expect(metricExporterMock).toHaveBeenCalledWith({ url: 'http://127.0.0.1:4318/v1/metrics' })
    expect(startMock).toHaveBeenCalledTimes(1)

    await shutdownTelemetry()
    expect(shutdownMock).toHaveBeenCalledTimes(1)
  })

  it('preserves fully qualified signal endpoints', async () => {
    process.env.OTEL_ENABLED = 'true'
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4317/v1/traces'
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:4318/v1/metrics'

    const { initTelemetry, shutdownTelemetry } = await import('./init.js')

    initTelemetry('REVIEWER')

    expect(traceExporterMock).toHaveBeenCalledWith({ url: 'http://127.0.0.1:4317/v1/traces' })
    expect(metricExporterMock).toHaveBeenCalledWith({ url: 'http://127.0.0.1:4318/v1/metrics' })

    await shutdownTelemetry()
  })
})
