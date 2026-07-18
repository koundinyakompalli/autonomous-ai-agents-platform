import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("spec-factory-telemetry");
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
const METRIC_EXPORT_INTERVAL_MS = 30_000;
const SERVICE_VERSION = "2.0.0";

let sdk: NodeSDK | null = null;

export function initSpecFactoryTelemetry(role: string): void {
  if (process.env.OTEL_ENABLED?.trim().toLowerCase() !== "true") {
    logger.info("Spec Factory OpenTelemetry disabled; using noop providers");
    return;
  }

  const tracesEndpoint = resolveSignalEndpoint("traces");
  const metricsEndpoint = resolveSignalEndpoint("metrics");
  const normalizedRole = role.trim().toLowerCase() || "all-local";
  const serviceName = `specter-spec-factory-${normalizedRole}`;
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    "service.instance.id":
      process.env.ECS_TASK_ARN ||
      process.env.HOSTNAME ||
      `${normalizedRole}-${process.pid}`,
    "deployment.environment": process.env.NODE_ENV || "development",
    "spec_factory.runtime_mode": normalizedRole,
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: tracesEndpoint }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
      exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
    }),
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new AWSXRayPropagator(),
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
  logger.info(
    { serviceName, tracesEndpoint, metricsEndpoint },
    "Spec Factory OpenTelemetry initialized",
  );
}

export async function shutdownSpecFactoryTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    logger.info("Spec Factory OpenTelemetry shut down");
  } catch (error) {
    logger.error({ err: error }, "Spec Factory OpenTelemetry shutdown failed");
  } finally {
    sdk = null;
  }
}

export function resolveSignalEndpoint(signal: "traces" | "metrics"): string {
  const specificName =
    signal === "traces"
      ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
      : "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
  const endpoint =
    process.env[specificName]?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    DEFAULT_OTLP_ENDPOINT;
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith(`/v1/${signal}`)
    ? trimmed
    : `${trimmed}/v1/${signal}`;
}
