import type { OneShotDashboardRow } from "./types.js";
import {
  BLOCKED_DISPLAY_STATES,
  ERROR_DISPLAY_STATES,
  EXECUTING_STATES,
  QUEUED_STATES,
  TERMINAL_STATES,
  WAITING_STATES,
} from "./pipelineStyles.js";

export type StatusTone =
  | "completed"
  | "running"
  | "queued"
  | "waiting"
  | "blocked"
  | "failed"
  | "neutral";

/**
 * Single source of truth for "what tone should a row's status pill use?"
 * RunsView, QueueBoard, DetailModal each used to carry a local copy of
 * this classifier; they now share this one so tone semantics cannot drift.
 *
 * Ordering matters: the displayState can match multiple groups (e.g. a
 * row could be both terminal and errored), so we check more specific
 * outcomes first — completed → blocked → failed → waiting → queued →
 * running → fallback.
 */
export function deriveStatusTone(row: OneShotDashboardRow): StatusTone {
  if (row.displayState === "qualification_no_action") return "neutral";
  // Row status tones track lifecycle; readiness remains a separate chip/model.
  if (row.displayState === "completed" || row.displayState === "pr_open") {
    return "completed";
  }
  if (row.failureAttribution?.attribution === "ticket") return "waiting";
  if (row.failureAttribution?.attribution === "mixed") return "blocked";
  if (BLOCKED_DISPLAY_STATES.includes(row.displayState)) return "blocked";
  if (ERROR_DISPLAY_STATES.includes(row.displayState)) return "failed";
  if (WAITING_STATES.includes(row.displayState)) return "waiting";
  if (QUEUED_STATES.includes(row.displayState)) return "queued";
  if (EXECUTING_STATES.includes(row.displayState)) return "running";
  if (TERMINAL_STATES.includes(row.displayState)) return "blocked";
  return "waiting";
}
