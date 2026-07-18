import { metrics } from "@opentelemetry/api";

type MetricAttributes = Record<string, string | number | boolean>;
type Timestamp = number | Date | string;

export type SpecFactoryWorkType =
  | "turn"
  | "agent_task"
  | "draft"
  | "conversion";
export type SpecFactoryWorkOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "abandoned"
  | "fence_rejected";
export type SpecFactoryProviderOutcome = "succeeded" | "failed" | "throttled";
export type SpecFactoryCoordinatorOutcome =
  | "selected"
  | "fallback"
  | "rejected";

interface CounterInstrument {
  add(value: number, attributes?: MetricAttributes): void;
}

interface HistogramInstrument {
  record(value: number, attributes?: MetricAttributes): void;
}

export interface SpecFactoryMetricInstruments {
  workAccepted: CounterInstrument;
  workOutcome: CounterInstrument;
  workQueueAgeMs: HistogramInstrument;
  workRunDurationMs: HistogramInstrument;
  providerCalls: CounterInstrument;
  providerLatencyMs: HistogramInstrument;
  providerTokens: HistogramInstrument;
  providerCostUsd: HistogramInstrument;
  coordinatorRoutes: CounterInstrument;
  coordinatorLatencyMs: HistogramInstrument;
  httpRequests: CounterInstrument;
  httpDurationMs: HistogramInstrument;
  leaseEvents: CounterInstrument;
  sloTurnQueueAgeMs: HistogramInstrument;
  sloDraftQueueAgeMs: HistogramInstrument;
  sloProviderLatencyMs: HistogramInstrument;
  sloCoordinatorLatencyMs: HistogramInstrument;
  sloCoordinatorAttempts: CounterInstrument;
  sloCoordinatorSuccesses: CounterInstrument;
}

export interface SpecFactoryMetrics {
  recordWorkAccepted(input: {
    workType: SpecFactoryWorkType;
    subtype?: string | null;
  }): void;
  recordWorkStarted(input: {
    workType: SpecFactoryWorkType;
    subtype?: string | null;
    queuedAt: Timestamp;
    startedAt?: Timestamp;
  }): void;
  recordWorkCompleted(input: {
    workType: SpecFactoryWorkType;
    subtype?: string | null;
    outcome: SpecFactoryWorkOutcome;
    startedAt: Timestamp;
    completedAt?: Timestamp;
  }): void;
  recordProviderCall(input: {
    purpose: string;
    provider: string;
    model: string;
    outcome: SpecFactoryProviderOutcome;
    latencyMs: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    costUsd?: number | null;
  }): void;
  recordCoordinatorRoute(input: {
    action?: string | null;
    outcome: SpecFactoryCoordinatorOutcome;
    durationMs: number;
    reason?: string | null;
  }): void;
  recordHttpRequest(input: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
  }): void;
  recordLeaseEvent(input: {
    workType: "turn" | "agent_task";
    event: "expired" | "fence_rejected";
    subtype?: string | null;
    count?: number;
  }): void;
}

const meter = metrics.getMeter("specter-spec-factory");

const defaultInstruments: SpecFactoryMetricInstruments = {
  workAccepted: meter.createCounter("spec_factory.work.accepted", {
    description: "Accepted Spec Factory work items",
  }),
  workOutcome: meter.createCounter("spec_factory.work.outcome", {
    description: "Spec Factory work attempt outcomes",
  }),
  workQueueAgeMs: meter.createHistogram("spec_factory.work.queue_age_ms", {
    description: "Age of Spec Factory work when claimed",
    unit: "ms",
  }),
  workRunDurationMs: meter.createHistogram(
    "spec_factory.work.run_duration_ms",
    {
      description: "Spec Factory work attempt duration",
      unit: "ms",
    },
  ),
  providerCalls: meter.createCounter("spec_factory.provider.calls", {
    description: "Spec Factory provider call outcomes",
  }),
  providerLatencyMs: meter.createHistogram("spec_factory.provider.latency_ms", {
    description: "Spec Factory provider call latency",
    unit: "ms",
  }),
  providerTokens: meter.createHistogram("spec_factory.provider.tokens", {
    description: "Spec Factory provider token usage per call",
    unit: "tokens",
  }),
  providerCostUsd: meter.createHistogram("spec_factory.provider.cost_usd", {
    description: "Spec Factory provider estimated cost per call",
    unit: "usd",
  }),
  coordinatorRoutes: meter.createCounter("spec_factory.coordinator.routes", {
    description: "Spec Factory coordinator route outcomes",
  }),
  coordinatorLatencyMs: meter.createHistogram(
    "spec_factory.coordinator.latency_ms",
    {
      description: "Spec Factory coordinator decision latency",
      unit: "ms",
    },
  ),
  httpRequests: meter.createCounter("spec_factory.http.requests", {
    description: "Spec Factory HTTP response outcomes",
  }),
  httpDurationMs: meter.createHistogram("spec_factory.http.duration_ms", {
    description: "Spec Factory HTTP request duration",
    unit: "ms",
  }),
  leaseEvents: meter.createCounter("spec_factory.lease.events", {
    description: "Spec Factory lease expiry and fence rejection events",
  }),
  sloTurnQueueAgeMs: meter.createHistogram(
    "spec_factory.slo.turn_queue_age_ms",
    {
      description: "Dimensionless interactive turn queue-age SLO stream",
      unit: "ms",
    },
  ),
  sloDraftQueueAgeMs: meter.createHistogram(
    "spec_factory.slo.draft_queue_age_ms",
    {
      description: "Dimensionless draft queue-age SLO stream",
      unit: "ms",
    },
  ),
  sloProviderLatencyMs: meter.createHistogram(
    "spec_factory.slo.provider_latency_ms",
    {
      description: "Dimensionless provider latency SLO stream",
      unit: "ms",
    },
  ),
  sloCoordinatorLatencyMs: meter.createHistogram(
    "spec_factory.slo.coordinator_latency_ms",
    {
      description: "Dimensionless coordinator decision latency SLO stream",
      unit: "ms",
    },
  ),
  sloCoordinatorAttempts: meter.createCounter(
    "spec_factory.slo.coordinator_attempts",
    { description: "Dimensionless coordinator route attempts" },
  ),
  sloCoordinatorSuccesses: meter.createCounter(
    "spec_factory.slo.coordinator_successes",
    { description: "Dimensionless successful coordinator route selections" },
  ),
};

