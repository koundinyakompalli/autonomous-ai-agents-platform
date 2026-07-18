import { z } from "zod";
import type { SpecFactoryRuntimeMode } from "./runtime-modes.js";

export const SPEC_FACTORY_LABEL = "SPEC-FACTORY";
export const SPEC_FACTORY_GENERATED_LABEL = "SPEC-FACTORY-GENERATED";
export const SPEC_FACTORY_STARTED_LABEL = "SPEC-FACTORY-STARTED";
export const LOUISE_ESTIMATED_LABEL = "louise-estimated";
export const PFOS_LABEL = "PFOS";

export const SPEC_FACTORY_LOUISE_JQL =
  process.env.SPEC_FACTORY_LOUISE_JQL ||
  'labels = "louise-estimated" AND labels not in ("SPEC-FACTORY-STARTED") ORDER BY updated DESC';

export const SourceStateSchema = z.enum([
  "candidate",
  "drafting",
  "draft_ready",
  "approved",
  "oneshot_submitted",
  "needs_attention",
  "not_qualified",
  "archived",
]);

export const SourceOriginSchema = z.enum(["louise", "compose"]);

export const QualificationReasonSchema = z.enum([
  "config_only",
  "needs_repo",
  "needs_information",
  "attachment_issue",
  "generation_failed",
]);

export const DraftStatusSchema = z.enum([
  "generating",
  "ready",
  "approved",
  "superseded",
  "failed",
]);

export const ChildTicketStateSchema = z.enum([
  "draft",
  "created",
  "pfos_labeled",
  "oneshot_requested",
  "oneshot_running",
  "oneshot_terminal",
  "failed",
]);

export type SourceState = z.infer<typeof SourceStateSchema>;
export type SourceOrigin = z.infer<typeof SourceOriginSchema>;
export type QualificationReason = z.infer<typeof QualificationReasonSchema>;
export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export type ChildTicketState = z.infer<typeof ChildTicketStateSchema>;

export const SpecFactoryChildTicketDraftSchema = z.object({
  repoName: z.string().trim().min(1),
  repoId: z.number().int().positive().optional(),
  summary: z.string().trim().min(1),
  overview: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(2),
  technicalDetails: z.object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).optional(),
    targetFiles: z.array(z.string().trim().min(1)).default([]),
    implementationNotes: z.array(z.string().trim().min(1)).min(1),
  }),
  outOfScope: z.array(z.string().trim().min(1)).default([]),
  testingNotes: z.array(z.string().trim().min(1)).default([]),
  loeHours: z.number().nonnegative().optional(),
  sourceEvidenceRefs: z.array(z.string().trim().min(1)).default([]),
});

export const SpecFactoryDraftBundleSchema = z.object({
  sourceJiraKey: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]+-\d+$/),
  loeHours: z.number().nonnegative().optional(),
  epic: z.object({
    summary: z.string().trim().min(1),
    description: z.string().trim().min(1),
    businessContext: z.array(z.string().trim().min(1)).min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    assumptions: z.array(z.string().trim().min(1)).default([]),
    dependencies: z.array(z.string().trim().min(1)).default([]),
  }),
  childTickets: z.array(SpecFactoryChildTicketDraftSchema).min(1),
  evidenceSummary: z.array(z.string().trim().min(1)).default([]),
  warnings: z.array(z.string().trim().min(1)).default([]),
});

export type SpecFactoryDraftBundle = z.infer<
  typeof SpecFactoryDraftBundleSchema
>;
export type SpecFactoryChildTicketDraft = z.infer<
  typeof SpecFactoryChildTicketDraftSchema
>;

export interface SpecFactorySourceSummary {
  id: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  loeHours: number | null;
  state: SourceState;
  origin: SourceOrigin;
  approvedEpicKey: string | null;
  qualificationReasons: QualificationReason[];
  errorMessage: string | null;
  updatedAt: string;
}

export interface SpecFactoryChildTicketSummary {
  id: number;
  repoName: string;
  summary: string;
  description: string | null;
  loeHours: number | null;
  jiraKey: string | null;
  state: ChildTicketState;
  oneshotRequestId: number | null;
  oneshotRunId: number | null;
  errorMessage: string | null;
}

