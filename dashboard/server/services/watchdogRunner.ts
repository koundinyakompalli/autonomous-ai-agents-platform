import type mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { getPool, query } from "../db.js";
import type {
  WatchdogInvestigationScope,
  WatchdogRunAttempt,
  WatchdogRunStatus,
  WatchdogRunTrigger,
  WatchdogSession,
} from "../types/watchdog.js";
import {
  appendWatchdogAuditEvent,
  appendWatchdogEvent,
  cleanupExpiredWatchdogRows,
  expireOpenWatchdogClarifications,
  getWatchdogSession,
  requestWatchdogClarification,
  WatchdogServiceError,
} from "./watchdog.js";
import { putWatchdogEvidencePayload } from "./watchdogEvidenceStore.js";
import {
  runWatchdogLlmJson,
  type WatchdogLlmAnalysis,
  type WatchdogLlmFinding,
} from "./watchdogLlmProvider.js";
import { callWatchdogMcpTool } from "./watchdogMcpClient.js";

type JsonColumn = string | Record<string, unknown> | unknown[] | null;

type WatchdogRunAttemptRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  attempt_number: number;
  trigger_cause: WatchdogRunTrigger;
  status: WatchdogRunStatus;
  correlation_id: string;
  approved_scope: JsonColumn;
  provider_key: string | null;
  model_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

type WatchdogStaleRunRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  attempt_number: number;
  correlation_id: string;
  title: string;
};

type WatchdogFindingKind = "finding" | "limitation" | "no_evidence";
type WatchdogFindingSeverity = "info" | "low" | "medium" | "high" | "critical";

interface WatchdogProgressUpdate {
  phase: "scope_resolution" | "evidence_collection" | "analysis" | "finalization";
  label: string;
  percent?: number;
}

interface WatchdogInvestigationFinding {
  kind: WatchdogFindingKind;
  severity: WatchdogFindingSeverity;
  title: string;
  summary: string;
  details?: Record<string, unknown>;
  confidence?: number;
  evidenceIds?: string[];
}

interface WatchdogInvestigationResult {
  findings: WatchdogInvestigationFinding[];
}

interface WatchdogInvestigationContext {
  session: WatchdogSession;
  runAttempt: WatchdogRunAttempt;
  approvedScope: WatchdogInvestigationScope;
  emitProgress: (update: WatchdogProgressUpdate) => Promise<void>;
}

interface WatchdogInvestigator {
  readonly key: string;
  investigate(context: WatchdogInvestigationContext): Promise<WatchdogInvestigationResult>;
}

class FakeNoEvidenceInvestigator implements WatchdogInvestigator {
  readonly key = "fake_no_evidence";

  async investigate(context: WatchdogInvestigationContext): Promise<WatchdogInvestigationResult> {
    await context.emitProgress({
      phase: "scope_resolution",
      label: "Validated approved scope",
      percent: 25,
    });
    await context.emitProgress({
      phase: "analysis",
      label: "Fake runner produced deterministic no-evidence result",
      percent: 80,
    });

    return {
      findings: [
        {
          kind: "no_evidence",
          severity: "info",
          title: "No evidence collected by fake runner",
          summary:
            "The Watchdog runner shell completed the approved scope without invoking MCP. This proves state transitions, findings, and SSE delivery only.",
          details: {
            deterministicRule: "fake_runner_no_mcp",
            approvedScope: context.approvedScope,
          },
          confidence: 1,
          evidenceIds: [],
        },
      ],
    };
  }
}

interface McpToolResponse {
  status?: string;
  message?: string;
  [key: string]: unknown;
}

interface McpSearchBundle extends McpToolResponse {
  search_id?: string;
  summary_counts?: {
    total_matches?: number;
    returned_samples?: number;
    regions?: Record<string, number>;
    log_groups?: Record<string, number>;
  };
  top_samples?: Array<Record<string, unknown>>;
  warnings?: string[];
}

interface WatchdogMcpFollowupPlan {
  actions?: Array<{
    reason?: string;
    querySpec?: WatchdogFollowupQuerySpec;
  }>;
}

interface WatchdogFollowupQuerySpec {
  keywords?: string[];
  exact_phrases?: string[];
  severity?: string[];
  component_filters?: string[];
  limit?: number;
}

