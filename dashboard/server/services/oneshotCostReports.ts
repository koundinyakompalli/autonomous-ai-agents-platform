import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import {
  TERMINAL_STATES,
  STATE_LABELS,
} from "../shared/oneshotStateModel.js";
import {
  normalizeOneShotTicketType,
  type OneShotTicketType,
} from "../shared/ticketType.js";
import type {
  OneShotAnalyticsRange,
  OneShotCostSource,
  OneShotDashboardRow,
} from "../types/oneshot.js";
import {
  estimateCostUsdFromModelUsage,
  mergeCostSources,
  resolveArtifactCostContribution,
  type DashboardArtifactCostRow,
} from "./oneshotCosting.js";
import { getOneShotDashboardRows } from "./oneshot.js";
import { normalizeOneShotAnalyticsRange } from "./oneshotAnalytics.js";

export type OneShotCostReportTicketTypeFilter = OneShotTicketType | "all";

export interface OneShotCostReportQuery {
  range: OneShotAnalyticsRange;
  ticketType: OneShotCostReportTicketTypeFilter;
}

export interface OneShotCostReportSummaryRow {
  ticketType: OneShotTicketType;
  displayState?: OneShotDashboardRow["displayState"];
  runCount: number;
  totalCostUsd: number;
  totalTokens: number;
  averageDurationMs: number;
  medianDurationMs: number;
  costSource: OneShotCostSource;
}

export interface OneShotCostReportModelColumn {
  key: string;
  label: string;
  costColumn: string;
  tokensColumn: string;
}

export interface OneShotCostReportRow {
  jiraKey: string;
  title: string;
  jiraIssueType: string | null;
  ticketType: OneShotTicketType;
  ticketTypeSource: string;
  displayState: OneShotDashboardRow["displayState"];
  readiness: OneShotDashboardRow["readiness"] | null;
  progressStage: OneShotDashboardRow["progressStage"];
  repoName: string | null;
  dashboardId: string;
  oneshotRunId: number;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  totalCostUsd: number;
  totalTokens: number;
  costSource: OneShotCostSource;
  modelBreakdown: OneShotCostReportModelBreakdown[];
  modelValues: Record<string, { costUsd: number; tokens: number }>;
}

export interface OneShotCostReport {
  generatedAt: string;
  window: {
    range: OneShotAnalyticsRange;
    label: string;
    ticketType: OneShotCostReportTicketTypeFilter;
    startAt: string | null;
    endAt: string;
  };
  totals: {
    runCount: number;
    totalCostUsd: number;
    totalTokens: number;
    averageDurationMs: number;
    medianDurationMs: number;
    costSource: OneShotCostSource;
  };
  modelColumns: OneShotCostReportModelColumn[];
  byTicketType: OneShotCostReportSummaryRow[];
  byTicketTypeAndState: OneShotCostReportSummaryRow[];
  rows: OneShotCostReportRow[];
}

type ArtifactMetricRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  stage_cost_usd: number | string | null;
  stage_tokens_used: number | string | null;
  tokens_used?: unknown;
  model: string | null;
  provider: string | null;
  model_usage?: unknown;
};

type ArtifactModelUsage = Record<string, { input: number; output: number }>;

