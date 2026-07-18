import { useState } from "react";
import { AnalyticsRangeControl } from "./AnalyticsRangeControl.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import type {
  OneShotAnalyticsRange,
  OneShotDashboardRow,
  OneShotFailureAttributionByCategory,
  OneShotFailureAttributionSummary,
  OneShotMissingSignalImpact,
  OneShotOperationalBottleneckRow,
  OneShotRepoStatusRow,
  OneShotStatisticsAction,
  OneShotStatisticsBusinessMetric,
  OneShotStatisticsInsight,
  OneShotStatisticsJiraExample,
  OneShotStatisticsResponse,
  OneShotTicketQualityDistributionBucket,
} from "./types.js";
import {
  formatDurationMs,
  formatRelTime,
  formatTokens,
  formatUsd,
} from "./formatters.js";
import { glassPlaceStyle } from "./motion.js";

const AI_REFRESH_FAILURE_MESSAGE =
  "AI summary refresh failed; showing deterministic statistics. Retrying automatically.";

type SelfFixCandidate = OneShotStatisticsResponse["selfFixCandidates"][number];
type SelfFixTicketResult = {
  candidateId: string;
  ticketKey: string;
  jiraUrl: string | null;
  runRequestId?: number;
  status: SelfFixCandidate["status"];
};

function friendlyStatisticsLastError(error: string | null | undefined) {
  if (!error) return null;
  if (
    /LLM statistics JSON (?:could not be parsed|failed schema validation)/i.test(
      error,
    ) ||
    /LLM statistics response was truncated/i.test(error)
  ) {
    return AI_REFRESH_FAILURE_MESSAGE;
  }
  return error;
}

