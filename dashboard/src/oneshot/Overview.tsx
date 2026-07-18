import { type CSSProperties, type ReactNode, useMemo } from "react";
import { MiniPipeline } from "./MiniPipeline.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import { glassPlaceStyle } from "./motion.js";
import {
  AGENT_STAGES,
  BLOCKED_DISPLAY_STATES,
  EXECUTING_STATES,
  QUEUED_STATES,
  STAGE_LABELS,
  WAITING_STATES,
} from "./pipelineStyles.js";
import type {
  OneShotAgentAnalyticsEntry,
  OneShotDashboardRow,
  OneShotOverviewAnalytics,
} from "./types.js";
import {
  formatCostSource,
  formatDuration,
  formatDurationMs,
  formatRunElapsed,
  hasManualRestart,
  formatRelTime,
  formatTokens,
  formatUsd,
} from "./formatters.js";

type RunTone =
  | "completed"
  | "running"
  | "queued"
  | "waiting"
  | "blocked"
  | "failed";

function isCompleted(row: OneShotDashboardRow): boolean {
  return row.displayState === "completed" || row.displayState === "pr_open";
}

function runTone(row: OneShotDashboardRow): RunTone {
  if (isCompleted(row)) {
    if (row.readiness === "ready") return "completed";
    if (row.readiness === "no_action") return "completed";
    if (row.readiness === "needs_review") return "blocked";
    if (row.readiness === "draft" || row.readiness === "with_risks") {
      return "waiting";
    }
    return "waiting";
  }
  if (BLOCKED_DISPLAY_STATES.includes(row.displayState)) return "blocked";
  if (
    row.displayState === "failed" ||
    row.displayState === "qualification_failed"
  ) {
    return "failed";
  }
  if (QUEUED_STATES.includes(row.displayState)) return "queued";
  if (EXECUTING_STATES.includes(row.displayState)) return "running";
  return "waiting";
}

function StatCard({
  label,
  value,
  sub,
  bar,
  barDelayMs = 0,
  placeDelayMs = 0,
  variant,
  isLive = false,
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  bar?: number;
  barDelayMs?: number;
  placeDelayMs?: number;
  variant?: "live";
  isLive?: boolean;
}) {
  const classes = [
    "stat-card",
    "glass-place-block",
    variant === "live" ? "stat-card-live" : "",
    isLive ? "is-live" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={classes} style={glassPlaceStyle(placeDelayMs)}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {bar != null && (
        <div className="stat-bar">
          <div
            className="stat-bar-fill"
            style={revealBarStyle(bar * 100, barDelayMs)}
          />
        </div>
      )}
      <div className="stat-sub">{sub}</div>
    </article>
  );
}

function LiveIndicator({ active }: { active: boolean }) {
  return (
    <span className={`live-indicator${active ? " is-live" : " is-idle"}`}>
      <span className="live-dot" aria-hidden="true" />
      <span className="dim mono">{active ? "open" : "none"}</span>
    </span>
  );
}

function formatOverviewWorkDuration(
  row: OneShotDashboardRow,
  nowMs = Date.now(),
): string {
  if (
    QUEUED_STATES.includes(row.displayState) ||
    WAITING_STATES.includes(row.displayState)
  ) {
    return formatDuration(row.updatedAt, new Date(nowMs).toISOString());
  }

  return formatRunElapsed(row);
}

function revealBarStyle(percent: number, delayMs = 0): CSSProperties {
  const clamped = Math.max(0, Math.min(percent, 100));
  return {
    "--overview-bar-width": `${clamped}%`,
    "--overview-bar-height": `${clamped}%`,
    "--overview-bar-delay": `${delayMs}ms`,
  } as CSSProperties;
}

/**
 * Overview mirrors the prototype layout but derives every value from the
 * loaded backend rows instead of mock data.
 */
