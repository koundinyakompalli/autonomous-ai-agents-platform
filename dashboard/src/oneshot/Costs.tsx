import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { AnalyticsRangeControl } from "./AnalyticsRangeControl.js";
import {
  ChevronDown,
  FileText,
  Receipt,
  ICON_SIZE,
  ICON_STROKE,
} from "./icons.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import { STAGE_LABELS } from "./pipelineStyles.js";
import {
  TICKET_TYPE_OPTIONS,
  ticketTypeLabel,
  type TicketTypeFilter,
} from "./ticketTypes.js";
import type {
  OneShotAnalyticsRange,
  OneShotCostsAnalytics,
  OneShotDashboardRow,
  OneShotModelCost,
  OneShotTopCostRun,
} from "./types.js";
import {
  formatCostSource,
  formatModelName,
  formatTokens,
  formatUsd,
} from "./formatters.js";
import { dataRevealStyle, glassPlaceStyle } from "./motion.js";

function DeltaPill({ pct }: { pct: number | null }) {
  if (pct === null) {
    return null;
  }
  const tone = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const sign = pct > 0 ? "+" : "";
  return (
    <span className={`ledger-delta ${tone} mono`}>
      {sign}
      {pct.toFixed(1)}%
    </span>
  );
}

function finiteNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Deterministic plan-contract guardrail rows are $0.00 "actual" cost rows
 * that must not surface as LLM spend in the By-model ladder. This is a
 * frontend mirror of oneshotCosting.ts's isDeterministicGuardrailRow; kept
 * in identical wording since Costs.tsx cannot import server code in the
 * production browser bundle. Exported (not just used internally) so
 * Costs.test.tsx can assert behavioral parity against the backend
 * predicate and catch future drift between the two copies.
 */
export function isDeterministicGuardrailRow(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  const normalizedProvider = provider?.trim().toLowerCase() ?? null;
  const normalizedModel = model?.trim().toLowerCase() ?? null;
  return (
    normalizedModel === "plan-contract-v1" ||
    normalizedProvider === "deterministic_guardrail"
  );
}

function canonicalizeModelCost(entry: OneShotModelCost):
  | (OneShotModelCost & {
      key: string;
    })
  | null {
  const model = entry.model.trim();
  const normalizedModel = model.toLowerCase();
  const provider = entry.provider?.trim().toLowerCase() ?? null;
  const tokens = finiteNumber(entry.tokens);
  const usd = finiteNumber(entry.usd);
  const share = finiteNumber(entry.share);
  const pricing = entry.pricing ?? null;
  const rawModelIds =
    entry.rawModelIds && entry.rawModelIds.length > 0
      ? entry.rawModelIds
      : model && normalizedModel !== "unknown"
        ? [model]
        : [];

  if (provider === "config" && normalizedModel === "disabled") return null;
  if (provider === "soft_gate" && normalizedModel === "advisory") return null;
  // Deterministic plan-contract guardrail rows are not LLM spend.
  if (isDeterministicGuardrailRow(provider, normalizedModel)) return null;
  if (
    (normalizedModel === "unknown" || normalizedModel === "") &&
    tokens <= 0 &&
    usd <= 0
  ) {
    return null;
  }

  const claudeMatch = normalizedModel.match(
    /claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?/,
  );
  if (claudeMatch) {
    const minor =
      claudeMatch[3] && claudeMatch[3].length <= 2 ? `-${claudeMatch[3]}` : "";
    const canonicalModel = `claude-${claudeMatch[1]}-${claudeMatch[2]}${minor}`;
    return {
      ...entry,
      key: `anthropic:${canonicalModel}`,
      model: canonicalModel,
      provider: "anthropic",
      rawModelIds,
      pricing,
      tokens,
      usd,
      share,
    };
  }

  const gptMatch = normalizedModel.match(
    /(?:^|[/.-])gpt[-.]?(\d+(?:[.-]\d+)?)/,
  );
  if (gptMatch) {
    const canonicalModel = `gpt-${gptMatch[1].replace("-", ".")}`;
    return {
      ...entry,
      key: `openai:${canonicalModel}`,
      model: canonicalModel,
      provider: "openai",
      rawModelIds,
      pricing,
      tokens,
      usd,
      share,
    };
  }

  return {
    ...entry,
    key: "unattributed:llm",
    model: "Unattributed LLM",
    provider: null,
    rawModelIds,
    pricing,
    tokens,
    usd,
    share,
  };
}