async function readSelfFixTicketError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string"
    ? payload.error
    : `Self-fix ticket request failed with status ${response.status}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function DeltaText({
  delta,
  formatValue,
  positiveIsGood = true,
  suffix = "",
}: {
  delta: OneShotStatisticsBusinessMetric["delta"];
  formatValue?: (value: number) => string;
  positiveIsGood?: boolean;
  suffix?: string;
}) {
  if (!delta) return <span className="dim">no baseline</span>;
  if (delta.priorValue === 0 && delta.currentValue === 0) {
    return (
      <span className="dim" title="no prior baseline">
        —
      </span>
    );
  }
  const positive = delta.delta > 0;
  const flat = delta.delta === 0;
  const favorable = flat || positive === positiveIsGood;
  const sign = positive ? "+" : "";
  const value = formatValue
    ? `${positive ? "+" : flat ? "" : "-"}${formatValue(Math.abs(delta.delta))}`
    : `${sign}${delta.delta.toFixed(Math.abs(delta.delta) < 1 ? 1 : 0)}${suffix}`;
  const isFirstObservation = delta.priorValue === 0 && delta.currentValue > 0;
  if (isFirstObservation) {
    return (
      <span
        className="stats-delta flat"
        title="no prior window data — first observation"
      >
        {value} · first
      </span>
    );
  }
  const pct =
    delta.pctChange === null ? "" : ` · ${sign}${delta.pctChange.toFixed(1)}%`;
  return (
    <span
      className={`stats-delta ${flat ? "flat" : favorable ? "up" : "down"}`}
    >
      {value}
      {pct}
    </span>
  );
}

function deltaValueFormatter(
  metricId: string,
): ((value: number) => string) | undefined {
  if (metricId === "cost") return formatUsd;
  if (metricId === "tokens") return formatTokens;
  if (metricId === "time-to-pr") return formatDurationMs;
  return undefined;
}

function metricPositiveIsGood(metricId: string): boolean {
  return (
    metricId === "pass-rate" ||
    metricId === "completed" ||
    metricId === "intake" ||
    metricId === "ticket-readiness"
  );
}

function JiraExamples({
  examples,
  rowsByDashboardId,
  onOpenDetail,
}: {
  examples: ReadonlyArray<OneShotStatisticsJiraExample>;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  if (examples.length === 0) return null;
  return (
    <div className="stats-examples">
      {examples.map((example) => {
        const row = rowsByDashboardId.get(example.dashboardId);
        return example.jiraUrl ? (
          <a
            key={`${example.dashboardId}:${example.jiraKey}`}
            className="triage-key-chip mono"
            href={example.jiraUrl}
            target="_blank"
            rel="noreferrer"
            title={example.title}
          >
            {example.jiraKey}
          </a>
        ) : (
          <a
            key={`${example.dashboardId}:${example.jiraKey}`}
            className="triage-key-chip mono stats-example-button"
            href={`?view=runs&run=${encodeURIComponent(example.dashboardId)}`}
            title={example.title}
            onClick={(event) => {
              if (!row) return;
              event.preventDefault();
              onOpenDetail(row);
            }}
          >
            {example.jiraKey}
          </a>
        );
      })}
    </div>
  );
}

function formatInsightReason(reason: string): string {
  if (/Wilson 95% lower bound/i.test(reason)) {
    return "Pass-rate gap remains above the selected-window baseline after sample-size and repo/stage checks.";
  }
  if (/Wilson 95% upper bound/i.test(reason)) {
    return "Pass-rate gap remains below the selected-window baseline after sample-size and repo/stage checks.";
  }
  return reason;
}

function InsightCard({
  insight,
  rowsByDashboardId,
  onOpenDetail,
  tone,
  delayMs,
}: {
  insight: OneShotStatisticsInsight;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  tone: "good" | "bad";
  delayMs: number;
}) {
  return (
    <article
      className={`stats-insight-card ${tone} glass-place-block`}
      style={glassPlaceStyle(delayMs)}
    >
      <div className="stats-insight-meta mono">
        <span>{insight.sampleSize} samples</span>
        <span>{formatPercent(insight.passRate)} pass</span>
      </div>
      <h3>{insight.title}</h3>
      <p>{insight.summary}</p>
      <p className="dim">{formatInsightReason(insight.reason)}</p>
      <JiraExamples
        examples={insight.examples}
        rowsByDashboardId={rowsByDashboardId}
        onOpenDetail={onOpenDetail}
      />
    </article>
  );
}

function ActionRow({
  action,
  rowsByDashboardId,
  onOpenDetail,
}: {
  action: OneShotStatisticsAction;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  return (
    <div className={`stats-action-row ${action.priority}`}>
      <span className="stats-action-priority mono">{action.priority}</span>
      <div>
        <div className="stats-action-title">{action.title}</div>
        <div className="stats-action-summary dim">{action.summary}</div>
        <JiraExamples
          examples={action.examples}
          rowsByDashboardId={rowsByDashboardId}
          onOpenDetail={onOpenDetail}
        />
      </div>
    </div>
  );
}

const BOTTLENECK_SEVERITY_COPY: Record<
  OneShotOperationalBottleneckRow["severity"],
  { label: string; tone: "bad" | "warn" | "dim" }
> = {
  high: { label: "high", tone: "bad" },
  medium: { label: "medium", tone: "warn" },
  low: { label: "low", tone: "dim" },
};

function bottleneckPassRateLabel(row: OneShotOperationalBottleneckRow): string {
  return row.failed === 0 && row.passRate === 0
    ? "no terminal sample"
    : formatPercent(row.passRate);
}

function OperationalBottlenecksSection({
  statistics,
  rowsByDashboardId,
  onOpenDetail,
}: {
  statistics: OneShotStatisticsResponse;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  const bottlenecks = statistics.operationalBottlenecks;
  if (!bottlenecks || bottlenecks.rows.length === 0) return null;
  return (
    <section
      className="stats-bottlenecks glass-place-block"
      style={glassPlaceStyle(78)}
    >
      <div className="stats-section-label mono dim">
        operational bottlenecks
      </div>
      <div className="stats-bottlenecks-head">
        <div>
          <h3>What to look at first</h3>
          <p className="dim">
            Ranked from stored OneShot intake in the selected{" "}
            {statistics.window.shortLabel} range. These are operational
            observations, not causal claims.
          </p>
        </div>
      </div>
      <div className="stats-bottleneck-list">
        {bottlenecks.rows.map((row) => {
          const severity = BOTTLENECK_SEVERITY_COPY[row.severity];
          return (
            <article
              key={row.id}
              className={`stats-bottleneck-row ${row.kind} ${row.severity}`}
            >
              <div className="stats-bottleneck-main">
                <div className="stats-bottleneck-title-line">
                  <span className={`stats-bottleneck-chip ${severity.tone}`}>
                    {severity.label}
                  </span>
                  <strong>{row.title}</strong>
                </div>
                <p>{row.summary}</p>
                <p className="dim">{row.nextStep}</p>
                <div className="stats-bottleneck-tags mono">
                  {row.repoLabel && <span>{row.repoLabel}</span>}
                  {row.stageLabel && <span>{row.stageLabel}</span>}
                  {row.failureAttribution && (
                    <span>{row.failureAttribution.label}</span>
                  )}
                  <span>{row.kind.replace(/_/g, " ")}</span>
                </div>
              </div>
              <div className="stats-bottleneck-metrics mono">
                <span>{row.affected} affected</span>
                <span>{row.failed} failed</span>
                <span>{row.noAction} no action</span>
                {row.costUsd > 0 && <span>{formatUsd(row.costUsd)}</span>}
                {row.tokens > 0 && <span>{formatTokens(row.tokens)}</span>}
              </div>
              <div className="stats-bottleneck-pass">
                <span className="stats-inline-bar">
                  <i style={{ width: `${row.passRate * 100}%` }} />
                </span>
                <span className="mono">{bottleneckPassRateLabel(row)}</span>
              </div>
              <JiraExamples
                examples={row.examples}
                rowsByDashboardId={rowsByDashboardId}
                onOpenDetail={onOpenDetail}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function passRateLabel(bucket: OneShotTicketQualityDistributionBucket): string {
  return bucket.cohort.terminalCount === 0
    ? "no terminal sample"
    : formatPercent(bucket.cohort.passRate);
}

const REPO_STATUS_COPY: Record<
  OneShotRepoStatusRow["status"],
  { label: string; tone: "ok" | "warn" | "bad" | "dim" }
> = {
  healthy: { label: "healthy", tone: "ok" },
  watch: { label: "watch", tone: "warn" },
  blocked: { label: "blocked", tone: "bad" },
  insufficient_data: { label: "low sample", tone: "dim" },
};

function repoPassRateLabel(row: OneShotRepoStatusRow): string {
  return row.terminalCount === 0
    ? "no terminal sample"
    : formatPercent(row.passRate);
}

function RepoStatusSection({
  statistics,
  rowsByDashboardId,
  onOpenDetail,
}: {
  statistics: OneShotStatisticsResponse;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  const repoStatus = statistics.repoStatus;
  if (!repoStatus || repoStatus.rows.length === 0) return null;
  return (
    <section
      className="stats-repo-status glass-place-block"
      style={glassPlaceStyle(85)}
    >
      <div className="stats-section-label mono dim">repo status</div>
      <div className="stats-repo-status-head">
        <div>
          <h3>{repoStatus.rows.length} repo groups observed</h3>
          <p className="dim">
            Based on previous OneShot intake in the selected{" "}
            {statistics.window.shortLabel} range. Unresolved repositories are
            grouped without guessing a target repo.
          </p>
        </div>
      </div>
      <div className="stats-repo-table">
        {repoStatus.rows.map((row) => {
          const copy = REPO_STATUS_COPY[row.status];
          return (
            <article
              key={row.repoKey}
              className={`stats-repo-row ${row.status} ${row.isUnresolved ? "unresolved" : ""}`}
            >
              <div className="stats-repo-main">
                <div className="stats-repo-title-line">
                  <strong>{row.repoLabel}</strong>
                  <span className={`stats-repo-status-chip ${copy.tone}`}>
                    {copy.label}
                  </span>
                </div>
                <p className="dim">{row.statusReason}</p>
                {row.topFailureAttribution && !row.isUnresolved && (
                  <span className="stats-repo-attribution dim">
                    top issue: {row.topFailureAttribution.label} ·{" "}
                    {row.topFailureAttribution.sampleSize}
                  </span>
                )}
              </div>
              <div className="stats-repo-counts mono">
                <span>{row.sampleSize} intake</span>
                <span>{row.completed} done</span>
                <span>{row.failed} failed</span>
                <span>{row.noAction} no action</span>
              </div>
              <div className="stats-repo-pass">
                <span className="stats-inline-bar">
                  <i style={{ width: `${row.passRate * 100}%` }} />
                </span>
                <span className="mono">{repoPassRateLabel(row)}</span>
                {row.topStageIssue && (
                  <span className="dim">
                    {row.topStageIssue.label} · {row.topStageIssue.affected}
                  </span>
                )}
              </div>
              <JiraExamples
                examples={row.examples}
                rowsByDashboardId={rowsByDashboardId}
                onOpenDetail={onOpenDetail}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}

function TicketReadinessSection({
  statistics,
  rowsByDashboardId,
  onOpenDetail,
}: {
  statistics: OneShotStatisticsResponse;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  const ticketQuality = statistics.ticketQuality;
  const nonEmptyDistribution = ticketQuality.readinessDistribution.filter(
    (bucket) => bucket.sampleSize > 0,
  );
  return (
    <section
      className="stats-ticket-quality glass-place-block"
      style={glassPlaceStyle(95)}
    >
      <div className="stats-section-label mono dim">ticket readiness</div>
      <div className="stats-ticket-quality-head">
        <div>
          <h3>{ticketQuality.averageScore.toFixed(1)} average readiness</h3>
          <p className="dim">{ticketQuality.disclaimer}</p>
        </div>
        {ticketQuality.dataHygieneCallout && (
          <div className="stats-quality-callout">
            <strong>{ticketQuality.dataHygieneCallout.title}</strong>
            <span className="dim">
              {ticketQuality.dataHygieneCallout.summary}
            </span>
            <JiraExamples
              examples={ticketQuality.dataHygieneCallout.examples}
              rowsByDashboardId={rowsByDashboardId}
              onOpenDetail={onOpenDetail}
            />
          </div>
        )}
      </div>

      <div
        className="stats-readiness-bar"
        aria-label="Ticket readiness distribution"
      >
        {nonEmptyDistribution.map((bucket) => (
          <div
            key={bucket.id}
            className={`stats-readiness-segment ${bucket.id}`}
            style={{ width: `${Math.max(bucket.share * 100, 3)}%` }}
            title={`${bucket.label}: ${bucket.sampleSize} samples`}
          />
        ))}
      </div>
      <div className="stats-readiness-legend">
        {ticketQuality.readinessDistribution.map((bucket) => (
          <span key={bucket.id}>
            <i className={`stats-readiness-dot ${bucket.id}`} />
            {bucket.label} · {bucket.sampleSize}
          </span>
        ))}
      </div>

      <div className="stats-quality-grid">
        <div className="stats-quality-panel">
          <div className="stats-quality-panel-title">Pass rate by tier</div>
          <div className="stats-quality-table">
            {ticketQuality.passRateByTier.map((bucket) => (
              <div key={bucket.id} className="stats-quality-row">
                <span>{bucket.label}</span>
                <span className="mono dim">{bucket.sampleSize} N</span>
                <span className="stats-inline-bar">
                  <i style={{ width: `${bucket.cohort.passRate * 100}%` }} />
                </span>
                <span className="mono">{passRateLabel(bucket)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="stats-quality-panel">
          <div className="stats-quality-panel-title">Template fit</div>
          {(() => {
            const buckets = ticketQuality.templateFit;
            const emptyCount = buckets.filter(
              (bucket) => bucket.cohort.terminalCount === 0,
            ).length;
            if (buckets.length > 0 && emptyCount >= buckets.length - 1) {
              return (
                <p className="dim">
                  Not enough terminal samples to evaluate template fit in this
                  window.
                </p>
              );
            }
            return (
              <div className="stats-template-fit-grid">
                {buckets.map((bucket) => (
                  <div key={bucket.id} className="stats-template-fit-item">
                    <span>{bucket.label}</span>
                    <strong>{formatPercent(bucket.share)}</strong>
                    <span className="dim">{passRateLabel(bucket)}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      <MissingSignalImpactTable
        impacts={ticketQuality.missingSignalImpact}
        rowsByDashboardId={rowsByDashboardId}
        onOpenDetail={onOpenDetail}
      />

      {ticketQuality.stratifiedReadinessGap.recommendationSummary && (
        <div className="stats-quality-recommendation">
          {ticketQuality.stratifiedReadinessGap.recommendationSummary}
        </div>
      )}

      <div className="stats-quality-footer dim">
        Readiness rubric {ticketQuality.rubric.rubricVersion} · score reflects
        ticket text captured at OneShot intake
      </div>
    </section>
  );
}

function MissingSignalImpactRow({
  impact,
  rowsByDashboardId,
  onOpenDetail,
}: {
  impact: OneShotMissingSignalImpact;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  return (
    <div className="stats-missing-signal-row">
      <div>
        <strong>{impact.label}</strong>
        <span className="dim">
          missing N={impact.missing.sampleSize} · present N=
          {impact.present.sampleSize}
        </span>
      </div>
      {impact.significant ? (
        <>
          <span className="stats-inline-bar impact">
            <i
              style={{
                width: `${Math.min(100, Math.max(0, impact.deltaPassRate))}%`,
              }}
            />
          </span>
          <span className="mono stats-impact-sig">
            {impact.deltaPassRate > 0 ? "+" : ""}
            {impact.deltaPassRate.toFixed(1)}pp
          </span>
        </>
      ) : (
        <>
          <span className="stats-inline-bar impact" aria-hidden />
          <span className="mono dim" title="within statistical noise">
            within noise
          </span>
        </>
      )}
      <div className="stats-balanced-examples">
        <JiraExamples
          examples={impact.examples.missingFailedOrNoAction}
          rowsByDashboardId={rowsByDashboardId}
          onOpenDetail={onOpenDetail}
        />
        <JiraExamples
          examples={impact.examples.presentPassed}
          rowsByDashboardId={rowsByDashboardId}
          onOpenDetail={onOpenDetail}
        />
      </div>
    </div>
  );
}

function MissingSignalImpactTable({
  impacts,
  rowsByDashboardId,
  onOpenDetail,
}: {
  impacts: ReadonlyArray<OneShotMissingSignalImpact>;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  if (impacts.length === 0) {
    return (
      <div className="stats-quality-panel stats-missing-signal-panel">
        <div className="stats-quality-panel-title">Missing-signal impact</div>
        <p className="dim">
          No missing signal has enough present and missing cohort volume yet.
        </p>
      </div>
    );
  }
  const significant = impacts.filter((impact) => impact.significant);
  const noisy = impacts.filter((impact) => !impact.significant);
  return (
    <div className="stats-quality-panel stats-missing-signal-panel">
      <div className="stats-quality-panel-title">Missing-signal impact</div>
      {significant.length === 0 && (
        <p className="dim">
          No signal shows a statistically significant pass-rate gap in this
          window.
        </p>
      )}
      {significant.length > 0 && (
        <div className="stats-missing-signal-table">
          {significant.map((impact) => (
            <MissingSignalImpactRow
              key={impact.signal}
              impact={impact}
              rowsByDashboardId={rowsByDashboardId}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </div>
      )}
      {noisy.length > 0 && (
        <details className="stats-missing-signal-noisy">
          <summary className="dim">
            Within statistical noise ({noisy.length}{" "}
            {noisy.length === 1 ? "signal" : "signals"})
          </summary>
          <div className="stats-missing-signal-table">
            {noisy.map((impact) => (
              <MissingSignalImpactRow
                key={impact.signal}
                impact={impact}
                rowsByDashboardId={rowsByDashboardId}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const ATTRIBUTION_COPY: Record<
  OneShotFailureAttributionByCategory["attribution"],
  { label: string; description: string }
> = {
  oneshot: {
    label: "OneShot",
    description: "Infra, agent, or LLM failures on well-formed tickets.",
  },
  ticket: {
    label: "Ticket",
    description: "Qualifier rejections or ticket-quality failures.",
  },
  mixed: {
    label: "Mixed",
    description: "Infra failure on a weak ticket — both sides plausible.",
  },
  unknown: {
    label: "Unknown",
    description: "Unrecognized failure pattern; needs human triage.",
  },
};

const ERROR_CATEGORY_LABEL: Record<
  OneShotFailureAttributionByCategory["errorCategory"],
  string
> = {
  git_operation: "Git operation",
  llm_provider: "LLM provider",
  llm_output: "LLM output",
  s3_storage: "S3 storage",
  db_operation: "Database",
  workspace: "Workspace / disk",
  github_api: "GitHub API",
  ticket_quality: "Ticket quality",
  budget: "Budget exhausted",
  agent_logic: "Agent logic",
  plan_validation: "Plan validation",
  test_runner_skipped: "Test runner skipped",
  ci_failure: "CI failure",
  unknown: "Uncategorized",
};

function FailureAttributionSection({
  attribution,
  rowsByDashboardId,
  onOpenDetail,
}: {
  attribution: OneShotFailureAttributionSummary;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
}) {
  const total = attribution.totalFailures;
  if (total === 0) {
    return (
      <section
        className="stats-attribution glass-place-block"
        style={glassPlaceStyle(100)}
      >
        <div className="stats-section-label mono dim">failure attribution</div>
        <p className="dim">
          No failures classified in this window
          {attribution.excludedFromDenominator > 0
            ? ` (${attribution.excludedFromDenominator} qualifier-gating outcomes excluded)`
            : ""}
          .
        </p>
      </section>
    );
  }
  const counts = attribution.countsByAttribution;
  const order: Array<keyof typeof counts> = [
    "oneshot",
    "ticket",
    "mixed",
    "unknown",
  ];
  return (
    <section
      className="stats-attribution glass-place-block"
      style={glassPlaceStyle(100)}
    >
      <div className="stats-section-label mono dim">failure attribution</div>
      <div className="stats-attribution-head">
        <h3>
          {total} failure{total === 1 ? "" : "s"} classified
        </h3>
        <p className="dim">
          {`${counts.oneshot} OneShot · ${counts.ticket} ticket · ${counts.mixed} mixed · ${counts.unknown} unknown`}
          {attribution.excludedFromDenominator > 0
            ? ` · ${attribution.excludedFromDenominator} gating outcomes excluded`
            : ""}
        </p>
      </div>
      <div
        className="stats-attribution-bar"
        aria-label="Failure attribution distribution"
      >
        {order.map((key) => {
          const value = counts[key];
          if (value === 0) return null;
          const share = total > 0 ? value / total : 0;
          return (
            <div
              key={key}
              className={`stats-attribution-segment ${key}`}
              style={{ width: `${Math.max(share * 100, 4)}%` }}
              title={`${ATTRIBUTION_COPY[key].label}: ${value}`}
            />
          );
        })}
      </div>
      <div className="stats-attribution-legend">
        {order.map((key) => (
          <span key={key}>
            <i className={`stats-attribution-dot ${key}`} />
            {ATTRIBUTION_COPY[key].label} · {counts[key]}
          </span>
        ))}
      </div>
      {attribution.byCategory.length > 0 && (
        <div className="stats-attribution-categories">
          {attribution.byCategory.map((row) => (
            <div
              key={`${row.errorCategory}:${row.attribution}`}
              className="stats-attribution-row"
            >
              <div>
                <strong>{ERROR_CATEGORY_LABEL[row.errorCategory]}</strong>
                <span className="dim">
                  {ATTRIBUTION_COPY[row.attribution].label}
                </span>
              </div>
              <span className="mono dim">{row.sampleSize} N</span>
              <JiraExamples
                examples={row.examples}
                rowsByDashboardId={rowsByDashboardId}
                onOpenDetail={onOpenDetail}
              />
            </div>
          ))}
        </div>
      )}
      {counts.unknown > 0 && (
        <p className="dim stats-attribution-note">
          Unknown attributions need human triage — typically when the failure
          message does not match any known category pattern.
        </p>
      )}
    </section>
  );
}

function SelfFixCandidatesSection({
  statistics,
  rowsByDashboardId,
  onOpenDetail,
  onTicketCreated,
}: {
  statistics: OneShotStatisticsResponse;
  rowsByDashboardId: ReadonlyMap<string, OneShotDashboardRow>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  onTicketCreated?: (result: SelfFixTicketResult) => void;
}) {
  const candidates = statistics.selfFixCandidates ?? [];
  const [pendingCandidateId, setPendingCandidateId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [localResults, setLocalResults] = useState<
    Record<string, SelfFixTicketResult>
  >({});

  if (candidates.length === 0) return null;
  const candidateCountLabel = `${candidates.length} OneShot-owned pattern${candidates.length === 1 ? "" : "s"} ready`;

  async function createTicket(candidate: SelfFixCandidate, autoRun: boolean) {
    if (pendingCandidateId) return;
    setPendingCandidateId(candidate.id);
    setError(null);
    try {
      const response = await fetch("/api/oneshot/statistics/self-fix-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          range: statistics.range,
          candidateId: candidate.id,
          autoRun,
        }),
      });
      if (!response.ok) {
        throw new Error(await readSelfFixTicketError(response));
      }
      const result = (await response.json()) as SelfFixTicketResult;
      setLocalResults((current) => ({
        ...current,
        [candidate.id]: result,
      }));
      onTicketCreated?.(result);
    } catch (ticketError) {
      setError(
        ticketError instanceof Error
          ? ticketError.message
          : "Self-fix ticket request failed",
      );
    } finally {
      setPendingCandidateId(null);
    }
  }

  return (
    <section
      className="stats-self-fix glass-place-block"
      style={glassPlaceStyle(105)}
    >
      <div className="stats-section-label mono dim">self-fix candidates</div>
      <div className="stats-self-fix-head">
        <div>
          <h3>{candidateCountLabel}</h3>
          <p className="dim">
            Defects are gated by {statistics.selfFixConfig.minSampleSize}+
            samples and a significant Wilson 95% gap against the selected
            window baseline.
          </p>
        </div>
      </div>
      {error && <div className="stats-self-fix-error">{error}</div>}
      <div className="stats-self-fix-list">
        {candidates.map((candidate) => {
          const local = localResults[candidate.id];
          const ticketKey = local?.ticketKey ?? candidate.ticketKey;
          const jiraUrl = local?.jiraUrl ?? candidate.jiraUrl;
          const runRequestId = local?.runRequestId ?? candidate.runRequestId;
          const status = local?.status ?? candidate.status;
          const pending = pendingCandidateId === candidate.id;
          return (
            <article key={candidate.id} className="stats-self-fix-row">
              <div className="stats-self-fix-main">
                <div className="stats-self-fix-title-line">
                  <strong>{ERROR_CATEGORY_LABEL[candidate.category]}</strong>
                  <span className={`stats-self-fix-status ${status}`}>
                    {status.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="dim">
                  {candidate.sampleSize} samples · baseline{" "}
                  {formatPercent(candidate.passRateBaseline)}
                </p>
                <JiraExamples
                  examples={candidate.examples}
                  rowsByDashboardId={rowsByDashboardId}
                  onOpenDetail={onOpenDetail}
                />
              </div>
              <div className="stats-self-fix-actions">
                {ticketKey && jiraUrl ? (
                  <a
                    className="stats-self-fix-link mono"
                    href={jiraUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {ticketKey}
                  </a>
                ) : ticketKey ? (
                  <span className="stats-self-fix-link mono">{ticketKey}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void createTicket(candidate, false)}
                    disabled={pending}
                  >
                    {pending ? "Creating" : "Create defect"}
                  </button>
                )}
                {runRequestId ? (
                  <span className="mono dim">request #{runRequestId}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void createTicket(candidate, true)}
                    disabled={pending}
                  >
                    {ticketKey ? "Queue run" : "Create + run"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function Statistics({
  statistics,
  rows,
  range,
  isLoading,
  error,
  onRangeChange,
  onOpenDetail,
  onSearch,
  onNewRun,
  onSelfFixTicketCreated,
  theme,
  onThemeChange,
}: {
  statistics: OneShotStatisticsResponse | null;
  rows: ReadonlyArray<OneShotDashboardRow>;
  range: OneShotAnalyticsRange;
  isLoading: boolean;
  error: string | null;
  onRangeChange: (next: OneShotAnalyticsRange) => void;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  onSearch?: () => void;
  onNewRun?: () => void;
  onSelfFixTicketCreated?: (result: SelfFixTicketResult) => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  const rowsByDashboardId = new Map(rows.map((row) => [row.dashboardId, row]));
  const scorecard = statistics?.scorecard;
  const modelInfo = statistics?.modelInfo;
  const generatedAt = modelInfo?.generatedAt;
  const hasAiSnapshot = Boolean(modelInfo?.provider && generatedAt);
  const aiRefreshError = friendlyStatisticsLastError(modelInfo?.lastError);
  const heroEyebrow = hasAiSnapshot ? "AI statistics" : "Statistics";
  const heroBadge = aiRefreshError
    ? { tone: "warn" as const, label: "ai retrying" }
    : modelInfo?.refreshing
      ? { tone: "warn" as const, label: "refreshing" }
      : hasAiSnapshot
        ? { tone: "ok" as const, label: "ai snapshot" }
        : { tone: "dim" as const, label: "no AI snapshot yet" };
  const refreshLabel = aiRefreshError
    ? aiRefreshError
    : modelInfo?.refreshing
      ? "refreshing"
      : generatedAt
        ? `refreshed ${formatRelTime(generatedAt)}`
        : "deterministic snapshot — no LLM run for this window";

  return (
    <div className="view statistics-view">
      <PageHeader
        title="Statistics"
        metrics={[
          { label: "intake", value: scorecard?.intake ?? "…" },
          {
            label: "pass rate",
            value: scorecard ? formatPercent(scorecard.passRate) : "…",
            tone:
              scorecard && scorecard.passRate >= 0.75
                ? "ok"
                : scorecard && scorecard.passRate < 0.5
                  ? "bad"
                  : "warn",
          },
          { label: "window", value: statistics?.window.shortLabel ?? range },
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

      {error && (
        <section
          className="triage-empty glass-place-block"
          style={glassPlaceStyle(0)}
        >
          <div className="triage-empty-title">Statistics unavailable</div>
          <div className="triage-empty-sub dim">{error}</div>
        </section>
      )}

      {!error && !statistics && (
        <section
          className="triage-empty glass-place-block"
          style={glassPlaceStyle(0)}
        >
          <div className="triage-empty-title">
            {isLoading ? "Loading statistics" : "No statistics yet"}
          </div>
          <div className="triage-empty-sub dim">
            The first AI snapshot will appear after the refresh lease completes.
          </div>
        </section>
      )}

      {statistics && (
        <>
          <section
            className="stats-hero glass-place-block"
            style={glassPlaceStyle(0)}
          >
            <div>
              <div className="tempo-hero-label stats-hero-eyebrow">
                <span>{heroEyebrow}</span>
                <span
                  className={`stats-hero-badge ${heroBadge.tone}`}
                  title={heroBadge.label}
                >
                  {heroBadge.label}
                </span>
              </div>
              <h2>{statistics.summary}</h2>
              <p className="dim">
                {refreshLabel}
                {statistics.modelInfo.model
                  ? ` · ${statistics.modelInfo.model}`
                  : ""}
              </p>
            </div>
            <div className="stats-score-grid">
              <div>
                <span className="mono dim">completed</span>
                <strong>{statistics.scorecard.completed}</strong>
              </div>
              <div>
                <span className="mono dim">failed</span>
                <strong>{statistics.scorecard.failed}</strong>
              </div>
              <div>
                <span className="mono dim">no action</span>
                <strong>{statistics.scorecard.noAction}</strong>
              </div>
              <div>
                <span className="mono dim">cost</span>
                <strong>{formatUsd(statistics.scorecard.totalUsd)}</strong>
              </div>
              <div>
                <span className="mono dim">tokens</span>
                <strong>
                  {formatTokens(statistics.scorecard.totalTokens)}
                </strong>
              </div>
              <div>
                <span className="mono dim">p50 PR</span>
                <strong>
                  {formatDurationMs(statistics.scorecard.p50TimeToPrMs)}
                </strong>
              </div>
            </div>
          </section>

          <section
            className="stats-metrics glass-place-block"
            style={glassPlaceStyle(70)}
          >
            {statistics.businessMetrics.map((metric) => (
              <div key={metric.id} className="stats-metric">
                <div className="stats-metric-head">
                  <span>{metric.title}</span>
                  <DeltaText
                    delta={metric.delta}
                    formatValue={deltaValueFormatter(metric.id)}
                    positiveIsGood={metricPositiveIsGood(metric.id)}
                    suffix={metric.id === "pass-rate" ? "pp" : ""}
                  />
                </div>
                <p className="dim">{metric.summary}</p>
              </div>
            ))}
          </section>

          <OperationalBottlenecksSection
            statistics={statistics}
            rowsByDashboardId={rowsByDashboardId}
            onOpenDetail={onOpenDetail}
          />

          <RepoStatusSection
            statistics={statistics}
            rowsByDashboardId={rowsByDashboardId}
            onOpenDetail={onOpenDetail}
          />

          <TicketReadinessSection
            statistics={statistics}
            rowsByDashboardId={rowsByDashboardId}
            onOpenDetail={onOpenDetail}
          />

          {statistics.failureAttribution && (
            <FailureAttributionSection
              attribution={statistics.failureAttribution}
              rowsByDashboardId={rowsByDashboardId}
              onOpenDetail={onOpenDetail}
            />
          )}

          <SelfFixCandidatesSection
            statistics={statistics}
            rowsByDashboardId={rowsByDashboardId}
            onOpenDetail={onOpenDetail}
            onTicketCreated={onSelfFixTicketCreated}
          />

          <div className="stats-two-col">
            <section>
              <div className="stats-section-label mono dim">working well</div>
              <div className="stats-card-stack">
                {statistics.workingWell.length === 0 ? (
                  <div className="stats-insight-card glass-place-block">
                    No high-sample success pattern yet.
                  </div>
                ) : (
                  statistics.workingWell.map((insight, idx) => (
                    <InsightCard
                      key={insight.id}
                      insight={insight}
                      rowsByDashboardId={rowsByDashboardId}
                      onOpenDetail={onOpenDetail}
                      tone="good"
                      delayMs={idx * 45}
                    />
                  ))
                )}
              </div>
            </section>

            <section>
              <div className="stats-section-label mono dim">
                needs improvement
              </div>
              <div className="stats-card-stack">
                {statistics.needsImprovement.length === 0 ? (
                  <div className="stats-insight-card glass-place-block">
                    No high-sample weak pattern yet.
                  </div>
                ) : (
                  statistics.needsImprovement.map((insight, idx) => (
                    <InsightCard
                      key={insight.id}
                      insight={insight}
                      rowsByDashboardId={rowsByDashboardId}
                      onOpenDetail={onOpenDetail}
                      tone="bad"
                      delayMs={idx * 45}
                    />
                  ))
                )}
              </div>
            </section>
          </div>

          <section
            className="stats-actions glass-place-block"
            style={glassPlaceStyle(120)}
          >
            <div className="stats-section-label mono dim">
              recommended actions
            </div>
            {statistics.recommendedActions.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                rowsByDashboardId={rowsByDashboardId}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
