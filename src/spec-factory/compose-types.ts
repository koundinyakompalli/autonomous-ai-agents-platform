import { z } from "zod";

export const ComposeSessionStatusSchema = z.enum([
  "draft",
  "ready",
  "handed_off",
  "archived",
]);
export type ComposeSessionStatus = z.infer<typeof ComposeSessionStatusSchema>;

export type ComposeContextStatus = "dirty" | "building" | "clean";

export const ComposeSourceKindSchema = z.enum([
  "file",
  "youtube",
  "chat",
  "note",
  "jira",
  "confluence",
  "generated_research",
]);
export type ComposeSourceKind = z.infer<typeof ComposeSourceKindSchema>;

export const ComposeConverterSchema = z.enum(["markitdown", "voxtral", "none"]);
export type ComposeConverter = z.infer<typeof ComposeConverterSchema>;

export const ComposeConversionStatusSchema = z.enum([
  "awaiting_upload",
  "pending",
  "converting",
  "converted",
  "unsupported",
  "failed",
]);
export type ComposeConversionStatus = z.infer<
  typeof ComposeConversionStatusSchema
>;

export const ComposeMessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type ComposeMessageRole = z.infer<typeof ComposeMessageRoleSchema>;

export interface ComposeReadiness {
  ready: boolean;
  openQuestions: string[];
  summary: string;
  details?: ComposeReadinessDetails | null;
  confidence?: ComposeReadinessConfidence | null;
  risks?: string[];
  assumptions?: string[];
  missingEvidence?: string[];
  nextStep?: string;
  validatorWarnings?: ComposeReadinessWarning[];
  /**
   * Per-repo code-grounding evidence: which repos were attached as live
   * read-only checkouts (or a warning when a repo could only be used as
   * metadata). Optional + backward-compatible; populated when repo grounding
   * is enabled.
   */
  repoEvidence?: ComposeRepoEvidence[];
  /**
   * Aggregate summary of the clarification agent's actual code investigation
   * this turn (files read, grep/search calls). Distinct from repoEvidence,
   * which describes the pre-scan; this reflects what the agent really did.
   */
  codeInvestigation?: ComposeCodeInvestigation;
  /** #2 — 2-3 lines describing what we're shaping. */
  ideating?: string;
  /** #2 — 1-2 lines describing the problem we're solving. */
  problem?: string;
  /** Requirements-first context synthesized after each committed context version. */
  solution?: string;
  businessRequirements?: string[];
  functionalRequirements?: string[];
  challenges?: string[];
  /** #5/#6/#7 — structured questions; supersedes openQuestions for render when present. */
  questions?: ComposeOpenQuestion[];
  /** #1 — the draft contract: one child ticket per story. */
  stories?: ComposeStory[];
}

export interface ComposeReadinessConfidence {
  score: number;
  rationale: string;
}

export interface ComposeReadinessWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "blocker";
}

export interface ComposeCodeInvestigation {
  /** Distinct files the agent opened/Read across the attached repos. */
  filesRead: number;
  /** Total tool calls (Read/Grep/Glob/Bash) the agent made this turn. */
  toolCalls: number;
}

export interface ComposeRepoEvidence {
  repoName: string;
  headSha?: string | null;
  /** Short tech-stack summary, e.g. "TypeScript/Express". */
  techStack?: string | null;
  /** Key file paths the scan/agent surfaced. */
  inspectedPaths: string[];
  /** Notable findings, e.g. "AppealsController.submit() found". */
  keyMatches: string[];
  /** Non-empty when the repo degraded to metadata-only (clone/scan failed). */
  warnings: string[];
}

export interface ComposeReadinessDetails {
  module?: string | null;
  repositories?: string[];
  difficulty?: string | null;
  loeHours?: number | null;
  storyPoints?: number | null;
}

export interface ComposeOpenQuestion {
  id: string;
  /** Precise, <= ~15 words, one concrete decision. */
  question: string;
  /** Up to 3 concrete candidate answers (A/B/C). */
  options?: string[];
  answered?: boolean;
  /** The chosen or typed answer once resolved. */
  answer?: string;
  questionType?:
    | "business"
    | "functional"
    | "implementation"
    | "research_consent";
}

export interface ComposeStory {
  id: string;
  title: string;
  /** One line. */
  summary: string;
  repos?: string[];
  sequence?: number;
  userStory?: string;
  businessValue?: string;
  acceptanceCriteria?: string[];
}

export interface ComposeRepositoryOption {
  id: number;
  repoName: string;
  repoUrl: string;
  defaultBranch: string | null;
  description: string;
}

export interface ComposeSourceEntities {
  jiraKeys: string[];
  repositories: string[];
  files: string[];
  clients: string[];
  loeHours: number[];
  dates: string[];
  assumptions: string[];
}

export type ComposeSourceUsefulness =
  | "high_signal"
  | "needs_clarification"
  | "duplicate"
  | "missing_repo_context"
  | "weak_requirement_detail"
  | "unknown";

