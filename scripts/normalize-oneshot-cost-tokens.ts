import "dotenv/config";
import { config as loadEnvFile } from "dotenv";
import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { resolveModelPricing } from "../src/oneshot/pricing.js";

export type SourceKind = "artifact" | "event";

type CostMetricRow = mysql.RowDataPacket & {
  source: SourceKind;
  id: number;
  oneshot_run_id: number;
  stage: string | null;
  version: number | string | null;
  revision: boolean | number | string | null;
  reason: string | null;
  provider: string | null;
  model: string | null;
  old_tokens: number | string | null;
  usd: number | string | null;
};

type NormalizedRow = CostMetricRow & {
  oldTokens: number;
  usdNumber: number;
  newTokens: number;
  delta: number;
  blendedUsdPerMillion: number | null;
  status:
    | "normalized"
    | "skipped_unknown_pricing"
    | "skipped_non_positive_cost";
};

const COST_NORMALIZATION_METHOD = "cost_preserving_pricing_blended";

export type RunTokenDeltaRow = {
  source: SourceKind;
  oneshot_run_id: number;
  stage?: string | null;
  version?: number | string | null;
  revision?: boolean | number | string | null;
  reason?: string | null;
  delta: number;
};

const EVENT_ONLY_ATTEMPT_REASONS = new Set([
  "failed_attempt",
  "implementation_disagreed_with_review",
  "planner_failed_attempt",
  "revision_no_changed_files_retry_fresh",
]);

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function rangePredicate(range: string, column: string): string {
  if (range === "all") {
    return "";
  }
  const match = range.match(/^(\d+)d$/);
  if (!match) {
    throw new Error(
      `Unsupported range "${range}". Use 30d, 7d, 24h is not supported here, or all.`,
    );
  }
  return ` AND ${column} >= NOW() - INTERVAL ${Number(match[1])} DAY`;
}

async function fetchRows(
  conn: mysql.Connection,
  range: string,
): Promise<CostMetricRow[]> {
  const artifactRange = rangePredicate(
    range,
    "COALESCE(a.completed_at, a.created_at)",
  );
  const eventRange = rangePredicate(range, "e.occurred_at");
  const [artifactRows] = await conn.query<CostMetricRow[]>(
    `SELECT
       'artifact' AS source,
       a.id,
       a.oneshot_run_id,
       a.stage,
       a.version,
       JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.revision')) AS revision,
       JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.reason')) AS reason,
       a.provider,
       a.model,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS old_tokens,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS usd
     FROM oneshot_artifacts a
     WHERE a.stage IN ('qualification', 'plan', 'review', 'implementation', 'code_review', 'test_result')
       AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_cost_usd')) AS DOUBLE) > 0
       ${artifactRange}
     ORDER BY a.id`,
  );
  const [eventRows] = await conn.query<CostMetricRow[]>(
    `SELECT
       'event' AS source,
       e.id,
       e.oneshot_run_id,
       e.stage,
       JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.version')) AS version,
       JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.revision')) AS revision,
       JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.reason')) AS reason,
       JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.provider')) AS provider,
       JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.model')) AS model,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS old_tokens,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS usd
     FROM oneshot_run_events e
     WHERE e.event_type = 'stage_attempt_metrics'
       AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_cost_usd')) AS DOUBLE) > 0
       ${eventRange}
     ORDER BY e.id`,
  );
  return [...artifactRows, ...eventRows];
}

function normalizeRow(row: CostMetricRow): NormalizedRow {
  const oldTokens = Math.max(finiteNumber(row.old_tokens) ?? 0, 0);
  const usdNumber = Math.max(finiteNumber(row.usd) ?? 0, 0);
  if (usdNumber <= 0) {
    return {
      ...row,
      oldTokens,
      usdNumber,
      newTokens: oldTokens,
      delta: 0,
      blendedUsdPerMillion: null,
      status: "skipped_non_positive_cost",
    };
  }
  const pricing = resolveModelPricing(row.provider, row.model);
  if (!pricing) {
    return {
      ...row,
      oldTokens,
      usdNumber,
      newTokens: oldTokens,
      delta: 0,
      blendedUsdPerMillion: null,
      status: "skipped_unknown_pricing",
    };
  }
  const newTokens = Math.max(
    Math.round((usdNumber / pricing.blendedUsdPerMillion) * 1_000_000),
    0,
  );
  return {
    ...row,
    oldTokens,
    usdNumber,
    newTokens,
    delta: newTokens - oldTokens,
    blendedUsdPerMillion: pricing.blendedUsdPerMillion,
    status: "normalized",
  };
}

