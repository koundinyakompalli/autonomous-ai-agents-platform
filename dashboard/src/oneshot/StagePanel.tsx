import { useMemo, useState } from "react";
import type {
  OneShotDashboardRow,
  OneShotProgressStage,
  OneShotRunTimelineResponse,
  OneShotStageDetail,
  OneShotTimelineEvent,
  OneShotTimelineEventTone,
  OneShotTimelineStageState,
} from "./types.js";
import {
  ERROR_DISPLAY_STATES,
  PIPELINE_STAGES,
  QUEUED_STATES,
  STAGE_LABELS,
  TERMINAL_STATES,
  WAITING_STATES,
} from "./pipelineStyles.js";
import {
  formatDateTime,
  formatDuration,
  formatDurationMs,
  formatRunElapsed,
  formatModelName,
  formatRelTime,
  formatTokens,
  formatUsd,
} from "./formatters.js";
import { displayStateLabel } from "./failureDisplay.js";

type NoteLevel = "info" | "ok" | "warn" | "err" | "res" | "dim";

function currentStageIdx(row: OneShotDashboardRow): number {
  const idx = PIPELINE_STAGES.indexOf(row.progressStage);
  return idx >= 0 ? idx : 0;
}

function fallbackState(
  row: OneShotDashboardRow,
  stage: OneShotProgressStage,
): OneShotTimelineStageState {
  const currentIdx = currentStageIdx(row);
  const stageIdx = PIPELINE_STAGES.indexOf(stage);

  if (stageIdx < currentIdx) return "completed";
  if (stageIdx > currentIdx) return "pending";
  if (row.displayState === "qualification_no_action") return "skipped";
  if (row.displayState === "pr_open") return "completed";
  if (QUEUED_STATES.includes(row.displayState)) return "queued";
  if (WAITING_STATES.includes(row.displayState)) return "waiting";
  if (ERROR_DISPLAY_STATES.includes(row.displayState)) return "failed";
  if (TERMINAL_STATES.includes(row.displayState)) {
    return "completed";
  }
  return "running";
}

function displayStageState(
  row: OneShotDashboardRow,
  stage: OneShotProgressStage,
  detail: OneShotStageDetail | undefined,
): OneShotTimelineStageState {
  if (
    row.displayState === "qualification_no_action" &&
    stage === "qualification"
  ) {
    return "skipped";
  }
  return detail?.state ?? fallbackState(row, stage);
}

function statusLabel(state: OneShotTimelineStageState): string {
  switch (state) {
    case "completed":
      return "Completed";
    case "skipped":
      return "Skipped";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "failed":
      return "Failed";
    case "pending":
      return "Pending";
  }
}

function toneClass(state: OneShotTimelineStageState): string {
  switch (state) {
    case "failed":
      return " bad";
    case "waiting":
    case "queued":
      return " warn";
    case "completed":
      return " ok";
    case "skipped":
      return "";
    default:
      return "";
  }
}

function eventLevel(tone: OneShotTimelineEventTone): NoteLevel {
  switch (tone) {
    case "success":
      return "ok";
    case "warning":
      return "warn";
    case "error":
      return "err";
    case "muted":
      return "dim";
    case "info":
      return "info";
  }
}

function statDuration(
  row: OneShotDashboardRow,
  detail: OneShotStageDetail | undefined,
): string {
  if (detail?.durationMs != null) return formatDurationMs(detail.durationMs);
  if (detail?.startedAt && detail.completedAt) {
    return formatDuration(detail.startedAt, detail.completedAt);
  }
  if (detail?.startedAt && detail.state === "running") {
    return formatDuration(detail.startedAt, new Date().toISOString());
  }
  return formatRunElapsed(row);
}

