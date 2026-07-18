import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  COMPOSE_SESSION_EXPORT_FORMAT,
  COMPOSE_SESSION_EXPORT_VERSION,
  ComposeSessionExportBundleSchema,
  composeSourceJiraKey,
} from "./compose-types.js";
import { mediaMimeOrExt } from "./compose-conversion.js";
import type {
  ClaimedTurnJob,
  ComposeRepository,
  ParkTurnForResearchTaskInput,
  TurnAgentTaskSummary,
} from "./compose-database.js";
import type { SpecFactoryRepository } from "./database.js";
import type {
  ComposeSessionExportBundle,
  ComposeSessionImportResult,
  ComposeSessionSummary,
  ComposeSourceDeletionSummary,
  ComposeUploadTarget,
} from "./compose-types.js";
import type {
  ComposeChatRunInput,
  ComposeChatRunOutput,
} from "./compose-chat-agent.js";
import {
  LegacyComposeChatExecutor,
  type LegacyComposeChatRunner,
} from "./agents/legacy-compose-chat-executor.js";
import {
  ChatCoordinationExecutor,
  type ChatCoordinatorRunner,
} from "./agents/chat-coordination-executor.js";
import {
  normalizeConfluenceUrl,
  normalizeYoutubeUrl,
} from "./compose-url-policy.js";
import {
  SYSTEM_ACTOR,
  actorContextFromSpecFactoryActor,
  type ActorContext,
  assertSessionExists,
  assertSessionHandoffAllowed,
  assertSessionMutable,
  assertSessionReadable,
  assertSessionStreamable,
} from "./session/session-guard.js";
import {
  buildCoordinatorContextBundle,
  type CoordinatorContextBundle,
  type CoordinatorDecision,
} from "./agents/chat-coordinator.js";
import { resolveResearchMaxCostUsd } from "./agents/research-executors.js";
import {
  buildHandoffBundle,
  buildHandoffEvidenceManifest,
  type HandoffBundle,
  type HandoffArtifactBytes,
} from "./agents/handoff-builder.js";
import type { CodeRepository } from "../orchestrator/database.js";
import { createLogger } from "../utils/logger.js";
import type {
  ComposeContextProjection,
  ComposeContextProjectionSummary,
  ComposeConversionStatus,
  ComposeReadiness,
  ComposeChatEvent,
  ComposeCodeInvestigation,
  ComposeRepoEvidence,
  ComposeRepositoryOption,
  ComposeSessionSourceSummary,
  ComposeTurnAccepted,
} from "./compose-types.js";
import { resolveSpecFactoryRetentionPolicy } from "./session/retention-policy.js";
import {
  ResearchBudgetError,
  SourceRestoreUnavailableError,
} from "./errors.js";
import { buildConversationContextPatch } from "./context/context-model.js";
import {
  clarificationType,
  isUserFacingClarification,
} from "./requirements-policy.js";
import {
  specFactoryMetrics,
  type SpecFactoryCoordinatorOutcome,
  type SpecFactoryMetrics,
} from "./telemetry/metrics.js";

const logger = createLogger("compose-service");

// Max pending clarification turns (running + queued) per session before new
// turns are rejected with queue_full. Each turn is a multi-minute model call
// run serially, so a small cap bounds latency + memory without hurting the
// normal one-at-a-time flow.
const MAX_QUEUED_TURNS_PER_SESSION = Number(
  process.env.COMPOSE_MAX_QUEUED_TURNS || 3,
);

// Hard ceiling on per-source upload size. Mirrors the sidecar's 500MB cap so a
// rejected upload fails fast at the API instead of after the presigned PUT.
const MAX_UPLOAD_BYTES = Number(
  process.env.COMPOSE_MAX_UPLOAD_BYTES || 524_288_000,
);

// Per-attempt backoff base for retrying transient chat-turn failures. Test
// suites set this to 1ms; production defaults to 1s so the bounded
// 1s/2s schedule stays well under any client timeout. Read on each call so
// vitest can override via process.env in beforeAll without losing the value
// to module-load capture.
function chatRetryBaseMs(): number {
  return Number(process.env.COMPOSE_RETRY_BASE_MS || 1000);
}
const CHAT_RETRY_MAX_ATTEMPTS = 3;
const TURN_FINAL_WRITE_MAX_ATTEMPTS = 3;

// Stream-token TTL for password-protected sessions. Tokens are SHA-256 hashed
// and stored in compose_stream_tokens; the plaintext value is only returned to
// the caller once at resume time.
const STREAM_TOKEN_TTL_MS = 30 * 60 * 1000;
const LEGACY_TURN_WORKER_ID = "legacy-compose-service";
const TURN_LEASE_MS = Number(process.env.SPEC_FACTORY_TURN_LEASE_MS || 300_000);
const DURABLE_TURN_MODES = ["off", "shadow", "drain", "on"] as const;
const RESEARCH_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESEARCH_INFLIGHT_TASKS_PER_SESSION = 3;
const COORDINATOR_RESEARCH_CAPABILITIES = new Set([
  "code_research",
  "config_research",
  "devops_research",
]);

type DurableTurnMode = (typeof DURABLE_TURN_MODES)[number];

type ComposeServiceComposeRepo = Pick<
  ComposeRepository,
  | "createSession"
  | "updateSessionPaths"
  | "recordSessionActivity"
  | "getSession"
  | "getLatestContextProjection"
  | "getContextProjection"
  | "getSessionPasswordHash"
  | "listSessions"
  | "archiveSessionWithWorkCancellation"
  | "cancelTurnJob"
  | "addNoteSource"
  | "createJiraSource"
  | "createConfluenceSource"
  | "restoreConvertedSource"
  | "deleteSessionSource"
  | "listUndoableSourceDeletions"
  | "restoreSessionSource"
  | "markSessionContextDirty"
  | "linkSource"
  | "createUploadSource"
  | "createYoutubeSource"
  | "updateSourceS3Key"
  | "getSessionSource"
  | "listSessionSources"
  | "listSessionSourceContents"
  | "reconvertSource"
  | "reconvertFailedSessionSources"
  | "markSourceUploaded"
  | "completeSourceConversion"
  | "appendMessage"
  | "listMessages"
  | "getSessionWorkflowState"
  | "setClaudeSessionId"
  | "setReadiness"
  | "resetSessionProgress"
  | "createMessageTurn"
  | "createAnalyzeTurn"
  | "createAgentTask"
  | "createHandoffBuildTask"
  | "commitHandoffSnapshot"
  | "markHandoffDraftQueued"
  | "listTurnAgentTasks"
  | "getSessionResearchBudgetUsage"
  | "getGlobalResearchBudgetUsage"
  | "parkTurnForResearch"
  | "parkTurnForClarification"
  | "answerAwaitingClarification"
  | "appendSessionEvent"
  | "markTurnJobRunning"
  | "renewTurnLease"
  | "confirmTurnLease"
  | "markTurnJobFailed"
  | "completeTurnWithAssistantMessage"
  | "appendAssistantMessageIfSessionActive"
  | "createStreamToken"
  | "verifyStreamTokenHash"
  | "revokeSessionStreamTokens"
>;
type ComposeServiceSpecRepo = Pick<
  SpecFactoryRepository,
  "createComposeSource" | "createEvidenceSnapshot"
>;

interface DraftRequester {
  requestDraftGeneration(input: {
    sourceId: number;
    actor?: string | null;
  }): Promise<unknown>;
}

interface UploadIssuer {
  createUploadUrl(input: {
    s3Prefix: string;
    sourceId: number;
    filename: string;
    mimeType: string | null;
  }): Promise<ComposeUploadTarget>;
  createPreviewUrl(input: {
    s3KeyRaw: string;
    filename: string;
    mimeType: string | null;
  }): Promise<string>;
}

interface ConversionKicker {
  drain(): Promise<void>;
}

interface ChatAgentLike {
  run(input: ComposeChatRunInput): Promise<ComposeChatRunOutput>;
}

interface LegacyComposeChatExecutorLike {
  execute(input: ComposeChatRunInput): Promise<ComposeChatRunOutput>;
}

interface ChatCoordinatorLike {
  decide(bundle: CoordinatorContextBundle): Promise<CoordinatorDecision>;
}

interface ChatCoordinationExecutorLike {
  execute(bundle: CoordinatorContextBundle): Promise<CoordinatorDecision>;
}

interface RepoGroundingLike {
  groundRepos(input: {
    selectedRepositoryIds: number[];
    sources: Array<{ filename: string; content: string }>;
  }): Promise<{
    codeRepoIds: string[];
    repositoriesMarkdown: string;
    manifest: ComposeRepoEvidence[];
  }>;
}

interface WorkspaceManagerLike {
  prepare(input: {
    sessionId?: number | null;
    workspacePath: string;
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    sources?: Array<{ sourceId: number; filename: string; content: string }>;
    contextMarkdown?: string;
    repositoryContextMarkdown?: string;
  }): Promise<string>;
  writeArtifact(input: {
    workspacePath: string;
    relativePath: string;
    content: string | Buffer;
  }): Promise<{
    artifactUri: string;
    relativePath: string;
    bytes: number;
    sha256: string;
  }>;
}

interface SseHubLike {
  publish(sessionId: number, event: ComposeChatEvent): void | Promise<void>;
}

interface ActiveTurnLease {
  turnJobId: number;
  workerId: string;
  leaseGeneration: number;
  lost: boolean;
}

interface AssistantTurnWrite {
  assistantMessageId: number | null;
  deduplicated: boolean;
  discardedDueToArchive?: boolean;
}

class LostTurnLeaseError extends Error {
  constructor(turnJobId: number) {
    super(`Compose turn job ${turnJobId} lease was lost`);
    this.name = "LostTurnLeaseError";
  }
}

interface JiraSourceFetcher {
  fetchMarkdown(jiraKey: string): Promise<{
    issueKey: string;
    title: string;
    sourceUrl: string;
    markdownContent: string;
  }>;
}

interface ComposeServiceConfig {
  workspaceBase: string;
  s3Prefix: string;
}

interface ComposeServiceOptions {
  jiraSourceFetcher?: JiraSourceFetcher;
  lookupRepositories?: () => Promise<CodeRepository[]>;
  repoGrounding?: RepoGroundingLike;
  chatCoordinator?: ChatCoordinatorLike | null;
  legacyChatExecutor?: LegacyComposeChatExecutorLike;
  chatCoordinationExecutor?: ChatCoordinationExecutorLike | null;
  metrics?: Pick<SpecFactoryMetrics, "recordCoordinatorRoute">;
}

function requireSession(
  session: ComposeSessionSummary | null,
  sessionId: number,
): ComposeSessionSummary {
  return assertSessionExists(session, sessionId);
}

function actorContextFromActorId(
  actor: string | null | undefined,
): ActorContext {
  if (!actor) return SYSTEM_ACTOR;
  return actorContextFromSpecFactoryActor({ id: actor, display: actor });
}

const scryptAsync = promisify(scryptCallback);
const PASSWORD_HASH_PREFIX = "scrypt:v1";

function normalizedPassword(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeJiraKey(value: string): string {
  const jiraKey = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(jiraKey)) {
    throw new Error("Jira key is required and must look like ABC-123");
  }
  return jiraKey;
}

function imageMimeOrExt(
  mimeType: string | null,
  filename: string | null,
): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  const name = (filename ?? "").toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].some((ext) =>
    name.endsWith(ext),
  );
}

async function hashSessionPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scryptAsync(password, salt, 32)) as Buffer;
  return `${PASSWORD_HASH_PREFIX}:${salt}:${derived.toString("base64url")}`;
}

async function verifySessionPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(":");
  if (
    parts.length !== 4 ||
    `${parts[0]}:${parts[1]}` !== PASSWORD_HASH_PREFIX
  ) {
    return false;
  }
  const [, , salt, encodedHash] = parts;
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = (await scryptAsync(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ER_DUP_ENTRY"
  );
}

const ANALYZE_BLOCKING_STATUSES = new Set<ComposeConversionStatus>([
  "awaiting_upload",
  "pending",
  "converting",
]);

const HANDOFF_BLOCKING_STATUSES = new Set<ComposeConversionStatus>([
  "awaiting_upload",
  "pending",
  "converting",
  "failed",
  "unsupported",
]);

function formatBlockedSources(sources: ComposeSessionSourceSummary[]): string {
  return sources
    .map(
      (source) =>
        `${source.originalFilename ?? source.sourceUrl ?? `source-${source.id}`} (${source.conversionStatus})`,
    )
    .join(", ");
}

function handoffErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handoffFailureReason(error: unknown): string {
  const message = handoffErrorMessage(error);
  if (/blocked sources/i.test(message)) return "blocked_sources";
  if (/not found/i.test(message)) return "session_not_found";
  if (/duplicate/i.test(message)) return "duplicate_source";
  return "handoff_failed";
}

function handoffEnrichmentEnabled(): boolean {
  return ["true", "1", "yes"].includes(
    (process.env.SPEC_FACTORY_HANDOFF_ENRICHED ?? "").toLowerCase(),
  );
}

function truthyEnv(value: string | undefined): boolean {
  return ["true", "1", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

function handoffBuildTaskEnabled(): boolean {
  return truthyEnv(process.env.SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED);
}

function legacyRuntimeDisabled(): boolean {
  return (
    process.env.SPEC_FACTORY_LEGACY_RUNTIME?.trim().toLowerCase() === "disabled"
  );
}

function criticReviewEnqueueEnabled(): boolean {
  return (
    truthyEnv(process.env.SPEC_FACTORY_ENABLE_CRITIC) &&
    truthyEnv(process.env.SPEC_FACTORY_LLM_GATEWAY)
  );
}

function isMissingResumeConversation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No conversation found with session ID/i.test(message);
}

/**
 * Conservative classifier for transient chat-turn failures. Only patterns we
 * are confident about retry — everything else is treated as deterministic so
 * we never mask a real bug by silently retrying. Bedrock's typical transient
 * failures surface as throttling, 5xx, request timeouts, or network resets.
 */
function isTransientChatError(message: string): boolean {
  if (!message) return false;
  // The Claude SDK reports its own wall-clock/tool-stall budget as a timeout.
  // Retrying the whole agent run cannot make that same work cheaper or faster;
  // it only multiplies latency and spend. Network-level timeouts remain
  // retryable through their explicit transport error codes below.
  if (
    /SDK timeout after|Claude SDK timeout|wall_timeout|tool_stall/i.test(
      message,
    )
  ) {
    return false;
  }
  if (/throttl/i.test(message)) return true;
  if (/\b429\b/.test(message)) return true;
  if (/\b5\d\d\b/.test(message)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(message)) return true;
  if (/request timeout|request timed out/i.test(message)) return true;
  if (/network|socket hang up/i.test(message)) return true;
  if (/service unavailable|temporarily unavailable/i.test(message)) return true;
  return false;
}

function isCoordinatorDecisionRejected(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("coordinator_decision_rejected:")
  );
}

function coordinatorMetricReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("coordinator_decision_rejected:")) {
    return "decision_rejected";
  }
  if (message.startsWith("llm_budget_exceeded:")) return "budget_exceeded";
  if (message === "llm_budget_requires_max_cost") {
    return "budget_configuration";
  }
  if (/throttl|rate.?limit|\b429\b/i.test(message)) return "provider_throttled";
  if (/timeout|timed out/i.test(message)) return "provider_timeout";
  return "execution_failed";
}

function parseCoordinatorDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function coordinatorEscalationMessage(reason: string): string {
  return `I can't answer safely with the current context/tools: ${reason.trim()}`;
}