export interface OneShotCostReportModelBreakdown {
  key: string;
  label: string;
  provider: string | null;
  rawModelIds: string[];
  tokens: number;
  costUsd: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RANGE_DURATION_MS: Record<Exclude<OneShotAnalyticsRange, "all">, number> =
  {
    "24h": DAY_MS,
    "7d": 7 * DAY_MS,
    "30d": 30 * DAY_MS,
  };

const RANGE_LABELS: Record<OneShotAnalyticsRange, string> = {
  "24h": "Last 24h",
  "7d": "Last 7d",
  "30d": "Last 30d",
  all: "All time",
};

const STABLE_CSV_COLUMNS = [
  "jira_key",
  "title",
  "jira_issue_type",
  "ticket_type",
  "ticket_type_source",
  "display_state",
  "readiness",
  "progress_stage",
  "repo_name",
  "dashboard_id",
  "created_at",
  "updated_at",
  "duration_minutes",
  "duration_hours",
  "total_cost_usd",
  "total_tokens",
  "cost_source",
] as const;

function coerceFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function roundDuration(value: number): number {
  return Number(value.toFixed(2));
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseModelUsage(value: unknown): ArtifactModelUsage | null {
  const raw = parseJson(value);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const parsed: ArtifactModelUsage = {};
  for (const [model, usage] of Object.entries(raw)) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      continue;
    }
    const input = coerceFiniteNumber(
      (usage as { input?: unknown; input_tokens?: unknown }).input ??
        (usage as { input_tokens?: unknown }).input_tokens,
    );
    const output = coerceFiniteNumber(
      (usage as { output?: unknown; output_tokens?: unknown }).output ??
        (usage as { output_tokens?: unknown }).output_tokens,
    );
    if ((input ?? 0) + (output ?? 0) > 0) {
      parsed[model] = { input: input ?? 0, output: output ?? 0 };
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function metricTokens(metric: ArtifactMetricRow): number {
  const raw = parseJson(metric.tokens_used);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const input = coerceFiniteNumber((raw as { input?: unknown }).input) ?? 0;
    const output = coerceFiniteNumber((raw as { output?: unknown }).output) ?? 0;
    if (input + output > 0) {
      return input + output;
    }
  }
  return coerceFiniteNumber(metric.stage_tokens_used) ?? 0;
}

function dashboardCostRow(metric: ArtifactMetricRow): DashboardArtifactCostRow {
  return {
    ...metric,
    stage_cost_usd: coerceFiniteNumber(metric.stage_cost_usd),
    stage_tokens_used: metricTokens(metric),
  } as DashboardArtifactCostRow;
}

function normalizeReportTicketType(
  value: unknown,
): OneShotCostReportTicketTypeFilter {
  if (value === "all") {
    return "all";
  }
  return normalizeOneShotTicketType(value) ?? "all";
}

export function normalizeOneShotCostReportQuery(input: {
  range?: unknown;
  ticketType?: unknown;
}): OneShotCostReportQuery {
  return {
    range: normalizeOneShotAnalyticsRange(input.range),
    ticketType: normalizeReportTicketType(input.ticketType),
  };
}

function reportStartMs(range: OneShotAnalyticsRange, nowMs: number): number {
  if (range === "all") {
    return Number.NEGATIVE_INFINITY;
  }
  return nowMs - RANGE_DURATION_MS[range];
}

function inCreatedWindow(
  row: Pick<OneShotDashboardRow, "createdAt">,
  range: OneShotAnalyticsRange,
  nowMs: number,
): boolean {
  const createdMs = timestampMs(row.createdAt);
  if (createdMs <= 0 || createdMs > nowMs) {
    return false;
  }
  return range === "all" || createdMs >= reportStartMs(range, nowMs);
}

function durationMs(row: OneShotDashboardRow, nowMs: number): number {
  const startMs = timestampMs(row.createdAt);
  const isTerminal = TERMINAL_STATES.includes(
    row.displayState as (typeof TERMINAL_STATES)[number],
  );
  const endMs = isTerminal ? timestampMs(row.updatedAt) : nowMs;
  return Math.max(0, endMs - startMs);
}

function canonicalModelLabel(model: string): {
  key: string;
  label: string;
} {
  const normalized = model.trim().toLowerCase();
  const claudeMatch = normalized.match(/claude-(haiku|sonnet|opus)-(\d+)-(\d+)/);
  if (claudeMatch) {
    const family = claudeMatch[1] ?? "claude";
    const major = claudeMatch[2] ?? "";
    const minor = claudeMatch[3] ?? "";
    return {
      key: `claude_${family}_${major}_${minor}`,
      label: `Claude ${family[0]?.toUpperCase() ?? ""}${family.slice(1)} ${major}.${minor}`,
    };
  }

  const gptMatch = normalized.match(/(?:^|[/.-])gpt[-.]?(\d+(?:[.-]\d+)?)/);
  if (gptMatch) {
    const version = (gptMatch[1] ?? "").replace("-", ".");
    return {
      key: `gpt_${version.replace(/\./g, "_")}`,
      label: `GPT-${version}`,
    };
  }

  if (!normalized || normalized === "unknown") {
    return { key: "unattributed_llm", label: "Unattributed LLM" };
  }

  const key = normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return {
    key: key || "unattributed_llm",
    label: model.trim() || "Unattributed LLM",
  };
}

function pricingModelForModelUsage(
  metric: ArtifactMetricRow,
  modelUsageKey: string,
): string {
  if (
    modelUsageKey.includes("claude-") ||
    modelUsageKey.includes("gpt-") ||
    modelUsageKey.includes("anthropic.") ||
    modelUsageKey.includes("openai.")
  ) {
    return modelUsageKey;
  }
  return metric.model ?? modelUsageKey;
}

function addModelBreakdown(
  byRunId: Map<number, Map<string, OneShotCostReportModelBreakdown>>,
  runId: number,
  input: {
    model: string;
    provider: string | null;
    rawModelId: string | null;
    tokens: number;
    costUsd: number;
  },
) {
  const canonical = canonicalModelLabel(input.model);
  const runModels = byRunId.get(runId) ?? new Map();
  const existing = runModels.get(canonical.key) ?? {
    key: canonical.key,
    label: canonical.label,
    provider: input.provider,
    rawModelIds: [],
    tokens: 0,
    costUsd: 0,
  };
  existing.tokens += input.tokens;
  existing.costUsd += input.costUsd;
  if (input.provider && !existing.provider) {
    existing.provider = input.provider;
  }
  if (input.rawModelId && !existing.rawModelIds.includes(input.rawModelId)) {
    existing.rawModelIds.push(input.rawModelId);
  }
  runModels.set(canonical.key, existing);
  byRunId.set(runId, runModels);
}

function addResidualModelBreakdown(
  modelBreakdown: readonly OneShotCostReportModelBreakdown[],
  row: OneShotDashboardRow,
): OneShotCostReportModelBreakdown[] {
  const capturedCostUsd = roundUsd(
    modelBreakdown.reduce((sum, model) => sum + model.costUsd, 0),
  );
  const capturedTokens = modelBreakdown.reduce(
    (sum, model) => sum + model.tokens,
    0,
  );
  const residualCostUsd = roundUsd(
    Math.max(0, row.estimatedCostUsd - capturedCostUsd),
  );
  const residualTokens = Math.max(
    0,
    Math.round(row.totalTokensUsed - capturedTokens),
  );
  if (residualCostUsd <= 0 && residualTokens <= 0) {
    return [...modelBreakdown];
  }

  const existingIndex = modelBreakdown.findIndex(
    (model) => model.key === "unattributed_llm",
  );
  if (existingIndex >= 0) {
    return modelBreakdown.map((model, index) =>
      index === existingIndex
        ? {
            ...model,
            costUsd: roundUsd(model.costUsd + residualCostUsd),
            tokens: model.tokens + residualTokens,
          }
        : { ...model },
    );
  }

  return [
    ...modelBreakdown.map((model) => ({ ...model })),
    {
      key: "unattributed_llm",
      label: "Unattributed LLM",
      provider: null,
      rawModelIds: [],
      tokens: residualTokens,
      costUsd: residualCostUsd,
    },
  ];
}

async function fetchArtifactMetricsForRunIds(
  runIds: readonly number[],
): Promise<ArtifactMetricRow[]> {
  if (runIds.length === 0) {
    return [];
  }
  const placeholders = runIds.map(() => "?").join(", ");
  const [rows] = await getPool().query<ArtifactMetricRow[]>(
    `SELECT
       a.oneshot_run_id,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS stage_cost_usd,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS stage_tokens_used,
       JSON_EXTRACT(a.metadata_json, '$.tokens_used') AS tokens_used,
       CAST(a.model AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(a.provider AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider,
       JSON_EXTRACT(a.metadata_json, '$.model_usage') AS model_usage
     FROM oneshot_artifacts a
     WHERE a.oneshot_run_id IN (${placeholders})
       AND a.stage IN ('qualification', 'plan', 'trace', 'verify', 'review', 'implementation', 'code_review', 'test_result')
     UNION ALL
     SELECT
       e.oneshot_run_id,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS stage_cost_usd,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS stage_tokens_used,
       JSON_EXTRACT(e.metadata_json, '$.tokens_used') AS tokens_used,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.model')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.provider')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider,
       JSON_EXTRACT(e.metadata_json, '$.model_usage') AS model_usage
     FROM oneshot_run_events e
     WHERE e.oneshot_run_id IN (${placeholders})
       AND e.event_type = 'stage_attempt_metrics'`,
    [...runIds, ...runIds],
  );
  return rows;
}

function buildModelBreakdowns(
  metrics: readonly ArtifactMetricRow[],
): Map<number, Map<string, OneShotCostReportModelBreakdown>> {
  const byRunId = new Map<
    number,
    Map<string, OneShotCostReportModelBreakdown>
  >();

  for (const metric of metrics) {
    const runId = Number(metric.oneshot_run_id);
    if (!Number.isFinite(runId) || runId <= 0) {
      continue;
    }
    const provider = metric.provider ?? null;
    const modelUsage = parseModelUsage(metric.model_usage);
    if (modelUsage) {
      for (const [model, usage] of Object.entries(modelUsage)) {
        const tokens = usage.input + usage.output;
        const pricingModel = pricingModelForModelUsage(metric, model);
        const costUsd =
          estimateCostUsdFromModelUsage(provider, pricingModel, usage) ?? 0;
        addModelBreakdown(byRunId, runId, {
          model,
          provider,
          rawModelId: pricingModel,
          tokens,
          costUsd,
        });
      }
      continue;
    }

    const model = metric.model ?? "Unattributed LLM";
    const contribution = resolveArtifactCostContribution(
      dashboardCostRow(metric),
    );
    const tokens = metricTokens(metric);
    if (tokens <= 0 && !contribution) {
      continue;
    }
    addModelBreakdown(byRunId, runId, {
      model,
      provider,
      rawModelId: metric.model,
      tokens,
      costUsd: contribution?.usd ?? 0,
    });
  }

  return byRunId;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
  }
  return sorted[middle] ?? 0;
}

function buildSummary(
  rows: readonly OneShotCostReportRow[],
): Omit<OneShotCostReport["totals"], "costSource"> & {
  costSource: OneShotCostSource;
} {
  const durations = rows.map((row) => row.durationMs);
  return {
    runCount: rows.length,
    totalCostUsd: roundUsd(rows.reduce((sum, row) => sum + row.totalCostUsd, 0)),
    totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    averageDurationMs:
      durations.length === 0
        ? 0
        : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    medianDurationMs: median(durations),
    costSource: mergeCostSources(rows.map((row) => row.costSource)),
  };
}

function groupedSummary(
  rows: readonly OneShotCostReportRow[],
  includeState: boolean,
): OneShotCostReportSummaryRow[] {
  const grouped = new Map<string, OneShotCostReportRow[]>();
  for (const row of rows) {
    const key = includeState
      ? `${row.ticketType}:${row.displayState}`
      : row.ticketType;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  return Array.from(grouped.entries())
    .map(([key, group]) => {
      const [ticketType, displayState] = key.split(":") as [
        OneShotTicketType,
        OneShotDashboardRow["displayState"] | undefined,
      ];
      const summary = buildSummary(group);
      return {
        ticketType,
        ...(includeState && displayState ? { displayState } : {}),
        ...summary,
      };
    })
    .sort((a, b) => {
      if (a.ticketType !== b.ticketType) {
        return a.ticketType.localeCompare(b.ticketType);
      }
      return (a.displayState ?? "").localeCompare(b.displayState ?? "");
    });
}

function modelColumns(
  rows: readonly OneShotCostReportRow[],
): OneShotCostReportModelColumn[] {
  const totals = new Map<string, { label: string; costUsd: number }>();
  for (const row of rows) {
    for (const model of row.modelBreakdown) {
      const existing = totals.get(model.key) ?? {
        label: model.label,
        costUsd: 0,
      };
      existing.costUsd += model.costUsd;
      totals.set(model.key, existing);
    }
  }

  return Array.from(totals.entries())
    .sort(([, a], [, b]) => b.costUsd - a.costUsd || a.label.localeCompare(b.label))
    .map(([key, value]) => ({
      key,
      label: value.label,
      costColumn: `${key}_cost_usd`,
      tokensColumn: `${key}_tokens`,
    }));
}

export async function generateOneShotCostReport(
  rawQuery: Partial<OneShotCostReportQuery> = {},
): Promise<OneShotCostReport> {
  const query = normalizeOneShotCostReportQuery(rawQuery);
  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const rows = (await getOneShotDashboardRows()).filter(
    (row) =>
      row.oneshotRunId !== null &&
      inCreatedWindow(row, query.range, nowMs) &&
      (query.ticketType === "all" || row.ticketType === query.ticketType),
  );
  const metrics = await fetchArtifactMetricsForRunIds(
    rows.map((row) => row.oneshotRunId).filter((id): id is number => id !== null),
  );
  const modelBreakdownByRunId = buildModelBreakdowns(metrics);

  const reportRows: OneShotCostReportRow[] = rows
    .map((row) => {
      const capturedModelBreakdown = Array.from(
        modelBreakdownByRunId.get(row.oneshotRunId ?? 0)?.values() ?? [],
      ).map((model) => ({
        ...model,
        rawModelIds: [...model.rawModelIds].sort(),
        tokens: Math.round(model.tokens),
        costUsd: roundUsd(model.costUsd),
      }));
      const modelBreakdown = addResidualModelBreakdown(
        capturedModelBreakdown,
        row,
      ).sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label));
      const modelValues = Object.fromEntries(
        modelBreakdown.map((model) => [
          model.key,
          { costUsd: model.costUsd, tokens: model.tokens },
        ]),
      );

      return {
        jiraKey: row.jiraKey,
        title: row.title,
        jiraIssueType: row.jiraIssueType,
        ticketType: row.ticketType,
        ticketTypeSource: row.ticketTypeSource,
        displayState: row.displayState,
        readiness: row.readiness ?? null,
        progressStage: row.progressStage,
        repoName: row.repoName,
        dashboardId: row.dashboardId,
        oneshotRunId: row.oneshotRunId ?? 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        durationMs: durationMs(row, nowMs),
        totalCostUsd: row.estimatedCostUsd,
        totalTokens: row.totalTokensUsed,
        costSource: row.costSource,
        modelBreakdown,
        modelValues,
      };
    })
    .sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt));

  const startAt =
    query.range === "all"
      ? null
      : new Date(reportStartMs(query.range, nowMs)).toISOString();

  return {
    generatedAt,
    window: {
      range: query.range,
      label: RANGE_LABELS[query.range],
      ticketType: query.ticketType,
      startAt,
      endAt: generatedAt,
    },
    totals: buildSummary(reportRows),
    modelColumns: modelColumns(reportRows),
    byTicketType: groupedSummary(reportRows, false),
    byTicketTypeAndState: groupedSummary(reportRows, true),
    rows: reportRows,
  };
}