const WATCHDOG_FOLLOWUP_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["reason", "querySpec"],
        properties: {
          reason: { type: "string", maxLength: 240 },
          querySpec: {
            type: "object",
            additionalProperties: false,
            required: ["keywords", "exact_phrases", "severity", "component_filters", "limit"],
            properties: {
              keywords: { type: "array", items: { type: "string" }, maxItems: 6 },
              exact_phrases: { type: "array", items: { type: "string" }, maxItems: 4 },
              severity: { type: "array", items: { type: "string" }, maxItems: 4 },
              component_filters: { type: "array", items: { type: "string" }, maxItems: 6 },
              limit: { type: "number", minimum: 1, maximum: 100 },
            },
          },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

class McpLogSearchInvestigator implements WatchdogInvestigator {
  readonly key = "mcp_log_search";

  async investigate(context: WatchdogInvestigationContext): Promise<WatchdogInvestigationResult> {
    await context.emitProgress({
      phase: "scope_resolution",
      label: "Checking Watchdog MCP health",
      percent: 10,
    });
    const health = await callWatchdogMcpTool<McpToolResponse>("healthcheck", {});
    if (health.status && !["ok", "degraded"].includes(health.status)) {
      throw new WatchdogServiceError(
        `Watchdog MCP healthcheck returned ${health.status}`,
        503,
        "mcp_healthcheck_failed",
      );
    }

    await context.emitProgress({
      phase: "scope_resolution",
      label: "Validating client and log scope through MCP",
      percent: 25,
    });
    const scopeResponse = await callWatchdogMcpTool<McpToolResponse>("build_investigation_scope", {
      session_id: context.session.id,
      selected_client: context.approvedScope.clientId,
      environment: context.approvedScope.environment,
      start_ts: context.approvedScope.timeWindow.startTs,
      end_ts: context.approvedScope.timeWindow.endTs,
      jira_issue_key: context.session.jiraKey,
    });
    if (scopeResponse.status !== "ok" || !scopeResponse.scope) {
      if (scopeResponse.status === "needs_user_input") {
        await requestWatchdogClarification({
          session: context.session,
          runAttempt: context.runAttempt,
          question: scopeResponse.message || "Which client, environment, or service should Watchdog investigate?",
          choices: Array.isArray(scopeResponse.candidates) ? scopeResponse.candidates : [],
          context: { mcpTool: "build_investigation_scope", mcpResponse: scopeResponse },
        });
        throw new WatchdogServiceError("Watchdog run is awaiting operator clarification", 409, "clarification_required");
      }
      return {
        findings: [
          {
            kind: scopeResponse.status === "needs_user_input" ? "limitation" : "no_evidence",
            severity: "info",
            title: "MCP could not build an investigation scope",
            summary: scopeResponse.message || "The MCP server did not return a usable log scope for the approved controls.",
            details: { mcpTool: "build_investigation_scope", mcpResponse: scopeResponse },
            confidence: 1,
            evidenceIds: [],
          },
        ],
      };
    }

    await context.emitProgress({
      phase: "evidence_collection",
      label: "Running bounded CloudWatch search through MCP",
      percent: 55,
    });
    const querySpec = {
      template_id: context.approvedScope.includeKeywords.length > 0 ? "keyword_scan" : "errors",
      keywords: context.approvedScope.includeKeywords,
      exact_phrases: [],
      severity: context.approvedScope.includeKeywords.length > 0 ? [] : ["error"],
      component_filters: context.approvedScope.serviceIds,
      limit: 100,
    };
    const search = await callWatchdogMcpTool<McpSearchBundle>("search_logs_by_client", {
      scope: scopeResponse.scope,
      query_spec: querySpec,
    });
    if (search.status && search.status !== "ok") {
      return {
        findings: [
          {
            kind: "limitation",
            severity: "info",
            title: "MCP log search did not complete",
            summary: search.message || `MCP search returned status ${search.status}.`,
            details: { mcpTool: "search_logs_by_client", querySpec, mcpResponse: search },
            confidence: 1,
            evidenceIds: [],
          },
        ],
      };
    }

    const evidenceId = await persistEvidenceArtifact({
      session: context.session,
      runAttempt: context.runAttempt,
      kind: "log_sample",
      title: `MCP log search ${search.search_id || "result"}`,
      summary: summarizeSearch(search),
      sourceTool: "search_logs_by_client",
      sourceRef: {
        searchId: search.search_id,
        querySpec,
        summaryCounts: search.summary_counts,
        warnings: search.warnings || [],
      },
      timeWindow: context.approvedScope.timeWindow,
      payload: {
        querySpec,
        summaryCounts: search.summary_counts || {},
        warnings: search.warnings || [],
        redactedSamples: search.top_samples || [],
      },
    });
    await context.emitProgress({
      phase: "analysis",
      label: "Converting MCP search result into Watchdog finding",
      percent: 85,
    });

    const totalMatches = Number(search.summary_counts?.total_matches || 0);
    if (totalMatches <= 0) {
      return {
        findings: [
          {
            kind: "no_evidence",
            severity: "info",
            title: "No matching log evidence found",
            summary:
              "The MCP-backed CloudWatch search completed but did not find matching log events in the approved scope.",
            details: {
              searchId: search.search_id,
              summaryCounts: search.summary_counts || {},
              warnings: search.warnings || [],
            },
            confidence: 1,
            evidenceIds: [evidenceId],
          },
        ],
      };
    }

    return {
      findings: [
        buildDeterministicSearchFinding({
          search,
          evidenceId,
          approvedScope: context.approvedScope,
        }),
      ],
    };
  }
}

class LlmLogAnalysisInvestigator implements WatchdogInvestigator {
  readonly key = "llm_log_analysis";

  async investigate(context: WatchdogInvestigationContext): Promise<WatchdogInvestigationResult> {
    await context.emitProgress({
      phase: "scope_resolution",
      label: "Checking Watchdog MCP health",
      percent: 10,
    });
    const health = await callWatchdogMcpTool<McpToolResponse>("healthcheck", {});
    if (health.status && !["ok", "degraded"].includes(health.status)) {
      throw new WatchdogServiceError(
        `Watchdog MCP healthcheck returned ${health.status}`,
        503,
        "mcp_healthcheck_failed",
      );
    }

    await context.emitProgress({
      phase: "scope_resolution",
      label: "Validating client and log scope through MCP",
      percent: 25,
    });
    const scopeResponse = await callWatchdogMcpTool<McpToolResponse>("build_investigation_scope", {
      session_id: context.session.id,
      selected_client: context.approvedScope.clientId,
      environment: context.approvedScope.environment,
      start_ts: context.approvedScope.timeWindow.startTs,
      end_ts: context.approvedScope.timeWindow.endTs,
      jira_issue_key: context.session.jiraKey,
    });
    if (scopeResponse.status !== "ok" || !scopeResponse.scope) {
      if (scopeResponse.status === "needs_user_input") {
        await requestWatchdogClarification({
          session: context.session,
          runAttempt: context.runAttempt,
          question: scopeResponse.message || "Which client, environment, or service should Watchdog investigate?",
          choices: Array.isArray(scopeResponse.candidates) ? scopeResponse.candidates : [],
          context: { mcpTool: "build_investigation_scope", mcpResponse: scopeResponse },
        });
        throw new WatchdogServiceError("Watchdog run is awaiting operator clarification", 409, "clarification_required");
      }
      return {
        findings: [
          {
            kind: scopeResponse.status === "needs_user_input" ? "limitation" : "no_evidence",
            severity: "info",
            title: "MCP could not build an investigation scope",
            summary: scopeResponse.message || "The MCP server did not return a usable log scope for the approved controls.",
            details: { mcpTool: "build_investigation_scope", mcpResponse: scopeResponse },
            confidence: 1,
            evidenceIds: [],
          },
        ],
      };
    }

    await context.emitProgress({
      phase: "evidence_collection",
      label: "Running bounded CloudWatch search through MCP",
      percent: 55,
    });
    const querySpec = {
      template_id: context.approvedScope.includeKeywords.length > 0 ? "keyword_scan" : "errors",
      keywords: context.approvedScope.includeKeywords,
      exact_phrases: [],
      severity: context.approvedScope.includeKeywords.length > 0 ? [] : ["error"],
      component_filters: context.approvedScope.serviceIds,
      limit: 100,
    };
    const search = await callWatchdogMcpTool<McpSearchBundle>("search_logs_by_client", {
      scope: scopeResponse.scope,
      query_spec: querySpec,
    });
    if (search.status && search.status !== "ok") {
      return {
        findings: [
          {
            kind: "limitation",
            severity: "info",
            title: "MCP log search did not complete",
            summary: search.message || `MCP search returned status ${search.status}.`,
            details: { mcpTool: "search_logs_by_client", querySpec, mcpResponse: search },
            confidence: 1,
            evidenceIds: [],
          },
        ],
      };
    }

    const evidenceId = await persistEvidenceArtifact({
      session: context.session,
      runAttempt: context.runAttempt,
      kind: "log_sample",
      title: `MCP log search ${search.search_id || "result"}`,
      summary: summarizeSearch(search),
      sourceTool: "search_logs_by_client",
      sourceRef: {
        searchId: search.search_id,
        querySpec,
        summaryCounts: search.summary_counts,
        warnings: search.warnings || [],
      },
      timeWindow: context.approvedScope.timeWindow,
      payload: {
        querySpec,
        summaryCounts: search.summary_counts || {},
        warnings: search.warnings || [],
        redactedSamples: search.top_samples || [],
      },
    });
    const evidenceIds = [evidenceId];

    await context.emitProgress({
      phase: "analysis",
      label: "Asking configured LLM to analyze redacted log evidence",
      percent: 82,
    });
    const totalMatches = Number(search.summary_counts?.total_matches || 0);
    if (totalMatches <= 0) {
      return {
        findings: [
          {
            kind: "no_evidence",
            severity: "info",
            title: "No matching log evidence found",
            summary:
              "The MCP-backed CloudWatch search completed but did not find matching log events in the approved scope.",
            details: {
              searchId: search.search_id,
              summaryCounts: search.summary_counts || {},
              warnings: search.warnings || [],
            },
            confidence: 1,
            evidenceIds: [evidenceId],
          },
        ],
      };
    }

    const followups = await executeAgenticFollowups({
      context,
      scope: scopeResponse.scope as Record<string, unknown>,
      baseQuerySpec: querySpec,
      baseSearch: search,
      baseEvidenceId: evidenceId,
    });
    evidenceIds.push(...followups.evidenceIds);

    const llm = await runWatchdogLlmJson<WatchdogLlmAnalysis>({
      systemPrompt: buildLlmSystemPrompt(),
      userPrompt: buildLlmUserPrompt({
        session: context.session,
        approvedScope: context.approvedScope,
        evidenceIds,
        searches: [{ evidenceId, search }, ...followups.searches],
      }),
      maxTokens: Number(process.env.WATCHDOG_LLM_MAX_OUTPUT_TOKENS || "1800"),
    });
    const findings = normalizeLlmFindings(llm.parsed.findings, {
      evidenceIds,
      providerKey: llm.providerKey,
      modelId: llm.modelId,
      fallbackSummary: summarizeSearch(search),
      totalMatches,
    });
    await getPool().execute(
      "UPDATE watchdog_run_attempts SET metrics_json = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [stringifyJson({ llm: llm.metrics, followupEvidenceCount: followups.evidenceIds.length }), context.runAttempt.id],
    );

    await context.emitProgress({
      phase: "finalization",
      label: `LLM analysis completed with ${llm.providerKey}`,
      percent: 95,
    });
    return { findings };
  }
}

function summarizeSearch(search: McpSearchBundle) {
  const counts = search.summary_counts || {};
  const total = Number(counts.total_matches || 0);
  const returned = Number(counts.returned_samples || 0);
  const regions = Object.keys(counts.regions || {});
  const regionText = regions.length > 0 ? ` across ${regions.join(", ")}` : "";
  return `MCP search ${search.search_id || "unknown"} found ${total} matching events and returned ${returned} redacted samples${regionText}.`;
}

export function buildDeterministicSearchFinding(input: {
  search: McpSearchBundle;
  evidenceId: string;
  approvedScope: WatchdogInvestigationScope;
}): WatchdogInvestigationFinding {
  const counts = input.search.summary_counts || {};
  const totalMatches = Number(counts.total_matches || 0);
  const samples = (input.search.top_samples || [])
    .map((sample) => ({
      message: typeof sample.message === "string" ? sample.message : "",
      logGroup: typeof sample.log_group_name === "string" ? sample.log_group_name : undefined,
      logStream: typeof sample.log_stream === "string" ? sample.log_stream : undefined,
      timestamp: typeof sample.timestamp === "string" ? sample.timestamp : undefined,
    }))
    .filter((sample) => sample.message.trim());
  const messages = samples.map((sample) => sample.message);
  const combined = messages.join("\n");
  const exceptionMatches = [
    ...combined.matchAll(/([A-Za-z0-9_.$]+(?:Exception|Error)):\s*([^;\n]+)/g),
  ];
  const rootException = exceptionMatches.at(-1);
  const exceptionClass = rootException?.[1];
  const exceptionMessage = rootException?.[2]?.trim();
  const beanNames = Array.from(
    new Set([...combined.matchAll(/bean with name '([^']+)'/g)].map((match) => match[1])),
  ).slice(0, 8);
  const terminalBean = [...beanNames]
    .reverse()
    .find((bean) => new RegExp(`bean with name '${escapeRegExpForRegex(bean)}'.{0,240}(?:Invocation of init method failed|${exceptionClass ? escapeRegExpForRegex(exceptionClass) : "$^"})`, "s").test(combined))
    || beanNames.at(-1);
  const contextFailed = /startup failed|Context initialization failed|Error listenerStart|Failed to start/i.test(combined);
  const rootCause = exceptionClass
    ? `${exceptionClass.split(".").at(-1)}${exceptionMessage ? `: ${exceptionMessage}` : ""}`
    : undefined;
  const title = rootCause
    ? contextFailed
      ? `${terminalBean ? `${terminalBean} ` : ""}startup blocked by ${rootCause}`
      : rootCause
    : `Found ${totalMatches} matching log events`;
  const logGroups = Object.keys(counts.log_groups || {});
  const affectedScope = [
    input.approvedScope.clientId,
    input.approvedScope.environment,
    input.approvedScope.serviceIds.join(", "),
    logGroups.length > 0 ? logGroups.join(", ") : undefined,
  ].filter(Boolean).join(" / ");
  const summary = rootCause
    ? [
        `Watchdog found ${totalMatches} matching log events.`,
        contextFailed ? "The samples indicate application startup/context initialization is failing." : undefined,
        terminalBean ? `The deepest failing bean appears to be '${terminalBean}'.` : undefined,
        `Root error: ${rootCause}.`,
      ].filter(Boolean).join(" ")
    : summarizeSearch(input.search);

  return {
    kind: "finding",
    severity: contextFailed || /IllegalArgumentException|BeanCreationException|UnsatisfiedDependencyException/i.test(rootCause || "")
      ? "critical"
      : totalMatches >= 25
        ? "high"
        : "medium",
    title,
    summary,
    details: {
      searchId: input.search.search_id,
      summaryCounts: counts,
      sampleCount: samples.length,
      rootCause,
      rootExceptionClass: exceptionClass,
      rootExceptionMessage: exceptionMessage,
      affectedBean: terminalBean,
      affectedBeans: beanNames,
      affectedScope,
      firstSeen: samples[0]?.timestamp,
      logStreams: Array.from(new Set(samples.map((sample) => sample.logStream).filter(Boolean))).slice(0, 5),
      warnings: input.search.warnings || [],
      sampleMessages: messages.slice(0, 3),
    },
    confidence: rootCause ? 0.9 : 0.8,
    evidenceIds: [input.evidenceId],
  };
}

function escapeRegExpForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLlmSystemPrompt() {
  return [
    "You are Watchdog, a production log investigator.",
    "Analyze only the provided redacted CloudWatch evidence metadata and samples.",
    "Do not invent stack traces, services, users, tickets, or root causes that are not supported by the input.",
    "Return exactly one JSON object with a findings array. No markdown.",
    "Each finding must include kind, severity, title, summary, details, confidence, and evidenceIds.",
    "kind must be one of finding, limitation, no_evidence.",
    "severity must be one of info, low, medium, high, critical.",
    "evidenceIds must cite only IDs provided in the prompt.",
  ].join("\n");
}

function buildLlmUserPrompt(input: {
  session: WatchdogSession;
  approvedScope: WatchdogInvestigationScope;
  evidenceIds: string[];
  searches: Array<{ evidenceId: string; search: McpSearchBundle }>;
}) {
  return JSON.stringify({
    task: "Summarize the most defensible operational findings from this log search.",
    outputSchema: {
      findings: [
        {
          kind: "finding | limitation | no_evidence",
          severity: "info | low | medium | high | critical",
          title: "short operator-facing title",
          summary: "one or two sentences with cited evidence",
          details: {
            suspectedPattern: "string",
            affectedScope: "string",
            nextSteps: ["string"],
          },
          confidence: 0.0,
          evidenceIds: input.evidenceIds,
        },
      ],
    },
    session: {
      id: input.session.id,
      title: input.session.title,
      mode: input.session.mode,
      jiraKey: input.session.jiraKey,
    },
    approvedScope: input.approvedScope,
    evidence: input.searches.map((item) => ({
      evidenceId: item.evidenceId,
      sourceTool: "search_logs_by_client",
      searchId: item.search.search_id,
      summaryCounts: item.search.summary_counts || {},
      warnings: item.search.warnings || [],
      redactedSamples: (item.search.top_samples || []).slice(0, 12),
    })),
  });
}

async function executeAgenticFollowups(input: {
  context: WatchdogInvestigationContext;
  scope: Record<string, unknown>;
  baseQuerySpec: Record<string, unknown>;
  baseSearch: McpSearchBundle;
  baseEvidenceId: string;
}) {
  if (process.env.WATCHDOG_AGENTIC_MCP_LOOP === "disabled") {
    return { evidenceIds: [] as string[], searches: [] as Array<{ evidenceId: string; search: McpSearchBundle }> };
  }
  const totalMatches = Number(input.baseSearch.summary_counts?.total_matches || 0);
  if (totalMatches <= 0) {
    return { evidenceIds: [] as string[], searches: [] as Array<{ evidenceId: string; search: McpSearchBundle }> };
  }

  const plan = await runWatchdogLlmJson<WatchdogMcpFollowupPlan>({
    systemPrompt: [
      "You plan bounded follow-up CloudWatch searches for Watchdog.",
      "Return JSON only. Do not write raw Logs Insights syntax.",
      "Use only querySpec slots: keywords, exact_phrases, severity, component_filters, limit.",
      "Choose zero to two follow-ups that could clarify the pattern from the redacted search summary.",
    ].join("\n"),
    userPrompt: JSON.stringify({
      approvedScope: input.context.approvedScope,
      baseEvidenceId: input.baseEvidenceId,
      baseQuerySpec: input.baseQuerySpec,
      summaryCounts: input.baseSearch.summary_counts || {},
      warnings: input.baseSearch.warnings || [],
      redactedSamples: (input.baseSearch.top_samples || []).slice(0, 8),
    }),
    schema: WATCHDOG_FOLLOWUP_PLAN_SCHEMA,
    maxTokens: 900,
    timeoutMs: Number(process.env.WATCHDOG_CLAUDE_PLAN_TIMEOUT_MS || "60000"),
  }).catch(() => undefined);

  const actions = (plan?.parsed.actions || [])
    .map((action) => ({
      reason: typeof action.reason === "string" ? action.reason : "LLM-planned follow-up",
      querySpec: normalizeFollowupQuerySpec(action.querySpec, input.context.approvedScope),
    }))
    .filter((action) => action.querySpec);

  const evidenceIds: string[] = [];
  const searches: Array<{ evidenceId: string; search: McpSearchBundle }> = [];
  for (const action of actions) {
    await input.context.emitProgress({
      phase: "evidence_collection",
      label: `Running follow-up search: ${action.reason.slice(0, 80)}`,
      percent: 68,
    });
    const search = await callWatchdogMcpTool<McpSearchBundle>("search_logs_by_client", {
      scope: input.scope,
      query_spec: action.querySpec,
    });
    if (search.status && search.status !== "ok") continue;
    const evidenceId = await persistEvidenceArtifact({
      session: input.context.session,
      runAttempt: input.context.runAttempt,
      kind: "log_sample",
      title: `MCP follow-up search ${search.search_id || "result"}`,
      summary: summarizeSearch(search),
      sourceTool: "search_logs_by_client",
      sourceRef: {
        searchId: search.search_id,
        reason: action.reason,
        querySpec: action.querySpec,
        summaryCounts: search.summary_counts,
        warnings: search.warnings || [],
      },
      timeWindow: input.context.approvedScope.timeWindow,
      payload: {
        reason: action.reason,
        querySpec: action.querySpec,
        summaryCounts: search.summary_counts || {},
        warnings: search.warnings || [],
        redactedSamples: search.top_samples || [],
      },
    });
    evidenceIds.push(evidenceId);
    searches.push({ evidenceId, search });
  }
  return { evidenceIds, searches };
}

function normalizeFollowupQuerySpec(
  raw: WatchdogFollowupQuerySpec | undefined,
  scope: WatchdogInvestigationScope,
) {
  if (!raw || typeof raw !== "object") return undefined;
  const keywords = sanitizeStringList(raw.keywords, 6);
  const exactPhrases = sanitizeStringList(raw.exact_phrases, 4);
  const severity = sanitizeStringList(raw.severity, 4);
  const componentFilters = sanitizeStringList(raw.component_filters, 6);
  const limit = Math.min(100, Math.max(1, Number(raw.limit || 50)));
  if (keywords.length + exactPhrases.length + severity.length === 0) return undefined;
  return {
    template_id: keywords.length > 0 || exactPhrases.length > 0 ? "keyword_scan" : "errors",
    keywords,
    exact_phrases: exactPhrases,
    severity,
    component_filters: componentFilters.length > 0 ? componentFilters : scope.serviceIds,
    limit,
  };
}

function sanitizeStringList(values: unknown, maxItems: number) {
  return Array.isArray(values)
    ? Array.from(new Set(values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 120)
      .slice(0, maxItems)))
    : [];
}

function normalizeLlmFindings(
  rawFindings: WatchdogLlmFinding[] | undefined,
  context: {
    evidenceIds: string[];
    providerKey: string;
    modelId: string;
    fallbackSummary: string;
    totalMatches: number;
  },
): WatchdogInvestigationFinding[] {
  const findings = Array.isArray(rawFindings) ? rawFindings : [];
  const normalized = findings
    .slice(0, 5)
    .map((finding): WatchdogInvestigationFinding | null => {
      const kind = normalizeFindingKind(finding.kind);
      const severity = normalizeFindingSeverity(finding.severity, context.totalMatches);
      const title = typeof finding.title === "string" && finding.title.trim()
        ? finding.title.trim().slice(0, 180)
        : "";
      const summary = typeof finding.summary === "string" && finding.summary.trim()
        ? finding.summary.trim().slice(0, 1000)
        : "";
      if (!title || !summary) return null;
      const citedEvidenceIds = Array.isArray(finding.evidenceIds)
        ? finding.evidenceIds.filter((id) => context.evidenceIds.includes(id))
        : [];
      return {
        kind,
        severity,
        title,
        summary,
        details: {
          ...(finding.details && typeof finding.details === "object" ? finding.details : {}),
          llmProvider: context.providerKey,
          modelId: context.modelId,
        },
        confidence: clampConfidence(finding.confidence),
        evidenceIds: citedEvidenceIds.length > 0 ? citedEvidenceIds : [context.evidenceIds[0]],
      };
    })
    .filter((finding): finding is WatchdogInvestigationFinding => Boolean(finding));

  if (normalized.length > 0) return normalized;
  return [
    {
      kind: "finding",
      severity: context.totalMatches >= 25 ? "high" : "medium",
      title: `Found ${context.totalMatches} matching log events`,
      summary: context.fallbackSummary,
      details: {
        deterministicFallback: "llm_returned_no_valid_findings",
        llmProvider: context.providerKey,
        modelId: context.modelId,
      },
      confidence: 0.7,
      evidenceIds: [context.evidenceIds[0]],
    },
  ];
}

function normalizeFindingKind(value: unknown): WatchdogFindingKind {
  return value === "limitation" || value === "no_evidence" || value === "finding" ? value : "finding";
}

function normalizeFindingSeverity(value: unknown, totalMatches: number): WatchdogFindingSeverity {
  if (value === "info" || value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return totalMatches >= 25 ? "high" : "medium";
}

function clampConfidence(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0.7;
  return Math.max(0, Math.min(1, numberValue));
}

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

function normalizeRunAttempt(row: WatchdogRunAttemptRow): WatchdogRunAttempt {
  return {
    id: row.id,
    sessionId: row.session_id,
    attemptNumber: Number(row.attempt_number),
    trigger: row.trigger_cause,
    status: row.status,
    correlationId: row.correlation_id,
    approvedScope: parseJson<WatchdogInvestigationScope>(row.approved_scope),
    providerKey: row.provider_key || undefined,
    modelId: row.model_id || undefined,
    createdAt: iso(row.created_at) || new Date().toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

function classifyRunError(error: unknown): { code: string; reason: string } {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof WatchdogServiceError) {
    return { code: error.code, reason };
  }

  const haystack = reason.toLowerCase();
  if (/(accessdenied|unauthorized|unrecognizedclient|expiredtoken|invalidclienttokenid)/i.test(reason)) {
    return { code: "aws_auth_failed", reason };
  }
  if (/(throttl|rate exceeded|too many requests|limitexceeded)/i.test(reason)) {
    return { code: "aws_throttled", reason };
  }
  if (/(timeout|etimedout|socket hang up|econnreset)/i.test(reason)) {
    return { code: "aws_timeout", reason };
  }
  if (/(mcp|epipe|econnrefused|child process|stdio|spawn)/i.test(reason)) {
    return { code: "mcp_unavailable", reason };
  }
  if (haystack.includes("cloudwatch") || haystack.includes("logs insights") || haystack.includes("filterlogevents")) {
    return { code: "cloudwatch_query_failed", reason };
  }
  return { code: "run_execution_failed", reason };
}

function getInvestigator(): WatchdogInvestigator {
  const key = process.env.WATCHDOG_INVESTIGATOR || "fake_no_evidence";
  if (key === "fake_no_evidence") return new FakeNoEvidenceInvestigator();
  if (key === "mcp_log_search") return new McpLogSearchInvestigator();
  if (key === "llm_log_analysis") return new LlmLogAnalysisInvestigator();
  throw new WatchdogServiceError(`Unsupported Watchdog investigator: ${key}`, 500, "investigator_unsupported");
}

async function loadRunAttempt(runId: string): Promise<WatchdogRunAttempt> {
  const rows = await query<WatchdogRunAttemptRow>(
    "SELECT * FROM watchdog_run_attempts WHERE id = ? LIMIT 1",
    [runId],
  );
  if (!rows[0]) {
    throw new WatchdogServiceError("Run attempt could not be loaded", 500, "run_load_failed");
  }
  return normalizeRunAttempt(rows[0]);
}

async function loadRunStatus(runId: string): Promise<WatchdogRunStatus | null> {
  const rows = await query<mysql.RowDataPacket & { status: WatchdogRunStatus }>(
    "SELECT status FROM watchdog_run_attempts WHERE id = ? LIMIT 1",
    [runId],
  );
  return rows[0]?.status || null;
}

async function ensureRunStillRunning(runId: string): Promise<boolean> {
  return (await loadRunStatus(runId)) === "running";
}

async function markRunFailed(input: {
  session: WatchdogSession;
  runAttempt: WatchdogRunAttempt;
  error: unknown;
}) {
  const { code, reason } = classifyRunError(input.error);
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `
      UPDATE watchdog_run_attempts
      SET status = 'failed',
          failure_code = ?,
          failure_message = ?,
          finished_at = CURRENT_TIMESTAMP(3),
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND status = 'running'
    `,
    [code, reason, input.runAttempt.id],
  );
  if (result.affectedRows !== 1) return;
  await getPool().execute(
    "UPDATE watchdog_sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [input.session.id],
  );
  await appendWatchdogEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    eventType: "run.failed",
    payload: {
      runAttemptId: input.runAttempt.id,
      status: "failed",
      attemptNumber: input.runAttempt.attemptNumber,
      code,
      reason,
    },
  });
  await appendWatchdogEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    eventType: "session.updated",
    payload: { sessionId: input.session.id, status: "failed", title: input.session.title },
  });
  await appendWatchdogAuditEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    actorId: "watchdog-agent",
    actorType: "agent_runtime",
    eventType: "run.failed",
    payload: { code, reason },
  });
}

