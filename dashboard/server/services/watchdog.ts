import type mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { getPool, query } from "../db.js";
import { WatchdogServiceError } from "./watchdogErrors.js";
import {
  getWatchdogEvidencePayload as downloadWatchdogEvidencePayload,
} from "./watchdogEvidenceStore.js";
import { getWatchdogLlmConfig, runWatchdogBedrockJson } from "./watchdogLlmProvider.js";
import { callWatchdogMcpTool, ensureWatchdogMcpReady, getWatchdogMcpStatus } from "./watchdogMcpClient.js";
import type {
  CreateWatchdogSessionInput,
  WatchdogInvestigationScope,
  WatchdogFinding,
  WatchdogMode,
  WatchdogOperatorIdentity,
  WatchdogRunAttempt,
  WatchdogRunStatus,
  WatchdogRunTrigger,
  WatchdogServerEvent,
  WatchdogSession,
  WatchdogSessionStatus,
} from "../types/watchdog.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SSE_REPLAY_HOURS = Number(process.env.WATCHDOG_SSE_REPLAY_HOURS || "24");

type JsonColumn = string | Record<string, unknown> | unknown[] | null;

type WatchdogMcpHealthcheck = {
  status?: string;
  aws?: {
    auth_mode?: string;
    account_id?: string;
    profile?: string;
  };
};

type WatchdogNaturalLanguageLlmControls = {
  interpretedIntent?: string;
  clientId?: string;
  environment?: string;
  serviceIds?: string[];
  includeKeywords?: string[];
  excludeKeywords?: string[];
  timeWindowHours?: number;
  confidence?: number;
  needsReview?: boolean;
  reasoning?: string;
};

const WATCHDOG_NATURAL_LANGUAGE_PREVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "interpretedIntent",
    "clientId",
    "environment",
    "serviceIds",
    "includeKeywords",
    "excludeKeywords",
    "timeWindowHours",
    "confidence",
    "needsReview",
    "reasoning",
  ],
  properties: {
    interpretedIntent: { type: "string", maxLength: 240 },
    clientId: { type: "string", maxLength: 80 },
    environment: { type: "string", maxLength: 80 },
    serviceIds: {
      type: "array",
      maxItems: 6,
      items: { type: "string", maxLength: 120 },
    },
    includeKeywords: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 80 },
    },
    excludeKeywords: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 80 },
    },
    timeWindowHours: { type: "number", minimum: 1, maximum: 24 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    needsReview: { type: "boolean" },
    reasoning: { type: "string", maxLength: 360 },
  },
} satisfies Record<string, unknown>;

type WatchdogSessionRow = mysql.RowDataPacket & {
  id: string;
  title: string;
  mode: WatchdogMode;
  status: WatchdogSessionStatus;
  owner_id: string;
  owner_display: string;
  auth_source: "alb_oidc" | "local_dev";
  jira_key: string | null;
  natural_language_prompt: string | null;
  approved_scope: JsonColumn;
  draft_scope: JsonColumn;
  created_at: Date | string;
  updated_at: Date | string;
  run_attempt_id: string | null;
  attempt_number: number | null;
  trigger_cause: WatchdogRunTrigger | null;
  run_status: WatchdogRunStatus | null;
  correlation_id: string | null;
  run_approved_scope: JsonColumn;
  provider_key: string | null;
  model_id: string | null;
  run_created_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

type WatchdogEventRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  run_attempt_id: string | null;
  correlation_id: string;
  event_type: string;
  sequence: number;
  payload_json: JsonColumn;
  created_at: Date | string;
};

type WatchdogDarciHandoffRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  run_attempt_id: string;
  finding_ids: JsonColumn;
  requested_by: string;
  requested_by_display: string;
  status: string;
  task_management_id: number | null;
  task_id: number | null;
  task_s3_bucket: string | null;
  task_s3_key: string | null;
  result_s3_bucket: string | null;
  result_s3_key: string | null;
  result_artifact_id: string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type WatchdogFindingRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  run_attempt_id: string;
  kind: WatchdogFinding["kind"];
  severity: WatchdogFinding["severity"];
  title: string;
  summary: string;
  details: JsonColumn;
  confidence: number | null;
  evidence_ids: JsonColumn;
  created_at: Date | string;
};

type WatchdogClarificationRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  run_attempt_id: string;
  status: "open" | "answered" | "expired";
  question: string;
  choices: JsonColumn;
  context_json: JsonColumn;
  answer_json: JsonColumn;
  answered_by: string | null;
  answered_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
};

type WatchdogEvidenceRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  run_attempt_id: string;
  kind: string;
  title: string;
  summary: string | null;
  source_tool: string;
  source_ref_json: JsonColumn;
  time_window: JsonColumn;
  s3_bucket: string | null;
  s3_key: string | null;
  sha256: string | null;
  byte_count: number | null;
  created_at: Date | string;
  expires_at: Date | string | null;
};

export { WatchdogServiceError } from "./watchdogErrors.js";

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: JsonColumn): T | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

function stringifyJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function normalizeLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function normalizeOffset(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function defaultTimeWindow(hours = 3) {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return {
    startTs: start.toISOString(),
    endTs: end.toISOString(),
    sourceHint: `last ${hours} hours`,
  };
}

function configuredStorage() {
  const bucketPrefix = process.env.S3_BUCKET_PREFIX || "specter";
  const evidenceBucket =
    process.env.WATCHDOG_EVIDENCE_BUCKET ||
    `${bucketPrefix}-watchdog-evidence`;
  const resultBucket =
    process.env.WATCHDOG_RESULT_BUCKET ||
    process.env.S3_RESULT_BUCKET ||
    `${bucketPrefix}-results`;
  const region =
    process.env.WATCHDOG_EVIDENCE_REGION ||
    process.env.WATCHDOG_DARCI_TASK_REGION ||
    process.env.S3_TASK_REGION ||
    process.env.S3_REGION ||
    process.env.AWS_REGION ||
    "us-east-2";
  return {
    evidenceBucket: evidenceBucket.split(/\s+#/)[0].trim(),
    resultBucket: resultBucket.split(/\s+#/)[0].trim(),
    region,
  };
}

function titleFromInput(input: CreateWatchdogSessionInput): string {
  if (input.mode === "jira" && input.jiraKey) {
    return `${input.jiraKey} Watchdog investigation`;
  }
  if (input.mode === "natural_language" && input.naturalLanguagePrompt) {
    return input.naturalLanguagePrompt.slice(0, 120);
  }
  const scope = input.draftScope;
  if (scope) {
    return `${scope.clientId} ${scope.environment} ${scope.serviceIds.join(", ")} investigation`;
  }
  return "Manual Watchdog investigation";
}

function assertScope(scope: unknown): asserts scope is WatchdogInvestigationScope {
  const candidate = scope as Partial<WatchdogInvestigationScope> | undefined;
  if (
    !candidate ||
    typeof candidate.clientId !== "string" ||
    typeof candidate.environment !== "string" ||
    !Array.isArray(candidate.serviceIds) ||
    candidate.serviceIds.length === 0 ||
    !candidate.timeWindow ||
    typeof candidate.timeWindow.startTs !== "string" ||
    typeof candidate.timeWindow.endTs !== "string" ||
    !Array.isArray(candidate.includeKeywords) ||
    !Array.isArray(candidate.excludeKeywords)
  ) {
    throw new WatchdogServiceError("A complete investigation scope is required", 400, "scope_invalid");
  }
}

function sourceEnvironment(source: Record<string, unknown>): string | undefined {
  return typeof source.environment === "string" ? source.environment.toUpperCase() : undefined;
}

function sourceComponent(source: Record<string, unknown>): string {
  return typeof source.component === "string" ? source.component : "";
}

function serviceMatches(source: Record<string, unknown>, serviceIds: string[]) {
  const component = sourceComponent(source).toLowerCase();
  return serviceIds.length === 0 || serviceIds.some((service) => {
    const needle = service.toLowerCase();
    return component === needle || component.startsWith(`${needle}/`) || component.includes(needle);
  });
}

function rankEnvironmentAlias(requested: string, candidate: string) {
  if (candidate === requested) return 0;
  if (requested === "PROD" && /^PROD\d+$/.test(candidate)) return Number(candidate.replace("PROD", "")) || 1;
  if (requested === "UAT" && /^UAT\d+$/.test(candidate)) return Number(candidate.replace("UAT", "")) || 1;
  if (requested === "CONFIG" && /^CONFIG\d+$/.test(candidate)) return Number(candidate.replace("CONFIG", "")) || 1;
  if (requested === "STAGE" && /^STAGE\d+$/.test(candidate)) return Number(candidate.replace("STAGE", "")) || 1;
  return Number.POSITIVE_INFINITY;
}

async function resolveScopeEnvironment(scope: WatchdogInvestigationScope): Promise<WatchdogInvestigationScope> {
  const requested = scope.environment.trim().toUpperCase();
  const allSources = await listWatchdogCatalogLogSources({ clientCode: scope.clientId }).catch(() => undefined);
  const sources = allSources?.sources || [];
  if (sources.length === 0) return { ...scope, environment: requested };

  const exactMatches = sources.filter((source) => sourceEnvironment(source) === requested && serviceMatches(source, scope.serviceIds));
  if (exactMatches.length > 0) return { ...scope, environment: requested };

  const candidates = Array.from(new Set(
    sources
      .filter((source) => serviceMatches(source, scope.serviceIds))
      .map(sourceEnvironment)
      .filter((value): value is string => Boolean(value)),
  ))
    .map((environment) => ({ environment, rank: rankEnvironmentAlias(requested, environment) }))
    .filter((candidate) => Number.isFinite(candidate.rank))
    .sort((left, right) => left.rank - right.rank || left.environment.localeCompare(right.environment));

  if (candidates.length === 0) return { ...scope, environment: requested };
  const best = candidates[0];
  const tiedBest = candidates.filter((candidate) => candidate.rank === best.rank);
  if (tiedBest.length > 1) return { ...scope, environment: requested };
  return {
    ...scope,
    environment: best.environment,
    advancedFilters: {
      ...(scope.advancedFilters || {}),
      environmentAlias: {
        requested,
        resolved: best.environment,
        reason: "catalog_environment_alias",
      },
    },
  };
}

function normalizeSession(row: WatchdogSessionRow): WatchdogSession {
  const latestRunAttempt = row.run_attempt_id && row.trigger_cause && row.run_status && row.correlation_id
    ? {
      id: row.run_attempt_id,
      sessionId: row.id,
      attemptNumber: Number(row.attempt_number || 1),
      trigger: row.trigger_cause,
      status: row.run_status,
      correlationId: row.correlation_id,
      approvedScope: parseJson<WatchdogInvestigationScope>(row.run_approved_scope),
      providerKey: row.provider_key || undefined,
      modelId: row.model_id || undefined,
      createdAt: iso(row.run_created_at) || iso(row.created_at) || new Date().toISOString(),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
    } satisfies WatchdogRunAttempt
    : undefined;

  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    owner: { id: row.owner_id, display: row.owner_display },
    authSource: row.auth_source,
    jiraKey: row.jira_key || undefined,
    naturalLanguagePrompt: row.natural_language_prompt || undefined,
    draftScope: parseJson<WatchdogInvestigationScope>(row.draft_scope),
    approvedScope: parseJson<WatchdogInvestigationScope>(row.approved_scope),
    latestRunAttempt,
    createdAt: iso(row.created_at) || new Date().toISOString(),
    updatedAt: iso(row.updated_at) || new Date().toISOString(),
  };
}

function normalizeEvent(row: WatchdogEventRow): WatchdogServerEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    runAttemptId: row.run_attempt_id || undefined,
    correlationId: row.correlation_id,
    eventType: row.event_type,
    sequence: Number(row.sequence),
    createdAt: iso(row.created_at) || new Date().toISOString(),
    payload: parseJson<Record<string, unknown>>(row.payload_json) || {},
  };
}

function normalizeFinding(row: WatchdogFindingRow): WatchdogFinding {
  return {
    id: row.id,
    sessionId: row.session_id,
    runAttemptId: row.run_attempt_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    summary: row.summary,
    details: parseJson<Record<string, unknown>>(row.details) || undefined,
    confidence: row.confidence === null || row.confidence === undefined ? undefined : Number(row.confidence),
    evidenceIds: parseJson<string[]>(row.evidence_ids) || [],
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

function normalizeDarciHandoff(row: WatchdogDarciHandoffRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    runAttemptId: row.run_attempt_id,
    findingIds: parseJson<string[]>(row.finding_ids) || [],
    requestedBy: row.requested_by,
    requestedByDisplay: row.requested_by_display,
    status: row.status,
    taskManagementId: row.task_management_id ?? undefined,
    taskId: row.task_id ?? undefined,
    taskS3Bucket: row.task_s3_bucket || undefined,
    taskS3Key: row.task_s3_key || undefined,
    resultS3Bucket: row.result_s3_bucket || undefined,
    resultS3Key: row.result_s3_key || undefined,
    resultArtifactId: row.result_artifact_id || undefined,
    errorMessage: row.error_message || undefined,
    createdAt: iso(row.created_at) || new Date().toISOString(),
    updatedAt: iso(row.updated_at) || new Date().toISOString(),
  };
}

function normalizeClarification(row: WatchdogClarificationRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    runAttemptId: row.run_attempt_id,
    status: row.status,
    question: row.question,
    choices: parseJson<unknown[]>(row.choices) || [],
    context: parseJson<Record<string, unknown>>(row.context_json) || {},
    answer: parseJson<Record<string, unknown>>(row.answer_json) || undefined,
    answeredBy: row.answered_by || undefined,
    answeredAt: iso(row.answered_at),
    expiresAt: iso(row.expires_at) || new Date().toISOString(),
    createdAt: iso(row.created_at) || new Date().toISOString(),
  };
}