function fallbackLines(
  row: OneShotDashboardRow,
  stage: OneShotProgressStage,
): Array<{ level: NoteLevel; message: string }> {
  const state = fallbackState(row, stage);
  if (state === "pending") {
    return [
      {
        level: "dim",
        message: "No recorded events or artifacts for this stage yet.",
      },
    ];
  }

  return [
    {
      level: "warn",
      message:
        "Timeline endpoint data is unavailable; showing dashboard snapshot only.",
    },
    {
      level:
        row.failureAttribution?.attribution === "ticket"
          ? "warn"
          : row.displayState === "failed" ||
              row.displayState === "qualification_failed"
          ? "err"
          : "res",
      message: `Dashboard state: ${displayStateLabel(row)}`,
    },
    {
      level: "info",
      message: `Updated ${formatRelTime(row.updatedAt)} · ${formatDateTime(row.updatedAt)}`,
    },
    {
      level: "info",
      message: `Progress ${row.progressPercent}% · plan review loops ${row.planReviewLoopCount ?? row.reviewLoopCount}/${row.maxPlanReviewLoops ?? row.maxReviewLoops} · verification loops ${row.verificationLoopCount ?? 0}/${row.maxVerificationLoops ?? 0}`,
    },
  ];
}

function metadataText(metadata: OneShotTimelineEvent["metadata"]): string {
  const parts = Object.entries(metadata).map(
    ([key, value]) => `${key}=${value}`,
  );
  return parts.length === 0 ? "" : parts.join(" · ");
}

function TimelineLine({
  event,
  idx,
}: {
  event: OneShotTimelineEvent;
  idx: number;
}) {
  const level = eventLevel(event.tone);
  const meta = metadataText(event.metadata);
  return (
    <div className={`log-line log-${level}`}>
      <span className="log-ts" title={formatDateTime(event.occurredAt)}>
        {String(idx + 1).padStart(2, "0")}
      </span>
      <span className={`log-level log-level-${level}`}>
        {event.eventType.replace(/_/g, " ").slice(0, 10).toUpperCase()}
      </span>
      <span className="log-msg">
        <span>{event.label}</span>
        <span className="log-meta">
          {formatRelTime(event.occurredAt)}
          {meta ? ` · ${meta}` : ""}
        </span>
      </span>
    </div>
  );
}