function optionalNonNegativeNumber(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalNonNegativeInteger(raw: string | undefined): number | null {
  const value = optionalNonNegativeNumber(raw);
  if (value === null) return null;
  return Number.isInteger(value) ? value : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneReadiness(readiness: ComposeReadiness | null): ComposeReadiness {
  if (!readiness) {
    return { ready: false, openQuestions: [], summary: "" };
  }
  return {
    ...readiness,
    openQuestions: [...readiness.openQuestions],
    risks: readiness.risks ? [...readiness.risks] : undefined,
    assumptions: readiness.assumptions ? [...readiness.assumptions] : undefined,
    missingEvidence: readiness.missingEvidence
      ? [...readiness.missingEvidence]
      : undefined,
    validatorWarnings: readiness.validatorWarnings
      ? readiness.validatorWarnings.map((warning) => ({ ...warning }))
      : undefined,
  };
}

function normalizeRepositoryIds(repositoryIds?: number[]): number[] {
  const ids = new Set<number>();
  for (const id of repositoryIds ?? []) {
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].slice(0, 25);
}

function fastChatAcknowledgement(content: string | null): string | null {
  const normalized = content
    ?.trim()
    .toLowerCase()
    .replace(/[!?.\s]+$/g, "");
  if (!normalized) return null;
  if (/^(hi|hello|hey|hiya|yo)$/.test(normalized)) {
    return "Hi. I'm here. What would you like to do next?";
  }
  if (/^(thanks|thank you|thx)$/.test(normalized)) {
    return "You're welcome.";
  }
  if (/^(ok|okay|got it|sounds good)$/.test(normalized)) {
    return "Got it.";
  }
  return null;
}

function isMysqlDeadlock(error: unknown): boolean {
  const candidate = error as { code?: string; errno?: number };
  return candidate.code === "ER_LOCK_DEADLOCK" || candidate.errno === 1213;
}

function boundedCriticText(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const maxChars = 24_000;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[critic input truncated]`;
}

function codeResearchExecutorEnabled(): boolean {
  return (
    process.env.SPEC_FACTORY_RESEARCH_EXECUTOR?.trim().toLowerCase() ===
    "claude_agent_sdk"
  );
}

function codeResearchEnqueueEnabled(): boolean {
  const ingressEnabled = truthyEnv(
    process.env.SPEC_FACTORY_RESEARCH_INGRESS_ENABLED,
  );
  return codeResearchExecutorEnabled() && ingressEnabled;
}

function sourceDistillationEnabled(): boolean {
  return ["true", "1", "yes"].includes(
    (process.env.SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION ?? "")
      .trim()
      .toLowerCase(),
  );
}

function streamTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function turnRequestHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function turnLeaseUntil(): Date {
  return new Date(Date.now() + TURN_LEASE_MS);
}

function turnLeaseHeartbeatMs(): number {
  const configured = Number(process.env.SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.trunc(configured);
  }
  return Math.max(1_000, Math.floor(TURN_LEASE_MS / 2));
}

function durableTurnMode(): DurableTurnMode {
  const mode = process.env.SPEC_FACTORY_DURABLE_TURNS;
  return DURABLE_TURN_MODES.includes(mode as DurableTurnMode)
    ? (mode as DurableTurnMode)
    : "off";
}

function legacyTurnExecutionEnabled(): boolean {
  const mode = durableTurnMode();
  return mode !== "drain" && mode !== "on";
}

function durableTurnWorkerExecutionEnabled(): boolean {
  const mode = durableTurnMode();
  return mode === "drain" || mode === "on";
}

function mapRepositoryOption(repo: CodeRepository): ComposeRepositoryOption {
  return {
    id: repo.id,
    repoName: repo.repo_name,
    repoUrl: repo.repo_url,
    defaultBranch: repo.default_branch ?? null,
    description: repo.description ?? "",
  };
}

function mapCoordinatorPendingTask(
  task: TurnAgentTaskSummary,
): CoordinatorContextBundle["pendingTasks"][number] {
  return {
    id: task.id,
    capability: task.capability,
    status: task.status,
    executorType: task.executorType,
    question: task.question,
    maxCostUsd: task.maxCostUsd,
    outputSourceId: task.outputSourceId,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  };
}

function renderRepositoryContext(
  repositories: ComposeRepositoryOption[],
): string | undefined {
  if (repositories.length === 0) return undefined;
  const body = repositories
    .map((repo) =>
      [
        `- ${repo.repoName}`,
        `  - Repository ID: ${repo.id}`,
        `  - Default branch: ${repo.defaultBranch ?? "unknown"}`,
        `  - URL: ${repo.repoUrl || "unknown"}`,
        repo.description ? `  - Description: ${repo.description}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
  return [
    "# Selected code repositories",
    "",
    "The operator selected these repositories before analysis. Use them as repo grounding and prefer them over guessing from ambiguous source text.",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Summarize the clarification agent's real code investigation from its run
 * metrics (distinct files Read + total Read/Grep/Glob/Bash tool calls). Returns
 * null when the agent did no code tool calls, so we don't claim investigation
 * that didn't happen.
 */
function summarizeCodeInvestigation(
  metrics: ComposeChatRunOutput["metrics"],
): ComposeCodeInvestigation | null {
  const toolCalls = metrics?.toolCalls ?? 0;
  const filesRead =
    metrics?.sdkLifecycleSummary?.distinctFilesRead ??
    metrics?.sdkLifecycleSummary?.readCount ??
    0;
  if (toolCalls <= 0 && filesRead <= 0) return null;
  return { filesRead, toolCalls };
}

function serviceText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function serviceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(serviceText).filter((item): item is string => item !== null)
    : [];
}

function firstProjectionFactText(values: unknown[]): string | null {
  for (const value of values) {
    const direct = serviceText(value);
    if (direct) return direct;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const candidate = serviceText(obj.text) ?? serviceText(obj.summary);
    if (candidate) return candidate;
  }
  return null;
}

function projectionQuestion(
  value: unknown,
  index: number,
): NonNullable<ComposeReadiness["questions"]>[number] | null {
  const direct = serviceText(value);
  if (direct) {
    return {
      id: `context-question-${index + 1}`,
      question: direct,
      questionType: clarificationType(direct),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const question =
    serviceText(obj.question) ??
    serviceText(obj.text) ??
    serviceText(obj.title) ??
    serviceText(obj.summary);
  if (!question) return null;
  return {
    id: serviceText(obj.id) ?? `context-question-${index + 1}`,
    question,
    ...(serviceStringArray(obj.options).slice(0, 3).length > 0
      ? { options: serviceStringArray(obj.options).slice(0, 3) }
      : {}),
    ...(typeof obj.answered === "boolean" ? { answered: obj.answered } : {}),
    ...(serviceText(obj.answer) ? { answer: serviceText(obj.answer)! } : {}),
    questionType: clarificationType(obj),
  };
}

function contextProjectionToReadiness(
  projection: ComposeContextProjection | null,
): ComposeReadiness | null {
  if (!projection) return null;
  const summary = projection.summary;
  const problem =
    serviceText(summary?.problemStatement) ??
    serviceText(summary?.objective) ??
    firstProjectionFactText(projection.facts);
  const actions = serviceStringArray(summary?.recommendedNextActions);
  const questions = projection.openQuestions
    .filter(isUserFacingClarification)
    .map((question, index) => projectionQuestion(question, index))
    .filter(
      (
        question,
      ): question is NonNullable<ComposeReadiness["questions"]>[number] =>
        question !== null,
    );
  const openQuestions = questions
    .filter((question) => question.answered !== true)
    .map((question) => question.question);
  const summaryText =
    serviceText(summary?.objective) ??
    problem ??
    `Working context v${projection.version}`;
  return {
    ready: openQuestions.length === 0,
    openQuestions,
    summary: summaryText,
    ...(problem ? { problem } : {}),
    ...(serviceText(summary?.solution)
      ? { solution: serviceText(summary?.solution)! }
      : {}),
    ...(summary?.businessRequirements?.length
      ? { businessRequirements: [...summary.businessRequirements] }
      : {}),
    ...(summary?.functionalRequirements?.length
      ? { functionalRequirements: [...summary.functionalRequirements] }
      : {}),
    ...(summary?.challenges?.length
      ? { challenges: [...summary.challenges] }
      : {}),
    ...(summary?.stories?.length ? { stories: [...summary.stories] } : {}),
    ...(actions.length > 0 ? { ideating: actions.join("\n") } : {}),
    ...(actions[0] ? { nextStep: actions[0] } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    validatorWarnings: [
      {
        code: "context_projection",
        message: `Readiness was projected from Working Context version ${projection.version}.`,
        severity: "info",
      },
    ],
  };
}

function contextProjectionWithReadinessFallback(
  projection: ComposeContextProjection | null,
  readiness: ComposeReadiness | null,
): ComposeContextProjection | null {
  if (!projection || projection.summary || !readiness) return projection;

  const nextStep = serviceText(readiness.nextStep);
  const recommendedNextActions = nextStep ? [nextStep] : [];
  const summary: ComposeContextProjectionSummary = {
    objective: serviceText(readiness.summary) ?? serviceText(readiness.problem),
    problemStatement:
      serviceText(readiness.problem) ?? serviceText(readiness.summary),
    solution:
      serviceText(readiness.solution) ?? serviceText(readiness.ideating),
    businessRequirements: serviceStringArray(readiness.businessRequirements),
    functionalRequirements: serviceStringArray(
      readiness.functionalRequirements,
    ),
    challenges: serviceStringArray(readiness.challenges),
    stories: [...(readiness.stories ?? [])],
    recommendedNextActions,
  };

  return { ...projection, summary };
}

export class ComposeService {
  private readonly activeTurns = new Set<number>();
  private readonly queuedTurns = new Map<number, Promise<void>>();
  private readonly legacyRunningTurns = new Set<number>();
  // Pending turns (running + queued) per session. Bounds the serial chain so a
  // burst of messages cannot enqueue unbounded multi-minute model calls.
  private readonly queuedDepth = new Map<number, number>();
  private readonly jiraSourceFetcher?: JiraSourceFetcher;
  private readonly lookupRepositories?: () => Promise<CodeRepository[]>;
  private readonly repoGrounding?: RepoGroundingLike;
  private readonly chatCoordinationExecutor?: ChatCoordinationExecutorLike | null;
  private readonly legacyChatExecutor: LegacyComposeChatExecutorLike;
  private readonly metrics: Pick<SpecFactoryMetrics, "recordCoordinatorRoute">;

  constructor(
    private readonly composeRepository: ComposeServiceComposeRepo,
    private readonly specRepository: ComposeServiceSpecRepo,
    private readonly draftRequester: DraftRequester,
    private readonly uploads: UploadIssuer,
    private readonly conversionWorker: ConversionKicker,
    chatAgent: ChatAgentLike,
    private readonly workspaceManager: WorkspaceManagerLike,
    private readonly sseHub: SseHubLike,
    private readonly config: ComposeServiceConfig,
    optionsOrJiraSourceFetcher?: JiraSourceFetcher | ComposeServiceOptions,
  ) {
    let legacyChatExecutor: LegacyComposeChatExecutorLike | undefined;
    let chatCoordinationExecutor:
      | ChatCoordinationExecutorLike
      | null
      | undefined;
    let chatCoordinator: ChatCoordinatorLike | null | undefined;
    let metrics: Pick<SpecFactoryMetrics, "recordCoordinatorRoute"> | undefined;
    if (
      optionsOrJiraSourceFetcher &&
      "fetchMarkdown" in optionsOrJiraSourceFetcher
    ) {
      this.jiraSourceFetcher = optionsOrJiraSourceFetcher;
    } else {
      const options = optionsOrJiraSourceFetcher as
        | ComposeServiceOptions
        | undefined;
      this.jiraSourceFetcher = options?.jiraSourceFetcher;
      this.lookupRepositories = options?.lookupRepositories;
      this.repoGrounding = options?.repoGrounding;
      chatCoordinator = options?.chatCoordinator ?? null;
      legacyChatExecutor = options?.legacyChatExecutor;
      chatCoordinationExecutor = options?.chatCoordinationExecutor;
      metrics = options?.metrics;
    }
    this.metrics = metrics ?? specFactoryMetrics;
    this.chatCoordinationExecutor =
      chatCoordinationExecutor ??
      (chatCoordinator
        ? new ChatCoordinationExecutor(chatCoordinator as ChatCoordinatorRunner)
        : null);
    this.legacyChatExecutor =
      legacyChatExecutor ??
      new LegacyComposeChatExecutor(chatAgent as LegacyComposeChatRunner);
  }

  getLegacyTurnQueueHealth(): {
    legacyInflight: number;
    legacyQueued: number;
  } {
    const pending = [...this.queuedDepth.values()].reduce(
      (sum, depth) => sum + depth,
      0,
    );
    const legacyInflight = this.legacyRunningTurns.size;
    return {
      legacyInflight,
      legacyQueued: Math.max(0, pending - legacyInflight),
    };
  }

  async createSession(input: {
    name: string;
    createdBy: string | null;
    createdByDisplay: string | null;
    password?: string | null;
  }): Promise<ComposeSessionSummary> {
    const name = input.name.trim();
    if (!name) {
      throw new Error("Compose session name is required");
    }
    const password = normalizedPassword(input.password);
    const passwordHash = password ? await hashSessionPassword(password) : null;

    const id = await this.composeRepository.createSession({
      name,
      createdBy: input.createdBy,
      createdByDisplay: input.createdByDisplay,
      s3Prefix: "",
      workspacePath: "",
      passwordHash,
    });

    const s3Prefix = `${this.config.s3Prefix}/${id}/`;
    const workspacePath = `${this.config.workspaceBase}/${id}`;
    await this.composeRepository.updateSessionPaths({
      sessionId: id,
      s3Prefix,
      workspacePath,
    });
    await this.recordSessionEvent({
      sessionId: id,
      eventType: "session.created",
      actor: input.createdBy,
      payload: {
        name,
        createdByDisplay: input.createdByDisplay,
        s3Prefix,
        workspacePath,
        passwordProtected: Boolean(passwordHash),
      },
    });

    return requireSession(await this.composeRepository.getSession(id), id);
  }

  async listSessions(actor?: string | null): Promise<ComposeSessionSummary[]> {
    const actorContext = actorContextFromActorId(actor);
    const sessions = (await this.composeRepository.listSessions()).filter(
      (session) => {
        try {
          assertSessionReadable(session, session.id, actorContext);
          return true;
        } catch {
          return false;
        }
      },
    );
    return this.withProjectedReadiness(sessions);
  }

  async listRepositories(): Promise<ComposeRepositoryOption[]> {
    if (!this.lookupRepositories) return [];
    const repositories = await this.lookupRepositories();
    return repositories.map(mapRepositoryOption);
  }

  async getSession(
    sessionId: number,
    actor?: string | null,
  ): Promise<ComposeSessionSummary> {
    const session = await this.requireReadableSession(
      sessionId,
      actorContextFromActorId(actor),
    );
    if (session.passwordProtected) {
      throw new Error(`Password is required for Compose session ${sessionId}`);
    }
    return this.withProjectedReadiness(session);
  }

  async getContextProjection(sessionId: number, actor?: string | null) {
    const session = await this.requireReadableSession(
      sessionId,
      actorContextFromActorId(actor),
    );
    return contextProjectionWithReadinessFallback(
      await this.composeRepository.getLatestContextProjection(sessionId),
      session.readiness,
    );
  }

  async resumeSession(input: {
    sessionId: number;
    password?: string | null;
    actor?: string | null;
  }): Promise<ComposeSessionSummary & { streamToken?: string }> {
    const session = await this.withProjectedReadiness(
      await this.requireAuthorizedSession(input),
    );
    // Only mint a stream token for password-protected sessions; unprotected
    // sessions keep the prior contract (no token needed) so the dashboard's
    // existing EventSource flow keeps working.
    if (session.passwordProtected) {
      const streamToken = await this.mintStreamToken(input.sessionId);
      return { ...session, streamToken };
    }
    return session;
  }

  private async withProjectedReadiness(
    session: ComposeSessionSummary,
  ): Promise<ComposeSessionSummary>;
  private async withProjectedReadiness(
    sessions: ComposeSessionSummary[],
  ): Promise<ComposeSessionSummary[]>;
  private async withProjectedReadiness(
    input: ComposeSessionSummary | ComposeSessionSummary[],
  ): Promise<ComposeSessionSummary | ComposeSessionSummary[]> {
    if (Array.isArray(input)) {
      return Promise.all(
        input.map((session) => this.withProjectedReadiness(session)),
      );
    }
    if (input.readiness) return input;
    const readiness = contextProjectionToReadiness(
      await this.composeRepository.getLatestContextProjection(input.id),
    );
    return readiness ? { ...input, readiness } : input;
  }

  /**
   * Returns true when the (sessionId, token) pair has an active entry in the
   * shared token store. The route layer is responsible for gating this call
   * with isSessionPasswordProtected — unprotected sessions skip the check
   * entirely so the pre-token contract (no token needed) is preserved.
   */
  async verifyStreamToken(
    sessionId: number,
    token: string | null | undefined,
  ): Promise<boolean> {
    if (typeof token !== "string" || token.length === 0) return false;
    return this.composeRepository.verifyStreamTokenHash({
      sessionId,
      tokenHash: streamTokenHash(token),
    });
  }

  /**
   * Returns true when the session has a password set. Used by the route layer
   * to decide whether to enforce stream-token auth on /stream and content
   * reads. A null hash (or missing session) is treated as unprotected.
   */
  async isSessionPasswordProtected(
    sessionId: number,
    actor?: string | null,
  ): Promise<boolean> {
    await this.requireStreamableSession(
      sessionId,
      actorContextFromActorId(actor),
    );
    const hash = await this.composeRepository.getSessionPasswordHash(sessionId);
    return Boolean(hash);
  }

  private async mintStreamToken(sessionId: number): Promise<string> {
    const token = randomBytes(32).toString("hex");
    await this.composeRepository.createStreamToken({
      sessionId,
      tokenHash: streamTokenHash(token),
      expiresAt: new Date(Date.now() + STREAM_TOKEN_TTL_MS),
    });
    return token;
  }

  async deleteSession(input: {
    sessionId: number;
    password?: string | null;
    actor?: string | null;
  }): Promise<void> {
    await this.requireAuthorizedSession(input, "mutable");
    await this.composeRepository.revokeSessionStreamTokens(input.sessionId);
    const archiveResult =
      await this.composeRepository.archiveSessionWithWorkCancellation(
        input.sessionId,
      );
    if (!archiveResult.archived) {
      throw new Error(`Compose session ${input.sessionId} was not found`);
    }
    await this.recordCancellationEvents({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      reason: "session_archived",
      turnJobIds: archiveResult.cancelledTurnJobIds,
      agentTaskIds: archiveResult.cancelledAgentTaskIds,
    });
    await this.sseHub.publish(input.sessionId, {
      type: "session",
      status: "archived",
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "session_archived",
      actor: input.actor ?? null,
    });
  }

  async cancelTurn(input: {
    sessionId: number;
    turnJobId: number;
    actor?: string | null;
  }): Promise<{
    cancelled: boolean;
    turnJobId: number;
    cancelledAgentTaskIds: number[];
    status: string;
  }> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const result = await this.composeRepository.cancelTurnJob({
      sessionId: input.sessionId,
      turnJobId: input.turnJobId,
    });
    if (!result) {
      throw new Error(
        `Compose turn job ${input.turnJobId} was not found in session ${input.sessionId}`,
      );
    }
    if (result.cancelled) {
      await this.recordCancellationEvents({
        sessionId: input.sessionId,
        actor: input.actor ?? null,
        reason: "operator_cancelled",
        turnJobIds: [input.turnJobId],
        agentTaskIds: result.cancelledAgentTaskIds,
      });
    }
    return {
      cancelled: result.cancelled,
      turnJobId: input.turnJobId,
      cancelledAgentTaskIds: result.cancelledAgentTaskIds,
      status: result.status,
    };
  }

  private async recordCancellationEvents(input: {
    sessionId: number;
    actor: string | null;
    reason: "operator_cancelled" | "session_archived";
    turnJobIds: number[];
    agentTaskIds: number[];
  }): Promise<void> {
    const actorType = input.actor ? "user" : "system";
    const actorId = input.actor ?? "spec-factory-operator";
    const writes: Array<Promise<unknown>> = [];
    for (const turnJobId of input.turnJobIds) {
      writes.push(
        this.composeRepository.appendSessionEvent({
          sessionId: input.sessionId,
          eventType: "turn.cancelling",
          payload: {
            type: "turn",
            status: "cancelling",
            reason: input.reason,
            turnJobId,
          },
          actorType,
          actorId,
          turnJobId,
        }),
      );
      writes.push(
        this.composeRepository.appendSessionEvent({
          sessionId: input.sessionId,
          eventType: "turn.cancelled",
          payload: {
            type: "turn",
            status: "cancelled",
            reason: input.reason,
            turnJobId,
          },
          actorType,
          actorId,
          turnJobId,
        }),
      );
    }
    for (const agentTaskId of input.agentTaskIds) {
      writes.push(
        this.composeRepository.appendSessionEvent({
          sessionId: input.sessionId,
          eventType: "task.cancelled",
          payload: {
            type: "task",
            status: "cancelled",
            reason: input.reason,
            agentTaskId,
          },
          actorType,
          actorId,
          agentTaskId,
        }),
      );
    }
    const results = await Promise.allSettled(writes);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn(
          {
            err: result.reason,
            sessionId: input.sessionId,
          },
          "Compose archive cancellation event write failed",
        );
      }
    }
  }

  async exportSession(input: {
    sessionId: number;
    password?: string | null;
    actor?: string | null;
  }): Promise<ComposeSessionExportBundle> {
    const session = await this.requireAuthorizedSession(input);
    const [sources, messages] = await Promise.all([
      this.composeRepository.listSessionSources(input.sessionId),
      this.composeRepository.listMessages(input.sessionId),
    ]);

    return {
      format: COMPOSE_SESSION_EXPORT_FORMAT,
      version: COMPOSE_SESSION_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      session: {
        name: session.name,
        createdByDisplay: session.createdByDisplay,
        readiness: session.readiness,
      },
      sources: sources
        .filter(
          (source) =>
            source.conversionStatus === "converted" &&
            Boolean(source.markdownContent?.trim()),
        )
        .map((source) => ({
          kind: source.kind,
          originalFilename: source.originalFilename,
          mimeType: source.mimeType,
          sizeBytes: source.sizeBytes,
          sourceUrl: source.sourceUrl,
          markdownContent: source.markdownContent?.trim() ?? "",
        })),
      messages: messages
        .filter((message) => Boolean(message.content.trim()))
        .map((message) => ({
          role: message.role,
          content: message.content.trim(),
        })),
    };
  }

  async importSession(input: {
    bundle: unknown;
    createdBy: string | null;
    createdByDisplay: string | null;
  }): Promise<ComposeSessionImportResult> {
    const parsed = ComposeSessionExportBundleSchema.safeParse(input.bundle);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `Invalid Compose session bundle: ${issue?.message ?? "schema validation failed"}`,
      );
    }

    const bundle = parsed.data;
    const session = await this.createSession({
      name: bundle.session.name,
      createdBy: input.createdBy,
      createdByDisplay:
        input.createdByDisplay ?? bundle.session.createdByDisplay ?? null,
    });

    for (const source of bundle.sources) {
      const sourceId = await this.composeRepository.restoreConvertedSource({
        sessionId: session.id,
        kind: source.kind,
        originalFilename: source.originalFilename,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        sourceUrl: source.sourceUrl,
        markdownContent: source.markdownContent,
      });
      await this.composeRepository.markSessionContextDirty(session.id);
      await this.completeInlineConvertedSource({
        sessionId: session.id,
        sourceId,
        markdownContent: source.markdownContent,
        baseContextVersion: session.latestContextVersion ?? null,
      });
    }

    for (const message of bundle.messages) {
      await this.composeRepository.appendMessage({
        sessionId: session.id,
        role: message.role,
        content: message.content,
      });
    }

    if (bundle.session.readiness) {
      await this.composeRepository.setReadiness({
        sessionId: session.id,
        readiness: bundle.session.readiness,
      });
    }

    const restored = requireSession(
      await this.composeRepository.getSession(session.id),
      session.id,
    );
    const [sources, messages] = await Promise.all([
      this.composeRepository.listSessionSourceContents(session.id),
      this.composeRepository.listMessages(session.id),
    ]);
    await this.workspaceManager.prepare({
      sessionId: restored.id,
      workspacePath: restored.workspacePath,
      sources,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    });

    return {
      session: restored,
      importedSources: bundle.sources.length,
      importedMessages: bundle.messages.length,
    };
  }

  private async requireAuthorizedSession(
    input: {
      sessionId: number;
      password?: string | null;
      actor?: string | null;
    },
    access: "readable" | "mutable" = "readable",
  ): Promise<ComposeSessionSummary> {
    const actorContext = actorContextFromActorId(input.actor);
    const session =
      access === "mutable"
        ? await this.requireMutableSession(input.sessionId, actorContext)
        : await this.requireReadableSession(input.sessionId, actorContext);
    const passwordHash = await this.composeRepository.getSessionPasswordHash(
      input.sessionId,
    );
    if (!passwordHash) {
      return session;
    }
    const password = normalizedPassword(input.password);
    if (!password) {
      throw new Error(
        `Password is required for Compose session ${input.sessionId}`,
      );
    }
    if (!(await verifySessionPassword(password, passwordHash))) {
      throw new Error(
        `Invalid password for Compose session ${input.sessionId}`,
      );
    }
    return session;
  }

  async addNote(input: {
    sessionId: number;
    content: string;
    actor?: string | null;
  }): Promise<ComposeSessionSummary> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Compose note content is required");
    }
    const session = await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const filename = `note-${session.sourceCount + 1}.md`;
    const sourceId = await this.composeRepository.addNoteSource({
      sessionId: input.sessionId,
      filename,
      content,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.completeInlineConvertedSource({
      sessionId: input.sessionId,
      sourceId,
      markdownContent: content,
      baseContextVersion: session.latestContextVersion ?? null,
    });
    await this.recordSourceEvent({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      eventType: "source.added",
      payload: {
        sourceId,
        kind: "note",
        filename,
        conversionStatus: "converted",
      },
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "note_source_added",
      actor: input.actor ?? null,
    });
    return requireSession(
      await this.composeRepository.getSession(input.sessionId),
      input.sessionId,
    );
  }

  async handoff(input: {
    sessionId: number;
    actor: string | null;
    idempotencyKey: string;
  }): Promise<{
    sourceId: number;
    session: ComposeSessionSummary;
    handoffId?: number;
    status?: "snapshot_building";
    contextVersion?: number | null;
    messageHighWatermarkId?: number | null;
  }> {
    const actorContext = actorContextFromActorId(input.actor);
    const session = await this.requireHandoffAllowedSession(
      input.sessionId,
      actorContext,
    );
    await this.recordHandoffStarted({
      sessionId: input.sessionId,
      actor: input.actor,
      existingSourceId: session.sourceId ?? null,
    });

    const useHandoffBuildTask = handoffBuildTaskEnabled();

    try {
      if (session.sourceId) {
        const buildTask = useHandoffBuildTask
          ? await this.queueHandoffBuildTask({
              session,
              sourceId: session.sourceId,
              actor: input.actor,
              idempotencyKey: input.idempotencyKey,
              reusedExistingSource: true,
            })
          : null;
        if (buildTask !== null) {
          await this.safeRecordActivity({
            sessionId: input.sessionId,
            action: "handoff_requested",
            actor: input.actor,
          });
          return {
            sourceId: session.sourceId,
            session,
            handoffId: buildTask.handoffId,
            status: "snapshot_building",
            contextVersion: buildTask.requestedContextVersion,
            messageHighWatermarkId: buildTask.messageHighWatermarkId,
          };
        }
        const artifactBytes = await this.persistHandoffBundleIfEnabled({
          session,
          sourceId: session.sourceId,
          sources: null,
        });
        await this.draftRequester.requestDraftGeneration({
          sourceId: session.sourceId,
          actor: input.actor,
        });
        await this.recordHandoffCompleted({
          sessionId: input.sessionId,
          actor: input.actor,
          sourceId: session.sourceId,
          reusedExistingSource: true,
          enriched: artifactBytes !== null,
          artifactBytes,
        });
        await this.safeRecordActivity({
          sessionId: input.sessionId,
          action: "handoff_requested",
          actor: input.actor,
        });
        return { sourceId: session.sourceId, session };
      }
      const sources = await this.assertNoBlockedSources({
        sessionId: input.sessionId,
        blockedStatuses: HANDOFF_BLOCKING_STATUSES,
        message: (blocked) =>
          `Cannot hand off Compose session ${input.sessionId} until blocked sources are resolved: ${formatBlockedSources(blocked)}`,
      });
      const handoffBundle =
        !useHandoffBuildTask && handoffEnrichmentEnabled()
          ? await this.buildHandoffBundle({
              session,
              sources,
            })
          : null;
      const sourceSummary = handoffBundle?.sourceSummary ?? session.name;

      let sourceId: number;
      try {
        sourceId = await this.specRepository.createComposeSource({
          sourceJiraKey: composeSourceJiraKey(session.id),
          sourceSummary,
        });
      } catch (error) {
        if (!isDuplicateEntry(error)) throw error;
        const linkedSession = await this.requireHandoffAllowedSession(
          input.sessionId,
          actorContext,
        );
        if (linkedSession.sourceId) {
          const buildTask = useHandoffBuildTask
            ? await this.queueHandoffBuildTask({
                session: linkedSession,
                sourceId: linkedSession.sourceId,
                actor: input.actor,
                idempotencyKey: input.idempotencyKey,
                reusedExistingSource: true,
              })
            : null;
          if (buildTask !== null) {
            return {
              sourceId: linkedSession.sourceId,
              session: linkedSession,
              handoffId: buildTask.handoffId,
              status: "snapshot_building",
              contextVersion: buildTask.requestedContextVersion,
              messageHighWatermarkId: buildTask.messageHighWatermarkId,
            };
          }
          const artifactBytes = await this.persistHandoffBundleIfEnabled({
            session: linkedSession,
            sourceId: linkedSession.sourceId,
            sources,
          });
          await this.draftRequester.requestDraftGeneration({
            sourceId: linkedSession.sourceId,
            actor: input.actor,
          });
          await this.recordHandoffCompleted({
            sessionId: input.sessionId,
            actor: input.actor,
            sourceId: linkedSession.sourceId,
            reusedExistingSource: true,
            enriched: artifactBytes !== null,
            artifactBytes,
          });
          return { sourceId: linkedSession.sourceId, session: linkedSession };
        }
        throw error;
      }

      const linked = await this.composeRepository.linkSource({
        sessionId: session.id,
        sourceId,
      });
      if (!linked) {
        const linkedSession = await this.requireHandoffAllowedSession(
          input.sessionId,
          actorContext,
        );
        if (linkedSession.sourceId) {
          const buildTask = useHandoffBuildTask
            ? await this.queueHandoffBuildTask({
                session: linkedSession,
                sourceId: linkedSession.sourceId,
                actor: input.actor,
                idempotencyKey: input.idempotencyKey,
                reusedExistingSource: true,
              })
            : null;
          if (buildTask !== null) {
            return {
              sourceId: linkedSession.sourceId,
              session: linkedSession,
              handoffId: buildTask.handoffId,
              status: "snapshot_building",
              contextVersion: buildTask.requestedContextVersion,
              messageHighWatermarkId: buildTask.messageHighWatermarkId,
            };
          }
          const artifactBytes = await this.persistHandoffBundleIfEnabled({
            session: linkedSession,
            sourceId: linkedSession.sourceId,
            sources,
          });
          await this.draftRequester.requestDraftGeneration({
            sourceId: linkedSession.sourceId,
            actor: input.actor,
          });
          await this.recordHandoffCompleted({
            sessionId: input.sessionId,
            actor: input.actor,
            sourceId: linkedSession.sourceId,
            reusedExistingSource: true,
            enriched: artifactBytes !== null,
            artifactBytes,
          });
          return { sourceId: linkedSession.sourceId, session: linkedSession };
        }
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }

      const buildTask = useHandoffBuildTask
        ? await this.queueHandoffBuildTask({
            session,
            sourceId,
            actor: input.actor,
            idempotencyKey: input.idempotencyKey,
            reusedExistingSource: false,
          })
        : null;
      if (buildTask !== null) {
        await this.safeRecordActivity({
          sessionId: input.sessionId,
          action: "handoff_requested",
          actor: input.actor,
        });
        return {
          sourceId,
          session: await this.requireHandoffAllowedSession(
            input.sessionId,
            actorContext,
          ),
          handoffId: buildTask.handoffId,
          status: "snapshot_building",
          contextVersion: buildTask.requestedContextVersion,
          messageHighWatermarkId: buildTask.messageHighWatermarkId,
        };
      }

      let artifactBytes: HandoffArtifactBytes | null = null;
      if (handoffBundle) {
        artifactBytes = await this.persistHandoffBundle({
          session,
          sourceId,
          bundle: handoffBundle,
        });
      }

      await this.draftRequester.requestDraftGeneration({
        sourceId,
        actor: input.actor,
      });
      await this.recordHandoffCompleted({
        sessionId: input.sessionId,
        actor: input.actor,
        sourceId,
        reusedExistingSource: false,
        enriched: Boolean(handoffBundle),
        artifactBytes,
      });
      await this.safeRecordActivity({
        sessionId: input.sessionId,
        action: "handoff_requested",
        actor: input.actor,
      });

      return {
        sourceId,
        session: await this.requireHandoffAllowedSession(
          input.sessionId,
          actorContext,
        ),
      };
    } catch (error) {
      await this.recordHandoffFailed({
        sessionId: input.sessionId,
        actor: input.actor,
        error,
      });
      throw error;
    }
  }

  private async recordHandoffStarted(input: {
    sessionId: number;
    actor: string | null;
    existingSourceId: number | null;
  }): Promise<void> {
    await this.recordHandoffEvent({
      sessionId: input.sessionId,
      actor: input.actor,
      eventType: "handoff.started",
      payload: {
        sourceJiraKey: composeSourceJiraKey(input.sessionId),
        existingSourceId: input.existingSourceId,
      },
    });
  }

  private async recordHandoffCompleted(input: {
    sessionId: number;
    actor: string | null;
    sourceId: number;
    reusedExistingSource: boolean;
    enriched: boolean;
    buildTaskId?: number | null;
    artifactBytes?: HandoffArtifactBytes | null;
  }): Promise<void> {
    await this.recordHandoffEvent({
      sessionId: input.sessionId,
      actor: input.actor,
      eventType: "handoff.completed",
      payload: {
        sourceJiraKey: composeSourceJiraKey(input.sessionId),
        sourceId: input.sourceId,
        reusedExistingSource: input.reusedExistingSource,
        enriched: input.enriched,
        ...(input.buildTaskId !== null && input.buildTaskId !== undefined
          ? { buildTaskId: input.buildTaskId }
          : {}),
        ...(input.artifactBytes !== null && input.artifactBytes !== undefined
          ? { artifactBytes: input.artifactBytes }
          : {}),
      },
    });
  }

  private async recordHandoffFailed(input: {
    sessionId: number;
    actor: string | null;
    error: unknown;
  }): Promise<void> {
    await this.recordHandoffEvent({
      sessionId: input.sessionId,
      actor: input.actor,
      eventType: "handoff.failed",
      payload: {
        sourceJiraKey: composeSourceJiraKey(input.sessionId),
        reason: handoffFailureReason(input.error),
        message: handoffErrorMessage(input.error),
      },
    });
  }

  private async recordHandoffEvent(input: {
    sessionId: number;
    actor: string | null;
    eventType: "handoff.started" | "handoff.completed" | "handoff.failed";
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: input.eventType,
        payload: input.payload,
        actorType: input.actor ? "user" : "system",
        actorId: input.actor ?? "spec-factory-operator",
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          eventType: input.eventType,
        },
        "Spec Factory handoff event write failed",
      );
    }
  }

  private async queueHandoffBuildTask(input: {
    session: ComposeSessionSummary;
    sourceId: number;
    actor: string | null;
    idempotencyKey: string;
    reusedExistingSource: boolean;
  }) {
    const build = await this.composeRepository.createHandoffBuildTask({
      sessionId: input.session.id,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      requestedBy: input.actor,
      reusedExistingSource: input.reusedExistingSource,
    });
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.session.id,
        eventType: "handoff.snapshot_building",
        payload: {
          handoffId: build.handoffId,
          capability: "handoff_build",
          executorType: "handoff_build",
          sourceId: input.sourceId,
          contextVersionUsed: build.requestedContextVersion,
          messageHighWatermarkId: build.messageHighWatermarkId,
          deduplicated: build.deduplicated,
        },
        actorType: input.actor ? "user" : "system",
        actorId: input.actor ?? "spec-factory-operator",
        agentTaskId: build.agentTaskId,
        contextVersion: build.requestedContextVersion,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.session.id,
          agentTaskId: build.agentTaskId,
        },
        "Spec Factory handoff-build queued-task event write failed",
      );
    }
    return build;
  }

  private async persistHandoffBundleIfEnabled(input: {
    session: ComposeSessionSummary;
    sourceId: number;
    sources: ComposeSessionSourceSummary[] | null;
  }): Promise<HandoffArtifactBytes | null> {
    if (!handoffEnrichmentEnabled()) return null;
    const sources =
      input.sources ??
      (await this.composeRepository.listSessionSources(input.session.id));
    return this.persistHandoffBundle({
      session: input.session,
      sourceId: input.sourceId,
      bundle: await this.buildHandoffBundle({
        session: input.session,
        sources,
      }),
    });
  }

  private async buildHandoffBundle(input: {
    session: ComposeSessionSummary;
    sources: ComposeSessionSourceSummary[];
  }): Promise<HandoffBundle> {
    const contextProjection =
      await this.composeRepository.getLatestContextProjection(input.session.id);
    return buildHandoffBundle({
      session: input.session,
      sources: input.sources,
      contextProjection,
    });
  }

  private async persistHandoffBundle(input: {
    session: ComposeSessionSummary;
    sourceId: number;
    bundle: HandoffBundle;
  }): Promise<HandoffArtifactBytes> {
    const markdownArtifact = await this.workspaceManager.writeArtifact({
      workspacePath: input.session.workspacePath,
      relativePath: "handoff/handoff-v2.md",
      content: input.bundle.markdown,
    });
    const jsonArtifact = await this.workspaceManager.writeArtifact({
      workspacePath: input.session.workspacePath,
      relativePath: "handoff/handoff-v2.json",
      content: input.bundle.jsonText,
    });
    await this.specRepository.createEvidenceSnapshot({
      sourceId: input.sourceId,
      manifest: buildHandoffEvidenceManifest({
        session: input.session,
        bundle: input.bundle,
        markdownArtifact,
        jsonArtifact,
      }),
    });
    return {
      markdown: markdownArtifact.bytes,
      json: jsonArtifact.bytes,
      total: markdownArtifact.bytes + jsonArtifact.bytes,
    };
  }

  async requestUpload(input: {
    sessionId: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    actor?: string | null;
  }): Promise<ComposeUploadTarget> {
    const filename = input.filename.trim();
    if (!filename) throw new Error("Upload filename is required");
    if (
      typeof input.sizeBytes === "number" &&
      Number.isFinite(input.sizeBytes) &&
      input.sizeBytes > MAX_UPLOAD_BYTES
    ) {
      throw new Error(
        `Upload exceeds the maximum size of ${MAX_UPLOAD_BYTES} bytes`,
      );
    }
    const session = await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const sourceId = await this.composeRepository.createUploadSource({
      sessionId: input.sessionId,
      filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      s3KeyRaw: "",
      converter: mediaMimeOrExt(input.mimeType, filename)
        ? "voxtral"
        : "markitdown",
    });
    const target = await this.uploads.createUploadUrl({
      s3Prefix: session.s3Prefix,
      sourceId,
      filename,
      mimeType: input.mimeType,
    });
    await this.composeRepository.updateSourceS3Key({
      sourceId,
      s3KeyRaw: target.s3KeyRaw,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.recordSourceEvent({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      eventType: "source.added",
      payload: {
        sourceId,
        kind: "file",
        filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        converter: mediaMimeOrExt(input.mimeType, filename)
          ? "voxtral"
          : "markitdown",
        conversionStatus: "awaiting_upload",
      },
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "upload_requested",
      actor: input.actor ?? null,
    });
    return target;
  }

  async confirmUpload(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
  }): Promise<void> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    await this.composeRepository.markSourceUploaded({
      sessionId: input.sessionId,
      sourceId: input.sourceId,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.recordSourceEvent({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      eventType: "source.uploaded",
      payload: {
        sourceId: input.sourceId,
        conversionStatus: "pending",
      },
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "upload_confirmed",
      actor: input.actor ?? null,
    });
    this.kickConversionDrain(input.sessionId, "confirmUpload");
  }

  async addYoutube(input: {
    sessionId: number;
    url: string;
    actor?: string | null;
  }): Promise<void> {
    const url = normalizeYoutubeUrl(input.url);
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const sourceId = await this.composeRepository.createYoutubeSource({
      sessionId: input.sessionId,
      url,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.recordSourceEvent({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      eventType: "source.added",
      payload: {
        sourceId,
        kind: "youtube",
        sourceUrl: url,
        conversionStatus: "pending",
      },
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "youtube_source_added",
      actor: input.actor ?? null,
    });
    this.kickConversionDrain(input.sessionId, "addYoutube");
  }

  async addConfluence(input: {
    sessionId: number;
    url: string;
    actor?: string | null;
  }): Promise<void> {
    const url = normalizeConfluenceUrl(input.url);
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const sourceId = await this.composeRepository.createConfluenceSource({
      sessionId: input.sessionId,
      url,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.recordSourceEvent({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      eventType: "source.added",
      payload: {
        sourceId,
        kind: "confluence",
        sourceUrl: url,
        conversionStatus: "pending",
      },
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "confluence_source_added",
      actor: input.actor ?? null,
    });
    this.kickConversionDrain(input.sessionId, "addConfluence");
  }

  async addJira(input: {
    sessionId: number;
    jiraKey: string;
    actor?: string | null;
  }): Promise<void> {
    const jiraKey = normalizeJiraKey(input.jiraKey);
    if (!this.jiraSourceFetcher) {
      throw new Error("Jira source fetching is not configured");
    }
    const session = await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const fetched = await this.jiraSourceFetcher.fetchMarkdown(jiraKey);
    const sourceId = await this.composeRepository.createJiraSource({
      sessionId: input.sessionId,
      jiraKey: fetched.issueKey,
      title: fetched.title,
      sourceUrl: fetched.sourceUrl,
      markdownContent: fetched.markdownContent,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.completeInlineConvertedSource({
      sessionId: input.sessionId,
      sourceId,
      markdownContent: fetched.markdownContent,
      baseContextVersion: session.latestContextVersion ?? null,
    });
    await this.recordSourceEvent({
      sessionId: input.sessionId,
      actor: input.actor ?? null,
      eventType: "source.added",
      payload: {
        sourceId,
        kind: "jira",
        jiraKey: fetched.issueKey,
        title: fetched.title,
        sourceUrl: fetched.sourceUrl,
        conversionStatus: "converted",
      },
    });
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "jira_source_added",
      actor: input.actor ?? null,
    });
  }

  async listSources(sessionId: number, actor?: string | null) {
    await this.requireReadableSession(
      sessionId,
      actorContextFromActorId(actor),
    );
    return this.composeRepository.listSessionSources(sessionId);
  }

  private async recordSourceEvent(input: {
    sessionId: number;
    actor: string | null;
    eventType: "source.added" | "source.uploaded";
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: input.eventType,
        payload: input.payload,
        actorType: input.actor ? "user" : "system",
        actorId: input.actor ?? "spec-factory-operator",
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          eventType: input.eventType,
        },
        "Compose source lifecycle event write failed",
      );
    }
  }

  private async recordSessionEvent(input: {
    sessionId: number;
    actor: string | null;
    eventType: "session.created" | "session.updated";
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: input.eventType,
        payload: input.payload,
        actorType: input.actor ? "user" : "system",
        actorId: input.actor ?? "spec-factory-operator",
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          eventType: input.eventType,
        },
        "Compose session lifecycle event write failed",
      );
    }
  }

  private async recordTurnEvent(input: {
    sessionId: number;
    turnJobId: number;
    eventType:
      | "turn.queued"
      | "turn.started"
      | "turn.completed"
      | "turn.duplicate_suppressed"
      | "context.version_drifted";
    payload: Record<string, unknown>;
    actor?: string | null;
    actorId?: string | null;
  }): Promise<void> {
    try {
      const actorId = input.actorId ?? input.actor ?? "spec-factory-operator";
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: input.eventType,
        payload: input.payload,
        actorType: input.actor ? "user" : "system",
        actorId,
        turnJobId: input.turnJobId,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          eventType: input.eventType,
        },
        "Compose turn lifecycle event write failed",
      );
    }
  }

  private async recordTurnLeaseFenceRejected(input: {
    sessionId: number;
    turnJobId: number;
    turnKind: "analyze" | "chat";
    actorId: string;
    reason: "lease_lost" | "failure_write_rejected";
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "turn.lease_fence_rejected",
        payload: {
          turnJobId: input.turnJobId,
          turnKind: input.turnKind,
          reason: input.reason,
        },
        actorType: "system",
        actorId: input.actorId,
        turnJobId: input.turnJobId,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          reason: input.reason,
        },
        "Compose turn lease-fence rejection event write failed",
      );
    }
  }

  private async recordAssistantDiscardedDueToArchive(input: {
    sessionId: number;
    turnJobId: number | null;
    turnKind: "analyze" | "chat";
    actorId: string;
  }): Promise<void> {
    const payload = {
      turnJobId: input.turnJobId,
      turnKind: input.turnKind,
      reason: "session_archived",
    };
    const writes: Array<Promise<unknown>> = [];
    if (input.turnJobId !== null) {
      writes.push(
        this.composeRepository.appendSessionEvent({
          sessionId: input.sessionId,
          eventType: "turn.discarded_due_to_archive",
          payload,
          actorType: "system",
          actorId: input.actorId,
          turnJobId: input.turnJobId,
        }),
      );
    }
    writes.push(
      this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "assistant.discarded_due_to_archive",
        payload,
        actorType: "system",
        actorId: input.actorId,
        turnJobId: input.turnJobId,
      }),
    );

    const results = await Promise.allSettled(writes);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn(
          {
            err: result.reason,
            sessionId: input.sessionId,
            turnJobId: input.turnJobId,
          },
          "Compose archive-discard event write failed",
        );
      }
    }
  }

  async getSourcePreview(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
  }): Promise<{ url: string; mimeType: string | null; filename: string }> {
    await this.requireReadableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const source = await this.composeRepository.getSessionSource(
      input.sourceId,
    );
    if (!source || source.sessionId !== input.sessionId) {
      throw new Error(
        `Compose source ${input.sourceId} was not found in session ${input.sessionId}`,
      );
    }
    const filename = source.originalFilename ?? `source-${source.id}`;
    if (!imageMimeOrExt(source.mimeType, filename)) {
      throw new Error(`Compose source ${input.sourceId} is not previewable`);
    }
    if (!source.s3KeyRaw) {
      throw new Error(
        `Compose source ${input.sourceId} has no uploaded object`,
      );
    }
    const url = await this.uploads.createPreviewUrl({
      s3KeyRaw: source.s3KeyRaw,
      filename,
      mimeType: source.mimeType,
    });
    return { url, mimeType: source.mimeType, filename };
  }

  async reconvert(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
  }): Promise<void> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    await this.composeRepository.reconvertSource({
      sessionId: input.sessionId,
      sourceId: input.sourceId,
    });
    await this.composeRepository.markSessionContextDirty(input.sessionId);
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "source_reconvert_queued",
      actor: input.actor ?? null,
    });
    this.kickConversionDrain(input.sessionId, "reconvert");
  }

  async reconvertFailedSources(input: {
    sessionId: number;
    actor?: string | null;
  }): Promise<{ queued: number }> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const queued = await this.composeRepository.reconvertFailedSessionSources(
      input.sessionId,
    );
    if (queued > 0) {
      await this.composeRepository.markSessionContextDirty(input.sessionId);
      await this.safeRecordActivity({
        sessionId: input.sessionId,
        action: "failed_sources_reconvert_queued",
        actor: input.actor ?? null,
      });
      this.kickConversionDrain(input.sessionId, "reconvertFailedSources");
    }
    return { queued };
  }

  async requestCodeResearch(input: {
    sessionId: number;
    question: string;
    parentSourceIds?: number[];
    contextVersionUsed?: number | null;
    actor?: string | null;
  }): Promise<{
    accepted: true;
    agentTaskId: number;
    capability: "code_research";
    status: "queued";
  }> {
    if (!codeResearchEnqueueEnabled()) {
      throw new Error("code_research_enqueue_disabled");
    }
    const question = input.question.trim();
    if (!question) {
      throw new Error("Research question is required");
    }
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const parentSourceIds = normalizeRepositoryIds(input.parentSourceIds);
    const contextVersionUsed =
      typeof input.contextVersionUsed === "number" &&
      Number.isInteger(input.contextVersionUsed) &&
      input.contextVersionUsed > 0
        ? input.contextVersionUsed
        : null;
    const maxCostUsd = resolveResearchMaxCostUsd();
    const budgetRejection = await this.coordinatorResearchBudgetRejection({
      sessionId: input.sessionId,
      taskCount: 1,
      requestedCostUsd: maxCostUsd,
    });
    if (budgetRejection) {
      throw new ResearchBudgetError(budgetRejection);
    }
    const agentTaskId = await this.composeRepository.createAgentTask({
      sessionId: input.sessionId,
      turnJobId: null,
      capability: "code_research",
      executorType: "code_research",
      priority: 70,
      maxAttempts: 2,
      outputSourceId: null,
      input: {
        question,
        parentSourceIds,
        contextVersionUsed,
        maxCostUsd,
      },
    });
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "task.queued",
        payload: {
          capability: "code_research",
          executorType: "code_research",
          question,
          parentSourceIds,
          contextVersionUsed,
          maxCostUsd,
        },
        actorType: input.actor ? "user" : "system",
        actorId: input.actor ?? "spec-factory-operator",
        agentTaskId,
        contextVersion: contextVersionUsed,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          agentTaskId,
        },
        "Spec Factory manual code-research queued-task event write failed",
      );
    }
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "code_research_requested",
      actor: input.actor ?? null,
    });
    this.sseHub.publish(input.sessionId, {
      type: "status",
      status: "thinking",
      message: "Code research queued",
    });
    return {
      accepted: true,
      agentTaskId,
      capability: "code_research",
      status: "queued",
    };
  }

  async deleteSource(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
  }): Promise<ComposeSourceDeletionSummary> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const deleted = await this.composeRepository.deleteSessionSource({
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      actor: input.actor ?? null,
      undoWindowMinutes:
        resolveSpecFactoryRetentionPolicy().sourceDeletionUndoMinutes,
    });
    if (!deleted) {
      throw new Error(
        `Compose source ${input.sourceId} was not found in session ${input.sessionId}`,
      );
    }
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "source_deleted",
      actor: input.actor ?? null,
    });
    this.sseHub.publish(input.sessionId, {
      type: "status",
      status: "idle",
      message:
        deleted.dependentSourceCount > 0
          ? `Source removed with ${deleted.dependentSourceCount} dependent artifact${deleted.dependentSourceCount === 1 ? "" : "s"}`
          : "Source removed",
    });
    return deleted;
  }

  async listUndoableSourceDeletions(input: {
    sessionId: number;
    actor?: string | null;
  }): Promise<ComposeSourceDeletionSummary[]> {
    await this.requireReadableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    return this.composeRepository.listUndoableSourceDeletions(input.sessionId);
  }

  async restoreDeletedSource(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
  }): Promise<ComposeSourceDeletionSummary> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const restored = await this.composeRepository.restoreSessionSource({
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      actor: input.actor ?? null,
    });
    if (!restored) {
      throw new SourceRestoreUnavailableError(
        `Compose source ${input.sourceId} cannot be restored because its undo window expired or it was not deleted from session ${input.sessionId}`,
      );
    }
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "source_restored",
      actor: input.actor ?? null,
    });
    await this.conversionWorker.drain();
    this.sseHub.publish(input.sessionId, {
      type: "status",
      status: "thinking",
      message: "Source restored; requirements are updating",
    });
    return restored;
  }

  private async runTurn(input: {
    sessionId: number;
    mode: "analyze" | "chat";
    latestUserMessage: string | null;
    userMessageId?: number | null;
    repositoryIds?: number[];
    turnJobId?: number;
    turnLease?: { workerId: string; leaseGeneration: number };
    requestedContextVersion?: number | null;
    contextVersionUsed?: number | null;
  }): Promise<ComposeReadiness> {
    if (this.activeTurns.has(input.sessionId)) {
      throw new Error(
        `A clarification turn is already in progress for session ${input.sessionId}`,
      );
    }
    const session = await this.requireMutableSession(input.sessionId);
    this.activeTurns.add(input.sessionId);
    let terminalAction = `${input.mode}_completed`;
    let turnLease: ActiveTurnLease | null = null;
    let stopTurnLeaseHeartbeat: (() => void) | null = null;
    let lostTurnLease = false;
    try {
      if (input.turnJobId) {
        if (input.turnLease) {
          turnLease = {
            turnJobId: input.turnJobId,
            workerId: input.turnLease.workerId,
            leaseGeneration: input.turnLease.leaseGeneration,
            lost: false,
          };
        } else {
          const establishedLease =
            await this.composeRepository.markTurnJobRunning({
              turnJobId: input.turnJobId,
              workerId: LEGACY_TURN_WORKER_ID,
              leaseUntil: turnLeaseUntil(),
            });
          if (!establishedLease) {
            throw new LostTurnLeaseError(input.turnJobId);
          }
          turnLease = {
            turnJobId: input.turnJobId,
            workerId: LEGACY_TURN_WORKER_ID,
            leaseGeneration: establishedLease.leaseGeneration,
            lost: false,
          };
        }
        stopTurnLeaseHeartbeat = this.startTurnLeaseHeartbeat(turnLease);
        await this.recordTurnEvent({
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          eventType: "turn.started",
          actorId: turnLease.workerId,
          payload: {
            turnJobId: input.turnJobId,
            turnKind: input.mode,
            workerId: turnLease.workerId,
            leaseGeneration: turnLease.leaseGeneration,
          },
        });
        if (
          input.requestedContextVersion !== undefined &&
          input.contextVersionUsed !== undefined &&
          input.requestedContextVersion !== input.contextVersionUsed
        ) {
          await this.recordTurnEvent({
            sessionId: input.sessionId,
            turnJobId: input.turnJobId,
            eventType: "context.version_drifted",
            actorId: turnLease.workerId,
            payload: {
              turnJobId: input.turnJobId,
              requestedContextVersion: input.requestedContextVersion,
              contextVersionUsed: input.contextVersionUsed,
            },
          });
        }
      }
      await this.safeRecordActivity({
        sessionId: input.sessionId,
        action: `${input.mode}_started`,
        actor: null,
        activeTurn: "started",
      });

      if (input.mode === "analyze") {
        await this.assertNoBlockedSources({
          sessionId: input.sessionId,
          blockedStatuses: ANALYZE_BLOCKING_STATUSES,
          message: (blocked) =>
            `Cannot analyze Compose session ${input.sessionId} until sources finish processing: ${formatBlockedSources(blocked)}`,
        });
      }
      this.publishTurnStatus(input.sessionId, input.mode, "Reading sources");

      const messages = await this.composeRepository.listMessages(
        input.sessionId,
      );
      const latestUserMessage =
        input.latestUserMessage ??
        (input.mode === "chat" && input.userMessageId != null
          ? (messages.find((message) => message.id === input.userMessageId)
              ?.content ?? null)
          : null);
      const coordinatorMessage =
        latestUserMessage ??
        (input.mode === "analyze"
          ? "Analyze the frozen working context and converted sources. Summarize readiness, gaps, risks, and the next highest-value action."
          : null);
      const fastReply =
        input.mode === "chat"
          ? fastChatAcknowledgement(latestUserMessage)
          : null;
      if (fastReply) {
        const readiness = cloneReadiness(session.readiness);
        this.publishTurnStatus(input.sessionId, input.mode, "Saving response");
        await this.assertTurnLease(turnLease);
        const assistantWrite = await this.writeAssistantTurn({
          turnJobId: input.turnJobId,
          sessionId: input.sessionId,
          content: fastReply,
          contextVersionUsed: session.latestContextVersion ?? null,
          finalPayload: {
            action: "fast_ack",
            reason: "trivial_chat_acknowledgement",
            answer: fastReply,
          },
          turnLease,
        });
        if (!assistantWrite) {
          throw new LostTurnLeaseError(input.turnJobId);
        }
        if (assistantWrite.discardedDueToArchive) {
          await this.recordAssistantDiscardedDueToArchive({
            sessionId: input.sessionId,
            turnJobId: input.turnJobId ?? null,
            turnKind: input.mode,
            actorId: turnLease?.workerId ?? "compose-fast-ack",
          });
          terminalAction = `${input.mode}_discarded_due_to_archive`;
          return readiness;
        }
        if (input.turnJobId && !assistantWrite.deduplicated) {
          await this.recordTurnEvent({
            sessionId: input.sessionId,
            turnJobId: input.turnJobId,
            eventType: "turn.completed",
            actorId: turnLease?.workerId ?? "compose-fast-ack",
            payload: {
              turnJobId: input.turnJobId,
              turnKind: input.mode,
              assistantMessageId: assistantWrite.assistantMessageId,
              coordinatorAction: "fast_ack",
            },
          });
        }
        if (!assistantWrite.deduplicated) {
          this.sseHub.publish(input.sessionId, {
            type: "message",
            role: "assistant",
            content: fastReply,
          });
        }
        this.sseHub.publish(input.sessionId, {
          type: "status",
          status: "idle",
        });
        return readiness;
      }
      const coordinatorResult = await this.tryCoordinatorTurn({
        turn: input,
        latestUserMessage: coordinatorMessage,
        turnLease,
        session,
      });
      if (coordinatorResult) {
        if (coordinatorResult.discardedDueToArchive) {
          terminalAction = `${input.mode}_discarded_due_to_archive`;
        }
        return coordinatorResult.readiness;
      }
      if (legacyRuntimeDisabled()) {
        throw new Error("legacy_runtime_disabled:no_coordinator_result");
      }
      const sources = await this.composeRepository.listSessionSourceContents(
        input.sessionId,
      );
      this.publishTurnStatus(
        input.sessionId,
        input.mode,
        "Checking repositories",
      );
      const grounding = await this.groundRepositories(
        input.mode,
        input.repositoryIds,
        sources,
      );
      this.publishTurnStatus(input.sessionId, input.mode, "Updating brief");
      await this.assertTurnLease(turnLease);
      const repoId = await this.workspaceManager.prepare({
        sessionId: input.sessionId,
        workspacePath: session.workspacePath,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        sources,
        repositoryContextMarkdown: grounding.repositoriesMarkdown,
      });

      const runInput = {
        sessionId: input.sessionId,
        workspaceRepoId: repoId,
        mode: input.mode,
        resumeSessionId: session.claudeSessionId,
        latestUserMessage,
        codeRepoIds: grounding.codeRepoIds,
      };
      let output: ComposeChatRunOutput;
      await this.assertTurnLease(turnLease);
      this.publishTurnStatus(
        input.sessionId,
        input.mode,
        "Preparing next question",
      );
      output = await this.runLegacyChatExecutorWithRetry(runInput, {
        sessionId: input.sessionId,
        mode: input.mode,
        claudeSessionId: session.claudeSessionId,
      });
      const { envelope, sessionId: claudeSessionId } = output;

      this.publishTurnStatus(input.sessionId, input.mode, "Saving response");
      await this.assertTurnLease(turnLease);
      const assistantWrite: AssistantTurnWrite | null = input.turnJobId
        ? await this.writeAssistantTurn({
            turnJobId: input.turnJobId,
            sessionId: input.sessionId,
            content: envelope.reply,
            contextVersionUsed: null,
            finalPayload: envelope,
            ...(latestUserMessage
              ? {
                  conversation: {
                    userMessageId: input.userMessageId,
                    userMessage: latestUserMessage,
                  },
                }
              : {}),
            turnLease,
          })
        : await this.writeAssistantTurn({
            sessionId: input.sessionId,
            content: envelope.reply,
            contextVersionUsed: null,
            finalPayload: envelope,
            turnLease,
          });
      if (!assistantWrite) {
        throw new LostTurnLeaseError(input.turnJobId);
      }
      if (assistantWrite.discardedDueToArchive) {
        await this.recordAssistantDiscardedDueToArchive({
          sessionId: input.sessionId,
          turnJobId: input.turnJobId ?? null,
          turnKind: input.mode,
          actorId: turnLease?.workerId ?? "legacy-compose-service",
        });
        terminalAction = `${input.mode}_discarded_due_to_archive`;
        return envelope.readiness;
      }
      if (input.turnJobId && !assistantWrite.deduplicated) {
        await this.recordTurnEvent({
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          eventType: "turn.completed",
          actorId: turnLease?.workerId ?? "legacy-compose-service",
          payload: {
            turnJobId: input.turnJobId,
            turnKind: input.mode,
            assistantMessageId: assistantWrite.assistantMessageId,
          },
        });
      }
      if (claudeSessionId && claudeSessionId !== session.claudeSessionId) {
        await this.composeRepository.setClaudeSessionId({
          sessionId: input.sessionId,
          claudeSessionId,
        });
      }
      await this.workspaceManager.prepare({
        sessionId: input.sessionId,
        workspacePath: session.workspacePath,
        messages: [
          ...messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          { role: "assistant" as const, content: envelope.reply },
        ],
        contextMarkdown: envelope.contextMarkdown,
        repositoryContextMarkdown: grounding.repositoriesMarkdown,
      });
      let readiness: ComposeReadiness = envelope.readiness;
      if (grounding.manifest.length > 0) {
        readiness = { ...readiness, repoEvidence: grounding.manifest };
        // Surface what the agent ACTUALLY did with the attached code (real
        // Read/Grep activity), distinct from the pre-scan in repoEvidence.
        const investigation = summarizeCodeInvestigation(output.metrics);
        if (investigation)
          readiness = { ...readiness, codeInvestigation: investigation };
      }
      await this.composeRepository.setReadiness({
        sessionId: input.sessionId,
        readiness,
      });

      if (!assistantWrite.deduplicated) {
        await this.enqueueCriticReview({
          sessionId: input.sessionId,
          turnJobId: input.turnJobId ?? null,
          userMessage: latestUserMessage,
          answer: envelope.reply,
          contextVersionUsed: null,
          workingContextMarkdown: envelope.contextMarkdown,
          evidence: grounding.manifest,
        });
        this.sseHub.publish(input.sessionId, {
          type: "message",
          role: "assistant",
          content: envelope.reply,
        });
      }
      this.sseHub.publish(input.sessionId, {
        type: "invalidate",
        resource: "readiness",
      });
      this.sseHub.publish(input.sessionId, { type: "status", status: "idle" });
      return readiness;
    } catch (error) {
      lostTurnLease = error instanceof LostTurnLeaseError;
      terminalAction = `${input.mode}_failed`;
      let leaseFenceRejectionReason: "lease_lost" | "failure_write_rejected" =
        lostTurnLease ? "lease_lost" : "failure_write_rejected";
      if (input.turnJobId && !lostTurnLease) {
        try {
          const failedTurnInput: {
            turnJobId: number;
            errorMessage: string;
            lease?: { workerId: string; leaseGeneration: number };
          } = {
            turnJobId: input.turnJobId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          };
          if (turnLease) {
            failedTurnInput.lease = {
              workerId: turnLease.workerId,
              leaseGeneration: turnLease.leaseGeneration,
            };
          }
          const markedFailed =
            await this.composeRepository.markTurnJobFailed(failedTurnInput);
          if (!markedFailed) {
            lostTurnLease = true;
            leaseFenceRejectionReason = "failure_write_rejected";
          }
        } catch (markError) {
          this.logTurnFailure(
            { sessionId: input.sessionId, mode: input.mode },
            markError,
          );
        }
      }
      if (input.turnJobId && lostTurnLease) {
        await this.recordTurnLeaseFenceRejected({
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          turnKind: input.mode,
          actorId: turnLease?.workerId ?? LEGACY_TURN_WORKER_ID,
          reason: leaseFenceRejectionReason,
        });
      }
      if (!lostTurnLease) {
        this.sseHub.publish(input.sessionId, {
          type: "status",
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      stopTurnLeaseHeartbeat?.();
      this.activeTurns.delete(input.sessionId);
      if (!lostTurnLease) {
        await this.safeRecordActivity({
          sessionId: input.sessionId,
          action: terminalAction,
          actor: null,
          activeTurn: "finished",
        });
      }
    }
  }

  async executeClaimedTurn(job: ClaimedTurnJob): Promise<void> {
    if (!job.activeWorkerId) {
      throw new Error(`Compose turn job ${job.id} has no active worker lease`);
    }
    await this.runTurn({
      sessionId: job.sessionId,
      mode: job.turnKind,
      latestUserMessage: null,
      userMessageId: job.userMessageId,
      turnJobId: job.id,
      requestedContextVersion: job.requestedContextVersion,
      contextVersionUsed: job.contextVersionUsed,
      turnLease: {
        workerId: job.activeWorkerId,
        leaseGeneration: job.leaseGeneration,
      },
    });
  }

  private async tryCoordinatorTurn(args: {
    turn: {
      sessionId: number;
      mode: "analyze" | "chat";
      turnJobId?: number;
      requestedContextVersion?: number | null;
      contextVersionUsed?: number | null;
      userMessageId?: number | null;
    };
    latestUserMessage: string | null;
    turnLease: ActiveTurnLease | null;
    session: ComposeSessionSummary;
  }): Promise<{
    readiness: ComposeReadiness;
    discardedDueToArchive?: boolean;
  } | null> {
    if (!this.chatCoordinationExecutor || !args.latestUserMessage) {
      if (legacyRuntimeDisabled() && args.latestUserMessage) {
        throw new Error("coordinator_required:not_configured");
      }
      return null;
    }

    let decision: CoordinatorDecision;
    let bundle: CoordinatorContextBundle | null = null;
    const coordinatorStartedAt = Date.now();
    try {
      this.publishTurnStatus(
        args.turn.sessionId,
        args.turn.mode,
        "Coordinating response",
      );
      await this.assertTurnLease(args.turnLease);
      const pendingTasks = args.turn.turnJobId
        ? await this.coordinatorPendingTasks(args.turn.turnJobId)
        : [];
      bundle = await buildCoordinatorContextBundle(this.composeRepository, {
        sessionId: args.turn.sessionId,
        userMessage: args.latestUserMessage,
        requestedContextVersion: args.turn.requestedContextVersion,
        contextVersionUsed: args.turn.contextVersionUsed,
        pendingTasks,
      });
      decision = await this.chatCoordinationExecutor.execute(bundle);
      this.recordCoordinatorRoute({
        action: decision.action,
        outcome: "selected",
        startedAt: coordinatorStartedAt,
      });
    } catch (error) {
      if (error instanceof LostTurnLeaseError) {
        throw error;
      }
      if (isCoordinatorDecisionRejected(error)) {
        await this.recordCoordinatorDecisionRejected({
          sessionId: args.turn.sessionId,
          turnJobId: args.turn.turnJobId ?? null,
          contextVersion: bundle?.contextVersionUsed ?? null,
          error,
        });
      }
      this.recordCoordinatorRoute({
        outcome: isCoordinatorDecisionRejected(error) ? "rejected" : "fallback",
        startedAt: coordinatorStartedAt,
        reason: coordinatorMetricReason(error),
      });
      logger.warn(
        {
          err: error,
          sessionId: args.turn.sessionId,
          mode: args.turn.mode,
        },
        "Spec Factory chat coordinator fell back to legacy turn execution",
      );
      if (legacyRuntimeDisabled()) {
        throw new Error(
          `coordinator_required:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return null;
    }

    if (decision.action === "dispatch_research") {
      const dispatched = await this.tryDispatchCoordinatorResearch({
        turn: args.turn,
        turnLease: args.turnLease,
        decision,
        contextVersionUsed: bundle?.contextVersionUsed ?? null,
      });
      if (dispatched.dispatched) {
        return {
          readiness: cloneReadiness(args.session.readiness),
          discardedDueToArchive: dispatched.discardedDueToArchive,
        };
      }
      if (legacyRuntimeDisabled()) {
        throw new Error("coordinator_required:research_dispatch_rejected");
      }
      return null;
    }

    if (decision.action === "ask_clarification") {
      if (!args.turn.turnJobId || !args.turnLease) {
        if (legacyRuntimeDisabled()) {
          throw new Error("coordinator_required:durable_clarification_turn");
        }
        return null;
      }
      const expiresAt = parseCoordinatorDate(decision.expiresAt);
      if (!expiresAt) {
        if (legacyRuntimeDisabled()) {
          throw new Error("coordinator_required:invalid_clarification_expiry");
        }
        return null;
      }
      await this.assertTurnLease(args.turnLease);
      const parked = await this.composeRepository.parkTurnForClarification({
        sessionId: args.turn.sessionId,
        turnJobId: args.turn.turnJobId,
        lease: {
          workerId: args.turnLease.workerId,
          leaseGeneration: args.turnLease.leaseGeneration,
        },
        question: decision.question,
        reason: decision.reason,
        expiresAt,
        contextVersionUsed: bundle?.contextVersionUsed ?? null,
      });
      if (!parked) {
        throw new LostTurnLeaseError(args.turn.turnJobId);
      }
      if (parked.discardedDueToArchive) {
        return {
          readiness: cloneReadiness(args.session.readiness),
          discardedDueToArchive: true,
        };
      }
      await this.recordCoordinatorAwaitingUserInput({
        sessionId: args.turn.sessionId,
        turnJobId: args.turn.turnJobId,
        contextVersion: bundle?.contextVersionUsed ?? null,
        decision,
      });
      this.sseHub.publish(args.turn.sessionId, {
        type: "message",
        role: "assistant",
        content: decision.question,
      });
      this.sseHub.publish(args.turn.sessionId, {
        type: "status",
        status: "idle",
      });
      const readiness = cloneReadiness(args.session.readiness);
      return {
        readiness: {
          ...readiness,
          ready: false,
          openQuestions: [...readiness.openQuestions, decision.question],
          summary: readiness.summary || decision.reason,
        },
      };
    }

    if (decision.action === "escalate") {
      const content = coordinatorEscalationMessage(decision.reason);
      this.publishTurnStatus(
        args.turn.sessionId,
        args.turn.mode,
        "Saving response",
      );
      await this.assertTurnLease(args.turnLease);
      const assistantWrite = await this.writeAssistantTurn({
        turnJobId: args.turn.turnJobId,
        sessionId: args.turn.sessionId,
        content,
        contextVersionUsed: bundle?.contextVersionUsed ?? null,
        finalPayload: decision,
        ...(args.turn.mode === "chat"
          ? {
              conversation: {
                userMessageId: args.turn.userMessageId,
                userMessage: args.latestUserMessage,
              },
            }
          : {}),
        turnLease: args.turnLease,
      });
      if (!assistantWrite) {
        throw new LostTurnLeaseError(args.turn.turnJobId);
      }

      const readiness = cloneReadiness(args.session.readiness);
      if (assistantWrite.discardedDueToArchive) {
        await this.recordAssistantDiscardedDueToArchive({
          sessionId: args.turn.sessionId,
          turnJobId: args.turn.turnJobId ?? null,
          turnKind: args.turn.mode,
          actorId: args.turnLease?.workerId ?? "chat_coordinator",
        });
        return { readiness, discardedDueToArchive: true };
      }
      if (!assistantWrite.deduplicated) {
        await this.recordCoordinatorPolicyDenied({
          sessionId: args.turn.sessionId,
          turnJobId: args.turn.turnJobId ?? null,
          contextVersion: bundle?.contextVersionUsed ?? null,
          decision,
        });
        if (args.turn.turnJobId) {
          await this.recordTurnEvent({
            sessionId: args.turn.sessionId,
            turnJobId: args.turn.turnJobId,
            eventType: "turn.completed",
            actorId: args.turnLease?.workerId ?? "chat_coordinator",
            payload: {
              turnJobId: args.turn.turnJobId,
              turnKind: args.turn.mode,
              assistantMessageId: assistantWrite.assistantMessageId,
              coordinatorAction: "escalate",
            },
          });
        }
        this.sseHub.publish(args.turn.sessionId, {
          type: "message",
          role: "assistant",
          content,
        });
      }
      this.sseHub.publish(args.turn.sessionId, {
        type: "status",
        status: "idle",
      });
      return { readiness };
    }

    if (decision.action !== "answer") {
      if (legacyRuntimeDisabled()) {
        throw new Error("coordinator_required:unsupported_decision");
      }
      return null;
    }

    this.publishTurnStatus(
      args.turn.sessionId,
      args.turn.mode,
      "Saving response",
    );
    await this.assertTurnLease(args.turnLease);
    const assistantWrite = await this.writeAssistantTurn({
      turnJobId: args.turn.turnJobId,
      sessionId: args.turn.sessionId,
      content: decision.answer,
      contextVersionUsed: bundle?.contextVersionUsed ?? null,
      finalPayload: decision,
      ...(args.turn.mode === "chat"
        ? {
            conversation: {
              userMessageId: args.turn.userMessageId,
              userMessage: args.latestUserMessage,
            },
          }
        : {}),
      turnLease: args.turnLease,
    });
    if (!assistantWrite) {
      throw new LostTurnLeaseError(args.turn.turnJobId);
    }

    let readiness = cloneReadiness(args.session.readiness);
    if (assistantWrite.discardedDueToArchive) {
      await this.recordAssistantDiscardedDueToArchive({
        sessionId: args.turn.sessionId,
        turnJobId: args.turn.turnJobId ?? null,
        turnKind: args.turn.mode,
        actorId: args.turnLease?.workerId ?? "chat_coordinator",
      });
      return { readiness, discardedDueToArchive: true };
    }
    readiness = enrichCoordinatorReadiness(readiness, bundle, decision.details);
    if (!sameReadiness(readiness, args.session.readiness)) {
      await this.composeRepository.setReadiness({
        sessionId: args.turn.sessionId,
        readiness,
      });
      this.sseHub.publish(args.turn.sessionId, {
        type: "invalidate",
        resource: "readiness",
      });
    }
    if (!assistantWrite.deduplicated) {
      if (args.turn.turnJobId) {
        await this.recordTurnEvent({
          sessionId: args.turn.sessionId,
          turnJobId: args.turn.turnJobId,
          eventType: "turn.completed",
          actorId: args.turnLease?.workerId ?? "chat_coordinator",
          payload: {
            turnJobId: args.turn.turnJobId,
            turnKind: args.turn.mode,
            assistantMessageId: assistantWrite.assistantMessageId,
            coordinatorAction: "answer",
          },
        });
      }
      if (args.turn.mode === "chat") {
        await this.enqueueCriticReview({
          sessionId: args.turn.sessionId,
          turnJobId: args.turn.turnJobId ?? null,
          userMessage: args.latestUserMessage,
          answer: decision.answer,
          contextVersionUsed: bundle?.contextVersionUsed ?? null,
          workingContextMarkdown: bundle?.workingContextMarkdown ?? null,
          generatedResearch: bundle?.generatedResearch ?? [],
        });
      }
      this.sseHub.publish(args.turn.sessionId, {
        type: "message",
        role: "assistant",
        content: decision.answer,
      });
    }
    this.sseHub.publish(args.turn.sessionId, {
      type: "status",
      status: "idle",
    });
    return { readiness };
  }

  private recordCoordinatorRoute(input: {
    action?: string | null;
    outcome: SpecFactoryCoordinatorOutcome;
    startedAt: number;
    reason?: string | null;
  }): void {
    try {
      this.metrics.recordCoordinatorRoute({
        action: input.action,
        outcome: input.outcome,
        durationMs: Date.now() - input.startedAt,
        reason: input.reason,
      });
    } catch (error) {
      logger.warn(
        { err: error, outcome: input.outcome, action: input.action ?? null },
        "Spec Factory coordinator metric write failed",
      );
    }
  }

  private async tryDispatchCoordinatorResearch(args: {
    turn: {
      sessionId: number;
      mode: "analyze" | "chat";
      turnJobId?: number;
    };
    turnLease: ActiveTurnLease | null;
    decision: Extract<CoordinatorDecision, { action: "dispatch_research" }>;
    contextVersionUsed: number | null;
  }): Promise<{ dispatched: boolean; discardedDueToArchive?: boolean }> {
    if (!codeResearchExecutorEnabled()) {
      return { dispatched: false };
    }
    if (
      !durableTurnWorkerExecutionEnabled() ||
      !args.turn.turnJobId ||
      !args.turnLease
    ) {
      return { dispatched: false };
    }
    if (
      args.contextVersionUsed === null ||
      !args.decision.researchTasks.every((task) =>
        COORDINATOR_RESEARCH_CAPABILITIES.has(task.capability),
      )
    ) {
      return { dispatched: false };
    }

    const researchMaxCostUsd = resolveResearchMaxCostUsd();
    const tasks: ParkTurnForResearchTaskInput[] = [];
    for (const task of args.decision.researchTasks) {
      const question = task.question.trim();
      if (!question) {
        return { dispatched: false };
      }
      const maxCostUsd = Math.min(task.maxCostUsd, researchMaxCostUsd);
      tasks.push({
        capability: task.capability,
        executorType: "code_research",
        priority: 70,
        maxAttempts: 2,
        outputSourceId: null,
        input: {
          question,
          parentSourceIds: [],
          contextVersionUsed: args.contextVersionUsed,
          requiredEvidence: task.requiredEvidence,
          maxCostUsd,
          synthesisInstructions: args.decision.synthesisInstructions,
        },
      });
    }

    const budgetRejection = await this.coordinatorResearchBudgetRejection({
      sessionId: args.turn.sessionId,
      taskCount: tasks.length,
      requestedCostUsd: tasks.reduce((sum, task) => {
        const maxCostUsd = Number(
          (task.input as { maxCostUsd?: unknown }).maxCostUsd,
        );
        return sum + (Number.isFinite(maxCostUsd) ? maxCostUsd : 0);
      }, 0),
    });
    if (budgetRejection) {
      await this.recordCoordinatorDecisionRejected({
        sessionId: args.turn.sessionId,
        turnJobId: args.turn.turnJobId,
        contextVersion: args.contextVersionUsed,
        error: new Error(`coordinator_decision_rejected:${budgetRejection}`),
      });
      return { dispatched: false };
    }

    this.sseHub.publish(args.turn.sessionId, {
      type: "status",
      status: "thinking",
      mode: args.turn.mode,
      message: args.decision.userVisibleStatus,
    });

    await this.assertTurnLease(args.turnLease);
    const parked = await this.composeRepository.parkTurnForResearch({
      sessionId: args.turn.sessionId,
      turnJobId: args.turn.turnJobId,
      lease: {
        workerId: args.turnLease.workerId,
        leaseGeneration: args.turnLease.leaseGeneration,
      },
      tasks,
    });
    if (!parked) {
      throw new LostTurnLeaseError(args.turn.turnJobId);
    }
    if (parked.discardedDueToArchive) {
      return { dispatched: true, discardedDueToArchive: true };
    }
    for (const [index, agentTaskId] of parked.agentTaskIds.entries()) {
      const task = args.decision.researchTasks[index];
      if (!task) {
        throw new Error("coordinator_research_task_index_mismatch");
      }
      await this.recordCoordinatorAgentTaskQueued({
        sessionId: args.turn.sessionId,
        turnJobId: args.turn.turnJobId,
        agentTaskId,
        contextVersionUsed: args.contextVersionUsed,
        task,
      });
    }

    await this.safeRecordActivity({
      sessionId: args.turn.sessionId,
      action: "coordinator_research_dispatched",
      actor: null,
    });
    this.sseHub.publish(args.turn.sessionId, {
      type: "status",
      status: "idle",
    });
    return { dispatched: true };
  }

  private async coordinatorResearchBudgetRejection(input: {
    sessionId: number;
    taskCount: number;
    requestedCostUsd: number;
  }): Promise<string | null> {
    const ceilingUsd = optionalNonNegativeNumber(
      process.env.SPEC_FACTORY_RESEARCH_COST_CEILING_USD,
    );
    if (ceilingUsd === null) {
      return "research_budget_unconfigured";
    }

    const usage = await this.composeRepository.getSessionResearchBudgetUsage({
      sessionId: input.sessionId,
      since: new Date(Date.now() - RESEARCH_BUDGET_WINDOW_MS),
    });
    if (
      usage.spentCostUsd + usage.reservedCostUsd + input.requestedCostUsd >
      ceilingUsd
    ) {
      return "budget_exceeded";
    }

    const inFlightLimit =
      optionalNonNegativeInteger(
        process.env.SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION,
      ) ?? DEFAULT_RESEARCH_INFLIGHT_TASKS_PER_SESSION;
    if (usage.inFlightTasks + input.taskCount > inFlightLimit) {
      return "research_inflight_limit";
    }

    const tasksPer24hLimit = optionalNonNegativeInteger(
      process.env.SPEC_FACTORY_RESEARCH_TASKS_PER_24H,
    );
    if (
      tasksPer24hLimit !== null &&
      usage.researchTasks24h + input.taskCount > tasksPer24hLimit
    ) {
      return "research_task_quota";
    }

    const globalCeilingUsd = optionalNonNegativeNumber(
      process.env.SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD,
    );
    const globalInFlightLimit = optionalNonNegativeInteger(
      process.env.SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS,
    );
    const globalTasksPer24hLimit = optionalNonNegativeInteger(
      process.env.SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H,
    );
    if (
      globalCeilingUsd !== null ||
      globalInFlightLimit !== null ||
      globalTasksPer24hLimit !== null
    ) {
      const globalUsage =
        await this.composeRepository.getGlobalResearchBudgetUsage({
          since: new Date(Date.now() - RESEARCH_BUDGET_WINDOW_MS),
        });
      if (
        globalCeilingUsd !== null &&
        globalUsage.spentCostUsd +
          globalUsage.reservedCostUsd +
          input.requestedCostUsd >
          globalCeilingUsd
      ) {
        return "global_budget_exceeded";
      }
      if (
        globalInFlightLimit !== null &&
        globalUsage.inFlightTasks + input.taskCount > globalInFlightLimit
      ) {
        return "global_research_inflight_limit";
      }
      if (
        globalTasksPer24hLimit !== null &&
        globalUsage.researchTasks24h + input.taskCount > globalTasksPer24hLimit
      ) {
        return "global_research_task_quota";
      }
    }

    return null;
  }

  private async coordinatorPendingTasks(
    turnJobId: number,
  ): Promise<CoordinatorContextBundle["pendingTasks"]> {
    const tasks = await this.composeRepository.listTurnAgentTasks(turnJobId);
    return tasks.map((task) => mapCoordinatorPendingTask(task));
  }

  private async recordCoordinatorAgentTaskQueued(input: {
    sessionId: number;
    turnJobId: number | null;
    agentTaskId: number;
    contextVersionUsed: number;
    task: Extract<
      CoordinatorDecision,
      { action: "dispatch_research" }
    >["researchTasks"][number];
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "task.queued",
        payload: {
          capability: input.task.capability,
          executorType: "code_research",
          question: input.task.question.trim(),
          contextVersionUsed: input.contextVersionUsed,
          maxCostUsd: input.task.maxCostUsd,
        },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: input.turnJobId,
        agentTaskId: input.agentTaskId,
        contextVersion: input.contextVersionUsed,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          agentTaskId: input.agentTaskId,
        },
        "Spec Factory coordinator queued-task event write failed",
      );
    }
  }

  private async recordCoordinatorAwaitingUserInput(input: {
    sessionId: number;
    turnJobId: number;
    contextVersion: number | null;
    decision: Extract<CoordinatorDecision, { action: "ask_clarification" }>;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "turn.awaiting_user_input",
        payload: {
          question: input.decision.question,
          reason: input.decision.reason,
          expiresAt: input.decision.expiresAt,
        },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: input.turnJobId,
        contextVersion: input.contextVersion,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
        },
        "Spec Factory coordinator awaiting-user-input event write failed",
      );
    }
  }

  private async recordCoordinatorClarificationAnswered(input: {
    sessionId: number;
    turnJobId: number;
    messageId: number;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "turn.clarification_answered",
        payload: {
          messageId: input.messageId,
        },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: input.turnJobId,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
        },
        "Spec Factory coordinator clarification-answered event write failed",
      );
    }
  }

  private async recordCoordinatorClarificationExpired(input: {
    sessionId: number;
    turnJobId: number;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "turn.clarification_expired",
        payload: {
          turnJobId: input.turnJobId,
        },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: input.turnJobId,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
        },
        "Spec Factory coordinator clarification-expired event write failed",
      );
    }
  }

  private async recordCoordinatorDecisionRejected(input: {
    sessionId: number;
    turnJobId: number | null;
    contextVersion: number | null;
    error: unknown;
  }): Promise<void> {
    const message =
      input.error instanceof Error ? input.error.message : String(input.error);
    const reason = message.replace(/^coordinator_decision_rejected:/, "");
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "coordinator.decision.rejected",
        payload: { reason, message },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: input.turnJobId,
        contextVersion: input.contextVersion,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          reason,
        },
        "Spec Factory coordinator rejection event write failed",
      );
    }
  }

  private async recordCoordinatorPolicyDenied(input: {
    sessionId: number;
    turnJobId: number | null;
    contextVersion: number | null;
    decision: Extract<CoordinatorDecision, { action: "escalate" }>;
  }): Promise<void> {
    try {
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "policy_denied",
        payload: {
          action: "escalate",
          reason: input.decision.reason,
        },
        actorType: "system",
        actorId: "chat_coordinator",
        turnJobId: input.turnJobId,
        contextVersion: input.contextVersion,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
        },
        "Spec Factory coordinator policy-denied event write failed",
      );
    }
  }

  private async enqueueCriticReview(input: {
    sessionId: number;
    turnJobId?: number | null;
    userMessage: string | null;
    answer: string;
    contextVersionUsed: number | null;
    workingContextMarkdown?: string | null;
    generatedResearch?: unknown[];
    evidence?: unknown[];
  }): Promise<void> {
    if (!criticReviewEnqueueEnabled()) return;
    try {
      const agentTaskId = await this.composeRepository.createAgentTask({
        sessionId: input.sessionId,
        turnJobId: input.turnJobId ?? null,
        capability: "critic_review",
        executorType: "critic_review",
        priority: 40,
        maxAttempts: 1,
        outputSourceId: null,
        input: {
          userMessage: boundedCriticText(input.userMessage),
          answer: boundedCriticText(input.answer),
          workingContextMarkdown: boundedCriticText(
            input.workingContextMarkdown,
          ),
          generatedResearch: input.generatedResearch ?? [],
          evidence: input.evidence ?? [],
          contextVersionUsed: input.contextVersionUsed,
        },
      });
      await this.composeRepository.appendSessionEvent({
        sessionId: input.sessionId,
        eventType: "task.queued",
        payload: {
          capability: "critic_review",
          executorType: "critic_review",
          contextVersionUsed: input.contextVersionUsed,
        },
        actorType: "system",
        actorId: "critic_scheduler",
        turnJobId: input.turnJobId ?? null,
        agentTaskId,
        contextVersion: input.contextVersionUsed,
      });
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          turnJobId: input.turnJobId ?? null,
        },
        "Spec Factory critic review enqueue failed",
      );
    }
  }

  private async writeAssistantTurn(input: {
    turnJobId?: number;
    sessionId: number;
    content: string;
    contextVersionUsed: number | null;
    finalPayload?: unknown;
    conversation?: {
      userMessageId?: number | null;
      userMessage: string;
      clarificationAnswer?: boolean;
    };
    turnLease: ActiveTurnLease | null;
  }): Promise<AssistantTurnWrite | null> {
    if (input.turnJobId) {
      const conversationPatch = input.conversation
        ? buildConversationContextPatch({
            turnJobId: input.turnJobId,
            userMessageId: input.conversation.userMessageId,
            userMessage: input.conversation.userMessage,
            assistantMessage: input.content,
            clarificationAnswer: input.conversation.clarificationAnswer,
          })
        : null;
      const completion = {
        turnJobId: input.turnJobId,
        sessionId: input.sessionId,
        content: input.content,
        contextVersionUsed: input.contextVersionUsed,
        finalPayload: input.finalPayload,
        ...(conversationPatch
          ? {
              conversationPatch: {
                patch: conversationPatch,
                messageIds: input.conversation?.userMessageId
                  ? [input.conversation.userMessageId]
                  : [],
              },
            }
          : {}),
        lease: input.turnLease
          ? {
              workerId: input.turnLease.workerId,
              leaseGeneration: input.turnLease.leaseGeneration,
            }
          : undefined,
      };
      for (
        let attempt = 1;
        attempt <= TURN_FINAL_WRITE_MAX_ATTEMPTS;
        attempt += 1
      ) {
        try {
          return await this.composeRepository.completeTurnWithAssistantMessage(
            completion,
          );
        } catch (error) {
          if (
            isMysqlDeadlock(error) &&
            attempt < TURN_FINAL_WRITE_MAX_ATTEMPTS
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new Error("turn_final_write_retry_exhausted");
    }
    return this.composeRepository.appendAssistantMessageIfSessionActive({
      sessionId: input.sessionId,
      content: input.content,
      contextVersionUsed: input.contextVersionUsed,
    });
  }

  private async assertTurnLease(lease: ActiveTurnLease | null): Promise<void> {
    if (!lease) return;
    if (lease.lost) {
      throw new LostTurnLeaseError(lease.turnJobId);
    }
    const valid = await this.composeRepository.confirmTurnLease({
      turnJobId: lease.turnJobId,
      workerId: lease.workerId,
      leaseGeneration: lease.leaseGeneration,
    });
    if (!valid) {
      lease.lost = true;
      throw new LostTurnLeaseError(lease.turnJobId);
    }
  }

  private startTurnLeaseHeartbeat(lease: ActiveTurnLease): () => void {
    const interval = setInterval(() => {
      void this.composeRepository
        .renewTurnLease({
          turnJobId: lease.turnJobId,
          workerId: lease.workerId,
          leaseGeneration: lease.leaseGeneration,
          leaseUntil: turnLeaseUntil(),
        })
        .then((renewed) => {
          if (!renewed) lease.lost = true;
        })
        .catch(() => {
          lease.lost = true;
        });
    }, turnLeaseHeartbeatMs());
    interval.unref?.();
    return () => clearInterval(interval);
  }

  /**
   * Run the legacy_compose_chat turn executor with bounded retry on transient
   * Bedrock failures (throttle / 5xx / transport timeout / network reset).
   * Full Claude SDK wall-budget exhaustion is terminal for the current turn.
   * Deterministic errors fall straight through. Stale resume-session errors
   * clear the stored Claude id once and retry without resume — the same
   * recovery the previous direct call performed, kept here so we don't
   * double-fire on a transient retry.
   */
  private async runLegacyChatExecutorWithRetry(
    runInput: ComposeChatRunInput,
    context: {
      sessionId: number;
      mode: "analyze" | "chat";
      claudeSessionId: string | null;
    },
  ): Promise<ComposeChatRunOutput> {
    let lastError: unknown;
    let resumeCleared = false;
    let currentInput = runInput;
    for (let attempt = 1; attempt <= CHAT_RETRY_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.legacyChatExecutor.execute(currentInput);
      } catch (error) {
        lastError = error;
        // Stale resume conversation — recover once, in-place, without
        // counting against the retry budget.
        if (
          !resumeCleared &&
          context.claudeSessionId &&
          isMissingResumeConversation(error)
        ) {
          resumeCleared = true;
          await this.composeRepository.setClaudeSessionId({
            sessionId: context.sessionId,
            claudeSessionId: null,
          });
          currentInput = { ...currentInput, resumeSessionId: null };
          // Don't increment attempt — the original direct call also did this
          // as a single fallback, not a retry.
          attempt -= 1;
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt >= CHAT_RETRY_MAX_ATTEMPTS ||
          !isTransientChatError(message)
        ) {
          throw error;
        }
        const waitMs = chatRetryBaseMs() * 2 ** (attempt - 1);
        const nextRetryInSeconds = Math.max(1, Math.round(waitMs / 1000));
        this.sseHub.publish(context.sessionId, {
          type: "status",
          status: "retrying",
          mode: context.mode,
          attempt,
          maxAttempts: CHAT_RETRY_MAX_ATTEMPTS,
          nextRetryInSeconds,
        });
        await delay(waitMs);
      }
    }
    // Unreachable — the loop either returns or throws — but TS needs it.
    throw lastError ?? new Error("chat retry failed");
  }

  /**
   * Resolve + clone + scan the relevant code repos for this turn. Only analyze
   * turns pass explicit selections (chat turns ground from auto-identify on the
   * sources). Always degrades safely: if grounding is unconfigured or throws,
   * fall back to the legacy metadata-only repositories.md so the turn proceeds.
   */
  private async groundRepositories(
    mode: "analyze" | "chat",
    repositoryIds: number[] | undefined,
    sources: Array<{ filename: string; content: string }>,
  ): Promise<{
    codeRepoIds: string[];
    repositoriesMarkdown: string;
    manifest: ComposeRepoEvidence[];
  }> {
    const selectedRepositoryIds =
      mode === "analyze" ? normalizeRepositoryIds(repositoryIds) : [];
    if (this.repoGrounding) {
      try {
        return await this.repoGrounding.groundRepos({
          selectedRepositoryIds,
          sources,
        });
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "compose repo grounding failed; falling back to metadata-only",
        );
      }
    }
    // Legacy fallback: metadata-only context, no code attached.
    const repositoryContextMarkdown = renderRepositoryContext(
      mode === "analyze" ? await this.selectedRepositories(repositoryIds) : [],
    );
    return {
      codeRepoIds: [],
      repositoriesMarkdown: repositoryContextMarkdown ?? "",
      manifest: [],
    };
  }

  private async selectedRepositories(
    repositoryIds: number[] | undefined,
  ): Promise<ComposeRepositoryOption[]> {
    const normalizedIds = normalizeRepositoryIds(repositoryIds);
    if (normalizedIds.length === 0 || !this.lookupRepositories) return [];
    const byId = new Map(
      (await this.lookupRepositories()).map((repo) => [
        repo.id,
        mapRepositoryOption(repo),
      ]),
    );
    return normalizedIds
      .map((id) => byId.get(id))
      .filter((repo): repo is ComposeRepositoryOption => Boolean(repo));
  }

  private async completeInlineConvertedSource(input: {
    sessionId: number;
    sourceId: number;
    markdownContent: string;
    baseContextVersion: number | null;
  }): Promise<void> {
    const distillationTask = sourceDistillationEnabled()
      ? {
          sessionId: input.sessionId,
          capability: "source_distillation",
          executorType: "source_distillation",
          input: {
            sourceId: input.sourceId,
            baseContextVersion: input.baseContextVersion,
          },
          priority: 80,
          event: {
            eventType: "task.queued",
            payload: {
              capability: "source_distillation",
              executorType: "source_distillation",
              sourceId: input.sourceId,
              baseContextVersion: input.baseContextVersion,
            },
            actorType: "system",
            actorId: "compose-inline-source",
            contextVersion: input.baseContextVersion,
          },
        }
      : undefined;
    await this.composeRepository.completeSourceConversion({
      sourceId: input.sourceId,
      markdownPath: null,
      markdownContent: input.markdownContent,
      ...(distillationTask ? { distillationTask } : {}),
    });
  }

  private publishTurnStatus(
    sessionId: number,
    mode: "analyze" | "chat",
    message: string,
  ): void {
    this.sseHub.publish(sessionId, {
      type: "status",
      status: "thinking",
      mode,
      message,
    });
  }

  private async safeRecordActivity(input: {
    sessionId: number;
    action: string;
    actor: string | null;
    activeTurn?: "started" | "finished";
  }): Promise<void> {
    try {
      await this.composeRepository.recordSessionActivity(input);
    } catch (error) {
      logger.warn(
        {
          err: error,
          sessionId: input.sessionId,
          action: input.action,
        },
        "Compose session activity update failed",
      );
    }
  }

  private kickConversionDrain(sessionId: number, operation: string): void {
    void this.conversionWorker.drain().catch((error) => {
      logger.error(
        {
          err: error,
          sessionId,
          operation,
        },
        "Compose conversion drain failed",
      );
    });
  }

  private logTurnFailure(
    context: { sessionId: number; mode: "analyze" | "chat" },
    error: unknown,
  ): void {
    logger.error(
      { err: error, sessionId: context.sessionId, mode: context.mode },
      "Compose clarification turn failed",
    );
  }

  /**
   * Enqueue a turn onto the per-session serial chain. Returns false (without
   * enqueuing) when the session already has MAX_QUEUED_TURNS_PER_SESSION turns
   * pending, so callers can surface backpressure instead of growing the chain
   * unbounded.
   */
  private enqueueTurn(input: {
    sessionId: number;
    mode: "analyze" | "chat";
    latestUserMessage: string | null;
    userMessageId?: number | null;
    repositoryIds?: number[];
    turnJobId?: number;
  }): boolean {
    const depth = this.queuedDepth.get(input.sessionId) ?? 0;
    if (depth >= MAX_QUEUED_TURNS_PER_SESSION) {
      return false;
    }
    this.queuedDepth.set(input.sessionId, depth + 1);

    const previous = this.queuedTurns.get(input.sessionId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        this.legacyRunningTurns.add(input.sessionId);
        try {
          await this.runTurn(input);
        } finally {
          this.legacyRunningTurns.delete(input.sessionId);
        }
      })
      // Surface turn failures server-side: runTurn only publishes an SSE error
      // event, which no-ops when no client is connected, so without this log a
      // failed turn would vanish. Still swallow so the next queued turn runs.
      .catch((error) => {
        this.logTurnFailure(
          { sessionId: input.sessionId, mode: input.mode },
          error,
        );
      })
      .finally(() => {
        const remaining = (this.queuedDepth.get(input.sessionId) ?? 1) - 1;
        if (remaining <= 0) {
          this.queuedDepth.delete(input.sessionId);
        } else {
          this.queuedDepth.set(input.sessionId, remaining);
        }
        if (this.queuedTurns.get(input.sessionId) === queued) {
          this.queuedTurns.delete(input.sessionId);
        }
      })
      .then(() => undefined);
    this.queuedTurns.set(input.sessionId, queued);
    return true;
  }

  async analyze(input: {
    sessionId: number;
    repositoryIds?: number[];
    reset?: boolean;
    actor?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ComposeTurnAccepted> {
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    await this.assertNoBlockedSources({
      sessionId: input.sessionId,
      blockedStatuses: ANALYZE_BLOCKING_STATUSES,
      message: (blocked) =>
        `Cannot analyze Compose session ${input.sessionId} until sources finish processing: ${formatBlockedSources(blocked)}`,
    });
    let durableTurn: {
      turnJobId: number;
      messageId: number | null;
      status: string;
      deduplicated: boolean;
    } | null = null;
    if (input.idempotencyKey) {
      const repositoryIds = normalizeRepositoryIds(input.repositoryIds);
      const createAnalyzeTurnInput = {
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        requestHash: turnRequestHash({
          type: "analyze",
          repositoryIds,
          reset: input.reset === true,
        }),
      };
      durableTurn = await this.composeRepository.createAnalyzeTurn(
        input.reset
          ? { ...createAnalyzeTurnInput, resetSessionProgress: true }
          : createAnalyzeTurnInput,
      );
      if (durableTurn.deduplicated) {
        await this.recordTurnEvent({
          sessionId: input.sessionId,
          turnJobId: durableTurn.turnJobId,
          eventType: "turn.duplicate_suppressed",
          actor: input.actor ?? null,
          payload: {
            turnJobId: durableTurn.turnJobId,
            turnKind: "analyze",
            userMessageId: durableTurn.messageId,
            status: durableTurn.status,
          },
        });
        return {
          accepted: true,
          messageId: durableTurn.messageId,
          turnJobId: durableTurn.turnJobId,
          status: durableTurn.status,
        };
      }
      await this.recordTurnEvent({
        sessionId: input.sessionId,
        turnJobId: durableTurn.turnJobId,
        eventType: "turn.queued",
        actor: input.actor ?? null,
        payload: {
          turnJobId: durableTurn.turnJobId,
          turnKind: "analyze",
          userMessageId: durableTurn.messageId,
          status: durableTurn.status,
          repositoryIds,
        },
      });
    }
    const legacyExecution = legacyTurnExecutionEnabled();
    if (!legacyExecution && !durableTurn) {
      return { accepted: false, reason: "durable_turn_required" };
    }
    if (input.reset && !input.idempotencyKey) {
      await this.composeRepository.resetSessionProgress(input.sessionId);
    }
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: input.reset ? "analyze_reset_requested" : "analyze_requested",
      actor: input.actor ?? null,
    });
    if (!legacyExecution && durableTurn) {
      return {
        accepted: true,
        messageId: durableTurn.messageId,
        turnJobId: durableTurn.turnJobId,
        status: durableTurn.status,
      };
    }
    const accepted = this.enqueueTurn({
      sessionId: input.sessionId,
      mode: "analyze",
      latestUserMessage: null,
      repositoryIds: input.repositoryIds,
      turnJobId: durableTurn?.turnJobId,
    });
    if (!accepted) return { accepted: false, reason: "queue_full" };
    if (!durableTurn) return { accepted: true };
    return {
      accepted: true,
      messageId: durableTurn.messageId,
      turnJobId: durableTurn.turnJobId,
      status: durableTurn.status,
    };
  }

  async postMessage(input: {
    sessionId: number;
    content: string;
    actor?: string | null;
    idempotencyKey?: string | null;
  }): Promise<ComposeTurnAccepted> {
    const content = input.content.trim();
    if (!content) throw new Error("Message content is required");
    // Validate the session exists before persisting the user turn (clean 404 + no failed INSERT).
    await this.requireMutableSession(
      input.sessionId,
      actorContextFromActorId(input.actor),
    );
    const legacyExecution = legacyTurnExecutionEnabled();
    if (!legacyExecution && !input.idempotencyKey) {
      return { accepted: false, reason: "durable_turn_required" };
    }
    // Reject before persisting so a queue_full turn does not orphan a user
    // message with no assistant reply.
    if (
      legacyExecution &&
      (this.queuedDepth.get(input.sessionId) ?? 0) >=
        MAX_QUEUED_TURNS_PER_SESSION
    ) {
      return { accepted: false, reason: "queue_full" };
    }
    let messageId: number | null = null;
    let turnJobId: number | undefined;
    let turnStatus: string | undefined;
    if (input.idempotencyKey) {
      const clarificationAnswer =
        await this.composeRepository.answerAwaitingClarification({
          sessionId: input.sessionId,
          content,
          idempotencyKey: input.idempotencyKey,
        });
      if (clarificationAnswer?.answered) {
        messageId = clarificationAnswer.messageId ?? null;
        turnJobId = clarificationAnswer.turnJobId;
        turnStatus = clarificationAnswer.status;
        await this.safeRecordActivity({
          sessionId: input.sessionId,
          action: "clarification_answered",
          actor: input.actor ?? null,
        });
        if (!clarificationAnswer.deduplicated) {
          this.sseHub.publish(input.sessionId, {
            type: "message",
            role: "user",
            content,
          });
          if (turnJobId && messageId) {
            await this.recordCoordinatorClarificationAnswered({
              sessionId: input.sessionId,
              turnJobId,
              messageId,
            });
          }
        }
        if (clarificationAnswer.deduplicated && turnJobId) {
          await this.recordTurnEvent({
            sessionId: input.sessionId,
            turnJobId,
            eventType: "turn.duplicate_suppressed",
            actor: input.actor ?? null,
            payload: {
              turnJobId,
              turnKind: "chat",
              userMessageId: messageId,
              status: turnStatus,
            },
          });
        }
        if (!legacyExecution && turnJobId) {
          return {
            accepted: true,
            messageId,
            turnJobId,
            status: turnStatus,
          };
        }
        if (!clarificationAnswer.deduplicated && turnJobId) {
          const accepted = this.enqueueTurn({
            sessionId: input.sessionId,
            mode: "chat",
            latestUserMessage: null,
            userMessageId: clarificationAnswer.userMessageId,
            turnJobId,
          });
          if (!accepted) return { accepted: false, reason: "queue_full" };
        }
        return {
          accepted: true,
          messageId,
          turnJobId,
          status: turnStatus,
        };
      }
      if (clarificationAnswer?.expiredTurnId) {
        await this.recordCoordinatorClarificationExpired({
          sessionId: input.sessionId,
          turnJobId: clarificationAnswer.expiredTurnId,
        });
      }
      const durableTurn = await this.composeRepository.createMessageTurn({
        sessionId: input.sessionId,
        content,
        idempotencyKey: input.idempotencyKey,
        requestHash: turnRequestHash({ type: "message", content }),
      });
      messageId = durableTurn.messageId;
      turnJobId = durableTurn.turnJobId;
      turnStatus = durableTurn.status;
      if (durableTurn.deduplicated) {
        await this.recordTurnEvent({
          sessionId: input.sessionId,
          turnJobId,
          eventType: "turn.duplicate_suppressed",
          actor: input.actor ?? null,
          payload: {
            turnJobId,
            turnKind: "chat",
            userMessageId: messageId,
            status: turnStatus,
          },
        });
        return {
          accepted: true,
          messageId,
          turnJobId,
          status: turnStatus,
        };
      }
      await this.recordTurnEvent({
        sessionId: input.sessionId,
        turnJobId,
        eventType: "turn.queued",
        actor: input.actor ?? null,
        payload: {
          turnJobId,
          turnKind: "chat",
          userMessageId: messageId,
          status: turnStatus,
        },
      });
    } else {
      messageId = await this.composeRepository.appendMessage({
        sessionId: input.sessionId,
        role: "user",
        content,
      });
    }
    await this.safeRecordActivity({
      sessionId: input.sessionId,
      action: "message_received",
      actor: input.actor ?? null,
    });
    this.sseHub.publish(input.sessionId, {
      type: "message",
      role: "user",
      content,
    });
    if (!legacyExecution && turnJobId) {
      return {
        accepted: true,
        messageId,
        turnJobId,
        status: turnStatus,
      };
    }
    const accepted = this.enqueueTurn({
      sessionId: input.sessionId,
      mode: "chat",
      latestUserMessage: content,
      userMessageId: messageId,
      turnJobId,
    });
    if (!accepted) return { accepted: false, reason: "queue_full" };
    if (!turnJobId) return { accepted: true };
    return {
      accepted: true,
      messageId,
      turnJobId,
      status: turnStatus,
    };
  }

  async listMessages(sessionId: number, actor?: string | null) {
    await this.requireReadableSession(
      sessionId,
      actorContextFromActorId(actor),
    );
    return this.composeRepository.listMessages(sessionId);
  }

  async getWorkflowState(sessionId: number, actor?: string | null) {
    await this.requireReadableSession(
      sessionId,
      actorContextFromActorId(actor),
    );
    return this.composeRepository.getSessionWorkflowState(sessionId);
  }

  private async requireReadableSession(
    sessionId: number,
    actor: ActorContext = SYSTEM_ACTOR,
  ): Promise<ComposeSessionSummary> {
    return assertSessionReadable(
      await this.composeRepository.getSession(sessionId),
      sessionId,
      actor,
    );
  }

  private async requireMutableSession(
    sessionId: number,
    actor: ActorContext = SYSTEM_ACTOR,
  ): Promise<ComposeSessionSummary> {
    return assertSessionMutable(
      await this.composeRepository.getSession(sessionId),
      sessionId,
      actor,
    );
  }

  private async requireStreamableSession(
    sessionId: number,
    actor: ActorContext = SYSTEM_ACTOR,
  ): Promise<ComposeSessionSummary> {
    return assertSessionStreamable(
      await this.composeRepository.getSession(sessionId),
      sessionId,
      actor,
    );
  }

  private async requireHandoffAllowedSession(
    sessionId: number,
    actor: ActorContext = SYSTEM_ACTOR,
  ): Promise<ComposeSessionSummary> {
    return assertSessionHandoffAllowed(
      await this.composeRepository.getSession(sessionId),
      sessionId,
      actor,
    );
  }

  private async assertNoBlockedSources(input: {
    sessionId: number;
    blockedStatuses: Set<ComposeConversionStatus>;
    message: (blocked: ComposeSessionSourceSummary[]) => string;
  }): Promise<ComposeSessionSourceSummary[]> {
    const sources = await this.composeRepository.listSessionSources(
      input.sessionId,
    );
    const blocked = sources.filter((source) =>
      input.blockedStatuses.has(source.conversionStatus),
    );
    if (blocked.length > 0) {
      throw new Error(input.message(blocked));
    }
    return sources;
  }
}

export function enrichCoordinatorReadiness(
  readiness: ComposeReadiness,
  bundle: CoordinatorContextBundle | null,
  proposed: Extract<CoordinatorDecision, { action: "answer" }>["details"],
): ComposeReadiness {
  const existing = readiness.details ?? {};
  const sourceRepositories =
    bundle?.attachedSources.flatMap(
      (source) => source.entities?.repositories ?? [],
    ) ?? [];
  const sourceLoeHours =
    bundle?.attachedSources.flatMap(
      (source) => source.entities?.loeHours ?? [],
    ) ?? [];
  const repositories = uniqueNonEmptyStrings([
    ...(existing.repositories ?? []),
    ...sourceRepositories,
    ...(proposed?.repositories ?? []),
  ]).slice(0, 20);
  const sourceLoe = sourceLoeHours
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce<
      number | null
    >((largest, value) => (largest === null ? value : Math.max(largest, value)), null);
  const module =
    cleanMetadataString(existing.module) ??
    cleanMetadataString(proposed?.module);
  const difficulty =
    cleanMetadataString(existing.difficulty) ??
    cleanMetadataString(proposed?.difficulty);
  const loeHours =
    nonNegativeMetadataNumber(existing.loeHours) ??
    nonNegativeMetadataNumber(proposed?.loeHours) ??
    sourceLoe;
  const storyPoints =
    nonNegativeMetadataNumber(existing.storyPoints) ??
    nonNegativeMetadataNumber(proposed?.storyPoints);
  const details = {
    ...existing,
    ...(module ? { module } : {}),
    ...(repositories.length > 0 ? { repositories } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(loeHours !== null ? { loeHours } : {}),
    ...(storyPoints !== null ? { storyPoints } : {}),
  };
  if (Object.keys(details).length === 0) return readiness;
  return { ...readiness, details };
}

function sameReadiness(
  left: ComposeReadiness,
  right: ComposeReadiness | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(cloneReadiness(right));
}

function cleanMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function nonNegativeMetadataNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
