import { describe, expect, it, vi } from "vitest";
import {
  createSpecFactoryMetrics,
  type SpecFactoryMetricInstruments,
} from "./metrics.js";

function instruments(): {
  values: SpecFactoryMetricInstruments;
  workAccepted: ReturnType<typeof vi.fn>;
  workOutcome: ReturnType<typeof vi.fn>;
  workQueueAgeMs: ReturnType<typeof vi.fn>;
  workRunDurationMs: ReturnType<typeof vi.fn>;
  providerCalls: ReturnType<typeof vi.fn>;
  providerLatencyMs: ReturnType<typeof vi.fn>;
  providerTokens: ReturnType<typeof vi.fn>;
  providerCostUsd: ReturnType<typeof vi.fn>;
  coordinatorRoutes: ReturnType<typeof vi.fn>;
  sloTurnQueueAgeMs: ReturnType<typeof vi.fn>;
  sloProviderLatencyMs: ReturnType<typeof vi.fn>;
} {
  const workAccepted = vi.fn();
  const workOutcome = vi.fn();
  const workQueueAgeMs = vi.fn();
  const workRunDurationMs = vi.fn();
  const providerCalls = vi.fn();
  const providerLatencyMs = vi.fn();
  const providerTokens = vi.fn();
  const providerCostUsd = vi.fn();
  const coordinatorRoutes = vi.fn();
  const sloTurnQueueAgeMs = vi.fn();
  const sloProviderLatencyMs = vi.fn();
  return {
    workAccepted,
    workOutcome,
    workQueueAgeMs,
    workRunDurationMs,
    providerCalls,
    providerLatencyMs,
    providerTokens,
    providerCostUsd,
    coordinatorRoutes,
    sloTurnQueueAgeMs,
    sloProviderLatencyMs,
    values: {
      workAccepted: { add: workAccepted },
      workOutcome: { add: workOutcome },
      workQueueAgeMs: { record: workQueueAgeMs },
      workRunDurationMs: { record: workRunDurationMs },
      providerCalls: { add: providerCalls },
      providerLatencyMs: { record: providerLatencyMs },
      providerTokens: { record: providerTokens },
      providerCostUsd: { record: providerCostUsd },
      coordinatorRoutes: { add: coordinatorRoutes },
      coordinatorLatencyMs: { record: vi.fn() },
      httpRequests: { add: vi.fn() },
      httpDurationMs: { record: vi.fn() },
      leaseEvents: { add: vi.fn() },
      sloTurnQueueAgeMs: { record: sloTurnQueueAgeMs },
      sloDraftQueueAgeMs: { record: vi.fn() },
      sloProviderLatencyMs: { record: sloProviderLatencyMs },
      sloCoordinatorLatencyMs: { record: vi.fn() },
      sloCoordinatorAttempts: { add: vi.fn() },
      sloCoordinatorSuccesses: { add: vi.fn() },
    },
  };
}

describe("Spec Factory metrics", () => {
  it("records queue age and attempt duration with bounded work dimensions", () => {
    const fake = instruments();
    const telemetry = createSpecFactoryMetrics(fake.values);

    telemetry.recordWorkAccepted({ workType: "turn", subtype: "Chat" });
    telemetry.recordWorkStarted({
      workType: "turn",
      subtype: "Chat",
      queuedAt: 1_000,
      startedAt: 3_500,
    });
    telemetry.recordWorkCompleted({
      workType: "turn",
      subtype: "Chat",
      outcome: "succeeded",
      startedAt: 3_500,
      completedAt: 8_000,
    });

    expect(fake.workAccepted).toHaveBeenCalledWith(1, {
      work_type: "turn",
      subtype: "chat",
    });
    expect(fake.workQueueAgeMs).toHaveBeenCalledWith(2_500, {
      work_type: "turn",
      subtype: "chat",
    });
    expect(fake.sloTurnQueueAgeMs).toHaveBeenCalledWith(2_500);
    expect(fake.workRunDurationMs).toHaveBeenCalledWith(4_500, {
      work_type: "turn",
      subtype: "chat",
      outcome: "succeeded",
    });
    expect(fake.workOutcome).toHaveBeenCalledWith(1, {
      work_type: "turn",
      subtype: "chat",
      outcome: "succeeded",
    });
  });

  it("records provider latency, tokens, and cost without identifier dimensions", () => {
    const fake = instruments();
    const telemetry = createSpecFactoryMetrics(fake.values);

    telemetry.recordProviderCall({
      purpose: "chat_coordinator_fast",
      provider: "bedrock",
      model: "US.Anthropic.Claude-Sonnet-5",
      outcome: "succeeded",
      latencyMs: 725,
      inputTokens: 100,
      outputTokens: 25,
      costUsd: 0.0125,
    });

    const attributes = {
      purpose: "chat_coordinator_fast",
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-5",
      outcome: "succeeded",
    };
    expect(fake.providerCalls).toHaveBeenCalledWith(1, attributes);
    expect(fake.providerLatencyMs).toHaveBeenCalledWith(725, attributes);
    expect(fake.sloProviderLatencyMs).toHaveBeenCalledWith(725);
    expect(fake.providerTokens).toHaveBeenCalledWith(100, {
      ...attributes,
      token_type: "input",
    });
    expect(fake.providerTokens).toHaveBeenCalledWith(25, {
      ...attributes,
      token_type: "output",
    });
    expect(fake.providerCostUsd).toHaveBeenCalledWith(0.0125, attributes);
  });
});