export async function appendWatchdogAuditEvent(input: {
  sessionId?: string;
  runAttemptId?: string;
  correlationId?: string;
  actorId: string;
  actorType?: "operator" | "system" | "agent_runtime" | "mcp";
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  const auditDays = Math.max(1, Number(process.env.WATCHDOG_AUDIT_RETENTION_DAYS || "7"));
  await getPool().execute(
    `
      INSERT INTO watchdog_audit_events (
        id, session_id, run_attempt_id, correlation_id, actor_id, actor_type,
        event_type, payload_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? DAY))
    `,
    [
      makeId("wdg_audit"),
      input.sessionId || null,
      input.runAttemptId || null,
      input.correlationId || makeId("wdg_corr"),
      input.actorId,
      input.actorType || "operator",
      input.eventType,
      stringifyJson(input.payload || {}),
      auditDays,
    ],
  );
}

async function assertOperatorRunCapacity(operator: WatchdogOperatorIdentity, excludeSessionId?: string) {
  const maxActive = Math.max(1, Number(process.env.WATCHDOG_MAX_ACTIVE_RUNS_PER_OPERATOR || "3"));
  const rows = await query<mysql.RowDataPacket & { active_runs: number }>(
    `
      SELECT COUNT(*) AS active_runs
      FROM watchdog_sessions
      WHERE owner_id = ?
        AND status IN ('queued', 'running', 'awaiting_user_input')
        AND (? IS NULL OR id <> ?)
    `,
    [operator.id, excludeSessionId || null, excludeSessionId || null],
  );
  const activeRuns = Number(rows[0]?.active_runs || 0);
  if (activeRuns >= maxActive) {
    throw new WatchdogServiceError(
      `Operator ${operator.display} already has ${activeRuns} active Watchdog run(s); limit is ${maxActive}`,
      429,
      "operator_active_run_limit",
    );
  }
}

export function previewNaturalLanguageIntent(
  prompt: string,
  catalogClients: string[] = [],
  catalogEnvironments: string[] = [],
) {
  const normalized = prompt.trim();
  if (normalized.length < 5) {
    throw new WatchdogServiceError("prompt must be at least 5 characters", 400, "prompt_too_short");
  }

  const clientResolution = clientFromText(normalized, catalogClients);
  const environmentResolution = environmentFromText(normalized, catalogEnvironments, [clientResolution.clientId]);

  return {
    prompt: normalized,
    interpretedIntent: normalized,
    suggestedScope: {
      clientId: clientResolution.clientId,
      environment: environmentResolution.environment,
      serviceIds: servicesFromText(normalized),
      timeWindow: defaultTimeWindow(hoursFromText(normalized)),
      includeKeywords: keywordsFromText(normalized),
      excludeKeywords: [],
    },
    suggestions: {
      source: "natural_language",
      confidence: clientResolution.clientId ? 0.72 : 0.35,
      clientCandidates: clientResolution.candidates,
      environmentCandidates: environmentResolution.candidates,
    },
    ambiguities: [
      ...(clientResolution.clientId ? [] : ["client"]),
      ...(environmentResolution.ambiguous ? ["environment"] : []),
    ],
  };
}

export async function previewNaturalLanguageIntentWithLlm(
  prompt: string,
  catalogClients: string[] = [],
  catalogEnvironments: string[] = [],
) {
  const fallback = previewNaturalLanguageIntent(prompt, catalogClients, catalogEnvironments);
  const normalized = fallback.prompt;
  const llm = await runWatchdogBedrockJson<WatchdogNaturalLanguageLlmControls>({
    maxTokens: 900,
    timeoutMs: Number(process.env.WATCHDOG_PREVIEW_LLM_TIMEOUT_MS || "20000"),
    schema: WATCHDOG_NATURAL_LANGUAGE_PREVIEW_SCHEMA,
    systemPrompt: [
      "You convert a Watchdog log-investigation request into UI controls.",
      "Return only structured JSON matching the provided schema.",
      "Use clientId only from catalogClients. If no exact/obvious client is present, return an empty clientId and needsReview=true.",
      "Use environment only from catalogEnvironments when provided. If the prompt uses shorthand and exactly one catalog environment matches, choose it.",
      "Normalize services to log-source selectors such as core, cas, batch, batch/CorrespondenceUtility.",
      "Generate includeKeywords from the user's actual investigation intent, not a generic default.",
      "Do not include error unless the user asks for errors, failures, exceptions, or similar fault signals.",
      "For health/status/running prompts, include component and lifecycle/status terms likely to appear in logs.",
      "Example: 'check if Opensearch is running in Medhok RUD1 core-app' should include opensearch plus running/start/health style keywords, not only error.",
      "Keep keywords short, literal, and useful for CloudWatch text search.",
    ].join("\n"),
    userPrompt: JSON.stringify({
      prompt: normalized,
      catalogClients: catalogClients.map((value) => value.trim().toUpperCase()).filter(Boolean).sort(),
      catalogEnvironments: catalogEnvironments.map((value) => value.trim().toUpperCase()).filter(Boolean).sort(),
      defaultTimeWindowHours: hoursFromText(normalized),
      allowedServices: ["core", "cas", "batch", "batch/CorrespondenceUtility"],
    }),
  });

  const parsed = llm.parsed;
  const clientId = normalizeCatalogValue(parsed.clientId, catalogClients) || fallback.suggestedScope.clientId;
  const environment = normalizeCatalogValue(parsed.environment, catalogEnvironments)
    || (!catalogEnvironments.length ? normalizeEnvironmentValue(parsed.environment) : "")
    || fallback.suggestedScope.environment;
  const serviceIds = sanitizeServiceIds(parsed.serviceIds);
  const includeKeywords = sanitizeStringList(parsed.includeKeywords, 8);
  const excludeKeywords = sanitizeStringList(parsed.excludeKeywords, 8);
  const timeWindowHours = clampHours(parsed.timeWindowHours, hoursFromText(normalized));
  const confidence = typeof parsed.confidence === "number"
    ? Math.min(Math.max(parsed.confidence, 0), 1)
    : fallback.suggestions.confidence;

  return {
    prompt: normalized,
    interpretedIntent: parsed.interpretedIntent?.trim() || fallback.interpretedIntent,
    suggestedScope: {
      clientId,
      environment,
      serviceIds: serviceIds.length > 0 ? serviceIds : fallback.suggestedScope.serviceIds,
      timeWindow: defaultTimeWindow(timeWindowHours),
      includeKeywords: includeKeywords.length > 0 ? includeKeywords : fallback.suggestedScope.includeKeywords,
      excludeKeywords,
    },
    suggestions: {
      source: "natural_language_llm",
      confidence,
      clientCandidates: fallback.suggestions.clientCandidates,
      environmentCandidates: fallback.suggestions.environmentCandidates,
      reasoning: parsed.reasoning,
      modelId: llm.modelId,
      needsReview: parsed.needsReview,
    },
    ambiguities: [
      ...(clientId ? [] : ["client"]),
      ...(environment ? [] : ["environment"]),
      ...(parsed.needsReview ? ["review"] : []),
    ],
  };
}

const CLIENT_ALIAS_OVERRIDES: Array<{ clientId: string; aliases: string[] }> = [
  { clientId: "AETNA", aliases: ["AETNA"] },
  { clientId: "CIGNA", aliases: ["CIGNA"] },
  { clientId: "CVS", aliases: ["CVS"] },
  { clientId: "GATEWAY", aliases: ["GATEWAY"] },
  { clientId: "MEDHOK", aliases: ["MEDHOK", "MED HOK", "MHK"] },
  { clientId: "SCAN", aliases: ["SCAN"] },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(text: string, token: string): boolean {
  return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(token).replace(/\s+/g, "\\s+")}([^A-Z0-9]|$)`, "i").test(text);
}

function clientFromText(text: string, catalogClients: string[] = []): { clientId: string; candidates: string[] } {
  const catalogEntries = catalogClients
    .map((client) => client.trim().toUpperCase())
    .filter(Boolean)
    .map((clientId) => ({ clientId, aliases: [clientId] }));
  const aliasesByClient = [...catalogEntries, ...CLIENT_ALIAS_OVERRIDES]
    .reduce((acc, entry) => {
      const existing = acc.get(entry.clientId) || new Set<string>();
      entry.aliases.forEach((alias) => existing.add(alias.toUpperCase()));
      acc.set(entry.clientId, existing);
      return acc;
    }, new Map<string, Set<string>>());

  const candidates = [...aliasesByClient.entries()]
    .filter(([, aliases]) => [...aliases].some((alias) => containsToken(text, alias)))
    .map(([clientId]) => clientId)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));

  if (candidates.length === 1) {
    return { clientId: candidates[0], candidates };
  }
  return { clientId: "", candidates };
}

function hoursFromText(text: string): number {
  const match = text.match(/\b(?:last|past)\s+(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\b/i);
  if (match?.[1]) {
    return Math.min(Math.max(Number(match[1]), 1), 24);
  }
  if (/\b(?:last|past)\s+(?:an?\s+)?hour\b/i.test(text)) return 1;
  if (/\btoday\b/i.test(text)) return 12;
  return 3;
}

function servicesFromText(text: string): string[] {
  const upper = text.toUpperCase();
  const services = [
    /\bCORE\b/.test(upper) ? "core" : null,
    /\bCAS\b/.test(upper) ? "cas" : null,
    /\bBATCH\b/.test(upper) ? "batch" : null,
    /\bCORRESPONDENCE\b/.test(upper) ? "batch/CorrespondenceUtility" : null,
  ].filter((value): value is string => Boolean(value));
  return services.length > 0 ? Array.from(new Set(services)) : ["core"];
}

function sanitizeStringList(values: unknown, maxItems: number): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => value.slice(0, 80)),
  )).slice(0, maxItems);
}

function normalizeServiceId(value: string): string {
  const normalized = value.trim();
  const upper = normalized.toUpperCase();
  if (!normalized) return "";
  if (upper === "CORE" || upper === "CORE-APP" || upper === "CORE APP") return "core";
  if (upper === "CAS") return "cas";
  if (upper === "BATCH") return "batch";
  if (upper.includes("CORRESPONDENCE")) return "batch/CorrespondenceUtility";
  return normalized;
}

function sanitizeServiceIds(values: unknown): string[] {
  return Array.from(new Set(sanitizeStringList(values, 6).map(normalizeServiceId).filter(Boolean)));
}

function normalizeCatalogValue(value: unknown, catalogValues: string[]): string {
  if (typeof value !== "string" || !value.trim() || catalogValues.length === 0) return "";
  const requested = value.trim().toUpperCase();
  const catalog = catalogValues.map((item) => item.trim()).filter(Boolean);
  return catalog.find((item) => item.toUpperCase() === requested) || "";
}

function normalizeEnvironmentValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function clampHours(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), 1), 24);
}

function keywordsFromText(text: string): string[] {
  const upper = text.toUpperCase();
  const keywords = [
    upper.includes("AUTH") ? "auth" : null,
    upper.includes("OPENSEARCH") || upper.includes("OPEN SEARCH") ? "opensearch" : null,
    upper.includes("ELASTICSEARCH") || upper.includes("ELASTIC SEARCH") ? "elasticsearch" : null,
    upper.includes("ERROR") || upper.includes("ERRORS") ? "error" : null,
    upper.includes("TIMEOUT") ? "timeout" : null,
    upper.includes("EXCEPTION") ? "exception" : null,
    upper.includes("FAIL") || upper.includes("FAILED") ? "fail" : null,
    upper.includes("STARTUP") || upper.includes("START UP") || upper.includes("BOOT") ? "startup" : null,
    upper.includes("RESTART") ? "restart" : null,
    /\bRUNNING\b|\bRUN\b|\bUP\b/.test(upper) ? "running" : null,
    /\bSTARTED\b|\bSTART\b/.test(upper) ? "started" : null,
    /\bHEALTH\b|\bHEALTHY\b|\bSTATUS\b/.test(upper) ? "health" : null,
    /\bDOWN\b|\bSTOPPED\b|\bUNAVAILABLE\b|\bNOT\s+RUNNING\b/.test(upper) ? "down" : null,
    /\bCONNECT(?:ED|ION|IVITY)?\b/.test(upper) ? "connection" : null,
  ].filter((value): value is string => Boolean(value));
  return keywords.length > 0 ? Array.from(new Set(keywords)) : ["error"];
}

function environmentFromText(
  text: string,
  catalogEnvironments: string[] = [],
  ignoredShorthandTerms: string[] = [],
): { environment: string; candidates: string[]; ambiguous: boolean } {
  const upper = text.toUpperCase();
  const ignoredTerms = new Set(ignoredShorthandTerms.map((value) => value.trim().toUpperCase()).filter(Boolean));
  const environments = Array.from(new Set(catalogEnvironments.map((value) => value.trim().toUpperCase()).filter(Boolean)))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const exactCatalogMatches = environments.filter((environment) => containsToken(text, environment));
  if (exactCatalogMatches.length === 1) {
    return { environment: exactCatalogMatches[0], candidates: exactCatalogMatches, ambiguous: false };
  }
  if (exactCatalogMatches.length > 1) {
    return { environment: "", candidates: exactCatalogMatches, ambiguous: true };
  }

  const shorthandMatches = environments.filter((environment) => {
    const shorthand = environment.replace(/\d+$/, "");
    return shorthand !== environment && shorthand.length >= 2 && !ignoredTerms.has(shorthand) && containsToken(text, shorthand);
  });
  if (shorthandMatches.length === 1) {
    return { environment: shorthandMatches[0], candidates: shorthandMatches, ambiguous: false };
  }
  if (shorthandMatches.length > 1) {
    return { environment: "", candidates: shorthandMatches, ambiguous: true };
  }

  const explicitEnvironment = upper.match(
    /\b(PROD1-EAST1|PROD1|QAM\d+|QA\d+|UAT\d*|STAGE\d*|CONFIG\d*|PERF\d+|MEDHOK\d+|MA\d+|RUD\d+|PROD)\b/,
  )?.[1];
  if (explicitEnvironment) return { environment: explicitEnvironment, candidates: [explicitEnvironment], ambiguous: false };
  if (upper.includes("UAT")) return { environment: "UAT", candidates: ["UAT"], ambiguous: false };
  if (upper.includes("STAGE")) return { environment: "STAGE", candidates: ["STAGE"], ambiguous: false };
  if (upper.includes("CONFIG")) return { environment: "CONFIG", candidates: ["CONFIG"], ambiguous: false };
  return { environment: "PROD", candidates: ["PROD"], ambiguous: false };
}

export async function previewJiraTicket(jiraKey: string) {
  const key = jiraKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    throw new WatchdogServiceError("jiraKey must look like CPSUP-12345", 400, "jira_key_invalid");
  }

  try {
    const ticketResponse = await callWatchdogMcpTool<{
      status?: string;
      message?: string;
      ticket?: {
        issue_key?: string;
        summary?: string;
        description?: string;
        status?: string;
        priority?: string;
        issue_type?: string;
        created_at?: string;
        updated_at?: string;
      };
    }>("jira_get_ticket", { issue_key: key });
    if (ticketResponse.status === "ok" && ticketResponse.ticket) {
      const ticket = ticketResponse.ticket;
      const text = `${ticket.summary || ""}\n${ticket.description || ""}`;
      const resolution = await callWatchdogMcpTool<{
        status?: string;
        candidates?: Array<{ client_code?: string; confidence?: number }>;
      }>("resolve_client_from_text", { text, manual_hints: [] }).catch(() => undefined);
      const candidate = resolution?.candidates?.[0];
      return {
        ticket: {
          key,
          summary: ticket.summary || key,
          status: ticket.status || "unknown",
          synopsis: ticket.description ? ticket.description.slice(0, 600) : "Jira ticket fetched successfully.",
          priority: ticket.priority,
          issueType: ticket.issue_type,
          createdAt: ticket.created_at,
          updatedAt: ticket.updated_at,
        },
        suggestedScope: {
          clientId: candidate?.client_code || "",
          environment: environmentFromText(text).environment,
          serviceIds: ["core"],
          timeWindow: defaultTimeWindow(),
          includeKeywords: keywordsFromText(text),
          excludeKeywords: [],
        },
        suggestions: {
          source: "jira_mcp",
          confidence: candidate?.confidence ?? 0,
          needsReview: !candidate?.client_code,
        },
      };
    }

    return {
      ticket: {
        key,
        summary: `${key} could not be fetched from Jira`,
        status: ticketResponse.status || "integration_unavailable",
        synopsis: ticketResponse.message || "Jira is unavailable. Continue by filling controls manually.",
      },
      suggestedScope: {
        clientId: "",
        environment: "PROD",
        serviceIds: ["core"],
        timeWindow: defaultTimeWindow(),
        includeKeywords: ["error"],
        excludeKeywords: [],
      },
      suggestions: {
        source: "jira_mcp",
        needsReview: true,
        fallback: "manual_mode",
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ticket: {
        key,
        summary: `${key} preview unavailable`,
        status: "integration_unavailable",
        synopsis: `${message}. Continue by filling controls manually.`,
      },
      suggestedScope: {
        clientId: "",
        environment: "PROD",
        serviceIds: ["core"],
        timeWindow: defaultTimeWindow(),
        includeKeywords: ["error"],
        excludeKeywords: [],
      },
      suggestions: {
        source: "jira_mcp",
        needsReview: true,
        fallback: "manual_mode",
      },
    };
  }
}

export async function getWatchdogHealth() {
  const storage = configuredStorage();
  const llmConfig = getWatchdogLlmConfig();
  let mcpAuthMode = process.env.WATCHDOG_MCP_AUTH_MODE
    || process.env.WATCHDOG_AWS_AUTH_MODE
    || process.env.WATCHDOG_AUTH_MODE
    || "local_profile";
  let targetAwsAccountId = process.env.WATCHDOG_TARGET_AWS_ACCOUNT_ID
    || process.env.WATCHDOG_AWS_ACCOUNT_ID
    || "239350186085";
  const dependencies: Record<string, { status: string; message?: string }> = {
    database: { status: "ok" },
    storage: {
      status: "ok",
      message: `${storage.evidenceBucket} / ${storage.resultBucket} (${storage.region})`,
    },
    mcp: { status: "not_configured" },
    llmProvider: {
      status: llmConfig.configured ? "ok" : "not_configured",
      message: `${llmConfig.providerKey}: ${llmConfig.message || llmConfig.modelId}`,
    },
    jira: {
      status: process.env.WATCHDOG_JIRA_SECRET_ARN || process.env.JIRA_USERNAME ? "ok" : "not_configured",
    },
  };

  try {
    await getPool().execute("SELECT 1");
  } catch (error) {
    dependencies.database = {
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (process.env.WATCHDOG_MCP_COMMAND?.trim() || process.env.WATCHDOG_MCP_HTTP_URL?.trim()) {
    try {
      const mcp = await ensureWatchdogMcpReady();
      const healthcheck = await callWatchdogMcpTool<WatchdogMcpHealthcheck>("healthcheck", {}).catch(() => null);
      mcpAuthMode = healthcheck?.aws?.auth_mode || mcpAuthMode;
      targetAwsAccountId = healthcheck?.aws?.account_id || targetAwsAccountId;
      dependencies.mcp = {
        status: mcp.status === "ok" ? "ok" : "degraded",
        message: [
          mcp.command,
          `auth=${mcpAuthMode}`,
          mcp.toolCount !== undefined ? `${mcp.toolCount} tools` : undefined,
          mcp.lastError,
        ].filter(Boolean).join("; ") || undefined,
      };
    } catch (error) {
      const mcp = getWatchdogMcpStatus();
      dependencies.mcp = {
        status: "unavailable",
        message: [
          mcp.command,
          error instanceof Error ? error.message : String(error),
          mcp.lastError,
        ].filter(Boolean).join("; "),
      };
    }
  }

  const status = Object.values(dependencies).some((item) => item.status === "unavailable")
    ? "unavailable"
    : Object.values(dependencies).some((item) => item.status === "not_configured" || item.status === "degraded")
      ? "degraded"
      : "ok";

  return {
    status,
    mode: mcpAuthMode,
    targetAwsAccountId,
    dependencies,
  };
}

export async function listWatchdogSessions(params: { limit?: unknown; offset?: unknown }) {
  const limit = normalizeLimit(params.limit);
  const offset = normalizeOffset(params.offset);
  const rows = await query<WatchdogSessionRow>(
    `
      SELECT
        s.*,
        r.id AS run_attempt_id,
        r.attempt_number,
        r.trigger_cause,
        r.status AS run_status,
        r.correlation_id,
        r.approved_scope AS run_approved_scope,
        r.provider_key,
        r.model_id,
        r.created_at AS run_created_at,
        r.started_at,
        r.finished_at
      FROM watchdog_sessions s
      LEFT JOIN watchdog_run_attempts r ON r.id = s.last_run_attempt_id
      ORDER BY s.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
  );
  const totalRows = await query<mysql.RowDataPacket & { total: number }>(
    "SELECT COUNT(*) AS total FROM watchdog_sessions",
  );
  return {
    sessions: rows.map(normalizeSession),
    pagination: { limit, offset, total: Number(totalRows[0]?.total || 0) },
  };
}

