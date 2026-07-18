import { Fragment, useEffect, useState } from "react";
import type {
  OneShotDashboardRow,
  OneShotProgressStage,
  OneShotStageDetail,
  OneShotTimelineStageState,
} from "./types.js";
import {
  ERROR_DISPLAY_STATES,
  EXECUTING_STATES,
  PIPELINE_STAGES,
  QUEUED_STATES,
  STAGE_LABELS,
  TERMINAL_STATES,
  WAITING_STATES,
} from "./pipelineStyles.js";
import { ICON_STROKE } from "./icons.js";
import {
  formatDurationMs,
  formatElapsedClockMs,
  formatModelName,
  formatTokens,
  formatUsd,
} from "./formatters.js";

type NodeState = OneShotTimelineStageState;

function stageIndex(stage: OneShotProgressStage): number {
  const idx = PIPELINE_STAGES.indexOf(stage);
  return idx >= 0 ? idx : 0;
}

function isPrOpenCurrentStage(row: OneShotDashboardRow, idx: number): boolean {
  return (
    row.displayState === "pr_open" &&
    row.progressStage === "pr_complete" &&
    idx === stageIndex(row.progressStage)
  );
}

function classifyFromRow(row: OneShotDashboardRow, idx: number): NodeState {
  const current = stageIndex(row.progressStage);
  if (idx < current) return "completed";
  if (idx > current) return "pending";
  if (row.displayState === "qualification_no_action") return "skipped";
  if (isPrOpenCurrentStage(row, idx)) return "completed";
  if (EXECUTING_STATES.includes(row.displayState)) return "running";
  if (QUEUED_STATES.includes(row.displayState)) return "queued";
  if (WAITING_STATES.includes(row.displayState)) return "waiting";
  if (ERROR_DISPLAY_STATES.includes(row.displayState)) {
    return row.failureAttribution?.attribution === "ticket"
      ? "waiting"
      : "failed";
  }
  if (
    TERMINAL_STATES.includes(row.displayState) &&
    !ERROR_DISPLAY_STATES.includes(row.displayState)
  ) {
    return "completed";
  }
  return "pending";
}

function displayStageState(
  row: OneShotDashboardRow,
  stage: OneShotProgressStage,
  detail: OneShotStageDetail | undefined,
  idx: number,
): NodeState {
  if (
    row.displayState === "qualification_no_action" &&
    stage === "qualification"
  ) {
    return "skipped";
  }
  return detail?.state ?? classifyFromRow(row, idx);
}

