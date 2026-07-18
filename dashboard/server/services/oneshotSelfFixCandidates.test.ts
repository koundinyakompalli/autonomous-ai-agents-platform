import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOneShotSelfFixCandidates,
  getOneShotSelfFixConfig,
  selfFixMinSampleSize,
} from "./oneshotSelfFixCandidates.js";
import type {
  OneShotFailureAttributionSummary,
  OneShotStatisticsJiraExample,
} from "../types/oneshot.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
});

const example: OneShotStatisticsJiraExample = {
  jiraKey: "CPDEV-1",
  dashboardId: "run-1",
  title: "example",
  jiraUrl: null,
};

function attributionSummary(
  row: OneShotFailureAttributionSummary["byCategory"][number],
): OneShotFailureAttributionSummary {
  return {
    totalFailures: row.sampleSize,
    excludedFromDenominator: 0,
    countsByAttribution: {
      oneshot: row.attribution === "oneshot" ? row.sampleSize : 0,
      ticket: row.attribution === "ticket" ? row.sampleSize : 0,
      mixed: row.attribution === "mixed" ? row.sampleSize : 0,
      unknown: row.attribution === "unknown" ? row.sampleSize : 0,
    },
    byCategory: [row],
    attributionVersion: 1,
  };
}

describe("selfFixMinSampleSize", () => {
  it("defaults to 5", () => {
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", undefined);
    expect(selfFixMinSampleSize()).toBe(5);
  });

  it("uses a positive integer override", () => {
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", "8");
    expect(selfFixMinSampleSize()).toBe(8);
  });

  it("falls back to 5 for invalid values", () => {
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", "0");
    expect(selfFixMinSampleSize()).toBe(5);
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", "abc");
    expect(selfFixMinSampleSize()).toBe(5);
  });

  it("does not inherit the ticket-readiness claim minimum of 10", () => {
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", undefined);
    expect(getOneShotSelfFixConfig().minSampleSize).toBe(5);
  });
});

describe("buildOneShotSelfFixCandidates", () => {
  it("creates an eligible candidate for significant OneShot failures at the configured sample size", () => {
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", "5");
    const candidates = buildOneShotSelfFixCandidates({
      range: "7d",
      passRateBaseline: 0.57,
      failureAttribution: attributionSummary({
        errorCategory: "agent_logic",
        attribution: "oneshot",
        sampleSize: 5,
        passRateInCohort: 0,
        wilson95: { low: 0, high: 0.43 },
        examples: [example],
        significant: true,
      }),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "oneshot-self-fix-agent_logic-oneshot",
      category: "agent_logic",
      attribution: "oneshot",
      sampleSize: 5,
      significant: true,
      passRateBaseline: 0.57,
      status: "eligible",
    });
  });

  it("does not create candidates for non-OneShot attribution", () => {
    vi.stubEnv("ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE", "5");
    const candidates = buildOneShotSelfFixCandidates({
      range: "7d",
      passRateBaseline: 0.57,
      failureAttribution: attributionSummary({
        errorCategory: "ticket_quality",
        attribution: "ticket",
        sampleSize: 5,
        passRateInCohort: 0,
        wilson95: { low: 0, high: 0.43 },
        examples: [example],
        significant: true,
      }),
    });

    expect(candidates).toEqual([]);
  });
});