export async function listWatchdogCatalogClients() {
  const response = await callWatchdogMcpTool<{ status?: string; clients?: string[] }>("list_clients", {});
  return {
    status: response.status || "ok",
    clients: Array.isArray(response.clients) ? response.clients : [],
  };
}

export async function listWatchdogCatalogLogSources(params: {
  clientCode: string;
  environment?: string;
  regions?: string[];
}) {
  const clientCode = params.clientCode.trim().toUpperCase();
  if (!clientCode) {
    throw new WatchdogServiceError("clientCode is required", 400, "client_required");
  }
  const response = await callWatchdogMcpTool<{
    status?: string;
    sources?: Array<Record<string, unknown>>;
  }>("list_client_log_sources", {
    client_code: clientCode,
    environment: params.environment?.trim() || undefined,
    regions: params.regions || [],
  });
  return {
    status: response.status || "ok",
    sources: Array.isArray(response.sources) ? response.sources : [],
  };
}

export async function getWatchdogSession(sessionId: string): Promise<WatchdogSession | null> {
  const rows = await query<WatchdogSessionRow>(
    `
      SELECT
        s.*,
        r.id AS run_attempt_id,
        r.attempt_number,
        r.trigger_cause,
        r.status AS run_status,
        r.correlation_id,
        r.approved_scope AS run_approved_scope,
        r.provider_key,
        r.model_id,
        r.created_at AS run_created_at,
        r.started_at,
        r.finished_at
      FROM watchdog_sessions s
      LEFT JOIN watchdog_run_attempts r ON r.id = s.last_run_attempt_id
      WHERE s.id = ?
      LIMIT 1
    `,
    [sessionId],
  );
  return rows[0] ? normalizeSession(rows[0]) : null;
}

