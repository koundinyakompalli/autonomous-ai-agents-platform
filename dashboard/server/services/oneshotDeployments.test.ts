import { describe, expect, it } from "vitest";
import { buildDeploymentSummaryFromRecord } from "./oneshotDeployments.js";
import type {
  OneShotDeploymentRecord,
} from "../types/oneshotDeployments.js";
import type { OneShotDeploymentStatus } from "../types/oneshot.js";

// ── Shared fixture ────────────────────────────────────────────────────────
// Builds a minimally-plausible OneShotDeploymentRecord with an overridable
// status so each test can pin the exact branch we care about.
function fakeRecord(
  status: OneShotDeploymentStatus,
  overrides: Partial<OneShotDeploymentRecord> = {},
): OneShotDeploymentRecord {
  return {
    id: 1,
    oneshotRunId: 100,
    slotName: "core-app-preview",
    repoId: 7,
    branchName: "feature/test",
    commitSha: "deadbeef",
    prUrl: null,
    requestedBy: null,
    requestedByDisplay: null,
    status,
    workflowRunId: null,
    workflowUrl: null,
    imageUri: null,
    taskDefinitionArn: null,
    ecsClusterName: "CLIENT-A",
    ecsServiceName: "CLIENT-A-cp-dev-mhk-core",
    previewUrl: null,
    error: null,
    supersededBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe("buildDeploymentSummaryFromRecord — Deploy Ready semantics", () => {
  it("non-eligible rows are neither eligible nor ready", () => {
    const summary = buildDeploymentSummaryFromRecord(null, false);
    expect(summary.eligible).toBe(false);
    expect(summary.ready).toBe(false);
    expect(summary.status).toBe("not_eligible");
    expect(summary.light).toBe("grey");
  });

  it("eligible rows with NO deployment record are ready (true Deploy Ready state)", () => {
    const summary = buildDeploymentSummaryFromRecord(null, true);
    expect(summary.eligible).toBe(true);
    expect(summary.ready).toBe(true);
    expect(summary.status).toBe("ready");
  });

  it("eligible rows with an ACTIVE deployment are eligible but NOT ready", () => {
    const summary = buildDeploymentSummaryFromRecord(
      fakeRecord("active", { previewUrl: "https://preview.example.com" }),
      true,
    );
    expect(summary.eligible).toBe(true);
    expect(summary.ready).toBe(false);
    expect(summary.status).toBe("active");
    expect(summary.active).toBe(true);
  });

  it("eligible rows with a FAILED deployment are eligible but NOT ready", () => {
    const summary = buildDeploymentSummaryFromRecord(
      fakeRecord("failed"),
      true,
    );
    expect(summary.eligible).toBe(true);
    expect(summary.ready).toBe(false);
    expect(summary.status).toBe("failed");
  });

  it("eligible rows with a CANCELLED deployment are eligible but NOT ready", () => {
    const summary = buildDeploymentSummaryFromRecord(
      fakeRecord("cancelled"),
      true,
    );
    expect(summary.eligible).toBe(true);
    expect(summary.ready).toBe(false);
    expect(summary.status).toBe("cancelled");
  });

  it("eligible rows with a SUPERSEDED deployment are eligible but NOT ready", () => {
    const summary = buildDeploymentSummaryFromRecord(
      fakeRecord("superseded"),
      true,
    );
    expect(summary.eligible).toBe(true);
    expect(summary.ready).toBe(false);
    expect(summary.status).toBe("superseded");
  });

  it.each([
    "requested",
    "awaiting_approval",
    "building",
    "pushing",
    "deploying",
  ] as const)(
    "eligible rows with an in-flight (%s) deployment are eligible but NOT ready",
    (status) => {
      const summary = buildDeploymentSummaryFromRecord(
        fakeRecord(status),
        true,
      );
      expect(summary.eligible).toBe(true);
      expect(summary.ready).toBe(false);
      expect(summary.status).toBe(status);
      expect(summary.light).toBe("amber");
    },
  );
});