function summarize(rows: NormalizedRow[]) {
  const totals = rows.reduce(
    (acc, row) => {
      acc.rows += 1;
      acc.oldTokens += row.oldTokens;
      acc.newTokens += row.newTokens;
      acc.delta += row.delta;
      acc.usd += row.usdNumber;
      if (row.status === "normalized") acc.normalized += 1;
      if (row.status === "skipped_unknown_pricing")
        acc.skippedUnknownPricing += 1;
      if (row.status === "skipped_non_positive_cost")
        acc.skippedNonPositiveCost += 1;
      return acc;
    },
    {
      rows: 0,
      normalized: 0,
      skippedUnknownPricing: 0,
      skippedNonPositiveCost: 0,
      oldTokens: 0,
      newTokens: 0,
      delta: 0,
      usd: 0,
    },
  );
  const byModel = new Map<string, typeof totals>();
  for (const row of rows) {
    const key = `${row.provider ?? "unknown"}:${row.model ?? "unknown"}`;
    const existing = byModel.get(key) ?? {
      rows: 0,
      normalized: 0,
      skippedUnknownPricing: 0,
      skippedNonPositiveCost: 0,
      oldTokens: 0,
      newTokens: 0,
      delta: 0,
      usd: 0,
    };
    existing.rows += 1;
    existing.oldTokens += row.oldTokens;
    existing.newTokens += row.newTokens;
    existing.delta += row.delta;
    existing.usd += row.usdNumber;
    if (row.status === "normalized") existing.normalized += 1;
    if (row.status === "skipped_unknown_pricing")
      existing.skippedUnknownPricing += 1;
    if (row.status === "skipped_non_positive_cost")
      existing.skippedNonPositiveCost += 1;
    byModel.set(key, existing);
  }
  return {
    totals: { ...totals, usd: Number(totals.usd.toFixed(6)) },
    byModel: Array.from(byModel.entries())
      .map(([model, values]) => ({
        model,
        ...values,
        usd: Number(values.usd.toFixed(6)),
      }))
      .sort((a, b) => b.usd - a.usd),
  };
}

function buildPlaceholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

async function fetchRunTokenTotals(
  conn: mysql.Connection,
  runIds: readonly number[],
): Promise<Map<number, number>> {
  if (runIds.length === 0) {
    return new Map();
  }
  const [rows] = await conn.query<
    (mysql.RowDataPacket & {
      id: number;
      total_tokens_used: number | string | null;
    })[]
  >(
    `SELECT id, total_tokens_used
     FROM oneshot_runs
     WHERE id IN (${buildPlaceholders(runIds)})`,
    [...runIds],
  );
  return new Map(
    rows.map((row) => [
      Number(row.id),
      Math.max(finiteNumber(row.total_tokens_used) ?? 0, 0),
    ]),
  );
}

export function buildRunTokenTargets(
  previousRunTotals: ReadonlyMap<number, number>,
  normalizedRows: readonly RunTokenDeltaRow[],
): Map<number, number> {
  const runTokenRows = selectRunTokenDeltaRows(normalizedRows);
  const targets = new Map(previousRunTotals);
  for (const row of runTokenRows) {
    if (row.oneshot_run_id <= 0) {
      continue;
    }
    const previous = targets.get(row.oneshot_run_id) ?? 0;
    targets.set(row.oneshot_run_id, Math.max(previous + row.delta, 0));
  }
  return targets;
}

export function selectRunTokenDeltaRows(
  normalizedRows: readonly RunTokenDeltaRow[],
): RunTokenDeltaRow[] {
  const artifactKeys = new Set(
    normalizedRows
      .filter((row) => row.source === "artifact")
      .map(metricAttemptKey)
      .filter((key): key is string => key !== null),
  );

  return normalizedRows.filter((row) => {
    if (row.source === "artifact") {
      return true;
    }
    if (row.oneshot_run_id <= 0) {
      return false;
    }
    if (isKnownEventOnlyAttempt(row)) {
      return true;
    }
    const key = metricAttemptKey(row);
    return key === null || !artifactKeys.has(key);
  });
}

