import { describe, expect, it } from "vitest";
import {
  bucketForView,
  inferBlockedOrEscalatedStage,
  inferFailedStage,
  inferReplanRequiredStage,
  mapTransientRetryMetadata,
  parseDashboardId,
  progressForFailedStage,
  progressForPausedStage,
} from "./oneshotRowHelpers.js";

describe("bucketForView", () => {
  it("keeps actionable paused states in Waiting", () => {
    expect(bucketForView("escalated")).toBe("waiting");
    expect(bucketForView("replan_required")).toBe("waiting");
  });

  it("keeps blocked runs in History", () => {
    expect(bucketForView("blocked")).toBe("history");
  });

  it("keeps qualifier no-action rows in History", () => {
    expect(bucketForView("qualification_no_action")).toBe("history");
  });

  it("keeps PR-open runs in History", () => {
    expect(bucketForView("pr_open")).toBe("history");
  });
});

describe("inferFailedStage", () => {
  it("prefers the latest failed event stage", () => {
    expect(
      inferFailedStage({
        transitionStage: "reviewing",
        finalDisposition: "test_failed",
        latestArtifactStage: "test_result",
        currentTestVersion: 1,
      }),
    ).toBe("review");
  });

  it("falls back to a stage-bearing final disposition", () => {
    expect(
      inferFailedStage({
        transitionStage: null,
        finalDisposition: "code_review_blocked",
        latestArtifactStage: null,
        currentCodeReviewVersion: null,
      }),
    ).toBe("code_review");
  });

  it("prefers version counters over the latest artifact stage", () => {
    expect(
      inferFailedStage({
        transitionStage: null,
        finalDisposition: "run_failed",
        latestArtifactStage: "implementation",
        currentImplementationVersion: 1,
        currentCodeReviewVersion: 1,
      }),
    ).toBe("code_review");
  });

  it("falls back to the latest artifact stage when versions are missing", () => {
    expect(
      inferFailedStage({
        transitionStage: null,
        finalDisposition: "budget_exceeded",
        latestArtifactStage: "implementation",
        currentPlanVersion: null,
        currentReviewVersion: null,
        currentImplementationVersion: null,
        currentCodeReviewVersion: null,
        currentTestVersion: null,
      }),
    ).toBe("implementation");
  });

  it("falls back to qualification when no other signal exists", () => {
    expect(
      inferFailedStage({
        transitionStage: null,
        finalDisposition: null,
        latestArtifactStage: null,
        currentPlanVersion: null,
        currentReviewVersion: null,
        currentImplementationVersion: null,
        currentCodeReviewVersion: null,
        currentTestVersion: null,
      }),
    ).toBe("qualification");
  });
});

describe("inferBlockedOrEscalatedStage", () => {
  it("uses the transition event stage when present", () => {
    expect(
      inferBlockedOrEscalatedStage({
        transitionStage: "code_reviewing",
        finalDisposition: "review_escalated",
      }),
    ).toBe("code_review");
  });

  it("falls back to final disposition when the transition stage is missing", () => {
    expect(
      inferBlockedOrEscalatedStage({
        transitionStage: null,
        finalDisposition: "code_review_blocked",
      }),
    ).toBe("code_review");
  });
});

describe("inferReplanRequiredStage", () => {
  it("uses the transition event stage when present", () => {
    expect(
      inferReplanRequiredStage({
        transitionStage: "code_review",
        currentImplementationVersion: 1,
      }),
    ).toBe("code_review");
  });

  it("falls back to the latest populated version counter", () => {
    expect(
      inferReplanRequiredStage({
        transitionStage: null,
        currentPlanVersion: 1,
        currentReviewVersion: 1,
        currentImplementationVersion: 1,
        currentCodeReviewVersion: 1,
      }),
    ).toBe("code_review");
  });

  it("falls back to implementation when no signal exists", () => {
    expect(
      inferReplanRequiredStage({
        transitionStage: null,
      }),
    ).toBe("implementation");
  });
});

describe("parseDashboardId", () => {
  it("parses run row ids", () => {
    expect(parseDashboardId("run-123")).toEqual({ kind: "run", id: 123 });
  });

  it("parses qualifier task ids", () => {
    expect(parseDashboardId("qualifier-task-456")).toEqual({
      kind: "qualifier-task",
      id: 456,
    });
  });

  it("rejects malformed ids", () => {
    expect(parseDashboardId("CPDEV-123")).toBeNull();
    expect(parseDashboardId("run-0")).toBeNull();
    expect(parseDashboardId("qualifier-task-nope")).toBeNull();
  });
});

