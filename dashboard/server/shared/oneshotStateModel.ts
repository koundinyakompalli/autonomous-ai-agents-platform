export const EXECUTING_STATES = [
  "qualification_pending",
  "planning",
  "reviewing",
  "implementing",
  "code_reviewing",
  "testing",
] as const;

export const QUEUED_STATES = [
  "queued_for_planning",
  "queued_for_review",
  "queued_for_implementation",
  "queued_for_code_review",
  "queued_for_testing",
] as const;

export const WAITING_STATES = [
  "repo_confirmation_pending",
  "needs_revision",
  "approved",
  "escalated",
  "replan_required",
] as const;

export const TERMINAL_STATES = [
  "pr_open",
  "completed",
  "failed",
  "qualification_failed",
  "qualification_no_action",
  "blocked",
] as const;

export const ACTIVE_STATES = [
  ...EXECUTING_STATES,
  ...QUEUED_STATES,
  ...WAITING_STATES,
] as const;

export const ERROR_DISPLAY_STATES = [
  "failed",
  "qualification_failed",
  "blocked",
  "escalated",
  "replan_required",
] as const;

export const BLOCKED_DISPLAY_STATES = [
  "blocked",
  "escalated",
] as const;

export const STATE_LABELS = {
  qualification_pending: "Qualification Pending",
  repo_confirmation_pending: "Repo Confirmation Pending",
  qualification_failed: "Qualification Failed",
  qualification_no_action: "Qualification No Action",
  queued_for_planning: "Queued for Planning",
  planning: "Planning",
  queued_for_review: "Queued for Review",
  reviewing: "Reviewing",
  needs_revision: "Needs Revision",
  approved: "Approved",
  escalated: "Escalated",
  blocked: "Blocked",
  queued_for_implementation: "Queued for Implementation",
  implementing: "Implementing",
  queued_for_code_review: "Queued for Code Review",
  code_reviewing: "Code Reviewing",
  queued_for_testing: "Queued for Testing",
  testing: "Testing",
  replan_required: "Replan Required",
  pr_open: "PR Open",
  completed: "Completed",
  failed: "Failed",
} as const;

export const HISTORY_STATE_OPTIONS = [
  { value: "all", label: "All states" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "qualification_failed", label: "Qualification Failed" },
  { value: "qualification_no_action", label: "Qualification No Action" },
  { value: "blocked", label: "Blocked" },
] as const;

export type OneShotViewBucket =
  | "running"
  | "queued"
  | "waiting"
  | "history"
  | "other";

export type NormalizedDashboardStage =
  | "qualification"
  | "planning"
  | "review"
  | "implementation"
  | "code_review"
  | "testing"
  | "pr_complete";

export function bucketForView(state: string): OneShotViewBucket {
  if ((EXECUTING_STATES as readonly string[]).includes(state)) return "running";
  if ((QUEUED_STATES as readonly string[]).includes(state)) return "queued";
  if ((WAITING_STATES as readonly string[]).includes(state)) return "waiting";
  if ((TERMINAL_STATES as readonly string[]).includes(state)) return "history";
  return "other";
}

export function normalizeDashboardStage(
  stage: string | null | undefined,
): Exclude<NormalizedDashboardStage, "pr_complete"> | null {
  if (!stage) {
    return null;
  }

  switch (stage.toLowerCase()) {
    case "qualification":
    case "qualification_pending":
    case "repo_confirmation_pending":
    case "qualification_failed":
    case "qualification_no_action":
      return "qualification";
    case "plan":
    case "trace":
    case "verify":
    case "planning":
    case "queued_for_planning":
      return "planning";
    case "review":
    case "reviewing":
    case "queued_for_review":
      return "review";
    case "implementation":
    case "implementing":
    case "queued_for_implementation":
      return "implementation";
    case "code_review":
    case "code_reviewing":
    case "queued_for_code_review":
      return "code_review";
    case "test_result":
    case "testing":
    case "queued_for_testing":
      return "testing";
    default:
      return null;
  }
}