const ComposeReadinessDetailsSchema = z.object({
  module: z.string().trim().min(1).nullable().optional(),
  repositories: z.array(z.string().trim().min(1)).default([]).optional(),
  difficulty: z.string().trim().min(1).nullable().optional(),
  loeHours: z.number().nonnegative().nullable().optional(),
  storyPoints: z.number().nonnegative().nullable().optional(),
});

const ComposeReadinessConfidenceSchema = z.object({
  score: z.number().min(0).max(1),
  rationale: z.string().trim().default(""),
});

const ComposeReadinessWarningSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  severity: z.enum(["info", "warning", "blocker"]),
});

const ComposeOpenQuestionSchema = z.object({
  id: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).max(3).optional(),
  answered: z.boolean().optional(),
  answer: z.string().trim().min(1).optional(),
  questionType: z
    .enum(["business", "functional", "implementation", "research_consent"])
    .optional(),
});

const ComposeStorySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().trim().default(""),
  repos: z.array(z.string().trim().min(1)).optional(),
  sequence: z.number().int().nonnegative().optional(),
  userStory: z.string().trim().min(1).optional(),
  businessValue: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).optional(),
});

export const ComposeReadinessSchema = z.object({
  ready: z.boolean(),
  openQuestions: z.array(z.string().trim().min(1)).default([]),
  summary: z.string().trim().default(""),
  details: ComposeReadinessDetailsSchema.nullable().optional(),
  confidence: ComposeReadinessConfidenceSchema.nullable().optional(),
  risks: z.array(z.string().trim().min(1)).optional(),
  assumptions: z.array(z.string().trim().min(1)).optional(),
  missingEvidence: z.array(z.string().trim().min(1)).optional(),
  nextStep: z.string().trim().min(1).optional(),
  validatorWarnings: z.array(ComposeReadinessWarningSchema).optional(),
  ideating: z.string().trim().min(1).optional(),
  problem: z.string().trim().min(1).optional(),
  solution: z.string().trim().min(1).optional(),
  businessRequirements: z.array(z.string().trim().min(1)).optional(),
  functionalRequirements: z.array(z.string().trim().min(1)).optional(),
  challenges: z.array(z.string().trim().min(1)).optional(),
  questions: z.array(ComposeOpenQuestionSchema).optional(),
  stories: z.array(ComposeStorySchema).optional(),
});

export const ComposeChatEnvelopeSchema = z.object({
  reply: z.string().trim().min(1),
  readiness: ComposeReadinessSchema,
  contextMarkdown: z.string().trim().min(1).optional(),
});
export type ComposeChatEnvelope = z.infer<typeof ComposeChatEnvelopeSchema>;

export type ComposeChatEvent =
  | {
      type: "status";
      status: "thinking" | "idle" | "error";
      mode?: "analyze" | "chat";
      message?: string;
      code?: string;
    }
  | {
      // Emitted before each backoff wait when chatAgent.run hits a transient
      // failure. Cross-lane parity: dashboard/src/types' ComposeStreamEvent
      // must mirror this variant so the SSE consumer can render a retry banner.
      type: "status";
      status: "retrying";
      mode?: "analyze" | "chat";
      attempt: number;
      maxAttempts: number;
      nextRetryInSeconds: number;
    }
  | { type: "message"; role: ComposeMessageRole; content: string }
  | { type: "readiness"; readiness: ComposeReadiness }
  | { type: "invalidate"; resource: "messages"; role?: ComposeMessageRole }
  | { type: "invalidate"; resource: "readiness" }
  | { type: "session"; status: "archived" };

export type ComposeTurnAccepted =
  | {
      accepted: true;
      messageId?: number | null;
      turnJobId?: number;
      status?: string;
    }
  | { accepted: false; reason: "queue_full" | "durable_turn_required" };