export function StagePanel({
  row,
  stage,
  timeline,
  isTimelineLoading = false,
  timelineError = null,
}: {
  row: OneShotDashboardRow;
  stage: OneShotProgressStage;
  timeline?: OneShotRunTimelineResponse | null;
  isTimelineLoading?: boolean;
  timelineError?: string | null;
}) {
  const [showAllEvents, setShowAllEvents] = useState(false);
  const detail = timeline?.stages.find((entry) => entry.stage === stage);
  const stageNum = PIPELINE_STAGES.indexOf(stage) + 1;
  const state = displayStageState(row, stage, detail);
  const status = statusLabel(state);
  const statusClass = toneClass(state);
  const modelLabel = formatModelName(detail?.model);

  const fallback = fallbackLines(row, stage);
  const realTimeline = timeline && !timeline.isFallback ? timeline : null;
  const hasTimeline = Boolean(realTimeline);

  const visibleEvents = useMemo(() => {
    if (!realTimeline) return [];
    return showAllEvents
      ? realTimeline.events
      : realTimeline.events.filter((event) => event.stage === stage);
  }, [showAllEvents, stage, realTimeline]);

  return (
    <aside className="stage-panel" aria-labelledby="stage-panel-title">
      <div className="stage-panel-head">
        <div>
          <div className="stage-panel-kicker">
            <span className="mono">
              agent.{String(stageNum).padStart(2, "0")}
            </span>
            <span>·</span>
            <span>{hasTimeline ? "Stage evidence" : "Dashboard snapshot"}</span>
          </div>
          <div id="stage-panel-title" className="stage-panel-title">
            {STAGE_LABELS[stage]}
          </div>
        </div>

        <div className="stage-panel-stats">
          <div className="stage-stat">
            <span className="stage-stat-label">status</span>
            <span className={`stage-stat-value${statusClass}`}>{status}</span>
          </div>
          <div className="stage-stat">
            <span className="stage-stat-label">model</span>
            <span
              className="stage-stat-value model"
              title={detail?.model ?? undefined}
            >
              {modelLabel}
            </span>
          </div>
          <div className="stage-stat">
            <span className="stage-stat-label">latest tokens</span>
            <span className="stage-stat-value">
              {detail?.tokensUsed != null
                ? formatTokens(detail.tokensUsed)
                : "—"}
            </span>
          </div>
          <div className="stage-stat">
            <span className="stage-stat-label">latest cost</span>
            <span className="stage-stat-value">
              {detail?.costUsd != null ? formatUsd(detail.costUsd) : "—"}
            </span>
          </div>
          <div className="stage-stat">
            <span className="stage-stat-label">total tokens</span>
            <span className="stage-stat-value">
              {detail?.totalTokensUsed != null
                ? formatTokens(detail.totalTokensUsed)
                : "—"}
            </span>
          </div>
          <div className="stage-stat">
            <span className="stage-stat-label">total cost</span>
            <span className="stage-stat-value">
              {detail?.totalCostUsd != null
                ? formatUsd(detail.totalCostUsd)
                : "—"}
            </span>
          </div>
          <div className="stage-stat">
            <span className="stage-stat-label">elapsed</span>
            <span className="stage-stat-value">
              {statDuration(row, detail)}
            </span>
          </div>
        </div>
      </div>

      {/* Keyed on `stage` so switching stages remounts the wrapper and
          plays the lg-panel-swap fade. The stage-panel-head above stays
          stable (header stats crossfading would feel jumpy). */}
      <div className="stage-panel-body" key={stage}>
        <div className="stage-evidence-bar">
          <div className="stage-evidence-meta mono dim">
            {detail?.latestVersion != null
              ? `artifact v${detail.latestVersion}`
              : "no artifact"}
            {detail?.artifactStatus ? ` · ${detail.artifactStatus}` : ""}
            {detail?.attempts
              ? ` · ${detail.attempts} attempt${detail.attempts === 1 ? "" : "s"}`
              : ""}
          </div>
          {realTimeline && realTimeline.events.length > 0 && (
            <button
              type="button"
              className="stage-toggle"
              onClick={() => setShowAllEvents((value) => !value)}
            >
              {showAllEvents ? "Selected stage" : "All events"}
            </button>
          )}
        </div>

        {timelineError && (
          <div className="timeline-warning">
            Timeline unavailable: {timelineError}
          </div>
        )}

        {detail && detail.metadataSummary.length > 0 && (
          <div className="stage-summary-list">
            {detail.metadataSummary.map((line) => (
              <span key={line} className="stage-summary-chip">
                {line}
              </span>
            ))}
          </div>
        )}

        <div className="stage-logs" aria-label="Stage timeline">
          {isTimelineLoading && !timeline && (
            <div className="log-line log-dim">
              <span className="log-ts">··</span>
              <span className="log-level log-level-dim">LOAD</span>
              <span className="log-msg">Loading stage timeline…</span>
            </div>
          )}

          {hasTimeline &&
            visibleEvents.length > 0 &&
            visibleEvents.map((event, idx) => (
              <TimelineLine key={event.id} event={event} idx={idx} />
            ))}

          {hasTimeline && visibleEvents.length === 0 && (
            <div className="log-line log-dim">
              <span className="log-ts">00</span>
              <span className="log-level log-level-dim">EMPTY</span>
              <span className="log-msg">
                No {showAllEvents ? "run" : "stage"} timeline events recorded.
              </span>
            </div>
          )}

          {!hasTimeline &&
            fallback.map((note, idx) => (
              <div
                key={`${note.level}-${idx}`}
                className={`log-line log-${note.level}`}
              >
                <span className="log-ts">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span className={`log-level log-level-${note.level}`}>
                  {note.level.toUpperCase()}
                </span>
                <span className="log-msg">{note.message}</span>
              </div>
            ))}
        </div>
      </div>
    </aside>
  );
}
