import type {
  OneShotDisplayState,
  OneShotProgressStage,
} from "../types/oneshot.js";
import {
  EXECUTING_STATES as SHARED_EXECUTING_STATES,
  bucketForView,
  normalizeDashboardStage,
  type OneShotViewBucket,
} from "../shared/oneshotStateModel.js";

export interface RetryEtaData {
  nextRetryAt: string | null;
  delaySeconds: number | null;
  attempt: number | null;
  maxAttempts: number | null;
  visibilityStatus: "success" | "failed" | null;
}

/**
 * Extracts retry-ETA fields from a raw `transientRetry` metadata object
 * (as stored in `oneshot_run_events.metadata_json.transientRetry`).
 *
 * Returns `null` when `raw` is falsy or not a plain object (e.g. from a
 * malformed or pre-feature event row), so callers can safely skip those.
 */
export function mapTransientRetryMetadata(
  raw: unknown,
): RetryEtaData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const visibilityStatus =
    r.visibilityChangeStatus === "success" ||
    r.visibilityChangeStatus === "failed"
      ? r.visibilityChangeStatus
      : null;
  return {
    nextRetryAt:
      visibilityStatus === "success" && typeof r.nextRetryTimestamp === 'string'
        ? r.nextRetryTimestamp
        : null,
    delaySeconds: typeof r.retryDelaySeconds === 'number' ? r.retryDelaySeconds : null,
    attempt: typeof r.retryAttempt === 'number' ? r.retryAttempt : null,
    maxAttempts: typeof r.maxRetryAttempts === 'number' ? r.maxRetryAttempts : null,
    visibilityStatus,
  };
}

export { bucketForView, type OneShotViewBucket };

export const EXECUTING_STATES: ReadonlySet<OneShotDisplayState> = new Set(
  SHARED_EXECUTING_STATES as readonly OneShotDisplayState[],
);

export type FailedProgressStage = Exclude<
  OneShotProgressStage,
  "pr_complete"
>;

export type PausedProgressStage = Exclude<
  OneShotProgressStage,
  "qualification" | "planning" | "pr_complete"
>;

export interface FailedStageInferenceInput {
  transitionStage?: string | null;
  finalDisposition?: string | null;
  latestArtifactStage?: string | null;
  currentPlanVersion?: number | null;
  currentReviewVersion?: number | null;
  currentImplementationVersion?: number | null;
  currentCodeReviewVersion?: number | null;
  currentTestVersion?: number | null;
}

export type DashboardIdLookup =
  | { kind: "run"; id: number }
  | { kind: "qualifier-task"; id: number };

function normalizeFailedStage(
  stage: string | null | undefined,
): FailedProgressStage | null {
  return normalizeDashboardStage(stage);
}

function normalizePausedStage(
  stage: string | null | undefined,
): PausedProgressStage | null {
  const normalized = normalizeDashboardStage(stage);
  switch (normalized) {
    case "review":
    case "implementation":
    case "code_review":
    case "testing":
      return normalized;
    default:
      return null;
  }
}

function normalizeReviewLikeStage(
  stage: string | null | undefined,
): Extract<PausedProgressStage, "review" | "code_review"> | null {
  const normalized = normalizePausedStage(stage);
  if (normalized === "review" || normalized === "code_review") {
    return normalized;
  }
  return null;
}

function inferStageFromDisposition(
  disposition: string | null | undefined,
): FailedProgressStage | null {
  if (!disposition) {
    return null;
  }

  switch (disposition.toLowerCase()) {
    case "test_failed":
      return "testing";
    case "review_blocked":
    case "review_escalated":
      return "review";
    case "code_review_blocked":
    case "code_review_escalated":
      return "code_review";
    case "workspace_setup_failed":
    case "planning_publish_failed":
      return "qualification";
    default:
      return normalizeDashboardStage(disposition);
  }
}

function inferStageFromVersions(
  input: FailedStageInferenceInput,
): FailedProgressStage | null {
  if (input.currentTestVersion != null) return "testing";
  if (input.currentCodeReviewVersion != null) return "code_review";
  if (input.currentImplementationVersion != null) return "implementation";
  if (input.currentReviewVersion != null) return "review";
  if (input.currentPlanVersion != null) return "planning";
  return null;
}

export function inferFailedStage(
  input: FailedStageInferenceInput,
): FailedProgressStage {
  return (
    normalizeFailedStage(input.transitionStage) ??
    inferStageFromDisposition(input.finalDisposition) ??
    inferStageFromVersions(input) ??
    normalizeFailedStage(input.latestArtifactStage) ??
    "qualification"
  );
}

export function inferBlockedOrEscalatedStage(
  input: FailedStageInferenceInput,
): Extract<PausedProgressStage, "review" | "code_review"> {
  return (
    normalizeReviewLikeStage(input.transitionStage) ??
    normalizeReviewLikeStage(inferStageFromDisposition(input.finalDisposition)) ??
    "review"
  );
}

export function inferReplanRequiredStage(
  input: FailedStageInferenceInput,
): PausedProgressStage {
  return (
    normalizePausedStage(input.transitionStage) ??
    normalizePausedStage(inferStageFromVersions(input)) ??
    "implementation"
  );
}

export function progressForFailedStage(stage: FailedProgressStage): {
  progressStage: FailedProgressStage;
  progressPercent: number;
} {
  switch (stage) {
    case "qualification":
      return { progressStage: "qualification", progressPercent: 10 };
    case "planning":
      return { progressStage: "planning", progressPercent: 22 };
    case "review":
      return { progressStage: "review", progressPercent: 38 };
    case "implementation":
      return { progressStage: "implementation", progressPercent: 55 };
    case "code_review":
      return { progressStage: "code_review", progressPercent: 70 };
    case "testing":
      return { progressStage: "testing", progressPercent: 85 };
  }
}

export function progressForPausedStage(stage: PausedProgressStage): {
  progressStage: PausedProgressStage;
  progressPercent: number;
} {
  switch (stage) {
    case "review":
      return { progressStage: "review", progressPercent: 40 };
    case "implementation":
      return { progressStage: "implementation", progressPercent: 50 };
    case "code_review":
      return { progressStage: "code_review", progressPercent: 72 };
    case "testing":
      return { progressStage: "testing", progressPercent: 85 };
  }
}

export function parseDashboardId(
  dashboardId: string | null | undefined,
): DashboardIdLookup | null {
  if (!dashboardId) {
    return null;
  }

  const runMatch = /^run-(\d+)$/.exec(dashboardId);
  if (runMatch) {
    const id = Number(runMatch[1]);
    return Number.isInteger(id) && id > 0 ? { kind: "run", id } : null;
  }

  const qualifierMatch = /^qualifier-task-(\d+)$/.exec(dashboardId);
  if (qualifierMatch) {
    const id = Number(qualifierMatch[1]);
    return Number.isInteger(id) && id > 0
      ? { kind: "qualifier-task", id }
      : null;
  }

  return null;
}