async function persistFinding(input: {
  session: WatchdogSession;
  runAttempt: WatchdogRunAttempt;
  finding: WatchdogInvestigationFinding;
}) {
  if (!(await ensureRunStillRunning(input.runAttempt.id))) {
    throw new WatchdogServiceError("Run attempt is no longer active", 409, "run_no_longer_active");
  }
  const findingId = makeId("wdg_find");
  const evidenceIds = input.finding.evidenceIds || [];
  if (evidenceIds.length > 0) {
    const rows = await query<mysql.RowDataPacket & { id: string }>(
      `
        SELECT id
        FROM watchdog_evidence_artifacts
        WHERE session_id = ? AND run_attempt_id = ? AND id IN (${evidenceIds.map(() => "?").join(",")})
      `,
      [input.session.id, input.runAttempt.id, ...evidenceIds],
    );
    if (rows.length !== evidenceIds.length) {
      throw new WatchdogServiceError(
        "Finding cites evidence artifacts that do not belong to this run attempt",
        500,
        "finding_evidence_invalid",
      );
    }
  }
  await getPool().execute(
    `
      INSERT INTO watchdog_findings (
        id, session_id, run_attempt_id, kind, severity, title, summary, details,
        confidence, evidence_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      findingId,
      input.session.id,
      input.runAttempt.id,
      input.finding.kind,
      input.finding.severity,
      input.finding.title,
      input.finding.summary,
      stringifyJson(input.finding.details || {}),
      input.finding.confidence ?? null,
      stringifyJson(evidenceIds),
    ],
  );
  await appendWatchdogEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    eventType: "finding.created",
    payload: {
      findingId,
      kind: input.finding.kind,
      severity: input.finding.severity,
      title: input.finding.title,
      evidenceIds,
    },
  });
}

async function persistEvidenceArtifact(input: {
  session: WatchdogSession;
  runAttempt: WatchdogRunAttempt;
  kind: string;
  title: string;
  summary: string;
  sourceTool: string;
  sourceRef: Record<string, unknown>;
  timeWindow: unknown;
  payload?: unknown;
}) {
  if (!(await ensureRunStillRunning(input.runAttempt.id))) {
    throw new WatchdogServiceError("Run attempt is no longer active", 409, "run_no_longer_active");
  }
  const evidenceId = makeId("wdg_ev");
  const storedPayload = input.payload === undefined
    ? undefined
    : await putWatchdogEvidencePayload({
      sessionId: input.session.id,
      runAttemptId: input.runAttempt.id,
      evidenceId,
      payload: input.payload,
    });
  await getPool().execute(
    `
      INSERT INTO watchdog_evidence_artifacts (
        id, session_id, run_attempt_id, kind, title, summary, source_tool,
        source_ref_json, time_window, s3_bucket, s3_key, sha256, byte_count,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 7 DAY))
    `,
    [
      evidenceId,
      input.session.id,
      input.runAttempt.id,
      input.kind,
      input.title,
      input.summary,
      input.sourceTool,
      stringifyJson(input.sourceRef),
      stringifyJson(input.timeWindow),
      storedPayload?.bucket || null,
      storedPayload?.key || null,
      storedPayload?.sha256 || null,
      storedPayload?.byteCount || null,
    ],
  );
  await appendWatchdogEvent({
    sessionId: input.session.id,
    runAttemptId: input.runAttempt.id,
    correlationId: input.runAttempt.correlationId,
    eventType: "evidence.created",
    payload: {
      evidenceId,
      kind: input.kind,
      title: input.title,
      sourceTool: input.sourceTool,
    },
  });
  return evidenceId;
}

export async function runNextWatchdogAttemptForSession(sessionId: string): Promise<WatchdogRunAttempt> {
  await reapStaleWatchdogRunAttempts();
  const session = await getWatchdogSession(sessionId);
  if (!session) {
    throw new WatchdogServiceError("Watchdog session not found", 404, "session_not_found");
  }
  if (!session.latestRunAttempt || session.latestRunAttempt.status !== "queued") {
    throw new WatchdogServiceError("Session does not have a queued run attempt", 409, "run_not_queued");
  }
  const approvedScope = session.latestRunAttempt.approvedScope || session.approvedScope;
  if (!approvedScope) {
    throw new WatchdogServiceError("Queued run attempt does not have an approved scope", 409, "approved_scope_missing");
  }

  const runId = session.latestRunAttempt.id;
  const replicaId = process.env.HOSTNAME || `local-${process.pid}`;
  const [claimResult] = await getPool().execute<mysql.ResultSetHeader>(
    `
      UPDATE watchdog_run_attempts
      SET status = 'running',
          claimed_by_replica = ?,
          claimed_at = CURRENT_TIMESTAMP(3),
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ? AND status = 'queued'
    `,
    [replicaId, runId],
  );

  if (claimResult.affectedRows !== 1) {
    throw new WatchdogServiceError("Queued run attempt was already claimed", 409, "run_claim_conflict");
  }

  await getPool().execute(
    "UPDATE watchdog_sessions SET status = 'running', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [sessionId],
  );

  const runAttempt = await loadRunAttempt(runId);
  await appendWatchdogAuditEvent({
    sessionId,
    runAttemptId: runId,
    correlationId: runAttempt.correlationId,
    actorId: replicaId,
    actorType: "agent_runtime",
    eventType: "run.started",
    payload: { attemptNumber: runAttempt.attemptNumber },
  });
  await appendWatchdogEvent({
    sessionId,
    runAttemptId: runId,
    correlationId: runAttempt.correlationId,
    eventType: "run.started",
    payload: {
      runAttemptId: runId,
      status: "running",
      attemptNumber: runAttempt.attemptNumber,
    },
  });

  try {
    const investigator = getInvestigator();
    const result = await investigator.investigate({
      session,
      runAttempt,
      approvedScope,
      emitProgress: async (update) => {
        if (!(await ensureRunStillRunning(runId))) {
          throw new WatchdogServiceError("Run attempt is no longer active", 409, "run_no_longer_active");
        }
        await appendWatchdogEvent({
          sessionId,
          runAttemptId: runId,
          correlationId: runAttempt.correlationId,
          eventType: "run.progress",
          payload: {
            phase: update.phase,
            investigator: investigator.key,
            progressHint: { label: update.label, percent: update.percent },
          },
        });
      },
    });

    for (const finding of result.findings) {
      await persistFinding({ session, runAttempt, finding });
    }

    if (!(await ensureRunStillRunning(runId))) {
      return loadRunAttempt(runId);
    }

    const [completeResult] = await getPool().execute<mysql.ResultSetHeader>(
      `
        UPDATE watchdog_run_attempts
        SET status = 'completed',
            finished_at = CURRENT_TIMESTAMP(3),
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND status = 'running'
      `,
      [runId],
    );
    if (completeResult.affectedRows !== 1) {
      return loadRunAttempt(runId);
    }
    await getPool().execute(
      "UPDATE watchdog_sessions SET status = 'completed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [sessionId],
    );
    await appendWatchdogEvent({
      sessionId,
      runAttemptId: runId,
      correlationId: runAttempt.correlationId,
      eventType: "run.completed",
      payload: {
        runAttemptId: runId,
        status: "completed",
        attemptNumber: runAttempt.attemptNumber,
      },
    });
    await appendWatchdogEvent({
      sessionId,
      runAttemptId: runId,
      correlationId: runAttempt.correlationId,
      eventType: "session.updated",
      payload: { sessionId, status: "completed", title: session.title },
    });
    await appendWatchdogAuditEvent({
      sessionId,
      runAttemptId: runId,
      correlationId: runAttempt.correlationId,
      actorId: replicaId,
      actorType: "agent_runtime",
      eventType: "run.completed",
      payload: { attemptNumber: runAttempt.attemptNumber },
    });

    return loadRunAttempt(runId);
  } catch (error) {
    await markRunFailed({ session, runAttempt, error });
    throw error;
  }
}

export async function reapStaleWatchdogRunAttempts() {
  const maxAgeSeconds = Math.max(60, Number(process.env.WATCHDOG_RUNNING_STALE_SECONDS || "1800"));
  const rows = await query<WatchdogStaleRunRow>(
    `
      SELECT r.id, r.session_id, r.attempt_number, r.correlation_id, s.title
      FROM watchdog_run_attempts r
      JOIN watchdog_sessions s ON s.id = r.session_id
      WHERE r.status = 'running'
        AND COALESCE(r.claimed_at, r.updated_at, r.started_at, r.created_at) < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${Math.floor(maxAgeSeconds)} SECOND)
      ORDER BY r.claimed_at ASC
      LIMIT 25
    `,
  );

  let reaped = 0;
  for (const row of rows) {
    const reason = `Run attempt exceeded stale claim window of ${maxAgeSeconds} seconds`;
    const [result] = await getPool().execute<mysql.ResultSetHeader>(
      `
        UPDATE watchdog_run_attempts
        SET status = 'failed',
            failure_code = 'run_stale_claim',
            failure_message = ?,
            finished_at = CURRENT_TIMESTAMP(3),
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND status = 'running'
      `,
      [reason, row.id],
    );
    if (result.affectedRows !== 1) continue;
    reaped += 1;
    await getPool().execute(
      "UPDATE watchdog_sessions SET status = 'failed', updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [row.session_id],
    );
    await appendWatchdogEvent({
      sessionId: row.session_id,
      runAttemptId: row.id,
      correlationId: row.correlation_id,
      eventType: "run.failed",
      payload: {
        runAttemptId: row.id,
        status: "failed",
        attemptNumber: row.attempt_number,
        code: "run_stale_claim",
        reason,
      },
    });
    await appendWatchdogEvent({
      sessionId: row.session_id,
      runAttemptId: row.id,
      correlationId: row.correlation_id,
      eventType: "session.updated",
      payload: { sessionId: row.session_id, status: "failed", title: row.title },
    });
  }

  return { status: "ok", scanned: rows.length, reaped, maxAgeSeconds };
}

export function startWatchdogBackgroundJobs() {
  const setting = process.env.WATCHDOG_BACKGROUND_JOBS?.trim().toLowerCase();
  if (setting !== "enabled") {
    return { enabled: false, stop: () => undefined };
  }
  const reaperSeconds = Math.max(30, Number(process.env.WATCHDOG_REAPER_INTERVAL_SECONDS || "60"));
  const cleanupSeconds = Math.max(300, Number(process.env.WATCHDOG_CLEANUP_INTERVAL_SECONDS || "900"));
  const runReaper = () => {
    void reapStaleWatchdogRunAttempts()
      .then(() => expireOpenWatchdogClarifications())
      .catch((error) => console.warn("[watchdog] background reaper failed:", error));
  };
  const runCleanup = () => {
    void cleanupExpiredWatchdogRows()
      .catch((error) => console.warn("[watchdog] background cleanup failed:", error));
  };
  const reaper = setInterval(runReaper, reaperSeconds * 1000);
  const cleanup = setInterval(runCleanup, cleanupSeconds * 1000);
  runReaper();
  return {
    enabled: true,
    stop: () => {
      clearInterval(reaper);
      clearInterval(cleanup);
    },
  };
}
