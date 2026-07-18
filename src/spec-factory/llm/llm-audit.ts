import type mysql from "mysql2/promise";
import { getDatabase } from "../../orchestrator/database.js";
import { currentSpecFactoryCorrelation } from "../telemetry/correlation.js";
import type { LlmPurpose } from "./llm-gateway.js";

export type LlmCallAuditPool = Pick<mysql.Pool, "query">;

export type LlmCallAuditStatus = "succeeded" | "failed";
export type LlmPromptLoggingMode = "none" | "redacted" | "full";

export interface LlmCallAuditRecord {
  sessionId?: number | null;
  turnJobId?: number | null;
  agentTaskId?: number | null;
  requestId?: string | null;
  purpose: LlmPurpose;
  provider: "bedrock";
  model: string;
  promptVersion?: string | null;
  contextVersionUsed?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  estimatedCostUsd?: number | null;
  status: LlmCallAuditStatus;
  errorCode?: string | null;
  redactedPromptUri?: string | null;
  redactedResponseUri?: string | null;
}

export interface LlmCallAuditSink {
  recordCall(input: LlmCallAuditRecord): Promise<number>;
}

export interface LlmBudgetUsage {
  sessionCostUsd: number;
  globalDayCostUsd: number;
}

export interface LlmAuditArtifactRetentionCandidate {
  id: number;
  redactedPromptUri: string | null;
  redactedResponseUri: string | null;
}

export interface LlmBudgetStore {
  getBudgetUsage(input: {
    sessionId?: number | null;
    since: Date;
  }): Promise<LlmBudgetUsage>;
}

export interface LlmAuditArtifactRetentionStore {
  listAuditArtifactsForRetention(input: {
    createdBefore: Date;
    limit: number;
  }): Promise<LlmAuditArtifactRetentionCandidate[]>;
  clearAuditArtifactUris(id: number): Promise<number>;
}

export const LLM_AUDIT_ERROR_CODE_MAX_LENGTH = 128;

interface LlmBudgetUsageRow extends mysql.RowDataPacket {
  session_cost_usd: number | string | null;
  global_day_cost_usd: number | string | null;
}

interface LlmAuditArtifactRetentionRow extends mysql.RowDataPacket {
  id: number | string;
  redacted_prompt_uri: string | null;
  redacted_response_uri: string | null;
}

export function resolveLlmPromptLoggingMode(
  raw = process.env.SPEC_FACTORY_LLM_PROMPT_LOGGING,
): LlmPromptLoggingMode {
  const mode = (raw ?? "").trim() || "none";
  if (mode === "none" || mode === "redacted" || mode === "full") {
    return mode;
  }
  throw new Error(`invalid_llm_prompt_logging_mode:${mode}`);
}

export class SpecFactoryLlmCallAuditRepository
  implements LlmCallAuditSink, LlmBudgetStore, LlmAuditArtifactRetentionStore
{
  constructor(
    private readonly pool: LlmCallAuditPool = getDatabase().getPool(),
  ) {}

  async recordCall(input: LlmCallAuditRecord): Promise<number> {
    const inputTokens = optionalInteger(input.inputTokens);
    const outputTokens = optionalInteger(input.outputTokens);
    const totalTokens =
      inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + (outputTokens ?? 0);
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO spec_factory_llm_calls
       (session_id, turn_job_id, agent_task_id, request_id, purpose, provider,
        model, prompt_version, context_version_used, input_tokens,
        output_tokens, total_tokens, latency_ms, estimated_cost_usd, status,
        error_code, redacted_prompt_uri, redacted_response_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId ?? null,
        input.turnJobId ?? null,
        input.agentTaskId ?? null,
        input.requestId ?? currentSpecFactoryCorrelation().requestId ?? null,
        input.purpose,
        input.provider,
        input.model,
        input.promptVersion ?? null,
        input.contextVersionUsed ?? null,
        inputTokens,
        outputTokens,
        totalTokens,
        optionalInteger(input.latencyMs),
        optionalNumber(input.estimatedCostUsd),
        input.status,
        truncateLlmAuditErrorCode(input.errorCode),
        input.redactedPromptUri ?? null,
        input.redactedResponseUri ?? null,
      ],
    );
    return Number(result.insertId);
  }

  async getBudgetUsage(input: {
    sessionId?: number | null;
    since: Date;
  }): Promise<LlmBudgetUsage> {
    const [rows] = await this.pool.query<LlmBudgetUsageRow[]>(
      `SELECT
         COALESCE((
           SELECT SUM(estimated_cost_usd)
           FROM spec_factory_llm_calls
           WHERE session_id = ?
             AND estimated_cost_usd IS NOT NULL
             AND created_at >= ?
         ), 0) AS session_cost_usd,
         COALESCE((
           SELECT SUM(estimated_cost_usd)
           FROM spec_factory_llm_calls
           WHERE estimated_cost_usd IS NOT NULL
             AND created_at >= ?
         ), 0) AS global_day_cost_usd`,
      [input.sessionId ?? null, input.since, input.since],
    );
    const row = rows[0];
    return {
      sessionCostUsd: Number(row?.session_cost_usd ?? 0),
      globalDayCostUsd: Number(row?.global_day_cost_usd ?? 0),
    };
  }

  async listAuditArtifactsForRetention(input: {
    createdBefore: Date;
    limit: number;
  }): Promise<LlmAuditArtifactRetentionCandidate[]> {
    const [rows] = await this.pool.query<LlmAuditArtifactRetentionRow[]>(
      `SELECT id, redacted_prompt_uri, redacted_response_uri
       FROM spec_factory_llm_calls
       WHERE created_at < ?
         AND (redacted_prompt_uri IS NOT NULL OR redacted_response_uri IS NOT NULL)
       ORDER BY id
       LIMIT ?`,
      [input.createdBefore, Math.floor(input.limit)],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      redactedPromptUri: row.redacted_prompt_uri ?? null,
      redactedResponseUri: row.redacted_response_uri ?? null,
    }));
  }

  async clearAuditArtifactUris(id: number): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_llm_calls
       SET redacted_prompt_uri = NULL,
           redacted_response_uri = NULL
       WHERE id = ?`,
      [id],
    );
    return Number(result.affectedRows ?? 0);
  }
}

function optionalInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.floor(value);
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function truncateLlmAuditErrorCode(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return value.slice(0, LLM_AUDIT_ERROR_CODE_MAX_LENGTH);
}
