import { describe, expect, it } from "vitest";
import { getMockData } from "./oneshotMockData.js";

describe("getMockData analytics", () => {
  it("populates the new analytics tabs with coherent mock data", () => {
    const { runs, artifactRuns, analytics, capabilities } = getMockData();

    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs.map((run) => run.ticketType))).toContain("retrofit");
    expect(artifactRuns.map((run) => run.mode)).toEqual([
      "wiz",
      "sonar",
      "documentation",
    ]);
    expect(artifactRuns.some((run) => run.humanReviewRequired)).toBe(true);
    expect(capabilities).toEqual({
      createRun: true,
      createRunMode: "mock",
      deployPreviewAvailable: false,
      deployPreview: false,
    });

    expect(analytics.throughput.window.range).toBe("24h");
    expect(analytics.throughput.totalRuns).toBeGreaterThan(0);
    expect(analytics.throughput.buckets).toHaveLength(48);
    expect(analytics.throughput.stageCompletion).toHaveLength(6);

    expect(analytics.costs.totalUsd).toBeGreaterThan(0);
    expect(analytics.costs.byStage.length).toBeGreaterThan(0);
    expect(analytics.costs.topRuns.length).toBeGreaterThan(0);

    if (analytics.failures.totalFailures > 0) {
      expect(analytics.failures.clusters.length).toBeGreaterThan(0);
      const clusteredFailureCount = analytics.failures.clusters.reduce(
        (sum, cluster) => sum + cluster.count,
        0,
      );
      expect(clusteredFailureCount).toBe(analytics.failures.totalFailures);
    }
  });

  it("builds coherent non-default range mock analytics", () => {
    const { analytics } = getMockData("30d");

    expect(analytics.throughput.window.range).toBe("30d");
    expect(analytics.throughput.buckets).toHaveLength(30);
    expect(analytics.costs.window.range).toBe("30d");
    expect(analytics.failures.window.range).toBe("30d");
  });

  it("omits prior-window trends for all-time mock analytics", () => {
    const { analytics } = getMockData("all");

    expect(analytics.throughput.window.isAllTime).toBe(true);
    expect(analytics.throughput.buckets.length).toBeLessThanOrEqual(36);
    expect(analytics.throughput.trend).toBeNull();
    expect(analytics.costs.trend).toBeNull();
  });
});
