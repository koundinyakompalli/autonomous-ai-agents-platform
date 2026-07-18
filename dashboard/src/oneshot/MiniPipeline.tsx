import type { CSSProperties } from "react";
import type { OneShotDashboardRow, OneShotProgressStage } from "./types.js";
import {
  ERROR_DISPLAY_STATES,
  PIPELINE_STAGES,
  STAGE_LABELS,
  TERMINAL_STATES,
} from "./pipelineStyles.js";

type SegmentState = "completed" | "active" | "failed" | "warning" | "pending";

function stageIndex(stage: OneShotProgressStage): number {
  const idx = PIPELINE_STAGES.indexOf(stage);
  return idx >= 0 ? idx : 0;
}

function classify(
  row: OneShotDashboardRow,
  idx: number,
  current: number,
): SegmentState {
  if (idx < current) return "completed";
  if (idx > current) return "pending";
  if (
    TERMINAL_STATES.includes(row.displayState) &&
    !ERROR_DISPLAY_STATES.includes(row.displayState)
  ) {
    return "completed";
  }
  if (ERROR_DISPLAY_STATES.includes(row.displayState)) {
    return row.failureAttribution?.attribution === "ticket"
      ? "warning"
      : "failed";
  }
  return "active";
}

const SEGMENT_CLASSES: Record<SegmentState, string> = {
  completed: "mini-success",
  active: "mini-running",
  failed: "mini-failed",
  warning: "mini-warning",
  pending: "mini-pending",
};

export function MiniPipeline({
  row,
  width = 120,
}: {
  row: OneShotDashboardRow;
  width?: number;
}) {
  const current = stageIndex(row.progressStage);
  return (
    <div
      className="mini-pipe mini-pipeline"
      aria-hidden="true"
      style={{
        "--mini-pipeline-width": `${width}px`,
      } as CSSProperties}
    >
      {PIPELINE_STAGES.map((stage, idx) => {
        const state = classify(row, idx, current);
        return (
          <span
            key={stage}
            className={`mini-seg ${SEGMENT_CLASSES[state]}`}
            title={`${STAGE_LABELS[stage]}: ${state}`}
          />
        );
      })}
    </div>
  );
}
