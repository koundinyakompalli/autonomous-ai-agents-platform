import type { OneShotAgentAnalyticsEntry } from "./types.js";
import { STAGE_LABELS } from "./pipelineStyles.js";
import { formatDurationMs, formatTokens } from "./formatters.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import { dataRevealStyle, glassPlaceStyle } from "./motion.js";

type Health = "ok" | "warn" | "bad";

function healthTone(failureRate: number): Health {
  if (failureRate > 0.15) return "bad";
  if (failureRate > 0.05) return "warn";
  return "ok";
}

function healthLabel(failureRate: number): string {
  if (failureRate > 0.15) return "degraded";
  if (failureRate > 0.05) return "nominal";
  return "healthy";
}

export function AgentsView({
  analytics,
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  analytics: ReadonlyArray<OneShotAgentAnalyticsEntry>;
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  return (
    <div className="view">
      <PageHeader
        title="Agents"
        metrics={[
          { label: "agents", value: analytics.length },
          { label: "window", value: "24h" },
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

      <div className="agents-grid">
        {analytics.map((card, idx) => {
          const maxRecentLatency = Math.max(
            1,
            ...card.recentSamples.map((entry) => entry.durationMs),
          );
          const tone = healthTone(card.failRate);
          const label = healthLabel(card.failRate);
          const isRunning = card.recentSamples.some(
            (entry) => entry.tone === "running",
          );
          const isDegraded = tone !== "ok";
          return (
            <article
              key={card.stage}
              className={[
                "agent-deep-card",
                "glass-place-block",
                isRunning ? "is-running" : "",
                isDegraded ? "is-degraded" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={glassPlaceStyle(idx * 45)}
            >
              <div className="agent-deep-head">
                <div className="agent-deep-idx mono">
                  agent.{String(idx + 1).padStart(2, "0")}
                </div>
                <h3 className="agent-deep-name">{STAGE_LABELS[card.stage]}</h3>
                <div className={`agent-deep-health-pill ${tone}`}>{label}</div>
              </div>

              <div className="agent-deep-stats">
                <div className="agent-deep-stat">
                  <div className="stat-label">runs</div>
                  <div className="agent-deep-stat-value">{card.runs}</div>
                </div>
                <div className="agent-deep-stat">
                  <div className="stat-label">avg latency</div>
                  <div className="agent-deep-stat-value">
                    {formatDurationMs(card.avgLatencyMs)}
                  </div>
                </div>
                <div className="agent-deep-stat">
                  <div className="stat-label">fail rate</div>
                  <div
                    className={`agent-deep-stat-value${card.failRate > 0.1 ? " bad" : ""}`}
                  >
                    {(card.failRate * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="agent-deep-stat">
                  <div className="stat-label">avg tokens</div>
                  <div className="agent-deep-stat-value">
                    {formatTokens(card.avgTokens)}
                  </div>
                </div>
              </div>

              <div className="agent-deep-label">
                Latency distribution (last 10)
              </div>
              <div className="agent-deep-spark">
                {card.recentSamples.length === 0 ? (
                  <span className="dim mono">No activity</span>
                ) : (
                  card.recentSamples.map((entry, sampleIdx) => (
                    <div
                      key={entry.dashboardId}
                      className="spark-bar-wrap"
                      title={formatDurationMs(entry.durationMs)}
                    >
                      <div
                        className={`spark-bar spark-${entry.tone} data-rise`}
                        style={dataRevealStyle({
                          heightPct:
                            (entry.durationMs / maxRecentLatency) * 100,
                          delayMs: idx * 45 + sampleIdx * 24,
                        })}
                      />
                    </div>
                  ))
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