export interface SpecFactoryAttachmentSummary {
  id: number;
  sourceId: number;
  jiraAttachmentId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  artifactKind: string;
  isPriority: boolean;
  s3Bucket: string | null;
  s3Key: string | null;
  sha256: string | null;
  extractedText: string | null;
  extractionStatus:
    | "stored"
    | "extracted"
    | "unsupported"
    | "failed"
    | "skipped";
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpecFactoryAttachmentRetryResult {
  source: SpecFactorySourceSummary;
  attachments: SpecFactoryAttachmentSummary[];
  retriedCount: number;
  beforeAttentionCount: number;
  afterAttentionCount: number;
}

export interface SpecFactoryEvidenceSnapshot {
  id: number;
  sourceId: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  sourceLabels: string[];
  descriptionMarkdown: string;
  comments: unknown[];
  loeHours: number | null;
  loeSource: string | null;
  artifacts: unknown[];
  repoReferences: unknown;
  warnings: string[];
  createdAt: string;
}

export interface SpecFactoryDraftDetail {
  id: number;
  sourceId: number;
  version: number;
  evidenceSnapshotId: number | null;
  status: DraftStatus;
  draft: SpecFactoryDraftBundle | null;
  renderedMarkdown: string | null;
  evidenceManifest: unknown;
  childTickets: SpecFactoryChildTicketSummary[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpecFactoryDraftRequestResult {
  queued: boolean;
  workflowId?: number;
  workflowStatus?: "queued";
  source: SpecFactorySourceSummary;
  draft: SpecFactoryDraftDetail | null;
}

export interface SpecFactoryEventSummary {
  id: number;
  sourceId: number;
  eventType: string;
  actor: string | null;
  requestId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface SpecFactoryBoardRefresh {
  status: "started" | "running" | "skipped" | "completed" | "failed";
  scanned?: number;
  upserted?: number;
  matched?: number;
  truncated?: boolean;
  claimed?: number;
  claimFailures?: number;
  autoQueued?: number;
  reason?: string;
  lastFetchedAt?: string | null;
  nextRefreshAt?: string | null;
  error?: string | null;
}

export interface SpecFactoryBoardRefreshResult {
  refresh: SpecFactoryBoardRefresh;
  sources: SpecFactorySourceSummary[];
}

export interface SpecFactoryProcessingJobHealth {
  byStatus: Record<"queued" | "running" | "succeeded" | "failed", number>;
  staleRunning: number;
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
}

export interface SpecFactoryComposeConversionHealth {
  byStatus: Record<
    | "awaiting_upload"
    | "pending"
    | "converting"
    | "converted"
    | "unsupported"
    | "failed",
    number
  >;
  inFlight: number;
  retryable: number;
  oldestPendingAt: string | null;
  oldestConvertingAt: string | null;
}

export type SpecFactoryComposeTurnHealthStatus =
  | "queued"
  | "running"
  | "waiting_on_research"
  | "awaiting_user_input"
  | "synthesizing"
  | "completed"
  | "failed"
  | "abandoned"
  | "cancelled";

export interface SpecFactoryComposeTurnHealth {
  byStatus: Record<SpecFactoryComposeTurnHealthStatus, number>;
  durableQueued: number;
  durableRunning: number;
  durableAbandoned: number;
  legacyInflight: number;
  legacyQueued: number;
  duplicateSuppressedToday: number;
  leaseExpired: number;
  leaseFenceRejected: number;
  outcomesByContextVersionToday: Array<{
    contextVersionUsed: number | null;
    completed: number;
    failed: number;
    cancelled: number;
    abandoned: number;
    total: number;
  }>;
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
}

export type SpecFactoryComposeAgentTaskHealthStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export interface SpecFactoryComposeAgentTaskHealth {
  byStatus: Record<SpecFactoryComposeAgentTaskHealthStatus, number>;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  abandoned: number;
  leaseExpired: number;
  leaseFenceRejected: number;
  byCapability: Record<
    string,
    {
      queued: number;
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
      abandoned: number;
      total: number;
      leaseExpired: number;
      oldestQueuedAt: string | null;
      oldestRunningAt: string | null;
    }
  >;
  oldestQueuedAt: string | null;
  oldestRunningAt: string | null;
}

export interface SpecFactoryComposeCoordinatorHealth {
  decisionsToday: {
    answer: number;
    dispatchResearch: number;
    askClarification: number;
    escalate: number;
    rejected: number;
  };
  latestDecisionAt: string | null;
}

export interface SpecFactoryComposeRetentionHealth {
  pendingWorkspaceCleanup: number;
  failedWorkspaceCleanup: number;
  oldestPendingArchivedAt: string | null;
  latestCleanupErrorAt: string | null;
  pendingLlmAuditArtifacts: number;
  oldestPendingLlmAuditArtifactAt: string | null;
}

export interface SpecFactoryComposeEventHealth {
  durablePublishedToday: number;
  durablePersistFailuresToday: number;
  payloadTooLargeToday: number;
  liveDeliveredByThisReplica: number;
  replayedByThisReplica: number;
  latestPublishedAt: string | null;
  latestDurableErrorAt: string | null;
}

export interface SpecFactoryComposeStreamHealth {
  activeSubscribers: number;
  activeSessions: number;
  connectedByThisReplica: number;
  disconnectedByThisReplica: number;
}

export interface SpecFactoryComposeStreamTokenHealth {
  activeTokens: number;
  expiredUnrevokedTokens: number;
  createdToday: number;
  revokedToday: number;
  latestCreatedAt: string | null;
  latestRevokedAt: string | null;
}

export interface SpecFactoryComposeResearchHealth {
  runningTasks: number;
  completedToday: number;
  failedToday: number;
  avgRuntimeSecondsToday: number;
  maxRuntimeSecondsToday: number;
  oldestRunningStartedAt: string | null;
  latestTerminalAt: string | null;
}

export interface SpecFactoryComposeContextHealth {
  patchesReady: number;
  patchesBuilding: number;
  patchesFailed: number;
  oldestReadyPatchAt: string | null;
  versionsCommittedToday: number;
  versionsFailedToday: number;
  versionsBuilding: number;
  latestCommittedVersionAt: string | null;
  latestFailedVersionAt: string | null;
}

export interface SpecFactoryComposeControlPlaneHealth {
  turns: SpecFactoryComposeTurnHealth;
  agentTasks: SpecFactoryComposeAgentTaskHealth;
  llm: {
    callsToday: number;
    failedToday: number;
    inputTokensToday: number;
    outputTokensToday: number;
    estimatedCostUsdToday: number;
    latestCallAt: string | null;
    byPurposeToday: Record<
      string,
      {
        callsToday: number;
        failedToday: number;
        inputTokensToday: number;
        outputTokensToday: number;
        estimatedCostUsdToday: number;
        latestCallAt: string | null;
      }
    >;
  };
  workers: {
    total: number;
    live: number;
    stale: number;
    byMode: Record<
      SpecFactoryRuntimeMode,
      {
        total: number;
        live: number;
        stale: number;
        latestHeartbeatAt: string | null;
      }
    >;
  };
  coordinator: SpecFactoryComposeCoordinatorHealth;
  retention: SpecFactoryComposeRetentionHealth;
  events: SpecFactoryComposeEventHealth;
  streams: SpecFactoryComposeStreamHealth;
  streamTokens: SpecFactoryComposeStreamTokenHealth;
  research: SpecFactoryComposeResearchHealth;
  context: SpecFactoryComposeContextHealth;
}

export interface SpecFactoryStatusSummary {
  generatedAt: string;
  board: {
    activeSourceCount: number;
    latestRefreshAt: string | null;
    byState: Record<SourceState, number>;
    byOrigin: Record<SourceOrigin, number>;
  };
  processing: SpecFactoryProcessingJobHealth;
  composeConversion: SpecFactoryComposeConversionHealth;
  composeControlPlane: SpecFactoryComposeControlPlaneHealth;
}