export async function createWatchdogSession(input: CreateWatchdogSessionInput): Promise<WatchdogSession> {
  if (input.mode === "manual") {
    assertScope(input.draftScope);
  }
  if (input.mode === "natural_language") {
    if (!input.naturalLanguagePrompt?.trim()) {
      throw new WatchdogServiceError("naturalLanguagePrompt is required", 400, "prompt_required");
    }
    assertScope(input.draftScope);
  }
  if (input.mode === "jira" && !input.jiraKey?.trim()) {
    throw new WatchdogServiceError("jiraKey is required", 400, "jira_key_required");
  }

  const id = makeId("wdg_sess");
  await getPool().execute(
    `
      INSERT INTO watchdog_sessions (
        id, title, mode, status, owner_id, owner_display, auth_source,
        jira_key, natural_language_prompt, draft_scope
      ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      titleFromInput(input),
      input.mode,
      input.operator.id,
      input.operator.display,
      input.operator.authSource,
      input.jiraKey?.trim().toUpperCase() || null,
      input.naturalLanguagePrompt?.trim() || null,
      stringifyJson(input.draftScope),
    ],
  );

  await appendWatchdogEvent({
    sessionId: id,
    correlationId: makeId("wdg_corr"),
    eventType: "session.created",
    payload: { sessionId: id, status: "draft", title: titleFromInput(input) },
  });
  await appendWatchdogAuditEvent({
    sessionId: id,
    actorId: input.operator.id,
    eventType: "session.created",
    payload: {
      mode: input.mode,
      jiraKey: input.jiraKey?.trim().toUpperCase() || undefined,
      title: titleFromInput(input),
    },
  });

  const session = await getWatchdogSession(id);
  if (!session) {
    throw new WatchdogServiceError("Created Watchdog session could not be loaded", 500, "session_load_failed");
  }
  return session;
}

export async function updateWatchdogDraft(sessionId: string, draftScope: unknown) {
  assertScope(draftScope);
  await getPool().execute(
    "UPDATE watchdog_sessions SET draft_scope = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [stringifyJson(draftScope), sessionId],
  );
  const session = await getWatchdogSession(sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  await appendWatchdogEvent({
    sessionId,
    correlationId: session.latestRunAttempt?.correlationId || makeId("wdg_corr"),
    eventType: "session.updated",
    payload: { sessionId, status: session.status, title: session.title },
  });
  return session;
}

export async function approveWatchdogSession(
  sessionId: string,
  approvedScope: unknown,
  operator?: WatchdogOperatorIdentity,
): Promise<WatchdogRunAttempt> {
  assertScope(approvedScope);
  const resolvedScope = await resolveScopeEnvironment(approvedScope);
  const session = await getWatchdogSession(sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  if (session.status !== "draft" && session.status !== "completed" && session.status !== "failed" && session.status !== "expired") {
    throw new WatchdogServiceError("Session is not approvable from its current state", 409, "session_not_approvable");
  }
  if (operator) {
    await assertOperatorRunCapacity(operator, sessionId);
  }

  const attemptRows = await query<mysql.RowDataPacket & { next_attempt: number }>(
    "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM watchdog_run_attempts WHERE session_id = ?",
    [sessionId],
  );
  const attemptNumber = Number(attemptRows[0]?.next_attempt || 1);
  const runId = makeId("wdg_run");
  const correlationId = makeId("wdg_corr");
  const llmConfig = getWatchdogLlmConfig();
  const providerKey = llmConfig.providerKey;
  const modelId = llmConfig.modelId;

  await getPool().execute(
    `
      INSERT INTO watchdog_run_attempts (
        id, session_id, attempt_number, trigger_cause, status, correlation_id,
        approved_scope, provider_key, model_id
      ) VALUES (?, ?, ?, 'approval', 'queued', ?, ?, ?, ?)
    `,
    [runId, sessionId, attemptNumber, correlationId, stringifyJson(resolvedScope), providerKey, modelId],
  );
  await getPool().execute(
    `
      UPDATE watchdog_sessions
      SET status = 'queued',
          approved_scope = ?,
          draft_scope = ?,
          last_run_attempt_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?
    `,
    [stringifyJson(resolvedScope), stringifyJson(resolvedScope), runId, sessionId],
  );

  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runId,
    correlationId,
    eventType: "session.updated",
    payload: { sessionId, status: "queued", title: session.title },
  });
  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runId,
    correlationId,
    eventType: "run.queued",
    payload: { runAttemptId: runId, status: "queued", attemptNumber },
  });
  await appendWatchdogAuditEvent({
    sessionId,
    runAttemptId: runId,
    correlationId,
    actorId: operator?.id || session.owner.id,
    eventType: "session.approved",
    payload: {
      attemptNumber,
      scope: resolvedScope,
      providerKey,
      modelId,
    },
  });

  return {
    id: runId,
    sessionId,
    attemptNumber,
    trigger: "approval",
    status: "queued",
    correlationId,
    approvedScope: resolvedScope,
    providerKey,
    modelId,
    createdAt: new Date().toISOString(),
  };
}

export async function rerunWatchdogSession(
  sessionId: string,
  approvedScope?: unknown,
  operator?: WatchdogOperatorIdentity,
  trigger: WatchdogRunTrigger = "user_rerun",
): Promise<WatchdogRunAttempt> {
  const session = await getWatchdogSession(sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  if (!["completed", "failed", "expired", "awaiting_user_input"].includes(session.status)) {
    throw new WatchdogServiceError("Session can only be rerun from a terminal state", 409, "session_not_rerunnable");
  }
  if (operator) {
    await assertOperatorRunCapacity(operator, sessionId);
  }

  const candidateScope = approvedScope || session.approvedScope || session.latestRunAttempt?.approvedScope || session.draftScope;
  assertScope(candidateScope);
  const resolvedScope = await resolveScopeEnvironment(candidateScope);

  const attemptRows = await query<mysql.RowDataPacket & { next_attempt: number }>(
    "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM watchdog_run_attempts WHERE session_id = ?",
    [sessionId],
  );
  const attemptNumber = Number(attemptRows[0]?.next_attempt || 1);
  const runId = makeId("wdg_run");
  const correlationId = makeId("wdg_corr");
  const llmConfig = getWatchdogLlmConfig();
  const providerKey = llmConfig.providerKey;
  const modelId = llmConfig.modelId;

  await getPool().execute(
    `
      INSERT INTO watchdog_run_attempts (
        id, session_id, attempt_number, trigger_cause, status, correlation_id,
        approved_scope, provider_key, model_id
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `,
    [runId, sessionId, attemptNumber, trigger, correlationId, stringifyJson(resolvedScope), providerKey, modelId],
  );
  await getPool().execute(
    `
      UPDATE watchdog_sessions
      SET status = 'queued',
          approved_scope = ?,
          draft_scope = ?,
          last_run_attempt_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?
    `,
    [stringifyJson(resolvedScope), stringifyJson(resolvedScope), runId, sessionId],
  );

  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runId,
    correlationId,
    eventType: "session.updated",
    payload: { sessionId, status: "queued", title: session.title },
  });
  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runId,
    correlationId,
    eventType: "run.queued",
    payload: { runAttemptId: runId, status: "queued", attemptNumber, trigger },
  });
  await appendWatchdogAuditEvent({
    sessionId,
    runAttemptId: runId,
    correlationId,
    actorId: operator?.id || session.owner.id,
    eventType: trigger === "clarification_resume" ? "clarification.resume_queued" : "session.rerun",
    payload: {
      attemptNumber,
      trigger,
      scope: resolvedScope,
      providerKey,
      modelId,
    },
  });

  return {
    id: runId,
    sessionId,
    attemptNumber,
    trigger,
    status: "queued",
    correlationId,
    approvedScope: resolvedScope,
    providerKey,
    modelId,
    createdAt: new Date().toISOString(),
  };
}

export async function cancelWatchdogSession(
  sessionId: string,
  operator: WatchdogOperatorIdentity,
): Promise<WatchdogSession> {
  const session = await getWatchdogSession(sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  const runAttempt = session.latestRunAttempt;
  if (!runAttempt || !["queued", "running", "awaiting_user_input"].includes(runAttempt.status)) {
    throw new WatchdogServiceError("Session does not have a cancellable run attempt", 409, "run_not_cancellable");
  }

  const reason = `Run cancelled by ${operator.display}`;
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `
      UPDATE watchdog_run_attempts
      SET status = 'failed',
          failure_code = 'run_cancelled',
          failure_message = ?,
          finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP(3)),
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND status IN ('queued', 'running', 'awaiting_user_input')
    `,
    [reason, runAttempt.id],
  );
  if (result.affectedRows !== 1) {
    throw new WatchdogServiceError("Run attempt was already terminal", 409, "run_already_terminal");
  }

  await getPool().execute(
    "UPDATE watchdog_sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [sessionId],
  );
  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runAttempt.id,
    correlationId: runAttempt.correlationId,
    eventType: "run.failed",
    payload: {
      runAttemptId: runAttempt.id,
      status: "failed",
      attemptNumber: runAttempt.attemptNumber,
      code: "run_cancelled",
      reason,
      cancelledBy: operator.id,
    },
  });
  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runAttempt.id,
    correlationId: runAttempt.correlationId,
    eventType: "session.updated",
    payload: { sessionId, status: "failed", title: session.title },
  });
  await appendWatchdogAuditEvent({
    sessionId,
    runAttemptId: runAttempt.id,
    correlationId: runAttempt.correlationId,
    actorId: operator.id,
    eventType: "run.cancelled",
    payload: { reason },
  });

  const refreshed = await getWatchdogSession(sessionId);
  if (!refreshed) {
    throw new WatchdogServiceError("Cancelled Watchdog session could not be loaded", 500, "session_load_failed");
  }
  return refreshed;
}

export async function requestWatchdogClarification(input: {
  session: WatchdogSession;
  runAttempt: WatchdogRunAttempt;
  question: string;
  choices?: unknown[];
  context?: Record<string, unknown>;
}) {
  const clarificationId = makeId("wdg_clar");
  const ttlHours = Math.max(1, Number(process.env.WATCHDOG_CLARIFICATION_TTL_HOURS || "48"));
  await getPool().execute(
    `
      INSERT INTO watchdog_clarifications (
        id, session_id, run_attempt_id, status, question, choices, context_json,
        expires_at
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR))
    `,
    [
      clarificationId,
      input.session.id,
      input.runAttempt.id,
      input.question,
      stringifyJson(input.choices || []),
      stringifyJson(input.context || {}),
      ttlHours,
    ],
  );
  await getPool().execute(
    `
      UPDATE watchdog_run_attempts
      SET status = 'awaiting_user_input',
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND status = 'running'
    `,
    [input.runAttempt.id],
  );
  await getPool().execute(
    `
      UPDATE watchdog_sessions
      SET status = 'awaiting_user_input',
          expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR),
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?
    `,
    [ttlHours, input.session.id],
  );
  await appendWatchdogEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    eventType: "clarification.required",
    payload: {
      clarificationId,
      question: input.question,
      choices: input.choices || [],
      expiresInHours: ttlHours,
    },
  });
  await appendWatchdogEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    eventType: "session.updated",
    payload: { sessionId: input.session.id, status: "awaiting_user_input", title: input.session.title },
  });
  await appendWatchdogAuditEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    actorId: "watchdog-agent",
    actorType: "agent_runtime",
    eventType: "clarification.required",
    payload: { clarificationId, question: input.question },
  });
  return {
    id: clarificationId,
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    status: "open" as const,
    question: input.question,
    choices: input.choices || [],
    context: input.context || {},
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
  };
}

export async function listWatchdogClarifications(sessionId: string) {
  const rows = await query<WatchdogClarificationRow>(
    `
      SELECT *
      FROM watchdog_clarifications
      WHERE session_id = ?
      ORDER BY created_at DESC
    `,
    [sessionId],
  );
  return { clarifications: rows.map(normalizeClarification) };
}

export async function answerWatchdogClarification(input: {
  sessionId: string;
  clarificationId: string;
  answer: unknown;
  operator: WatchdogOperatorIdentity;
}) {
  const rows = await query<WatchdogClarificationRow>(
    `
      SELECT *
      FROM watchdog_clarifications
      WHERE id = ? AND session_id = ?
      LIMIT 1
    `,
    [input.clarificationId, input.sessionId],
  );
  const clarification = rows[0];
  if (!clarification) {
    throw new WatchdogServiceError("Clarification not found", 404, "clarification_not_found");
  }
  if (clarification.status !== "open") {
    throw new WatchdogServiceError("Clarification is not open", 409, "clarification_not_open");
  }
  if (new Date(clarification.expires_at).getTime() < Date.now()) {
    throw new WatchdogServiceError("Clarification has expired", 409, "clarification_expired");
  }

  await getPool().execute(
    `
      UPDATE watchdog_clarifications
      SET status = 'answered',
          answer_json = ?,
          answered_by = ?,
          answered_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND status = 'open'
    `,
    [stringifyJson({ answer: input.answer }), input.operator.id, input.clarificationId],
  );
  await getPool().execute(
    `
      UPDATE watchdog_run_attempts
      SET status = 'completed',
          metrics_json = JSON_SET(COALESCE(metrics_json, JSON_OBJECT()), '$.checkpoint', 'clarification_answered'),
          finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP(3)),
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND status = 'awaiting_user_input'
    `,
    [clarification.run_attempt_id],
  );

  const session = await getWatchdogSession(input.sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  const scope = session.approvedScope || session.latestRunAttempt?.approvedScope || session.draftScope;
  assertScope(scope);
  const resumedScope: WatchdogInvestigationScope = {
    ...scope,
    advancedFilters: {
      ...(scope.advancedFilters || {}),
      clarification: {
        id: input.clarificationId,
        question: clarification.question,
        answer: input.answer,
      },
    },
  };
  await appendWatchdogEvent({
    sessionId: input.sessionId,
    runAttemptId: clarification.run_attempt_id,
    correlationId: session.latestRunAttempt?.correlationId || makeId("wdg_corr"),
    eventType: "clarification.answered",
    payload: {
      clarificationId: input.clarificationId,
      answeredBy: input.operator.id,
    },
  });
  await appendWatchdogAuditEvent({
    sessionId: input.sessionId,
    runAttemptId: clarification.run_attempt_id,
    correlationId: session.latestRunAttempt?.correlationId,
    actorId: input.operator.id,
    eventType: "clarification.answered",
    payload: { clarificationId: input.clarificationId },
  });
  return rerunWatchdogSession(input.sessionId, resumedScope, input.operator, "clarification_resume");
}

export async function expireOpenWatchdogClarifications() {
  const rows = await query<WatchdogClarificationRow>(
    `
      SELECT c.*, s.title, r.correlation_id, r.attempt_number
      FROM watchdog_clarifications c
      JOIN watchdog_sessions s ON s.id = c.session_id
      JOIN watchdog_run_attempts r ON r.id = c.run_attempt_id
      WHERE c.status = 'open'
        AND c.expires_at < CURRENT_TIMESTAMP(3)
      LIMIT 50
    `,
  );
  let expired = 0;
  for (const row of rows) {
    const [result] = await getPool().execute<mysql.ResultSetHeader>(
      "UPDATE watchdog_clarifications SET status = 'expired' WHERE id = ? AND status = 'open'",
      [row.id],
    );
    if (result.affectedRows !== 1) continue;
    expired += 1;
    await getPool().execute(
      `
        UPDATE watchdog_run_attempts
        SET status = 'expired',
            failure_code = 'clarification_expired',
            failure_message = 'Clarification expired before the operator answered',
            finished_at = CURRENT_TIMESTAMP(3),
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND status = 'awaiting_user_input'
      `,
      [row.run_attempt_id],
    );
    await getPool().execute(
      "UPDATE watchdog_sessions SET status = 'expired', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'awaiting_user_input'",
      [row.session_id],
    );
    await appendWatchdogEvent({
      sessionId: row.session_id,
      runAttemptId: row.run_attempt_id,
      correlationId: (row as WatchdogClarificationRow & { correlation_id?: string }).correlation_id || makeId("wdg_corr"),
      eventType: "session.expired",
      payload: {
        sessionId: row.session_id,
        status: "expired",
        reason: "clarification_expired",
        clarificationId: row.id,
      },
    });
  }
  return { status: "ok", scanned: rows.length, expired };
}

export async function appendWatchdogEvent(input: {
  sessionId: string;
  runAttemptId?: string;
  correlationId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<WatchdogServerEvent> {
  const eventId = makeId("wdg_evt");
  const seqRows = await query<mysql.RowDataPacket & { next_sequence: number }>(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM watchdog_server_events WHERE session_id = ?",
    [input.sessionId],
  );
  const sequence = Number(seqRows[0]?.next_sequence || 1);
  await getPool().execute(
    `
      INSERT INTO watchdog_server_events (
        id, session_id, run_attempt_id, correlation_id, event_type, sequence,
        payload_json, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR))
    `,
    [
      eventId,
      input.sessionId,
      input.runAttemptId || null,
      input.correlationId,
      input.eventType,
      sequence,
      stringifyJson(input.payload),
      SSE_REPLAY_HOURS,
    ],
  );
  return {
    id: eventId,
    sessionId: input.sessionId,
    runAttemptId: input.runAttemptId,
    correlationId: input.correlationId,
    eventType: input.eventType,
    sequence,
    createdAt: new Date().toISOString(),
    payload: input.payload,
  };
}

export async function listWatchdogEvents(sessionId: string, afterSequence = 0) {
  const rows = await query<WatchdogEventRow>(
    `
      SELECT *
      FROM watchdog_server_events
      WHERE session_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT 200
    `,
    [sessionId, afterSequence],
  );
  return rows.map(normalizeEvent);
}

export async function cleanupExpiredWatchdogRows() {
  const [eventsResult] = await getPool().execute<mysql.ResultSetHeader>(
    "DELETE FROM watchdog_server_events WHERE expires_at < CURRENT_TIMESTAMP(3) LIMIT 1000",
  );
  const [auditResult] = await getPool().execute<mysql.ResultSetHeader>(
    "DELETE FROM watchdog_audit_events WHERE expires_at < CURRENT_TIMESTAMP(3) LIMIT 1000",
  );
  return {
    status: "ok",
    serverEventsDeleted: eventsResult.affectedRows,
    auditEventsDeleted: auditResult.affectedRows,
  };
}

export function parseLastEventSequence(lastEventId: unknown): number {
  if (typeof lastEventId !== "string") return 0;
  const value = Number(lastEventId.split(":").pop());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function listWatchdogEvidence(sessionId: string) {
  const rows = await query<WatchdogEvidenceRow>(
    `
      SELECT
        id, session_id, run_attempt_id, kind, title, summary, source_tool,
        source_ref_json, time_window, s3_bucket, s3_key, sha256, byte_count,
        created_at, expires_at
      FROM watchdog_evidence_artifacts
      WHERE session_id = ?
      ORDER BY created_at DESC
    `,
    [sessionId],
  );
  return {
    artifacts: rows.map((row) => ({
      ...row,
      sourceRef: parseJson<Record<string, unknown>>(row.source_ref_json) || {},
      timeWindow: parseJson<Record<string, unknown>>(row.time_window) || undefined,
      hasPayload: Boolean(row.s3_bucket && row.s3_key),
      s3Bucket: row.s3_bucket || undefined,
      s3Key: row.s3_key || undefined,
      sha256: row.sha256 || undefined,
      byteCount: row.byte_count === null || row.byte_count === undefined ? undefined : Number(row.byte_count),
    })),
  };
}

export async function getWatchdogEvidenceArtifactPayload(sessionId: string, evidenceId: string) {
  const rows = await query<WatchdogEvidenceRow>(
    `
      SELECT *
      FROM watchdog_evidence_artifacts
      WHERE session_id = ? AND id = ?
      LIMIT 1
    `,
    [sessionId, evidenceId],
  );
  const artifact = rows[0];
  if (!artifact) {
    throw new WatchdogServiceError("Evidence artifact not found", 404, "evidence_not_found");
  }
  if (!artifact.s3_bucket || !artifact.s3_key) {
    throw new WatchdogServiceError("Evidence artifact does not have a stored payload", 404, "evidence_payload_missing");
  }
  const payload = await downloadWatchdogEvidencePayload({
    bucket: artifact.s3_bucket,
    key: artifact.s3_key,
  });
  return {
    artifactId: artifact.id,
    sessionId: artifact.session_id,
    runAttemptId: artifact.run_attempt_id,
    contentType: "application/json",
    sha256: artifact.sha256 || undefined,
    byteCount: artifact.byte_count === null || artifact.byte_count === undefined ? undefined : Number(artifact.byte_count),
    payload,
  };
}

export async function listWatchdogFindings(sessionId: string) {
  const rows = await query<WatchdogFindingRow>(
    `
      SELECT id, session_id, run_attempt_id, kind, severity, title, summary, details, confidence, evidence_ids, created_at
      FROM watchdog_findings
      WHERE session_id = ?
      ORDER BY created_at DESC
    `,
    [sessionId],
  );
  return { findings: rows.map(normalizeFinding) };
}

export async function listWatchdogDarciHandoffs(sessionId: string) {
  const rows = await query<WatchdogDarciHandoffRow>(
    `
      SELECT *
      FROM watchdog_darci_handoffs
      WHERE session_id = ?
      ORDER BY created_at DESC
    `,
    [sessionId],
  );
  return { handoffs: rows.map(normalizeDarciHandoff) };
}

function repoNamesForServices(serviceIds: string[]) {
  const services = serviceIds.map((service) => service.toLowerCase());
  const names = new Set<string>();
  if (services.some((service) => service.includes("core"))) names.add("core-app");
  if (services.some((service) => service.includes("batch"))) names.add("batch-jobs");
  if (services.some((service) => service.includes("portal"))) names.add("provider-portal");
  if (services.some((service) => service.includes("interop") || service.includes("fhir"))) names.add("interop");
  if (services.some((service) => service.includes("client"))) names.add("client-services");
  if (names.size === 0) names.add("core-app");
  return Array.from(names);
}

export async function getWatchdogDarciMappingDiagnostics(
  sessionId: string,
  options: { createMissingCustomer?: boolean } = {},
) {
  const session = await getWatchdogSession(sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  const scope = session.latestRunAttempt?.approvedScope || session.approvedScope || session.draftScope;
  if (!scope) {
    throw new WatchdogServiceError("Session does not have a scope to map", 409, "scope_missing");
  }

  const darciRows = await query<mysql.RowDataPacket>(
    `
      SELECT id, name, description, task_type, model, is_active
      FROM agents
      WHERE name = 'DARCI'
      LIMIT 1
    `,
  );
  const clientNeedle = scope.clientId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  let customerRows = await query<mysql.RowDataPacket>(
    `
      SELECT id, customer, branch, \`default\`
      FROM customer_branches
      WHERE LOWER(REPLACE(REPLACE(customer, ' ', ''), '-', '')) LIKE ?
         OR LOWER(customer) LIKE ?
      ORDER BY \`default\` DESC, customer ASC
      LIMIT 10
    `,
    [`%${clientNeedle}%`, `%${scope.clientId.toLowerCase()}%`],
  );
  if (customerRows.length === 0 && options.createMissingCustomer) {
    const [insertResult] = await getPool().execute<mysql.ResultSetHeader>(
      "INSERT INTO customer_branches (customer, branch, `default`) VALUES (?, 'master', 0)",
      [scope.clientId],
    );
    customerRows = await query<mysql.RowDataPacket>(
      "SELECT id, customer, branch, `default` FROM customer_branches WHERE id = ?",
      [insertResult.insertId],
    );
  }
  const repoNames = repoNamesForServices(scope.serviceIds);
  const repoRows = await query<mysql.RowDataPacket>(
    `
      SELECT id, repo_name, repo_url, description, default_branch
      FROM code_repositories
      WHERE repo_name IN (${repoNames.map(() => "?").join(",")})
      ORDER BY FIELD(repo_name, ${repoNames.map(() => "?").join(",")})
    `,
    [...repoNames, ...repoNames],
  );

  return {
    sessionId,
    scope,
    darciAgent: darciRows[0] || null,
    customerCandidates: customerRows,
    repositoryCandidates: repoRows,
    proposed: {
      ready:
        Boolean(darciRows[0]?.id) &&
        customerRows.length === 1 &&
        repoRows.length > 0,
      agentId: darciRows[0]?.id,
      customerId: customerRows.length === 1 ? customerRows[0].id : undefined,
      relatedCode: repoRows.map((row) => row.id).join(","),
      taskType: darciRows[0]?.task_type || "defect_analysis",
      blockers: [
        !darciRows[0]?.id ? "DARCI agent row not found" : null,
        customerRows.length === 0 ? `No customer_branches match for ${scope.clientId}` : null,
        customerRows.length > 1 ? `Multiple customer_branches candidates for ${scope.clientId}` : null,
        repoRows.length === 0 ? `No code_repositories match service ids ${scope.serviceIds.join(", ")}` : null,
      ].filter(Boolean),
    },
  };
}