function csvEscape(value: unknown): string {
  if (typeof value === "string") {
    const safeText = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safeText)
      ? `"${safeText.replace(/"/g, '""')}"`
      : safeText;
  }

  const text =
    value === null || value === undefined
      ? ""
      : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderOneShotCostReportCsv(
  report: OneShotCostReport,
): string {
  const columns = [
    ...STABLE_CSV_COLUMNS,
    ...report.modelColumns.flatMap((column) => [
      column.costColumn,
      column.tokensColumn,
    ]),
  ];
  const lines = [columns.map(csvEscape).join(",")];

  for (const row of report.rows) {
    const stableValues: Record<(typeof STABLE_CSV_COLUMNS)[number], unknown> = {
      jira_key: row.jiraKey,
      title: row.title,
      jira_issue_type: row.jiraIssueType,
      ticket_type: row.ticketType,
      ticket_type_source: row.ticketTypeSource,
      display_state: row.displayState,
      readiness: row.readiness,
      progress_stage: row.progressStage,
      repo_name: row.repoName,
      dashboard_id: row.dashboardId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      duration_minutes: roundDuration(row.durationMs / 60_000),
      duration_hours: roundDuration(row.durationMs / HOUR_MS),
      total_cost_usd: roundUsd(row.totalCostUsd),
      total_tokens: row.totalTokens,
      cost_source: row.costSource,
    };
    const dynamicValues = report.modelColumns.flatMap((column) => {
      const value = row.modelValues[column.key];
      return [value?.costUsd ?? 0, value?.tokens ?? 0];
    });
    lines.push(
      [
        ...STABLE_CSV_COLUMNS.map((column) => stableValues[column]),
        ...dynamicValues,
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUsd(value: number): string {
  return `$${roundUsd(value).toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "0m";
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function summaryTable(
  title: string,
  rows: readonly OneShotCostReportSummaryRow[],
  includeState: boolean,
): string {
  const headers = [
    "Ticket Type",
    ...(includeState ? ["State"] : []),
    "Runs",
    "Cost",
    "Tokens",
    "Avg Duration",
    "Median Duration",
    "Cost Source",
  ];
  const body = rows
    .map(
      (row) => `<tr>
        <td>${htmlEscape(row.ticketType)}</td>
        ${includeState ? `<td>${htmlEscape(row.displayState ? STATE_LABELS[row.displayState] : "")}</td>` : ""}
        <td>${row.runCount}</td>
        <td>${htmlEscape(formatUsd(row.totalCostUsd))}</td>
        <td>${row.totalTokens}</td>
        <td>${htmlEscape(formatDuration(row.averageDurationMs))}</td>
        <td>${htmlEscape(formatDuration(row.medianDurationMs))}</td>
        <td>${htmlEscape(row.costSource)}</td>
      </tr>`,
    )
    .join("");

  return `<section>
    <h2>${htmlEscape(title)}</h2>
    <table>
      <thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr></thead>
      <tbody>${body || `<tr><td colspan="${headers.length}">No runs in this window.</td></tr>`}</tbody>
    </table>
  </section>`;
}

export function renderOneShotCostReportHtml(
  report: OneShotCostReport,
): string {
  const modelHeaders = report.modelColumns.flatMap((column) => [
    `${column.label} Cost`,
    `${column.label} Tokens`,
  ]);
  const ticketHeaders = [
    "Jira Key",
    "Title",
    "Jira Issue Type",
    "Ticket Type",
    "State",
    "Readiness",
    "Stage",
    "Repo",
    "Created",
    "Updated",
    "Duration",
    "Total Cost",
    "Total Tokens",
    "Cost Source",
    ...modelHeaders,
  ];
  const ticketRows = report.rows
    .map((row) => {
      const modelCells = report.modelColumns
        .flatMap((column) => {
          const value = row.modelValues[column.key];
          return [
            htmlEscape(formatUsd(value?.costUsd ?? 0)),
            htmlEscape(value?.tokens ?? 0),
          ];
        })
        .map((value) => `<td>${value}</td>`)
        .join("");
      return `<tr>
        <td>${htmlEscape(row.jiraKey)}</td>
        <td>${htmlEscape(row.title)}</td>
        <td>${htmlEscape(row.jiraIssueType)}</td>
        <td>${htmlEscape(row.ticketType)}</td>
        <td>${htmlEscape(STATE_LABELS[row.displayState])}</td>
        <td>${htmlEscape(row.readiness)}</td>
        <td>${htmlEscape(row.progressStage)}</td>
        <td>${htmlEscape(row.repoName)}</td>
        <td>${htmlEscape(row.createdAt)}</td>
        <td>${htmlEscape(row.updatedAt)}</td>
        <td>${htmlEscape(formatDuration(row.durationMs))}</td>
        <td>${htmlEscape(formatUsd(row.totalCostUsd))}</td>
        <td>${row.totalTokens}</td>
        <td>${htmlEscape(row.costSource)}</td>
        ${modelCells}
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>OneShot Cost Report</title>
  <style>
    body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #151515; background: #f7f7f4; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    h2 { margin: 28px 0 10px; font-size: 18px; }
    .meta { color: #555; margin-bottom: 18px; }
    .summary { display: flex; flex-wrap: wrap; gap: 12px; margin: 18px 0 22px; }
    .metric { border: 1px solid #d7d7d0; background: #fff; border-radius: 6px; padding: 10px 12px; min-width: 140px; }
    .metric span { display: block; color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .metric strong { display: block; margin-top: 4px; font-size: 18px; }
    table { border-collapse: collapse; width: 100%; background: #fff; margin-bottom: 18px; }
    th, td { border: 1px solid #d7d7d0; padding: 7px 8px; text-align: left; vertical-align: top; font-size: 12px; }
    th { background: #ecece6; position: sticky; top: 0; z-index: 1; }
    tbody tr:nth-child(even) { background: #fafaf8; }
    .wide { overflow-x: auto; border: 1px solid #d7d7d0; }
    .wide table { margin: 0; }
  </style>
</head>
<body>
  <h1>OneShot Cost Report</h1>
  <div class="meta">
    Generated ${htmlEscape(report.generatedAt)} &middot; ${htmlEscape(report.window.label)} &middot; ticket type ${htmlEscape(report.window.ticketType)}
  </div>
  <div class="summary">
    <div class="metric"><span>Runs</span><strong>${report.totals.runCount}</strong></div>
    <div class="metric"><span>Total Cost</span><strong>${htmlEscape(formatUsd(report.totals.totalCostUsd))}</strong></div>
    <div class="metric"><span>Total Tokens</span><strong>${report.totals.totalTokens}</strong></div>
    <div class="metric"><span>Average Duration</span><strong>${htmlEscape(formatDuration(report.totals.averageDurationMs))}</strong></div>
    <div class="metric"><span>Median Duration</span><strong>${htmlEscape(formatDuration(report.totals.medianDurationMs))}</strong></div>
    <div class="metric"><span>Cost Source</span><strong>${htmlEscape(report.totals.costSource)}</strong></div>
  </div>
  ${summaryTable("By Ticket Type", report.byTicketType, false)}
  ${summaryTable("By Ticket Type and State", report.byTicketTypeAndState, true)}
  <section>
    <h2>Runs</h2>
    <div class="wide">
      <table>
        <thead><tr>${ticketHeaders.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr></thead>
        <tbody>${ticketRows || `<tr><td colspan="${ticketHeaders.length}">No runs in this window.</td></tr>`}</tbody>
      </table>
    </div>
  </section>
</body>
</html>`;
}

export function oneShotCostReportFilename(
  report: OneShotCostReport,
  extension: "csv" | "html",
): string {
  const typePart =
    report.window.ticketType === "all" ? "all-types" : report.window.ticketType;
  return `oneshot-costs-${report.window.range}-${typePart}.${extension}`;
}
