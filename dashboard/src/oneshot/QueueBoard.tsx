import { useMemo } from "react";
import { MiniPipeline } from "./MiniPipeline.js";
import type { OneShotDashboardRow, OneShotQueueAnalytics } from "./types.js";
import {
  EXECUTING_STATES,
  QUEUED_STATES,
  TERMINAL_STATES,
  WAITING_STATES,
} from "./pipelineStyles.js";
import {
  formatRunElapsed,
  formatRelTime,
  formatTokens,
  hasManualRestart,
} from "./formatters.js";
import { StatusPill } from "./StatusPill.js";
import { deriveStatusTone } from "./statusTone.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import { glassPlaceStyle } from "./motion.js";

type Column = {
  id: "queued" | "running" | "waiting" | "finished";
  title: string;
  dotClass: string;
  rows: ReadonlyArray<OneShotDashboardRow>;
  count: number;
};

export function QueueBoard({
  rows,
  analytics,
  onOpenDetail,
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  rows: ReadonlyArray<OneShotDashboardRow>;
  analytics: OneShotQueueAnalytics;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  const columns = useMemo<Column[]>(() => {
    const queued: OneShotDashboardRow[] = [];
    const running: OneShotDashboardRow[] = [];
    const waiting: OneShotDashboardRow[] = [];
    const finished: OneShotDashboardRow[] = [];

    for (const row of rows) {
      if (EXECUTING_STATES.includes(row.displayState)) running.push(row);
      else if (QUEUED_STATES.includes(row.displayState)) queued.push(row);
      else if (WAITING_STATES.includes(row.displayState)) waiting.push(row);
      else if (TERMINAL_STATES.includes(row.displayState)) finished.push(row);
    }

    queued.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    running.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    waiting.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    finished.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return [
      {
        id: "queued",
        title: "Queued",
        dotClass: "queue-dot-muted",
        rows: queued,
        count: analytics.queued,
      },
      {
        id: "running",
        title: "Running",
        dotClass: "queue-dot-accent",
        rows: running,
        count: analytics.running,
      },
      {
        id: "waiting",
        title: "Waiting",
        dotClass: "queue-dot-warn",
        rows: waiting,
        count: analytics.waiting,
      },
      {
        id: "finished",
        title: "Recently finished",
        dotClass: "queue-dot-dim",
        rows: finished.slice(0, 6),
        count: analytics.recentlyFinished,
      },
    ];
  }, [
    analytics.queued,
    analytics.recentlyFinished,
    analytics.running,
    analytics.waiting,
    rows,
  ]);

  return (
    <div className="view">
      <PageHeader
        title="Queue"
        metrics={[
          { label: "queued", value: analytics.queued },
          { label: "running", value: analytics.running, tone: "accent" },
          { label: "waiting", value: analytics.waiting, tone: "warn" },
          { label: "workers", value: analytics.workerCapacity },
        ]}
        actions={
          <PageHeaderActions
            onSearch={onSearch}
            onNewRun={onNewRun}
            theme={theme}
            onThemeChange={onThemeChange}
          />
        }
      />

      <div className="queue-board">
        {columns.map((column, columnIdx) => (
          <section
            key={column.id}
            className="queue-col glass-place-block"
            aria-labelledby={`queue-col-${column.id}`}
            style={glassPlaceStyle(columnIdx * 55)}
          >
            <div className="queue-col-head">
              <span
                className={`queue-col-dot ${column.dotClass}`}
                aria-hidden="true"
              />
              <span id={`queue-col-${column.id}`} className="queue-col-title">
                {column.title}
              </span>
              <span className="queue-col-count mono">{column.count}</span>
            </div>

            <div className="queue-col-body">
              {column.rows.length === 0 ? (
                <div className="queue-empty dim">
                  {column.id === "queued"
                    ? "queue empty — ready for work"
                    : column.id === "running"
                      ? "no active runs"
                      : column.id === "waiting"
                        ? "no runs parked on external action"
                        : "no recently finished runs"}
                </div>
              ) : (
                column.rows.map((row, rowIdx) => {
                  const compact = column.id === "finished";
                  return (
                    <button
                      key={row.dashboardId}
                      type="button"
                      className={[
                        "queue-card",
                        column.id === "running" ? "live" : "",
                        compact ? "compact" : "",
                        "glass-place-block",
                        "glass-place-nested",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={glassPlaceStyle(
                        columnIdx * 55 + 110 + Math.min(rowIdx, 4) * 22,
                      )}
                      onClick={() => onOpenDetail(row)}
                    >
                      <div className="queue-card-head">
                        <StatusPill tone={deriveStatusTone(row)} />
                        <span className="mono dim queue-card-ticket">
                          {row.jiraKey}
                        </span>
                      </div>

                      <div className="queue-card-title">{row.title}</div>

                      {!compact && (
                        <>
                          <MiniPipeline row={row} width={220} />
                          <div className="queue-card-foot mono dim">
                            <span
                              title={
                                hasManualRestart(row)
                                  ? "elapsed since restart"
                                  : undefined
                              }
                            >
                              {formatRunElapsed(row)}
                            </span>
                            <span>·</span>
                            <span>{formatTokens(row.totalTokensUsed)}</span>
                            <span>·</span>
                            <span>{formatRelTime(row.createdAt)}</span>
                          </div>
                        </>
                      )}

                      {compact && (
                        <div className="queue-card-foot mono dim">
                          <span>{formatRelTime(row.createdAt)}</span>
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