function isKnownEventOnlyAttempt(row: RunTokenDeltaRow): boolean {
  const reason = row.reason?.trim().toLowerCase();
  return reason ? EVENT_ONLY_ATTEMPT_REASONS.has(reason) : false;
}

function metricAttemptKey(row: RunTokenDeltaRow): string | null {
  if (row.oneshot_run_id <= 0) {
    return null;
  }
  const stage = normalizeAttemptStage(row.stage);
  const version = normalizeAttemptVersion(row.version);
  if (!stage || version === null) {
    return null;
  }
  const revision = normalizeAttemptRevision(row.revision);
  return `${row.oneshot_run_id}:${stage}:${version}:${revision}`;
}

function normalizeAttemptStage(stage: string | null | undefined): string | null {
  const normalized = stage?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "planning") {
    return "plan";
  }
  return normalized;
}

function normalizeAttemptVersion(
  version: number | string | null | undefined,
): string | null {
  if (version === null || version === undefined || version === "") {
    return null;
  }
  const numeric = Number(version);
  if (Number.isFinite(numeric)) {
    return String(numeric);
  }
  return String(version).trim().toLowerCase();
}

function normalizeAttemptRevision(
  revision: boolean | number | string | null | undefined,
): string {
  if (revision === null || revision === undefined || revision === "") {
    return "";
  }
  if (typeof revision === "boolean") {
    return revision ? "true" : "false";
  }
  const normalized = String(revision).trim().toLowerCase();
  if (normalized === "1") {
    return "true";
  }
  if (normalized === "0") {
    return "false";
  }
  return normalized;
}

async function updateMetricRow(
  conn: mysql.Connection,
  row: NormalizedRow,
  appliedAt: string,
): Promise<number> {
  const table =
    row.source === "artifact" ? "oneshot_artifacts" : "oneshot_run_events";
  const [result] = await conn.execute<mysql.ResultSetHeader>(
    `UPDATE ${table}
     SET metadata_json = JSON_SET(
       JSON_INSERT(COALESCE(metadata_json, JSON_OBJECT()), '$.stage_tokens_used_before_cost_normalization', CAST(? AS UNSIGNED)),
       '$.stage_tokens_used', CAST(? AS UNSIGNED),
       '$.token_normalization_method', ?,
       '$.token_normalization_status', 'normalized',
       '$.token_normalization_rate_usd_per_million', ?,
       '$.token_normalization_applied_at', ?
     )
     WHERE id = ?
       AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.stage_tokens_used')) AS UNSIGNED), 0) = ?`,
    [
      row.oldTokens,
      row.newTokens,
      COST_NORMALIZATION_METHOD,
      row.blendedUsdPerMillion,
      appliedAt,
      row.id,
      row.oldTokens,
    ],
  );
  return result.affectedRows;
}

async function markSkippedRow(
  conn: mysql.Connection,
  row: NormalizedRow,
  appliedAt: string,
): Promise<number> {
  const table =
    row.source === "artifact" ? "oneshot_artifacts" : "oneshot_run_events";
  const [result] = await conn.execute<mysql.ResultSetHeader>(
    `UPDATE ${table}
     SET metadata_json = JSON_SET(
       COALESCE(metadata_json, JSON_OBJECT()),
       '$.token_normalization_method', ?,
       '$.token_normalization_status', ?,
       '$.token_normalization_applied_at', ?
     )
     WHERE id = ?`,
    [COST_NORMALIZATION_METHOD, row.status, appliedAt, row.id],
  );
  return result.affectedRows;
}