function buildVisibleModelRows(
  rows: ReadonlyArray<OneShotModelCost>,
  totalUsd: number,
): OneShotModelCost[] {
  const byKey = new Map<
    string,
    OneShotModelCost & { key: string; rawModelIds: string[]; share: number }
  >();

  for (const row of rows) {
    const canonical = canonicalizeModelCost(row);
    if (!canonical) continue;
    const existing = byKey.get(canonical.key);
    if (existing) {
      existing.tokens += canonical.tokens;
      existing.usd += canonical.usd;
      existing.rawModelIds = Array.from(
        new Set([...existing.rawModelIds, ...(canonical.rawModelIds ?? [])]),
      ).sort();
      existing.pricing = existing.pricing ?? canonical.pricing ?? null;
    } else {
      byKey.set(canonical.key, {
        ...canonical,
        rawModelIds: [...(canonical.rawModelIds ?? [])].sort(),
      });
    }
  }

  return Array.from(byKey.values())
    .map(({ key: _key, ...row }) => ({
      ...row,
      share: totalUsd === 0 ? 0 : row.usd / totalUsd,
    }))
    .sort((a, b) => b.usd - a.usd);
}

function LadderMetric({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      className="ladder-metric mono"
      title={title}
      aria-label={`${value} ${label}`}
    >
      <span className="ladder-metric-value">{value}</span>
    </div>
  );
}

function LadderColumnHead() {
  return (
    <div className="ladder-column-head mono" aria-hidden="true">
      <span className="ladder-column-spacer" />
      <span className="ladder-column-spacer" />
      <span>Tokens</span>
      <span>Cost</span>
    </div>
  );
}

function formatUsdPerMillion(value: number): string {
  return `${formatUsd(value)}/M`;
}

function ModelPriceStrip({
  pricing,
}: {
  pricing: OneShotModelCost["pricing"];
}) {
  if (!pricing) {
    return (
      <div className="model-price-strip unavailable mono">
        pricing unavailable
      </div>
    );
  }

  const items = [
    ["Input", pricing.inputUsdPerMillion],
    ["Output", pricing.outputUsdPerMillion],
    ["Blended", pricing.blendedUsdPerMillion],
  ] as const;

  return (
    <div
      className="model-price-strip mono"
      title={`Pricing source: ${pricing.sourceModel}`}
      aria-label={`Pricing source ${pricing.sourceModel}`}
    >
      {items.map(([label, value]) => (
        <span key={label} className="model-price-pill">
          <span className="model-price-label">{label}</span>
          <span className="model-price-value">
            {formatUsdPerMillion(value)}
          </span>
        </span>
      ))}
    </div>
  );
}

function CostLadderRow({
  label,
  title,
  tokens,
  usd,
  widthPct,
  delayMs,
  heavy,
  extra,
}: {
  label: ReactNode;
  title?: string;
  tokens: number | null;
  usd: number | null;
  widthPct: number;
  delayMs: number;
  heavy: boolean;
  extra?: ReactNode;
}) {
  const tokenValue = tokens === null ? "—" : formatTokens(tokens);
  const costValue = usd === null ? "—" : formatUsd(usd);
  return (
    <>
      <div className={`ladder-row${heavy ? " heavy" : ""}`}>
        <div className="ladder-label" title={title}>
          {label}
        </div>
        <div className="ladder-track" role="presentation">
          <div
            className="ladder-fill data-fill"
            style={dataRevealStyle({
              widthPct: Math.max(widthPct, 0),
              delayMs,
            })}
          />
        </div>
        <LadderMetric
          label="tokens"
          value={tokenValue}
          title={tokens === null ? undefined : `${tokenValue} tokens`}
        />
        <LadderMetric
          label="cost"
          value={costValue}
          title={usd === null ? undefined : costValue}
        />
      </div>
      {extra && <div className="ladder-row-extra">{extra}</div>}
    </>
  );
}

function buildCostReportHref(
  format: "csv" | "html",
  range: OneShotAnalyticsRange,
  ticketType: TicketTypeFilter,
): string {
  const params = new URLSearchParams({ range, ticketType });
  return `/api/oneshot/reports/costs.${format}?${params.toString()}`;
}

