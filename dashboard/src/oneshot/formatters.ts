/**
 * Shared display formatters for OneShot dashboard surfaces.
 * Extracted so Overview, DetailModal, QueueBoard, AgentsView can render
 * identical values without duplicating the token/currency/duration logic.
 */

import type { OneShotDashboardRow } from "./types.js";

export function formatDateTime(value: string): string {
  const date = new Date(value);
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day} at ${time}`;
}

function toFixedRounded(value: number, digits: number): string {
  const factor = 10 ** digits;
  return (Math.round((value + Number.EPSILON) * factor) / factor).toFixed(
    digits,
  );
}

export function formatDuration(createdAt: string, updatedAt: string): string {
  const deltaMs = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
  if (deltaMs <= 0) return "<1m";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rm = minutes % 60;
  if (hours < 24) return rm > 0 ? `${hours}h ${rm}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh > 0 ? `${days}d ${rh}h` : `${days}d`;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function hasManualRestart(
  row: Pick<OneShotDashboardRow, "lastManualRestartAt">,
): boolean {
  return parseTimestamp(row.lastManualRestartAt) != null;
}

export function effectiveRunStartAt(
  row: Pick<OneShotDashboardRow, "createdAt" | "lastManualRestartAt">,
): string {
  return hasManualRestart(row) ? row.lastManualRestartAt! : row.createdAt;
}

export function formatRunElapsed(
  row: Pick<
    OneShotDashboardRow,
    "createdAt" | "lastManualRestartAt" | "updatedAt"
  >,
): string {
  return formatDuration(effectiveRunStartAt(row), row.updatedAt);
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rm = minutes % 60;
  if (hours < 24) return rm > 0 ? `${hours}h ${rm}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh > 0 ? `${days}d ${rh}h` : `${days}d`;
}

/**
 * Wall-clock elapsed formatter for live tickers (e.g., the running-stage
 * meta in PipelineDiagram). Emits "M:SS" under an hour, "H:MM:SS" at or
 * over an hour. Negative or NaN inputs clamp to "0:00" so clock skew and
 * parse failures render sanely.
 *
 * This is intentionally separate from formatDurationMs, which emits
 * coarse labels (<1m, 42m, 2h 5m) for long-running summaries elsewhere
 * in the dashboard.
 */
export function formatElapsedClockMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours === 0) return `${minutes}:${ss}`;
  const mm = String(minutes).padStart(2, "0");
  return `${hours}:${mm}:${ss}`;
}

/** Compact token count with stable decimals: 1_000 → "1.0k", 1_200_000 → "1.20M". */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${toFixedRounded(value / 1000, 1)}k`;
  return `${toFixedRounded(value / 1_000_000, 2)}M`;
}

/** USD with two decimals; sub-cent values collapse to "<$0.01". */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function formatCostSource(
  value: "actual" | "estimated" | "mixed",
): string {
  switch (value) {
    case "actual":
      return "actual";
    case "mixed":
      return "mixed";
    default:
      return "estimated";
  }
}

export function formatModelName(model: string | null | undefined): string {
  if (!model) return "—";
  const normalized = model.trim();
  if (!normalized) return "—";
  const lower = normalized.toLowerCase();

  // Deterministic plan-contract guardrail rows are not LLM models.
  // NOTE: this display label intentionally matches more broadly
  // (substring "plan-contract") than the cost-attribution guardrail
  // predicate isDeterministicGuardrailRow (exact "plan-contract-v1"
  // match, oneshotCosting.ts). Do not "fix" this toward false parity —
  // the label only needs to avoid surfacing a raw id, while the cost
  // predicate must narrowly exclude guardrail rows from spend totals.
  if (lower === "plan-contract-v1" || lower.includes("plan-contract")) {
    return "Plan Contract Check";
  }

  // Minor version is optional so single-minor ids (Sonnet 5) render cleanly;
  // mirrors canonicalizeModelBucket in oneshotAnalytics.ts.
  const claudeMatch = lower.match(
    /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/,
  );
  if (claudeMatch) {
    const family =
      claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    const minor =
      claudeMatch[3] && claudeMatch[3].length <= 2 ? `.${claudeMatch[3]}` : "";
    return `${family} ${claudeMatch[2]}${minor}`;
  }

  const gptMatch = lower.match(/(?:^|[/.-])gpt[-.]?(\d+(?:[.-]\d+)?)/);
  if (gptMatch) {
    return `GPT-${gptMatch[1].replace("-", ".")}`;
  }

  const byDot = normalized.split(".").pop() ?? normalized;
  return byDot.split("/").pop() ?? byDot;
}

/**
 * Relative timestamp ("3m ago", "2h ago", "yesterday"). Returns "just now"
 * for deltas under a minute so the Overview throughput/activity surfaces
 * don't show "0m ago" during rapid polls.
 */
export function formatRelTime(value: string, now: Date = new Date()): string {
  const then = new Date(value).getTime();
  const deltaMs = now.getTime() - then;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return formatDateTime(value);
}