describe("progressForFailedStage", () => {
  it("returns the stage-specific failed progress mapping", () => {
    expect(progressForFailedStage("planning")).toEqual({
      progressStage: "planning",
      progressPercent: 22,
    });
    expect(progressForFailedStage("testing")).toEqual({
      progressStage: "testing",
      progressPercent: 85,
    });
  });
});

describe("progressForPausedStage", () => {
  it("returns review, implementation, and code-review paused mappings", () => {
    expect(progressForPausedStage("review")).toEqual({
      progressStage: "review",
      progressPercent: 40,
    });
    expect(progressForPausedStage("implementation")).toEqual({
      progressStage: "implementation",
      progressPercent: 50,
    });
    expect(progressForPausedStage("code_review")).toEqual({
      progressStage: "code_review",
      progressPercent: 72,
    });
  });
});

describe("inferFailedStage — handoff dispositions", () => {
  it("infers qualification stage for workspace_setup_failed disposition", () => {
    expect(
      inferFailedStage({
        transitionStage: null,
        finalDisposition: "workspace_setup_failed",
        latestArtifactStage: null,
      }),
    ).toBe("qualification");
  });

  it("infers qualification stage for planning_publish_failed disposition", () => {
    expect(
      inferFailedStage({
        transitionStage: null,
        finalDisposition: "planning_publish_failed",
        latestArtifactStage: null,
      }),
    ).toBe("qualification");
  });

  it("prefers explicit transitionStage over workspace_setup_failed disposition", () => {
    expect(
      inferFailedStage({
        transitionStage: "planning",
        finalDisposition: "workspace_setup_failed",
        latestArtifactStage: null,
      }),
    ).toBe("planning");
  });
});

describe("mapTransientRetryMetadata", () => {
  it("returns null for null input", () => {
    expect(mapTransientRetryMetadata(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(mapTransientRetryMetadata(undefined)).toBeNull();
  });

  it("returns null for a non-object primitive", () => {
    expect(mapTransientRetryMetadata("string")).toBeNull();
    expect(mapTransientRetryMetadata(42)).toBeNull();
  });

  it("returns null for an array (not a plain object)", () => {
    expect(mapTransientRetryMetadata([])).toBeNull();
  });

  it("maps a well-formed transientRetry object to RetryEtaData", () => {
    const raw = {
      nextRetryTimestamp: "2026-06-15T12:02:00.000Z",
      retryDelaySeconds: 120,
      retryAttempt: 1,
      maxRetryAttempts: 3,
      visibilityChangeStatus: "success",
    };
    expect(mapTransientRetryMetadata(raw)).toEqual({
      nextRetryAt: "2026-06-15T12:02:00.000Z",
      delaySeconds: 120,
      attempt: 1,
      maxAttempts: 3,
      visibilityStatus: "success",
    });
  });

  it("returns nulls for missing fields (partial object)", () => {
    expect(mapTransientRetryMetadata({})).toEqual({
      nextRetryAt: null,
      delaySeconds: null,
      attempt: null,
      maxAttempts: null,
      visibilityStatus: null,
    });
  });

  it("coerces wrong-type fields to null", () => {
    const raw = {
      nextRetryTimestamp: 12345,        // should be string
      retryDelaySeconds: "120",         // should be number
      retryAttempt: null,
      maxRetryAttempts: true,           // should be number
      visibilityChangeStatus: 0,        // should be string
    };
    expect(mapTransientRetryMetadata(raw)).toEqual({
      nextRetryAt: null,
      delaySeconds: null,
      attempt: null,
      maxAttempts: null,
      visibilityStatus: null,
    });
  });

  it("handles visibilityChangeStatus='failed' correctly", () => {
    const raw = {
      nextRetryTimestamp: "2026-06-15T12:02:00.000Z",
      retryDelaySeconds: 300,
      retryAttempt: 2,
      maxRetryAttempts: 3,
      visibilityChangeStatus: "failed",
    };
    const result = mapTransientRetryMetadata(raw);
    expect(result?.visibilityStatus).toBe("failed");
    expect(result?.attempt).toBe(2);
    expect(result?.nextRetryAt).toBeNull();
  });

  it("treats unknown visibilityChangeStatus values as unusable ETA metadata", () => {
    const raw = {
      nextRetryTimestamp: "2026-06-15T12:02:00.000Z",
      retryDelaySeconds: 300,
      retryAttempt: 2,
      maxRetryAttempts: 3,
      visibilityChangeStatus: "unknown",
    };
    expect(mapTransientRetryMetadata(raw)).toEqual({
      nextRetryAt: null,
      delaySeconds: 300,
      attempt: 2,
      maxAttempts: 3,
      visibilityStatus: null,
    });
  });
});