export function Overview({
  rows,
  analytics,
  agentAnalytics,
  onOpenDetail,
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  rows: ReadonlyArray<OneShotDashboardRow>;
  analytics: OneShotOverviewAnalytics;
  agentAnalytics: ReadonlyArray<OneShotAgentAnalyticsEntry>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  const activeRuns = useMemo(() => {
    return rows
      .filter(
        (row) =>
          EXECUTING_STATES.includes(row.displayState) ||
          QUEUED_STATES.includes(row.displayState) ||
          WAITING_STATES.includes(row.displayState),
      )
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .slice(0, 8);
  }, [rows]);

  const throughputMax = Math.max(1, ...analytics.throughputBuckets);
  const openWorkCount =
    analytics.running + analytics.queued + analytics.waiting;
  const hasOpenWork = openWorkCount > 0;
  const prOutcomeCount = analytics.completed + analytics.failed;

  return (
    <div className="overview">
      <PageHeader
        title="Overview"
        metrics={[
          { label: "agents", value: AGENT_STAGES.length },
          { label: "starts 24h", value: analytics.runs24h },
          {
            label: "open",
            value: openWorkCount,
            tone: hasOpenWork ? "accent" : "default",
          },
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

      <div className="stat-strip overview-stat-strip">
        <StatCard
          label="Open work"
          value={
            <span className="active-stat-value">
              <span className="active-stat-count">{analytics.running}</span>
              <span className="active-stat-context">
                running · {analytics.queued} queued · {analytics.waiting}{" "}
                waiting
              </span>
            </span>
          }
          sub={<LiveIndicator active={hasOpenWork} />}
          variant="live"
          isLive={hasOpenWork}
          placeDelayMs={0}
        />
        <StatCard
          label="Outcomes (24h)"
          value={prOutcomeCount}
          sub={
            <span>
              <span className="ok">{analytics.completed} PR opened</span> ·{" "}
              <span className="bad">{analytics.failed} failed</span>
            </span>
          }
          placeDelayMs={45}
        />
        <StatCard
          label="PR pass rate"
          value={
            prOutcomeCount === 0
              ? "—"
              : `${(analytics.passRate * 100).toFixed(1)}%`
          }
          sub={
            <span className="dim mono">
              {prOutcomeCount === 0
                ? "no outcomes yet"
                : `${analytics.completed}/${prOutcomeCount} reached PR`}
            </span>
          }
          bar={analytics.passRate}
          barDelayMs={80}
          placeDelayMs={90}
        />
        <StatCard
          label="Time to PR"
          value={
            analytics.completed === 0
              ? "—"
              : formatDurationMs(analytics.medianTimeToPrMs)
          }
          sub={
            <span className="dim mono">
              {analytics.completed === 0
                ? "no PRs yet"
                : `median across ${analytics.completed} PR${analytics.completed === 1 ? "" : "s"} opened`}
            </span>
          }
          placeDelayMs={135}
        />
        <StatCard
          label="Spend (24h)"
          value={
            analytics.estimatedCostUsd === 0 && analytics.totalTokens === 0
              ? "—"
              : formatUsd(analytics.estimatedCostUsd)
          }
          sub={
            <span className="dim mono">
              {analytics.estimatedCostUsd === 0 && analytics.totalTokens === 0
                ? "no spend yet"
                : `${formatTokens(analytics.totalTokens)} tokens · ${formatCostSource(analytics.costSource)}`}
            </span>
          }
          placeDelayMs={180}
        />
      </div>

      <div className="two-col">
        <section
          className="agent-health glass-place-block"
          aria-labelledby="overview-agent-health"
          style={glassPlaceStyle(210)}
        >
          <div className="section-head">
            <span id="overview-agent-health">Stage health</span>
            <span className="dim">
              last 24h · backend-recorded duration + fail rate
            </span>
          </div>
          <div className="agent-health-grid">
            {agentAnalytics.map((entry, idx) => (
              <div
                key={entry.stage}
                className="agent-card glass-place-block glass-place-nested"
                style={glassPlaceStyle(270 + idx * 35)}
              >
                <div className="agent-card-head">
                  <span className="agent-idx mono">
                    {String(idx + 1).padStart(2, "0")}
                  </span>
                  <span className="agent-name">
                    {STAGE_LABELS[entry.stage]}
                  </span>
                  {entry.failRate > 0.1 && (
                    <span className="agent-warn">!</span>
                  )}
                </div>
                <div className="agent-stats">
                  <div className="agent-stat">
                    <div className="agent-stat-label">avg duration</div>
                    <div className="agent-stat-value mono">
                      {entry.runs === 0
                        ? "—"
                        : formatDurationMs(entry.avgLatencyMs)}
                    </div>
                  </div>
                  <div className="agent-stat">
                    <div className="agent-stat-label">fail rate</div>
                    <div
                      className={`agent-stat-value mono${entry.failRate > 0.1 ? " bad" : ""}`}
                    >
                      {entry.runs === 0
                        ? "—"
                        : `${(entry.failRate * 100).toFixed(1)}%`}
                    </div>
                  </div>
                </div>
                <div className="agent-bar">
                  {entry.runs > 0 && (
                    <div
                      className="agent-bar-fill"
                      style={{
                        ...revealBarStyle(
                          Math.max(entry.failRate * 100, 3),
                          idx * 45,
                        ),
                        background:
                          entry.failRate > 0.15
                            ? "var(--bad)"
                            : entry.failRate > 0.05
                              ? "var(--warn)"
                              : "var(--ok)",
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          className="throughput glass-place-block"
          aria-labelledby="overview-throughput"
          style={glassPlaceStyle(255)}
        >
          <div className="section-head">
            <span id="overview-throughput">Throughput</span>
            <span className="dim">starts/hour · past 24h</span>
          </div>
          <div className="throughput-chart">
            {analytics.throughputBuckets.map((value, idx) => (
              <div key={idx} className="throughput-bar-wrap">
                <div
                  className="throughput-bar"
                  style={revealBarStyle(
                    (value / throughputMax) * 100,
                    idx * 18,
                  )}
                  title={`${value} ${value === 1 ? "start" : "starts"}`}
                />
              </div>
            ))}
          </div>
          <div className="throughput-axis mono">
            <span>−24h</span>
            <span>−18h</span>
            <span>−12h</span>
            <span>−6h</span>
            <span>now</span>
          </div>
        </section>
      </div>

      <section
        className="run-list glass-place-block"
        aria-labelledby="overview-active-runs"
        style={glassPlaceStyle(315)}
      >
        <div className="section-head">
          <span id="overview-active-runs">Open Work</span>
        </div>

        <div className="table">
          <div className="table-head mono">
            <div className="col-status" />
            <div className="col-ticket">ticket</div>
            <div className="col-title">title</div>
            <div className="col-pipe">pipeline</div>
            <div className="col-time">duration</div>
            <div className="col-tok">tokens</div>
            <div className="col-when">started</div>
          </div>

          {activeRuns.map((row) => {
            const tone = runTone(row);
            return (
              <button
                key={row.dashboardId}
                type="button"
                className={["table-row", "overview-run-row"]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => onOpenDetail(row)}
                aria-label={`Open details for ${row.jiraKey}`}
              >
                <div className="col-status">
                  <span className={`row-status status-${tone}`}>
                    <span className="dot" />
                  </span>
                </div>
                <div className="col-ticket mono">{row.jiraKey}</div>
                <div className="col-title">{row.title}</div>
                <div className="col-pipe">
                  <MiniPipeline row={row} width={180} />
                </div>
                <div
                  className="col-time mono dim"
                  title={
                    hasManualRestart(row) ? "elapsed since restart" : undefined
                  }
                >
                  {formatOverviewWorkDuration(row)}
                </div>
                <div className="col-tok mono dim">
                  {formatTokens(row.totalTokensUsed)}
                </div>
                <div className="col-when mono dim">
                  {formatRelTime(row.createdAt)}
                </div>
              </button>
            );
          })}

          {activeRuns.length === 0 && (
            <div className="table-empty dim">No work is currently open.</div>
          )}
        </div>
      </section>
    </div>
  );
}