export function createSpecFactoryMetrics(
  instruments: SpecFactoryMetricInstruments = defaultInstruments,
): SpecFactoryMetrics {
  return {
    recordWorkAccepted({ workType, subtype }) {
      safeMetric(() =>
        instruments.workAccepted.add(1, workAttributes(workType, subtype)),
      );
    },

    recordWorkStarted({ workType, subtype, queuedAt, startedAt = Date.now() }) {
      safeMetric(() => {
        const queueAgeMs = elapsedMs(queuedAt, startedAt);
        if (queueAgeMs === null) return;
        instruments.workQueueAgeMs.record(
          queueAgeMs,
          workAttributes(workType, subtype),
        );
        if (workType === "turn" && bounded(subtype ?? "") === "chat") {
          instruments.sloTurnQueueAgeMs.record(queueAgeMs);
        } else if (workType === "draft") {
          instruments.sloDraftQueueAgeMs.record(queueAgeMs);
        }
      });
    },

    recordWorkCompleted({
      workType,
      subtype,
      outcome,
      startedAt,
      completedAt = Date.now(),
    }) {
      safeMetric(() => {
        const attributes = {
          ...workAttributes(workType, subtype),
          outcome,
        };
        const durationMs = elapsedMs(startedAt, completedAt);
        if (durationMs !== null) {
          instruments.workRunDurationMs.record(durationMs, attributes);
        }
        instruments.workOutcome.add(1, attributes);
      });
    },

    recordProviderCall(input) {
      safeMetric(() => {
        const attributes = {
          purpose: bounded(input.purpose),
          provider: bounded(input.provider),
          model: bounded(input.model),
          outcome: input.outcome,
        };
        instruments.providerCalls.add(1, attributes);
        if (finiteNonNegative(input.latencyMs)) {
          instruments.providerLatencyMs.record(input.latencyMs, attributes);
          instruments.sloProviderLatencyMs.record(input.latencyMs);
        }
        recordOptionalHistogram(instruments.providerTokens, input.inputTokens, {
          ...attributes,
          token_type: "input",
        });
        recordOptionalHistogram(
          instruments.providerTokens,
          input.outputTokens,
          { ...attributes, token_type: "output" },
        );
        recordOptionalHistogram(
          instruments.providerCostUsd,
          input.costUsd,
          attributes,
        );
      });
    },

    recordCoordinatorRoute(input) {
      safeMetric(() => {
        const attributes: MetricAttributes = {
          outcome: input.outcome,
          action: bounded(input.action || "none"),
        };
        if (input.reason) attributes.reason = bounded(input.reason);
        instruments.coordinatorRoutes.add(1, attributes);
        instruments.sloCoordinatorAttempts.add(1);
        if (input.outcome === "selected") {
          instruments.sloCoordinatorSuccesses.add(1);
        }
        if (finiteNonNegative(input.durationMs)) {
          instruments.coordinatorLatencyMs.record(input.durationMs, attributes);
          instruments.sloCoordinatorLatencyMs.record(input.durationMs);
        }
      });
    },

    recordHttpRequest(input) {
      safeMetric(() => {
        const attributes = {
          method: bounded(input.method.toUpperCase()),
          route: bounded(input.route),
          status_code: input.statusCode,
          status_class: `${Math.trunc(input.statusCode / 100)}xx`,
        };
        instruments.httpRequests.add(1, attributes);
        if (finiteNonNegative(input.durationMs)) {
          instruments.httpDurationMs.record(input.durationMs, attributes);
        }
      });
    },

    recordLeaseEvent({ workType, event, subtype, count = 1 }) {
      safeMetric(() => {
        if (!finiteNonNegative(count) || count === 0) return;
        instruments.leaseEvents.add(Math.trunc(count), {
          ...workAttributes(workType, subtype),
          event,
        });
      });
    },
  };
}

export const specFactoryMetrics = createSpecFactoryMetrics();

function workAttributes(
  workType: SpecFactoryWorkType,
  subtype?: string | null,
): MetricAttributes {
  return {
    work_type: workType,
    ...(subtype ? { subtype: bounded(subtype) } : {}),
  };
}

function elapsedMs(start: Timestamp, end: Timestamp): number | null {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null) return null;
  return Math.max(0, endMs - startMs);
}

function timestampMs(value: Timestamp): number | null {
  const result =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function recordOptionalHistogram(
  histogram: HistogramInstrument,
  value: number | null | undefined,
  attributes: MetricAttributes,
): void {
  if (value === null || value === undefined || !finiteNonNegative(value))
    return;
  histogram.record(value, attributes);
}

function bounded(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, "_");
  return (normalized || "unknown").slice(0, 128);
}

function safeMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Telemetry must never fail a committed product operation.
  }
}
