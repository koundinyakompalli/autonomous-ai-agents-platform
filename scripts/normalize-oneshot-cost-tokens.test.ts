import { describe, expect, it } from "vitest";
import { buildRunTokenTargets } from "./normalize-oneshot-cost-tokens.js";

describe("normalize-oneshot-cost-tokens", () => {
  it("applies normalized row deltas to existing run totals", () => {
    const targets = buildRunTokenTargets(
      new Map([
        [101, 10_000],
        [102, 500],
      ]),
      [
        { source: "artifact", oneshot_run_id: 101, delta: 2_000 },
        { source: "artifact", oneshot_run_id: 101, delta: -750 },
        { source: "artifact", oneshot_run_id: 102, delta: 0 },
        { source: "artifact", oneshot_run_id: 0, delta: 5_000 },
      ],
    );

    expect(targets.get(101)).toBe(11_250);
    expect(targets.get(102)).toBe(500);
    expect(targets.has(0)).toBe(false);
  });

  it("does not let a correction push a run total below zero", () => {
    const targets = buildRunTokenTargets(
      new Map([[101, 100]]),
      [{ source: "artifact", oneshot_run_id: 101, delta: -1_000 }],
    );

    expect(targets.get(101)).toBe(0);
  });

  it("does not apply mirrored stage_attempt_metrics event deltas to run totals", () => {
    const targets = buildRunTokenTargets(
      new Map([[101, 10_000]]),
      [
        {
          source: "artifact",
          oneshot_run_id: 101,
          stage: "plan",
          version: 2,
          revision: false,
          delta: 2_000,
        },
        {
          source: "event",
          oneshot_run_id: 101,
          stage: "planning",
          version: 2,
          revision: "0",
          delta: 2_000,
        },
      ],
    );

    expect(targets.get(101)).toBe(12_000);
  });

  it("keeps known event-only attempt deltas even when an artifact exists for the stage", () => {
    const targets = buildRunTokenTargets(
      new Map([[101, 10_000]]),
      [
        {
          source: "artifact",
          oneshot_run_id: 101,
          stage: "implementation",
          version: 3,
          revision: true,
          delta: 1_000,
        },
        {
          source: "event",
          oneshot_run_id: 101,
          stage: "implementation",
          version: 3,
          revision: true,
          reason: "failed_attempt",
          delta: 2_000,
        },
      ],
    );

    expect(targets.get(101)).toBe(13_000);
  });

  it("applies event-only attempt deltas when there is no matching artifact", () => {
    const targets = buildRunTokenTargets(
      new Map([[101, 10_000]]),
      [
        {
          source: "event",
          oneshot_run_id: 101,
          stage: "planning",
          version: 4,
          revision: false,
          reason: "planner_failed_attempt",
          delta: 2_000,
        },
      ],
    );

    expect(targets.get(101)).toBe(12_000);
  });
});
