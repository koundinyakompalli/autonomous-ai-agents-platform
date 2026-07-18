import { STATE_LABELS } from "./pipelineStyles.js";
import type { OneShotDashboardRow } from "./types.js";

export function displayStateLabel(row: OneShotDashboardRow): string {
  return row.failureAttribution?.label ?? STATE_LABELS[row.displayState];
}

export function failureAttributionChipClass(row: OneShotDashboardRow): string {
  return `attribution-${row.failureAttribution?.attribution ?? "none"}`;
}

export function failureOwnerCopy(row: OneShotDashboardRow): string | null {
  switch (row.failureAttribution?.attribution) {
    case "ticket":
      return "Ticket author action: update Jira with acceptance criteria, scope, repository, or product decisions before retrying OneShot.";
    case "oneshot":
      return row.failureAttribution.label === "Qualifier Error"
        ? "OneShot platform action: investigate the qualifier runtime/output failure before asking the ticket author for changes."
        : "OneShot platform action: investigate the failed OneShot stage or runtime before asking the ticket author for changes.";
    case "mixed":
      return "Shared action: confirm ticket readiness and inspect the OneShot runtime signal before retrying.";
    case "unknown":
      return "Triage needed: this failure does not match a known ticket or platform pattern yet.";
    default:
      return null;
  }
}
