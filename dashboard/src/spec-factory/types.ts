export type SpecFactorySourceState =
  | "candidate"
  | "drafting"
  | "draft_ready"
  | "approved"
  | "oneshot_submitted"
  | "needs_attention"
  | "not_qualified"
  | "archived";

export type SpecFactorySourceOrigin = "louise" | "compose";

export type SpecFactoryQualificationReason =
  | "config_only"
  | "needs_repo"
  | "needs_information"
  | "attachment_issue"
  | "generation_failed";

export type SpecFactoryDraftStatus =
  | "generating"
  | "ready"
  | "approved"
  | "superseded"
  | "failed";

export type SpecFactoryChildTicketState =
  | "draft"
  | "created"
  | "pfos_labeled"
  | "oneshot_requested"
  | "oneshot_running"
  | "oneshot_terminal"
  | "failed";

export interface SpecFactorySourceSummary {
  id: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  loeHours: number | null;
  state: SpecFactorySourceState;
  origin: SpecFactorySourceOrigin;
  approvedEpicKey: string | null;
  qualificationReasons: SpecFactoryQualificationReason[];
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
  state: SpecFactoryChildTicketState;
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

export interface SpecFactoryChildTicketDraft {
  repoName: string;
  repoId?: number;
  summary: string;
  overview: string;
  acceptanceCriteria: string[];
  technicalDetails: {
    repo: string;
    branch?: string;
    targetFiles: string[];
    implementationNotes: string[];
  };
  outOfScope: string[];
  testingNotes: string[];
  loeHours?: number;
  sourceEvidenceRefs: string[];
}

export interface SpecFactoryDraftBundle {
  sourceJiraKey: string;
  loeHours?: number;
  epic: {
    summary: string;
    description: string;
    businessContext: string[];
    acceptanceCriteria: string[];
    assumptions: string[];
    dependencies: string[];
  };
  childTickets: SpecFactoryChildTicketDraft[];
  evidenceSummary: string[];
  warnings: string[];
}

export interface SpecFactoryDraftDetail {
  id: number;
  sourceId: number;
  version: number;
  evidenceSnapshotId: number | null;
  status: SpecFactoryDraftStatus;
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

export interface SpecFactoryOneShotSubmissionSummary {
  source: SpecFactorySourceSummary;
  childTickets: SpecFactoryChildTicketSummary[];
}

export interface SpecFactoryRefreshResult {
  refresh?: {
    status?: "started" | "running" | "skipped" | "completed" | "failed";
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
  };
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
      string,
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
    byState: Record<SpecFactorySourceState, number>;
    byOrigin: Record<SpecFactorySourceOrigin, number>;
  };
  processing: SpecFactoryProcessingJobHealth;
  composeConversion: SpecFactoryComposeConversionHealth;
  composeControlPlane: SpecFactoryComposeControlPlaneHealth;
}