export interface ComposeSessionSummary {
  id: number;
  name: string;
  createdBy: string | null;
  createdByDisplay: string | null;
  agentPersonaKey?: string | null;
  agentPersonaName?: string | null;
  lastActiveAt?: string | null;
  lastAction?: string | null;
  lastActor?: string | null;
  analysisRunning?: boolean;
  status: ComposeSessionStatus;
  claudeSessionId: string | null;
  sourceId: number | null;
  readiness: ComposeReadiness | null;
  s3Prefix: string;
  workspacePath: string;
  sourceCount: number;
  passwordProtected: boolean;
  latestContextVersion?: number | null;
  contextStatus?: ComposeContextStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeContextProjectionSummary {
  objective: string | null;
  problemStatement: string | null;
  solution: string | null;
  businessRequirements: string[];
  functionalRequirements: string[];
  challenges: string[];
  stories: ComposeStory[];
  recommendedNextActions: string[];
}

export interface ComposeContextProjection {
  sessionId: number;
  version: number;
  artifactUri: string | null;
  structuredArtifactUri: string | null;
  summary: ComposeContextProjectionSummary | null;
  facts: unknown[];
  implementationFindings: unknown[];
  requirements: unknown[];
  constraints: unknown[];
  openQuestions: unknown[];
  conflicts: unknown[];
  decisions: unknown[];
  risks: unknown[];
  sourceIds: number[];
  patchIds: number[];
  committedAt: string | null;
}

export interface ComposeSessionSourceSummary {
  id: number;
  sessionId: number;
  requestId: string | null;
  kind: ComposeSourceKind;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  s3KeyRaw: string | null;
  converter: ComposeConverter;
  markdownPath: string | null;
  markdownContent: string | null;
  sourceSummary?: string | null;
  sourceEntities?: ComposeSourceEntities | null;
  sourceUsefulness?: ComposeSourceUsefulness | null;
  sourceContribution?: string | null;
  sourceOrigin?: string | null;
  generatedByTaskId?: number | null;
  parentSourceIds?: number[] | null;
  contextVersionUsed?: number | null;
  evidence?: unknown;
  confidence?: string | null;
  artifactUri?: string | null;
  artifactSha256?: string | null;
  artifactBytes?: number | null;
  currentRevisionId?: number | null;
  contentSha256?: string | null;
  deletedAt?: string | null;
  conversionStatus: ComposeConversionStatus;
  conversionStartedAt: string | null;
  conversionAttempts: number;
  conversionLeaseExpiresAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ComposeSourceDeletionStatus =
  | "undoable"
  | "restored"
  | "purging"
  | "purged"
  | "failed";

export interface ComposeSourceDeletionSummary {
  id: number;
  sessionId: number;
  sourceId: number;
  sourceTitle: string;
  status: ComposeSourceDeletionStatus;
  undoUntil: string;
  invalidatedSourceIds: number[];
  invalidatedHandoffIds: number[];
  dependentSourceCount: number;
  createdAt: string;
}

export interface ComposeConversionQueueHealth {
  byStatus: Record<ComposeConversionStatus, number>;
  inFlight: number;
  retryable: number;
  oldestPendingAt: string | null;
  oldestConvertingAt: string | null;
}

export interface ComposeSessionMessageSummary {
  id: number;
  sessionId: number;
  role: ComposeMessageRole;
  content: string;
  createdAt: string;
}

export type ComposeBackgroundAgentStatus =
  | "idle"
  | "working"
  | "waiting"
  | "attention";

export interface ComposeBackgroundAgentState {
  key: "sources" | "requirements" | "research" | "draft";
  label: string;
  status: ComposeBackgroundAgentStatus;
  detail: string;
  activeCount: number;
}

export interface ComposeSessionWorkflowState {
  sessionId: number;
  generatedAt: string;
  turn: {
    id: number;
    kind: "chat" | "analyze";
    status: string;
    attemptCount: number;
    maxAttempts: number;
    queuePosition: number | null;
    requestedContextVersion: number | null;
    contextVersionUsed: number | null;
    queuedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    clarificationExpiresAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
  handoff: {
    id: number;
    sourceId: number | null;
    status: string;
    contextVersionUsed: number | null;
    messageHighWatermarkId: number | null;
    snapshotId: number | null;
    draftWorkflowId: number | null;
    workflowStatus: string | null;
    workflowStage: string | null;
    draftId: number | null;
    epicKey: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string;
  } | null;
  agents: ComposeBackgroundAgentState[];
}

/** Synthetic Spec Factory source key for a handed-off compose session. */
export function composeSourceJiraKey(sessionId: number): string {
  return `COMPOSE-${sessionId}`;
}

export interface ComposeUploadTarget {
  sourceId: number;
  uploadUrl: string;
  s3KeyRaw: string;
  expiresInSeconds: number;
}

export const COMPOSE_SESSION_EXPORT_FORMAT = "spec-factory.compose-session";
export const COMPOSE_SESSION_EXPORT_VERSION = 1;

export const ComposeSessionExportSourceSchema = z.object({
  kind: ComposeSourceKindSchema,
  originalFilename: z.string().trim().max(255).nullable().default(null),
  mimeType: z.string().trim().max(255).nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  sourceUrl: z.string().trim().max(2048).nullable().default(null),
  markdownContent: z.string().trim().min(1).max(2_000_000),
});
export type ComposeSessionExportSource = z.infer<
  typeof ComposeSessionExportSourceSchema
>;

export const ComposeSessionExportMessageSchema = z.object({
  role: ComposeMessageRoleSchema,
  content: z.string().trim().min(1).max(200_000),
});
export type ComposeSessionExportMessage = z.infer<
  typeof ComposeSessionExportMessageSchema
>;

export const ComposeSessionExportBundleSchema = z.object({
  format: z.literal(COMPOSE_SESSION_EXPORT_FORMAT),
  version: z.literal(COMPOSE_SESSION_EXPORT_VERSION),
  exportedAt: z.string().datetime(),
  session: z.object({
    name: z.string().trim().min(1).max(255),
    createdByDisplay: z.string().trim().max(255).nullable().default(null),
    readiness: ComposeReadinessSchema.nullable().default(null),
  }),
  sources: z.array(ComposeSessionExportSourceSchema).max(200).default([]),
  messages: z.array(ComposeSessionExportMessageSchema).max(500).default([]),
});
export type ComposeSessionExportBundle = z.infer<
  typeof ComposeSessionExportBundleSchema
>;

export interface ComposeSessionImportResult {
  session: ComposeSessionSummary;
  importedSources: number;
  importedMessages: number;
}