function stateLabel(state: NodeState): string {
  switch (state) {
    case "completed":
      return "Done";
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

function StatusIcon({ state }: { state: NodeState }) {
  if (state === "completed") {
    return (
      <svg viewBox="0 0 14 14" className="stream-icon ok" aria-hidden="true">
        <path
          d="M3 7.5l3 3 5-6"
          stroke="currentColor"
          strokeWidth={ICON_STROKE}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === "failed") {
    return (
      <svg viewBox="0 0 14 14" className="stream-icon bad" aria-hidden="true">
        <path
          d="M4 4l6 6M10 4l-6 6"
          stroke="currentColor"
          strokeWidth={ICON_STROKE}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (state === "running") {
    return <span className="stream-spinner" aria-hidden="true" />;
  }
  if (state === "waiting") {
    return <span className="stream-waiting-dot" aria-hidden="true" />;
  }
  if (state === "skipped") {
    return (
      <svg viewBox="0 0 14 14" className="stream-icon dim" aria-hidden="true">
        <path
          d="M4 7h6"
          stroke="currentColor"
          strokeWidth={ICON_STROKE}
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 14 14" className="stream-icon dim" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="5"
        stroke="currentColor"
        strokeWidth={ICON_STROKE * 0.8}
        fill="none"
        strokeDasharray="2 2"
      />
    </svg>
  );
}

function stageMeta(
  detail: OneShotStageDetail | undefined,
  state: NodeState,
): string {
  if (!detail) return state === "pending" ? "—" : stateLabel(state);
  if (detail.latestVersion != null) {
    const parts = [`v${detail.latestVersion}`];
    if (detail.model) parts.push(formatModelName(detail.model));
    if (detail.totalCostUsd != null) parts.push(formatUsd(detail.totalCostUsd));
    else if (detail.costUsd != null) parts.push(formatUsd(detail.costUsd));
    if (detail.totalTokensUsed != null)
      parts.push(formatTokens(detail.totalTokensUsed));
    else if (detail.tokensUsed != null)
      parts.push(formatTokens(detail.tokensUsed));
    if (detail.durationMs != null)
      parts.push(formatDurationMs(detail.durationMs));
    return parts.join(" · ");
  }
  if (detail.eventCount > 0) {
    return `${detail.eventCount} event${detail.eventCount === 1 ? "" : "s"}`;
  }
  if (detail.attempts > 0) {
    return `${detail.attempts} attempt${detail.attempts === 1 ? "" : "s"}`;
  }
  return state === "pending" ? "—" : stateLabel(state);
}

/**
 * Live-ticking elapsed time for the running stage. Updates every 1s via
 * a component-local interval so the ticker smooths over the timeline
 * poll cadence (5s). Clamps future/invalid timestamps to 0:00.
 */
function RunningMeta({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const startedMs = new Date(startedAt).getTime();
  const elapsed = Date.now() - startedMs;
  return (
    <span className="stream-meta-live">
      <span className="stream-meta-pulse" aria-hidden="true" />
      {formatElapsedClockMs(elapsed)}
    </span>
  );
}

function isParseableDate(value: string | null | undefined): value is string {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Glassy pill card with a drifting multi-color orb (active), settled
 * green orb (completed), red orb (failed), or dark glass (queued/
 * pending/waiting/skipped). All motion lives in CSS — keep this
 * component free of refs and animation state.
 */
function StreamCard({
  stage,
  label,
  idx,
  state,
  detail,
  selected,
  showLiveTicker,
  onSelect,
}: {
  stage: OneShotProgressStage;
  label: string;
  idx: number;
  state: NodeState;
  detail: OneShotStageDetail | undefined;
  selected: boolean;
  showLiveTicker: boolean;
  onSelect: () => void;
}) {
  const num = String(idx + 1).padStart(2, "0");
  const modelName = detail?.model ? formatModelName(detail.model) : "";
  const tokens = detail?.totalTokensUsed ?? detail?.tokensUsed ?? null;
  const cost = detail?.totalCostUsd ?? detail?.costUsd ?? null;
  return (
    <button
      type="button"
      className={["stream-card", state, selected ? "selected" : ""]
        .filter(Boolean)
        .join(" ")}
      onClick={onSelect}
      aria-current={selected ? "step" : undefined}
      aria-label={`${label} stage (${stateLabel(state)})`}
      data-stage={stage}
    >
      <div className="c2-orb" aria-hidden="true">
        <div className="c2-orb-blob b1" />
        <div className="c2-orb-blob b2" />
        <div className="c2-orb-blob b3" />
      </div>
      <div className="c2-vignette" aria-hidden="true" />

      <span className="border-runner" aria-hidden="true">
        <span className="bead b1" />
        <span className="bead b2" />
        <span className="bead b3" />
      </span>

      <div className="c2-top">
        <span className="c2-num">
          <span>{num}</span>
          <StatusIcon state={state} />
        </span>
        {modelName ? <span className="c2-model">{modelName}</span> : null}
      </div>

      <div className="c2-name">{label}</div>

      <div className="c2-bottom">
        {showLiveTicker && detail?.startedAt ? (
          <RunningMeta startedAt={detail.startedAt} />
        ) : tokens != null || cost != null || detail?.durationMs != null ? (
          <span>
            {tokens != null ? formatTokens(tokens) : "—"}
            <span style={{ opacity: 0.5, margin: "0 4px" }}>·</span>
            {cost != null ? formatUsd(cost) : "—"}
            {detail?.durationMs != null ? (
              <>
                <span style={{ opacity: 0.5, margin: "0 4px" }}>·</span>
                {formatDurationMs(detail.durationMs)}
              </>
            ) : null}
          </span>
        ) : (
          <span>{stageMeta(detail, state)}</span>
        )}
      </div>
    </button>
  );
}

/**
 * Kinetic SVG s-curve between cards. Two staggered comets (white head
 * dot + 5 blurred blue tail dots tracking the same path with small
 * time offsets) only animate when the previous stage is `running`.
 */
function StreamChannel({
  idx,
  prevState,
}: {
  idx: number;
  prevState: NodeState;
}) {
  const live = prevState === "running";
  const halted = prevState === "failed";
  const done = prevState === "completed" || prevState === "skipped";

  // s-curve: alternate the wobble direction so adjacent connectors
  // don't all bow the same way.
  const dy1 = idx % 2 === 0 ? -10 : 10;
  const dy2 = idx % 2 === 0 ? 10 : -10;
  const path = `M 0 50 C 40 ${50 + dy1}, 80 ${50 + dy2}, 120 50`;
  const pathId = `stream-path-${idx}`;
  const dur = 4.8;

  const channelClass = ["stream-channel"];
  if (done) channelClass.push("done");
  if (halted) channelClass.push("halted");

  return (
    <div className={channelClass.join(" ")} aria-hidden="true">
      <svg viewBox="0 0 120 100" preserveAspectRatio="none">
        <defs>
          <path id={pathId} d={path} />
        </defs>
        <use href={`#${pathId}`} className="rail" />
        {live ? <use href={`#${pathId}`} className="rail-live" /> : null}
        {live ? (
          <>
            <CometTrail pathId={pathId} dur={dur} delay={-0.32} />
            <CometTrail pathId={pathId} dur={dur} delay={-0.78} />
          </>
        ) : null}
      </svg>
    </div>
  );
}

function CometTrail({
  pathId,
  dur,
  delay,
}: {
  pathId: string;
  dur: number;
  delay: number;
}) {
  const tailOffsets = [0.045, 0.085, 0.13, 0.18, 0.25];
  return (
    <g>
      {tailOffsets.map((dt, k) => (
        <circle
          key={`t${k}`}
          r={6.4 - k * 0.62}
          fill="#6FA9FF"
          opacity={0.58 - k * 0.08}
          style={{ filter: "blur(5.5px)" }}
        >
          <animateMotion
            dur={`${dur}s`}
            repeatCount="indefinite"
            begin={`${(delay + dt) * dur}s`}
          >
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
      <circle
        r="6.8"
        fill="#9EC4FF"
        opacity="0.62"
        style={{ filter: "blur(4.5px)" }}
      >
        <animateMotion
          dur={`${dur}s`}
          repeatCount="indefinite"
          begin={`${delay * dur}s`}
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </circle>
      <circle
        r="1.8"
        fill="#fff"
        opacity="0.78"
        style={{ filter: "drop-shadow(0 0 5px rgba(111, 169, 255, 0.72))" }}
      >
        <animateMotion
          dur={`${dur}s`}
          repeatCount="indefinite"
          begin={`${delay * dur}s`}
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </circle>
    </g>
  );
}

export function PipelineDiagram({
  row,
  selectedStage,
  onSelectStage,
  stages,
}: {
  row: OneShotDashboardRow;
  selectedStage: OneShotProgressStage;
  onSelectStage: (stage: OneShotProgressStage) => void;
  stages?: ReadonlyArray<OneShotStageDetail>;
}) {
  const stageDetails = new Map(stages?.map((stage) => [stage.stage, stage]));

  // Resolve every stage's state up front so each connector knows the
  // previous card's state (drives comet animation + halted styling).
  const resolved = PIPELINE_STAGES.map((stage, idx) => {
    const detail = stageDetails.get(stage);
    return {
      stage,
      idx,
      detail,
      state: displayStageState(row, stage, detail, idx),
    };
  });

  return (
    <nav className="pipeline" aria-label="Pipeline stages">
      {resolved.map(({ stage, idx, detail, state }) => {
        const selected = stage === selectedStage;
        const showLiveTicker =
          state === "running" && isParseableDate(detail?.startedAt);
        return (
          <Fragment key={stage}>
            <StreamCard
              stage={stage}
              label={STAGE_LABELS[stage]}
              idx={idx}
              state={state}
              detail={detail}
              selected={selected}
              showLiveTicker={showLiveTicker}
              onSelect={() => onSelectStage(stage)}
            />
            {idx < PIPELINE_STAGES.length - 1 ? (
              <StreamChannel idx={idx} prevState={state} />
            ) : null}
          </Fragment>
        );
      })}
    </nav>
  );
}