export async function createWatchdogDarciHandoff(input: {
  sessionId: string;
  findingIds: unknown;
  operator: WatchdogOperatorIdentity;
}) {
  const session = await getWatchdogSession(input.sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  if (!session.latestRunAttempt) {
    throw new WatchdogServiceError("Session does not have a run attempt to hand off", 409, "run_missing");
  }
  const findingIds = Array.isArray(input.findingIds)
    ? input.findingIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  if (findingIds.length === 0) {
    throw new WatchdogServiceError("At least one finding id is required for DARCI handoff", 400, "finding_required");
  }

  const existingFindings = await query<mysql.RowDataPacket & { id: string }>(
    `
      SELECT id
      FROM watchdog_findings
      WHERE session_id = ? AND id IN (${findingIds.map(() => "?").join(",")})
    `,
    [input.sessionId, ...findingIds],
  );
  if (existingFindings.length !== findingIds.length) {
    throw new WatchdogServiceError("One or more findings do not belong to this session", 400, "finding_invalid");
  }

  const handoffId = makeId("wdg_darci");
  await getPool().execute(
    `
      INSERT INTO watchdog_darci_handoffs (
        id, session_id, run_attempt_id, finding_ids, requested_by, requested_by_display, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued')
    `,
    [
      handoffId,
      input.sessionId,
      session.latestRunAttempt.id,
      stringifyJson(findingIds),
      input.operator.id,
      input.operator.display,
    ],
  );
  await appendWatchdogEvent({
    sessionId: input.sessionId,
    runAttemptId: session.latestRunAttempt.id,
    correlationId: session.latestRunAttempt.correlationId,
    eventType: "darci_handoff.created",
    payload: {
      handoffId,
      status: "queued",
      findingIds,
      message: "DARCI handoff queued. Task bridge is pending repository/customer mapping.",
    },
  });
  await appendWatchdogAuditEvent({
    sessionId: input.sessionId,
    runAttemptId: session.latestRunAttempt.id,
    correlationId: session.latestRunAttempt.correlationId,
    actorId: input.operator.id,
    eventType: "darci_handoff.created",
    payload: { handoffId, findingIds },
  });

  const rows = await query<WatchdogDarciHandoffRow>(
    "SELECT * FROM watchdog_darci_handoffs WHERE id = ? LIMIT 1",
    [handoffId],
  );
  return normalizeDarciHandoff(rows[0]);
}

export async function setWatchdogRuntimeAwsCredentials(input: {
  awsAccessKeyId: unknown;
  awsSecretAccessKey: unknown;
  awsSessionToken?: unknown;
  awsAccountId?: unknown;
}) {
  const awsAccessKeyId = typeof input.awsAccessKeyId === "string" ? input.awsAccessKeyId.trim() : "";
  const awsSecretAccessKey = typeof input.awsSecretAccessKey === "string" ? input.awsSecretAccessKey.trim() : "";
  const awsSessionToken = typeof input.awsSessionToken === "string" ? input.awsSessionToken.trim() : "";
  const awsAccountId = typeof input.awsAccountId === "string" && input.awsAccountId.trim()
    ? input.awsAccountId.trim()
    : process.env.WATCHDOG_TARGET_AWS_ACCOUNT_ID || "239350186085";

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    throw new WatchdogServiceError(
      "AWS access key id and secret access key are required",
      400,
      "aws_credentials_required",
    );
  }

  return callWatchdogMcpTool<{
    status: string;
    aws: {
      source: string;
      account_id: string;
      arn?: string;
      has_session_token?: boolean;
    };
  }>("set_runtime_aws_credentials", {
    aws_access_key_id: awsAccessKeyId,
    aws_secret_access_key: awsSecretAccessKey,
    aws_session_token: awsSessionToken || undefined,
    aws_account_id: awsAccountId,
  });
}