async function applyRows(conn: mysql.Connection, rows: NormalizedRow[]) {
  const appliedAt = new Date().toISOString();
  const normalizedRows = rows.filter((row) => row.status === "normalized");
  const runTokenRows = selectRunTokenDeltaRows(normalizedRows);
  const skippedRows = rows.filter(
    (row) => row.status === "skipped_unknown_pricing",
  );
  const runIds = Array.from(
    new Set(
      runTokenRows
        .filter((row) => row.oneshot_run_id > 0)
        .map((row) => row.oneshot_run_id),
    ),
  ).sort((a, b) => a - b);

  await conn.beginTransaction();
  try {
    const previousRunTotals = await fetchRunTokenTotals(conn, runIds);
    if (previousRunTotals.size !== runIds.length) {
      throw new Error(
        `Found ${previousRunTotals.size} runs, expected ${runIds.length}`,
      );
    }

    let metricUpdates = 0;
    let skippedUpdates = 0;
    for (const row of normalizedRows) {
      metricUpdates += await updateMetricRow(conn, row, appliedAt);
    }
    if (metricUpdates !== normalizedRows.length) {
      throw new Error(
        `Updated ${metricUpdates} normalized rows, expected ${normalizedRows.length}`,
      );
    }
    for (const row of skippedRows) {
      skippedUpdates += await markSkippedRow(conn, row, appliedAt);
    }

    const runTokenTargets = buildRunTokenTargets(
      previousRunTotals,
      runTokenRows,
    );
    if (runTokenTargets.size !== runIds.length) {
      throw new Error(
        `Computed ${runTokenTargets.size} run token totals, expected ${runIds.length}`,
      );
    }
    let runUpdateAttempts = 0;
    for (const [runId, totalTokens] of runTokenTargets.entries()) {
      await conn.execute<mysql.ResultSetHeader>(
        `UPDATE oneshot_runs
         SET total_tokens_used = ?
         WHERE id = ?`,
        [totalTokens, runId],
      );
      runUpdateAttempts += 1;
    }
    const updatedRunTotals = await fetchRunTokenTotals(conn, runIds);
    for (const [runId, expectedTokens] of runTokenTargets.entries()) {
      const actualTokens = updatedRunTotals.get(runId);
      if (actualTokens !== expectedTokens) {
        throw new Error(
          `Run ${runId} total_tokens_used is ${actualTokens}, expected ${expectedTokens}`,
        );
      }
    }

    await conn.commit();
    return {
      appliedAt,
      metricUpdates,
      skippedUpdates,
      runUpdateAttempts,
      runTotalSync: Object.fromEntries(
        Array.from(runTokenTargets.entries())
          .sort(([a], [b]) => a - b)
          .map(([runId, newTokens]) => [
            runId,
            {
              oldTokens: previousRunTotals.get(runId) ?? 0,
              newTokens,
              delta: newTokens - (previousRunTotals.get(runId) ?? 0),
            },
          ]),
      ),
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

async function main() {
  const envPath = readArg("env");
  if (envPath) {
    loadEnvFile({ path: envPath });
  }
  const range = readArg("range") ?? "30d";
  const apply = hasFlag("apply");
  const host =
    process.env.LOCAL_TUNNEL_HOST || process.env.DB_HOST || "127.0.0.1";
  const port = Number(
    process.env.LOCAL_TUNNEL_PORT || process.env.DB_PORT || 3306,
  );
  const user = process.env.DB_USERNAME || process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;
  if (!user || !password || !database) {
    throw new Error("Missing DB_USERNAME/DB_USER, DB_PASSWORD, or DB_NAME");
  }

  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
  });
  try {
    const rows = (await fetchRows(conn, range)).map(normalizeRow);
    const summary = summarize(rows);
    const result = apply ? await applyRows(conn, rows) : null;
    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          range,
          method: COST_NORMALIZATION_METHOD,
          summary,
          sampleChanges: rows
            .filter((row) => row.status === "normalized" && row.delta !== 0)
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
            .slice(0, 25)
            .map((row) => ({
              source: row.source,
              id: row.id,
              runId: row.oneshot_run_id,
              stage: row.stage,
              provider: row.provider,
              model: row.model,
              costUsd: Number(row.usdNumber.toFixed(6)),
              rateUsdPerMillion: row.blendedUsdPerMillion,
              oldTokens: row.oldTokens,
              newTokens: row.newTokens,
              delta: row.delta,
            })),
          skippedUnknownPricing: rows
            .filter((row) => row.status === "skipped_unknown_pricing")
            .map((row) => ({
              source: row.source,
              id: row.id,
              runId: row.oneshot_run_id,
              stage: row.stage,
              provider: row.provider,
              model: row.model,
              costUsd: Number(row.usdNumber.toFixed(6)),
              oldTokens: row.oldTokens,
            })),
          result,
        },
        null,
        2,
      ),
    );
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
