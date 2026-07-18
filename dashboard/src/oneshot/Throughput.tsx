import { useMemo } from "react";
import { AnalyticsRangeControl } from "./AnalyticsRangeControl.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import { STAGE_LABELS } from "./pipelineStyles.js";
import type {
  OneShotAnalyticsRange,
  OneShotThroughputAnalytics,
} from "./types.js";
import { formatDurationMs } from "./formatters.js";
import { dataRevealStyle, glassPlaceStyle } from "./motion.js";

function DeltaPill({ pct }: { pct: number | null }) {
  if (pct === null) {
    return null;
  }
  const tone = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const sign = pct > 0 ? "+" : "";
  return (
    <span className={`tempo-delta ${tone} mono`}>
      {sign}
      {pct.toFixed(1)}%
    </span>
  );
}

function axisLabels(
  range: OneShotAnalyticsRange,
): [string, string, string, string, string] {
  switch (range) {
    case "7d":
      return ["-7d", "-5d", "-3d", "-1d", "now"];
    case "30d":
      return ["-30d", "-21d", "-14d", "-7d", "now"];
    case "all":
      return ["start", "", "mid", "", "now"];
    case "24h":
      return ["-24h", "-18h", "-12h", "-6h", "now"];
  }
}

/**
 * Throughput tab — *Tempo & Bottleneck*.
 *
 * Hero ± trend, adaptive horizon strip, stage-waterfall completion ratios,
 * p50/p90 rail.
 */
export function Throughput({
  analytics,
  range,
  onRangeChange,
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  analytics: OneShotThroughputAnalytics;
  range: OneShotAnalyticsRange;
  onRangeChange: (next: OneShotAnalyticsRange) => void;
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  const bucketMax = useMemo(
    () => Math.max(1, ...analytics.buckets),
    [analytics.buckets],
  );
  const horizonAxis = axisLabels(analytics.window.range);

  const bottleneck = useMemo(() => {
    let worst = { stage: "" as string, ratio: 1 };
    for (const entry of analytics.stageCompletion) {
      if (entry.attempts === 0) continue;
      const ratio = entry.completions / entry.attempts;
      if (ratio < worst.ratio) {
        worst = { stage: entry.stage, ratio };
      }
    }
    return worst.stage ? worst : null;
  }, [analytics.stageCompletion]);

  return (
    <div className="view throughput-view">
      <PageHeader
        title="Throughput"
        metrics={[
          { label: "runs", value: analytics.totalRuns },
          { label: "buckets", value: analytics.buckets.length },
          { label: "window", value: analytics.window.shortLabel },
        ]}
        actions={
          <div className="analytics-header-actions">
            <AnalyticsRangeControl value={range} onChange={onRangeChange} />
            <PageHeaderActions
              onSearch={onSearch}
              onNewRun={onNewRun}
              theme={theme}
              onThemeChange={onThemeChange}
            />
          </div>
        }
      />

      <section
        className="tempo-hero glass-place-block"
        aria-labelledby="tempo-hero-title"
        style={glassPlaceStyle(0)}
      >
        <div className="tempo-hero-left">
          <div id="tempo-hero-title" className="tempo-hero-label mono">
            runs · {analytics.window.label.toLowerCase()}
          </div>
          <div className="tempo-hero-value">
            <span className="tempo-hero-number">{analytics.totalRuns}</span>
            {analytics.trend && <DeltaPill pct={analytics.trend.pctChange} />}
          </div>
          {analytics.trend && (
            <div className="tempo-hero-sub dim mono">
              prior window: {analytics.trend.priorValue} runs
            </div>
          )}
        </div>

        <div className="tempo-rail" aria-label="Time to PR">
          <div className="tempo-rail-head mono dim">time to PR</div>
          <div className="tempo-rail-body">
            <div className="tempo-tick">
              <div className="tempo-tick-label mono">p50</div>
              <div className="tempo-tick-value">
                {formatDurationMs(analytics.p50TimeToPrMs)}
              </div>
            </div>
            <div className="tempo-tick">
              <div className="tempo-tick-label mono">p90</div>
              <div className="tempo-tick-value">
                {formatDurationMs(analytics.p90TimeToPrMs)}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="tempo-horizon glass-place-block"
        aria-labelledby="horizon-title"
        style={glassPlaceStyle(90)}
      >
        <div className="section-head">
          <span id="horizon-title">Horizon</span>
          <span className="dim mono">
            {analytics.window.bucketLabel} · oldest → now
          </span>
        </div>
        <div className="tempo-horizon-strip">
          {analytics.buckets.map((count, idx) => {
            const heightPct = (count / bucketMax) * 100;
            const intensity = count / bucketMax;
            return (
              <div
                key={idx}
                className="tempo-horizon-col"
                title={`${count} runs`}
                aria-label={`${count} runs at bucket ${idx + 1} of ${analytics.buckets.length}`}
              >
                <div
                  className="tempo-horizon-bar data-rise"
                  style={{
                    ...dataRevealStyle({
                      heightPct: Math.max(2, heightPct),
                      delayMs: idx * 10,
                    }),
                    opacity: 0.35 + intensity * 0.65,
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="tempo-horizon-axis mono dim">
          {horizonAxis.map((label, idx) => (
            <span key={`${label}-${idx}`}>{label}</span>
          ))}
        </div>
      </section>

      <section
        className="tempo-waterfall glass-place-block"
        aria-labelledby="waterfall-title"
        style={glassPlaceStyle(160)}
      >
        <div className="section-head">
          <span id="waterfall-title">Stage waterfall</span>
          <span className="dim mono">
            completion rate · attempts → next stage
          </span>
        </div>

        <div className="waterfall-rows">
          {analytics.stageCompletion.map((entry, idx) => {
            const ratio =
              entry.attempts === 0 ? 0 : entry.completions / entry.attempts;
            const isBottleneck = bottleneck?.stage === entry.stage;
            const label = STAGE_LABELS[entry.stage];
            return (
              <div
                key={entry.stage}
                className={`waterfall-row${isBottleneck ? " bottleneck" : ""}`}
              >
                <div className="waterfall-label">{label}</div>
                <div className="waterfall-track" role="presentation">
                  <div
                    className="waterfall-fill data-fill"
                    style={dataRevealStyle({
                      widthPct: Math.max(2, ratio * 100),
                      delayMs: idx * 55,
                    })}
                  />
                  {isBottleneck && (
                    <span className="waterfall-dot" aria-hidden="true" />
                  )}
                </div>
                <div className="waterfall-ratio mono">
                  {entry.attempts === 0 ? "—" : `${Math.round(ratio * 100)}%`}
                </div>
                <div className="waterfall-counts mono dim">
                  {entry.completions}/{entry.attempts}
                  {entry.failures > 0 ? ` · ${entry.failures} failed` : ""}
                </div>
              </div>
            );
          })}
        </div>

        {bottleneck && (
          <div className="waterfall-callout">
            <span className="waterfall-callout-label mono">bottleneck</span>
            <span className="waterfall-callout-text">
              {STAGE_LABELS[bottleneck.stage as keyof typeof STAGE_LABELS]} —{" "}
              {Math.round(bottleneck.ratio * 100)}% completion
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