/**
 * Costs tab — *Ledger*.
 *
 * Fraunces-serif hero number + ± trend, per-stage ladder, per-model
 * ladder, top-5 most expensive runs. Stages without captured metrics render
 * as "—" instead of reporting a synthetic zero.
 */
export function Costs({
  analytics,
  rows,
  range,
  onRangeChange,
  onOpenDetail,
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  analytics: OneShotCostsAnalytics;
  rows: ReadonlyArray<OneShotDashboardRow>;
  range: OneShotAnalyticsRange;
  onRangeChange: (next: OneShotAnalyticsRange) => void;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  const [reportTicketType, setReportTicketType] =
    useState<TicketTypeFilter>("all");
  const tokensInMillions = useMemo(
    () => (analytics.totalTokens / 1_000_000).toFixed(2),
    [analytics.totalTokens],
  );

  const maxStageUsd = useMemo(() => {
    return Math.max(0.01, ...analytics.byStage.map((entry) => entry.usd ?? 0));
  }, [analytics.byStage]);

  const visibleModelRows = useMemo(
    () => buildVisibleModelRows(analytics.byModel, analytics.totalUsd),
    [analytics.byModel, analytics.totalUsd],
  );

  const maxModelUsd = useMemo(() => {
    return Math.max(0.01, ...visibleModelRows.map((entry) => entry.usd));
  }, [visibleModelRows]);

  const rowsById = useMemo(() => {
    const map = new Map<string, OneShotDashboardRow>();
    for (const row of rows) map.set(row.dashboardId, row);
    return map;
  }, [rows]);

  const openTopRun = (top: OneShotTopCostRun) => {
    const fresh = rowsById.get(top.dashboardId);
    if (fresh) onOpenDetail(fresh);
  };

  const csvReportHref = buildCostReportHref("csv", range, reportTicketType);
  const htmlReportHref = buildCostReportHref("html", range, reportTicketType);

  return (
    <div className="view costs-view">
      <PageHeader
        title="Costs"
        metrics={[
          { label: "source", value: formatCostSource(analytics.costSource) },
          { label: "tokens", value: formatTokens(analytics.totalTokens) },
          { label: "window", value: analytics.window.shortLabel },
        ]}
        actions={
          <div className="analytics-header-actions">
            <AnalyticsRangeControl value={range} onChange={onRangeChange} />
            <div
              className="cost-report-actions"
              aria-label="Cost report exports"
            >
              <div className="cost-report-select-shell">
                <select
                  className="select-field mono cost-report-select"
                  aria-label="Report ticket type"
                  value={reportTicketType}
                  onChange={(event) =>
                    setReportTicketType(event.target.value as TicketTypeFilter)
                  }
                >
                  {TICKET_TYPE_OPTIONS.map((type) => (
                    <option key={type} value={type}>
                      {type === "all" ? "All types" : ticketTypeLabel(type)}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="cost-report-select-icon"
                  size={ICON_SIZE.xs}
                  strokeWidth={ICON_STROKE}
                />
              </div>
              <a
                className="cost-report-link mono"
                href={csvReportHref}
                download
                aria-label="Download cost report CSV"
                title="Download cost report CSV"
              >
                <Receipt size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
                <span>CSV</span>
              </a>
              <a
                className="cost-report-link mono"
                href={htmlReportHref}
                download
                aria-label="Download cost report HTML"
                title="Download cost report HTML"
              >
                <FileText size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
                <span>HTML</span>
              </a>
            </div>
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
        className="ledger-hero glass-place-block"
        aria-labelledby="ledger-hero-title"
        style={glassPlaceStyle(0)}
      >
        <div id="ledger-hero-title" className="ledger-hero-label mono">
          spend · {analytics.window.label.toLowerCase()}
        </div>
        <div className="ledger-hero-number-row">
          <span className="ledger-hero-number">
            {formatUsd(analytics.totalUsd)}
          </span>
          {analytics.trend && <DeltaPill pct={analytics.trend.pctChange} />}
        </div>
        <div
          className="ledger-hero-rule data-line-draw"
          aria-hidden="true"
          style={dataRevealStyle({ delayMs: 120 })}
        />
        <div className="ledger-hero-decomp mono dim">
          {tokensInMillions}M tok · {formatCostSource(analytics.costSource)}
          {analytics.trend
            ? ` · prior ${formatUsd(analytics.trend.priorValue)}`
            : ""}
        </div>
      </section>

      <div className="ledger-two-col">
        <section
          className="ledger-ladder glass-place-block"
          aria-labelledby="ledger-stage-title"
          style={glassPlaceStyle(90)}
        >
          <div className="section-head">
            <span id="ledger-stage-title">By stage</span>
          </div>
          <div className="ladder-rows">
            <LadderColumnHead />
            {analytics.byStage.map((entry, idx) => {
              const label = STAGE_LABELS[entry.stage];
              const usd = entry.usd;
              const width =
                usd === null || maxStageUsd === 0
                  ? 0
                  : (usd / maxStageUsd) * 100;
              const heavy = (entry.share ?? 0) > 0.25;
              return (
                <CostLadderRow
                  key={entry.stage}
                  label={label}
                  title={
                    entry.tokens === null && usd === null
                      ? "Per-stage token cost is not tracked for this row yet."
                      : undefined
                  }
                  tokens={entry.tokens}
                  usd={usd}
                  widthPct={width}
                  delayMs={idx * 55}
                  heavy={heavy}
                />
              );
            })}
          </div>
        </section>

        <section
          className="ledger-ladder glass-place-block"
          aria-labelledby="ledger-model-title"
          style={glassPlaceStyle(135)}
        >
          <div className="section-head">
            <span id="ledger-model-title">By model</span>
          </div>
          <div className="ladder-rows">
            {visibleModelRows.length === 0 ? (
              <div className="ladder-empty dim mono">
                No per-model data in this window.
              </div>
            ) : (
              <>
                <LadderColumnHead />
                {visibleModelRows.map((entry, idx) => {
                  const width =
                    maxModelUsd === 0 ? 0 : (entry.usd / maxModelUsd) * 100;
                  const heavy = entry.share > 0.25;
                  const title =
                    entry.rawModelIds && entry.rawModelIds.length > 0
                      ? entry.rawModelIds.join("\n")
                      : entry.model;
                  return (
                    <CostLadderRow
                      key={`${entry.provider ?? "unknown"}:${entry.model}`}
                      title={title}
                      label={
                        <>
                          <span className="mono">
                            {formatModelName(entry.model)}
                          </span>
                          {entry.provider && (
                            <span className="ladder-provider dim">
                              {" · "}
                              {entry.provider}
                            </span>
                          )}
                        </>
                      }
                      tokens={entry.tokens}
                      usd={entry.usd}
                      widthPct={width}
                      delayMs={idx * 55}
                      heavy={heavy}
                      extra={<ModelPriceStrip pricing={entry.pricing} />}
                    />
                  );
                })}
              </>
            )}
          </div>
        </section>
      </div>

      <section
        className="ledger-leaderboard glass-place-block"
        aria-labelledby="ledger-top-title"
        style={glassPlaceStyle(210)}
      >
        <div className="section-head">
          <span id="ledger-top-title">Most expensive runs</span>
          <span className="dim mono">
            top 5 · {analytics.window.label.toLowerCase()}
          </span>
        </div>
        {analytics.topRuns.length === 0 ? (
          <div className="ladder-empty dim mono">
            No runs recorded in this window.
          </div>
        ) : (
          <div className="top-runs">
            {analytics.topRuns.map((row, idx) => (
              <button
                key={row.dashboardId}
                type="button"
                className="top-run-row data-row-in"
                style={dataRevealStyle({ delayMs: 260 + idx * 45 })}
                onClick={() => openTopRun(row)}
                aria-label={`Open ${row.jiraKey} — ${formatUsd(row.estimatedCostUsd)} (${formatCostSource(row.costSource)})`}
              >
                <span className="top-run-rank mono">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span className="top-run-jira mono">{row.jiraKey}</span>
                <span className="top-run-title">{row.title}</span>
                <span className="top-run-tok mono dim">
                  {formatTokens(row.totalTokensUsed)}
                </span>
                <span className="top-run-cost mono">
                  {formatUsd(row.estimatedCostUsd)}
                </span>
                <span className="top-run-tok mono dim">
                  {formatCostSource(row.costSource)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
