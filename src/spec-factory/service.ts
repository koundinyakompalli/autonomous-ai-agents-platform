import type {
  SpecFactoryOneShotSubmissionSummary,
  SpecFactoryRepository,
  SpecFactorySourceWithNextDraftVersion,
} from "./database.js";
import type {
  CandidateIngestorNewSource,
  CandidateIngestorRefreshResult,
} from "./candidate-ingestor.js";
import type { GenerateDraftResult } from "./draft-generator.js";
import type { EvidenceManifest } from "./evidence.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";
import type {
  JiraPublisherApprovalOptions,
  JiraPublisherApprovalResult,
} from "./jira-publisher.js";
import type {
  OneShotSubmitChildResult,
  SpecFactoryActor,
} from "./oneshot-submitter.js";
import type {
  SpecFactoryBoardRefreshResult,
  SpecFactoryAttachmentRetryResult,
  SpecFactoryComposeControlPlaneHealth,
  SpecFactoryAttachmentSummary,
  SpecFactoryComposeConversionHealth,
  SpecFactoryDraftBundle,
  SpecFactoryDraftRequestResult,
  SpecFactoryDraftDetail,
  SpecFactoryEventSummary,
  QualificationReason,
  SourceOrigin,
  SourceState,
  SpecFactoryStatusSummary,
  SpecFactorySourceSummary,
} from "./types.js";
import { validateDraftBundle } from "./draft-validator.js";
import { renderDraftMarkdown } from "./renderers.js";
import {
  SpecFactoryTaskWorkspaceManager,
  type SpecFactoryTaskWorkspace,
} from "./evidence-workspace.js";
import {
  SpecFactoryQualifier,
  type SpecFactoryQualificationDecision,
} from "./qualifier.js";
import {
  currentSpecFactoryCorrelation,
  runWithSpecFactoryCorrelation,
} from "./telemetry/correlation.js";
import {
  specFactoryMetrics,
  type SpecFactoryMetrics,
  type SpecFactoryWorkOutcome,
} from "./telemetry/metrics.js";
import { withSpecFactorySpan } from "./telemetry/tracing.js";
import { DraftWorkflowWorker } from "./draft-workflow-worker.js";
import type {
  ClaimedDraftStageRun,
  DraftStageExecutionOutput,
} from "./draft-workflow-types.js";
import type { ImmutableArtifactStore } from "./storage/immutable-s3-artifact-store.js";
import { SPEC_FACTORY_RUNTIME_MODES } from "./runtime-modes.js";

type RefreshRunResult = CandidateIngestorRefreshResult & {
  autoQueued: number;
};

type Repository = Pick<
  SpecFactoryRepository,
  | "listLouiseBoardSources"
  | "getLatestIntakeRefreshAt"
  | "recordIntakeRefresh"
  | "getSourceById"
  | "createDraft"
  | "reviseDraft"
  | "markSourceDrafting"
  | "getLatestDraft"
  | "markSourceNeedsAttention"
  | "markSourceNotQualified"
  | "markDraftGenerationFailed"
  | "archiveSource"
  | "restoreArchivedSource"
  | "createProcessingJob"
  | "expireStaleProcessingJobs"
  | "expireStaleQueuedProcessingJobs"
  | "claimNextProcessingJob"
  | "completeProcessingJob"
  | "failProcessingJob"
  | "getProcessingJobHealth"
  | "listSourceEvents"
  | "listSourceAttachments"
  | "markDraftApproved"
  | "updateSourceApproved"
  | "updateChildCreated"
  | "listApprovedChildren"
  | "updateChildSubmitted"
  | "markSourceOneShotSubmitted"
  | "recordEvent"
  | "getSourceOrigin"
  | "createDraftWorkflow"
  | "queueDraftWorkflowApproval"
  | "claimNextDraftStage"
  | "completeDraftStage"
  | "failDraftStage"
> & {
  listOneShotSubmissions?: () => Promise<SpecFactoryOneShotSubmissionSummary[]>;
  listArchivedSources?: () => Promise<SpecFactorySourceSummary[]>;
};

interface Ingestor {
  refresh(): Promise<CandidateIngestorRefreshResult>;
}

interface EvidenceCollector {
  collect(sourceId: number): Promise<EvidenceManifest>;
}

interface RepoContextCollector {
  collect(input: {
    sourceId: number;
    evidenceManifest: EvidenceManifest;
    qualification?: Pick<SpecFactoryQualificationDecision, "repoHints">;
  }): Promise<SpecFactoryRepoContextManifest>;
}

interface EvidenceWorkspaceManager {
  prepare(input: {
    sourceId: number;
    evidenceManifest: EvidenceManifest;
    repoContextManifest?: SpecFactoryRepoContextManifest | null;
  }): Promise<SpecFactoryTaskWorkspace>;
}

interface Generator {
  generate(input: {
    sourceId: number;
    sourceJiraKey: string;
    repoIds: string[];
    evidenceManifest: EvidenceManifest;
    repoContextManifest?: SpecFactoryRepoContextManifest;
    taskWorkspace?: SpecFactoryTaskWorkspace;
  }): Promise<GenerateDraftResult>;
}

interface Qualifier {
  qualify(input: {
    sourceId: number;
    sourceJiraKey: string;
    evidenceManifest: EvidenceManifest;
    taskWorkspace: SpecFactoryTaskWorkspace;
  }): Promise<SpecFactoryQualificationDecision>;
}

interface Publisher {
  approveDraft(
    draft: SpecFactoryDraftDetail,
    options?: JiraPublisherApprovalOptions,
  ): Promise<JiraPublisherApprovalResult>;
}

interface ComposeHealthProvider {
  getConversionQueueHealth(): Promise<SpecFactoryComposeConversionHealth>;
  getControlPlaneHealth?(): Promise<SpecFactoryComposeControlPlaneHealth>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredStageOutput<T>(
  stage: ClaimedDraftStageRun,
  stageName: keyof ClaimedDraftStageRun["priorOutputs"],
): T {
  const output = stage.priorOutputs[stageName];
  if (!output || typeof output !== "object") {
    throw new Error(
      `draft_stage_input_missing:${String(stageName)}:${stage.workflowId}`,
    );
  }
  return output as T;
}

interface Submitter {
  submitChildren(input: {
    children: SpecFactoryDraftDetail["childTickets"];
    actor: SpecFactoryActor;
    onChildSubmitted?: (result: OneShotSubmitChildResult) => Promise<void>;
  }): Promise<OneShotSubmitChildResult[]>;
}

interface SpecFactoryServiceOptions {
  repoDeepDiveEnabled?: boolean;
  workerId?: string;
  pollIntervalMs?: number;
  boardRefreshTtlMs?: number;
  processingJobStaleMs?: number;
  processingJobQueuedStaleMs?: number;
  draftWorkflowV2Enabled?: boolean;
  draftWorkflowConcurrency?: number;
  draftArtifactStore?: ImmutableArtifactStore;
  qualifier?: Qualifier;
  composeEvidenceProvider?: EvidenceCollector;
  composeHealthProvider?: ComposeHealthProvider;
  metrics?: Pick<
    SpecFactoryMetrics,
    "recordWorkStarted" | "recordWorkCompleted"
  >;
}

type ClaimedProcessingJob = NonNullable<
  Awaited<ReturnType<Repository["claimNextProcessingJob"]>>
>;

const DRAFT_GENERATION_JOB = "draft_generation";
const DEFAULT_BOARD_REFRESH_TTL_MS = 60 * 60 * 1000;
// A draft generation alone can run up to SPEC_FACTORY_DRAFT_TIMEOUT_MS (default
// 20m), on top of qualify + repo deep-dive in the same job. The stale window
// must comfortably exceed that whole budget so a legitimately-slow live job is
// not expired out from under itself; the status-guarded complete/fail keeps an
// expiry that does still fire from corrupting state, but a wider default makes
// false expiries rare in the first place.
const DEFAULT_PROCESSING_JOB_STALE_MS = 45 * 60 * 1000;
// On a single-replica restart, a queued job whose worker died (and its
// `drafting` source) can sit forever — claimNextProcessingJob will keep
// finding it but the source is already in a terminal-feeling state. After
// 60min of sitting in 'queued', age it out and repair the source state
// (mirrors the running-job stale repair).
const DEFAULT_PROCESSING_JOB_QUEUED_STALE_MS = 60 * 60 * 1000;
const SOURCE_STATES: SourceState[] = [
  "candidate",
  "drafting",
  "draft_ready",
  "approved",
  "oneshot_submitted",
  "needs_attention",
  "not_qualified",
  "archived",
];
const SOURCE_ORIGINS: SourceOrigin[] = ["louise", "compose"];

function defaultComposeConversionHealth(): SpecFactoryComposeConversionHealth {
  return {
    byStatus: {
      awaiting_upload: 0,
      pending: 0,
      converting: 0,
      converted: 0,
      unsupported: 0,
      failed: 0,
    },
    inFlight: 0,
    retryable: 0,
    oldestPendingAt: null,
    oldestConvertingAt: null,
  };
}

function defaultWorkerHealthByMode(): SpecFactoryComposeControlPlaneHealth["workers"]["byMode"] {
  return Object.fromEntries(
    SPEC_FACTORY_RUNTIME_MODES.map((mode) => [
      mode,
      { total: 0, live: 0, stale: 0, latestHeartbeatAt: null },
    ]),
  ) as SpecFactoryComposeControlPlaneHealth["workers"]["byMode"];
}

function defaultComposeControlPlaneHealth(): SpecFactoryComposeControlPlaneHealth {
  return {
    turns: {
      byStatus: {
        queued: 0,
        running: 0,
        waiting_on_research: 0,
        awaiting_user_input: 0,
        synthesizing: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        cancelled: 0,
      },
      durableQueued: 0,
      durableRunning: 0,
      durableAbandoned: 0,
      legacyInflight: 0,
      legacyQueued: 0,
      duplicateSuppressedToday: 0,
      leaseExpired: 0,
      leaseFenceRejected: 0,
      outcomesByContextVersionToday: [],
      oldestQueuedAt: null,
      oldestRunningAt: null,
    },
    agentTasks: {
      byStatus: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        abandoned: 0,
      },
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      leaseExpired: 0,
      leaseFenceRejected: 0,
      byCapability: {},
      oldestQueuedAt: null,
      oldestRunningAt: null,
    },
    llm: {
      callsToday: 0,
      failedToday: 0,
      inputTokensToday: 0,
      outputTokensToday: 0,
      estimatedCostUsdToday: 0,
      latestCallAt: null,
      byPurposeToday: {},
    },
    workers: {
      total: 0,
      live: 0,
      stale: 0,
      byMode: defaultWorkerHealthByMode(),
    },
    coordinator: {
      decisionsToday: {
        answer: 0,
        dispatchResearch: 0,
        askClarification: 0,
        escalate: 0,
        rejected: 0,
      },
      latestDecisionAt: null,
    },
    retention: {
      pendingWorkspaceCleanup: 0,
      failedWorkspaceCleanup: 0,
      oldestPendingArchivedAt: null,
      latestCleanupErrorAt: null,
      pendingLlmAuditArtifacts: 0,
      oldestPendingLlmAuditArtifactAt: null,
    },
    events: {
      durablePublishedToday: 0,
      durablePersistFailuresToday: 0,
      payloadTooLargeToday: 0,
      liveDeliveredByThisReplica: 0,
      replayedByThisReplica: 0,
      latestPublishedAt: null,
      latestDurableErrorAt: null,
    },
    streams: {
      activeSubscribers: 0,
      activeSessions: 0,
      connectedByThisReplica: 0,
      disconnectedByThisReplica: 0,
    },
    streamTokens: {
      activeTokens: 0,
      expiredUnrevokedTokens: 0,
      createdToday: 0,
      revokedToday: 0,
      latestCreatedAt: null,
      latestRevokedAt: null,
    },
    research: {
      runningTasks: 0,
      completedToday: 0,
      failedToday: 0,
      avgRuntimeSecondsToday: 0,
      maxRuntimeSecondsToday: 0,
      oldestRunningStartedAt: null,
      latestTerminalAt: null,
    },
    context: {
      patchesReady: 0,
      patchesBuilding: 0,
      patchesFailed: 0,
      oldestReadyPatchAt: null,
      versionsCommittedToday: 0,
      versionsFailedToday: 0,
      versionsBuilding: 0,
      latestCommittedVersionAt: null,
      latestFailedVersionAt: null,
    },
  };
}

function attachmentNeedsAttention(
  attachment: SpecFactoryAttachmentSummary,
): boolean {
  return ["failed", "skipped", "unsupported"].includes(
    attachment.extractionStatus,
  );
}

function priorityAttachmentBlockMessage(
  attachments: SpecFactoryAttachmentSummary[],
): string | null {
  const blocking = attachments.filter(
    (attachment) =>
      attachment.isPriority && attachmentNeedsAttention(attachment),
  );
  if (blocking.length === 0) return null;
  const labels = blocking
    .slice(0, 5)
    .map(
      (attachment) => `${attachment.filename} (${attachment.extractionStatus})`,
    );
  const suffix =
    blocking.length > labels.length
      ? ` and ${(blocking.length - labels.length).toString()} more`
      : "";
  return `Retry priority attachments before generating a draft: ${labels.join(", ")}${suffix}.`;
}

function isAttachmentGenerationBlockedMessage(message: string): boolean {
  return /^Retry priority attachments before generating a draft:/i.test(
    message,
  );
}

function boardRefreshMetrics(
  refresh: RefreshRunResult | null,
): Partial<SpecFactoryBoardRefreshResult["refresh"]> {
  if (!refresh) return {};
  return {
    scanned: refresh.scanned,
    upserted: refresh.upserted,
    matched: refresh.matched,
    truncated: refresh.truncated,
    claimed: refresh.claimed,
    claimFailures: refresh.claimFailures,
    autoQueued: refresh.autoQueued,
  };
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function positiveNumberEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isSdkTimeoutMessage(message: string): boolean {
  return /SDK timeout after\s+\d+ms/i.test(message);
}

function requireSource(
  source: SpecFactorySourceWithNextDraftVersion | null,
  sourceId: number,
): SpecFactorySourceWithNextDraftVersion {
  if (!source) {
    throw new Error(`Spec Factory source ${sourceId} was not found`);
  }
  return source;
}

function requireLatestDraft(
  draft: SpecFactoryDraftDetail | null,
  sourceId: number,
): SpecFactoryDraftDetail {
  if (!draft) {
    throw new Error(`Spec Factory source ${sourceId} has no draft`);
  }
  return draft;
}

function repoIdsFromContext(
  repoContextManifest: SpecFactoryRepoContextManifest,
): string[] {
  return repoContextManifest.repos
    .map((repo) => repo.repoId?.trim())
    .filter((repoId): repoId is string => Boolean(repoId));
}

function stripRepoContextRuntimeHandles(
  repoContextManifest: SpecFactoryRepoContextManifest | null,
): SpecFactoryRepoContextManifest | null {
  if (!repoContextManifest) return null;
  return {
    ...repoContextManifest,
    repos: repoContextManifest.repos.map(
      ({ cleanup: _cleanup, ...repo }) => repo,
    ),
  };
}

async function cleanupRepoContextWorkspaces(input: {
  sourceId: number;
  repoContextManifest: SpecFactoryRepoContextManifest | null;
  repository: Pick<Repository, "recordEvent">;
  workerId: string;
}): Promise<void> {
  const repos =
    input.repoContextManifest?.repos.filter((repo) => repo.cleanup) ?? [];
  if (repos.length === 0) return;

  const cleaned: string[] = [];
  const failed: Array<{ repoName: string; message: string }> = [];

  for (const repo of repos) {
    try {
      await repo.cleanup?.();
      cleaned.push(repo.repoName);
    } catch (error) {
      failed.push({ repoName: repo.repoName, message: errorMessage(error) });
    }
  }

  await input.repository.recordEvent(
    input.sourceId,
    failed.length === 0
      ? "repo_workspace_cleanup_completed"
      : "repo_workspace_cleanup_incomplete",
    input.workerId,
    { cleaned, failed },
  );
}

function notQualifiedMessage(
  reasons: QualificationReason[],
  evidenceManifest: EvidenceManifest,
  qualifierSummary?: string | null,
): string {
  if (qualifierSummary?.trim()) {
    return qualifierSummary.trim();
  }
  if (reasons.includes("config_only")) {
    return "Louise evidence describes configuration-only work, so no OneShot development Epic will be generated.";
  }
  if (reasons.includes("needs_repo")) {
    return "Spec Factory could not identify a repo reference matched against code_repositories.";
  }
  if (reasons.includes("attachment_issue")) {
    return "One or more priority Louise attachments could not be extracted for drafting.";
  }
  if (reasons.includes("needs_information")) {
    return "Spec Factory does not have enough source evidence to generate a OneShot-ready Epic.";
  }
  return `Spec Factory could not qualify ${evidenceManifest.sourceJiraKey} for draft generation.`;
}

export class SpecFactoryService {
  private refreshPromise: Promise<RefreshRunResult> | null = null;
  private latestRefresh: RefreshRunResult | null = null;
  private latestRefreshError: string | null = null;
  private processing = false;
  private processingTimer: NodeJS.Timeout | null = null;
  private readonly repoDeepDiveEnabled: boolean;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly boardRefreshTtlMs: number;
  private readonly processingJobStaleMs: number;
  private readonly processingJobQueuedStaleMs: number;
  private readonly draftWorkflowV2Enabled: boolean;
  private readonly draftWorkflowConcurrency: number;
  private readonly draftArtifactStore: ImmutableArtifactStore | undefined;
  private readonly qualifier: Qualifier;
  private readonly composeEvidenceProvider: EvidenceCollector | null;
  private readonly composeHealthProvider: ComposeHealthProvider | null;
  private readonly metrics: Pick<
    SpecFactoryMetrics,
    "recordWorkStarted" | "recordWorkCompleted"
  >;

  constructor(
    private readonly repository: Repository,
    private readonly ingestor: Ingestor,
    private readonly evidenceCollector: EvidenceCollector,
    private readonly repoContextCollector: RepoContextCollector,
    private readonly generator: Generator,
    private readonly publisher: Publisher,
    private readonly submitter: Submitter,
    private readonly taskWorkspaceManager: EvidenceWorkspaceManager = new SpecFactoryTaskWorkspaceManager(),
    options: SpecFactoryServiceOptions = {},
  ) {
    this.repoDeepDiveEnabled =
      options.repoDeepDiveEnabled ??
      booleanEnv("SPEC_FACTORY_REPO_DEEP_DIVE_ENABLED", false);
    this.workerId =
      options.workerId ||
      process.env.ECS_TASK_ARN ||
      process.env.HOSTNAME ||
      `spec-factory-${process.pid}`;
    this.pollIntervalMs =
      options.pollIntervalMs ??
      Number(process.env.SPEC_FACTORY_PROCESSOR_POLL_MS || 5000);
    this.boardRefreshTtlMs =
      options.boardRefreshTtlMs ??
      positiveNumberEnv(
        "SPEC_FACTORY_BOARD_REFRESH_TTL_MS",
        DEFAULT_BOARD_REFRESH_TTL_MS,
      );
    this.processingJobStaleMs =
      options.processingJobStaleMs ??
      positiveNumberEnv(
        "SPEC_FACTORY_PROCESSING_JOB_STALE_MS",
        DEFAULT_PROCESSING_JOB_STALE_MS,
      );
    this.processingJobQueuedStaleMs =
      options.processingJobQueuedStaleMs ??
      positiveNumberEnv(
        "SPEC_FACTORY_PROCESSING_JOB_QUEUED_STALE_MS",
        DEFAULT_PROCESSING_JOB_QUEUED_STALE_MS,
      );
    this.draftWorkflowV2Enabled =
      options.draftWorkflowV2Enabled ??
      booleanEnv("SPEC_FACTORY_DRAFT_WORKFLOW_V2_ENABLED", false);
    this.draftWorkflowConcurrency = Math.max(
      1,
      Math.min(
        16,
        options.draftWorkflowConcurrency ??
          positiveNumberEnv("SPEC_FACTORY_DRAFT_WORKFLOW_CONCURRENCY", 2),
      ),
    );
    this.draftArtifactStore = options.draftArtifactStore;
    this.qualifier = options.qualifier ?? new SpecFactoryQualifier();
    this.composeEvidenceProvider = options.composeEvidenceProvider ?? null;
    this.composeHealthProvider = options.composeHealthProvider ?? null;
    this.metrics = options.metrics ?? specFactoryMetrics;
  }

  async refreshLouiseBoard(): Promise<SpecFactoryBoardRefreshResult> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.runBoardRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }

    const refresh = await this.refreshPromise;
    return {
      refresh: { status: "completed", ...boardRefreshMetrics(refresh) },
      sources: await this.repository.listLouiseBoardSources(),
    };
  }

  async requestBoardRefresh(
    input: {
      force?: boolean;
    } = {},
  ): Promise<SpecFactoryBoardRefreshResult> {
    return this.requestLouiseBoardRefresh(input);
  }

  async requestLouiseBoardRefresh(
    input: {
      force?: boolean;
    } = {},
  ): Promise<SpecFactoryBoardRefreshResult> {
    const latestFetchAt = await this.repository.getLatestIntakeRefreshAt();
    const latestFetchMs = latestFetchAt ? new Date(latestFetchAt).getTime() : 0;
    const now = Date.now();
    const hasFreshCache =
      !input.force &&
      latestFetchMs > 0 &&
      now - latestFetchMs < this.boardRefreshTtlMs;

    if (hasFreshCache) {
      return {
        refresh: {
          status: "skipped",
          reason: "fresh_cache",
          lastFetchedAt: latestFetchAt,
          nextRefreshAt: new Date(
            latestFetchMs + this.boardRefreshTtlMs,
          ).toISOString(),
          ...boardRefreshMetrics(this.latestRefresh),
        },
        sources: await this.repository.listLouiseBoardSources(),
      };
    }

    if (this.refreshPromise) {
      return {
        refresh: {
          status: "running",
          reason: "already_in_progress",
          lastFetchedAt: latestFetchAt,
          nextRefreshAt: latestFetchMs
            ? new Date(latestFetchMs + this.boardRefreshTtlMs).toISOString()
            : null,
          ...boardRefreshMetrics(this.latestRefresh),
          error: this.latestRefreshError,
        },
        sources: await this.repository.listLouiseBoardSources(),
      };
    }

    this.refreshPromise = this.runBoardRefresh().finally(() => {
      this.refreshPromise = null;
    });

    void this.refreshPromise.catch((error) => {
      console.warn(
        `[spec-factory] background Louise refresh failed: ${errorMessage(error)}`,
      );
    });

    return {
      refresh: {
        status: "started",
        reason: input.force ? "manual_force" : "stale_or_empty_cache",
        lastFetchedAt: latestFetchAt,
        nextRefreshAt: latestFetchMs
          ? new Date(latestFetchMs + this.boardRefreshTtlMs).toISOString()
          : null,
        ...boardRefreshMetrics(this.latestRefresh),
      },
      sources: await this.repository.listLouiseBoardSources(),
    };
  }

  async listBoardSources(): Promise<SpecFactorySourceSummary[]> {
    return this.repository.listLouiseBoardSources();
  }

  async getSource(
    sourceId: number,
  ): Promise<SpecFactorySourceWithNextDraftVersion | null> {
    return this.repository.getSourceById(sourceId);
  }

  async listLouiseBoard(): Promise<SpecFactorySourceSummary[]> {
    return this.listBoardSources();
  }

  async getStatus(): Promise<SpecFactoryStatusSummary> {
    const now = new Date();
    const staleStartedBefore = new Date(
      now.getTime() - this.processingJobStaleMs,
    );
    const [
      sources,
      latestRefreshAt,
      processing,
      composeConversion,
      composeControlPlane,
    ] = await Promise.all([
      this.repository.listLouiseBoardSources(),
      this.repository.getLatestIntakeRefreshAt(),
      this.repository.getProcessingJobHealth({ staleStartedBefore }),
      this.composeHealthProvider?.getConversionQueueHealth() ??
        Promise.resolve(defaultComposeConversionHealth()),
      this.composeHealthProvider?.getControlPlaneHealth?.() ??
        Promise.resolve(defaultComposeControlPlaneHealth()),
    ]);

    const byState = Object.fromEntries(
      SOURCE_STATES.map((state) => [state, 0]),
    ) as Record<SourceState, number>;
    const byOrigin = Object.fromEntries(
      SOURCE_ORIGINS.map((origin) => [origin, 0]),
    ) as Record<SourceOrigin, number>;
    for (const source of sources) {
      byState[source.state] = (byState[source.state] ?? 0) + 1;
      byOrigin[source.origin] = (byOrigin[source.origin] ?? 0) + 1;
    }

    return {
      generatedAt: now.toISOString(),
      board: {
        activeSourceCount: sources.length,
        latestRefreshAt,
        byState,
        byOrigin,
      },
      processing,
      composeConversion,
      composeControlPlane,
    };
  }

  async requestDraftGeneration(input: {
    sourceId: number;
    actor?: string | null;
    idempotencyKey?: string | null;
    handoffSnapshotId?: number | null;
    reuseExistingDraft?: boolean;
  }): Promise<SpecFactoryDraftRequestResult> {
    const source = requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    if (input.reuseExistingDraft) {
      const existingDraft = await this.repository.getLatestDraft(
        input.sourceId,
      );
      if (
        existingDraft &&
        (existingDraft.status === "ready" ||
          existingDraft.status === "approved")
      ) {
        await this.repository.recordEvent(
          input.sourceId,
          "draft_generation_reused",
          input.actor ?? null,
          {
            draftId: existingDraft.id,
            draftVersion: existingDraft.version,
            draftStatus: existingDraft.status,
            handoffSnapshotId: input.handoffSnapshotId ?? null,
          },
        );
        return {
          queued: false,
          source,
          draft: existingDraft,
        };
      }
    }
    const attachmentBlockMessage = priorityAttachmentBlockMessage(
      source.origin === "louise"
        ? await this.repository.listSourceAttachments(input.sourceId)
        : [],
    );
    if (attachmentBlockMessage) {
      throw new Error(attachmentBlockMessage);
    }
    if (this.draftWorkflowV2Enabled) {
      const workflow = await this.repository.createDraftWorkflow({
        sourceId: input.sourceId,
        idempotencyKey:
          input.idempotencyKey?.trim() ||
          currentSpecFactoryCorrelation().requestId ||
          `draft-${input.sourceId}-${Date.now()}`,
        requestedBy: input.actor ?? null,
        handoffSnapshotId: input.handoffSnapshotId ?? null,
        immutableInput: {
          sourceId: input.sourceId,
          handoffSnapshotId: input.handoffSnapshotId ?? null,
        },
      });
      await this.repository.recordEvent(
        input.sourceId,
        "draft_workflow_queued",
        input.actor ?? null,
        {
          workflowId: workflow.workflowId,
          deduplicated: workflow.deduplicated,
          handoffSnapshotId: input.handoffSnapshotId ?? null,
        },
      );
      this.kickProcessing();
      return {
        queued: true,
        workflowId: workflow.workflowId,
        workflowStatus: "queued",
        source: requireSource(
          await this.repository.getSourceById(input.sourceId),
          input.sourceId,
        ),
        draft: await this.repository.getLatestDraft(input.sourceId),
      };
    }
    await this.expireStaleDraftGenerationJobs();
    await this.repository.markSourceDrafting(input.sourceId);
    const jobId = await this.repository.createProcessingJob({
      sourceId: input.sourceId,
      jobType: DRAFT_GENERATION_JOB,
      requestedBy: input.actor ?? null,
    });
    await this.repository.recordEvent(
      input.sourceId,
      "draft_generation_queued",
      input.actor ?? null,
      { jobId },
    );

    this.kickProcessing();

    return {
      queued: true,
      source: requireSource(
        await this.repository.getSourceById(input.sourceId),
        input.sourceId,
      ),
      draft: await this.repository.getLatestDraft(input.sourceId),
    };
  }

  async generateDraft(input: {
    sourceId: number;
  }): Promise<SpecFactoryDraftDetail | null> {
    let repoContextManifest: SpecFactoryRepoContextManifest | null = null;
    try {
      const source = requireSource(
        await this.repository.getSourceById(input.sourceId),
        input.sourceId,
      );
      const attachmentBlockMessage = priorityAttachmentBlockMessage(
        source.origin === "louise"
          ? await this.repository.listSourceAttachments(input.sourceId)
          : [],
      );
      if (attachmentBlockMessage) {
        throw new Error(attachmentBlockMessage);
      }
      await this.repository.markSourceDrafting(input.sourceId);
      const origin = await this.repository.getSourceOrigin(input.sourceId);
      const isCompose = origin === "compose";
      if (isCompose && !this.composeEvidenceProvider) {
        throw new Error(
          `Compose source ${input.sourceId} requires a composeEvidenceProvider, but none was configured`,
        );
      }
      const provider = isCompose
        ? this.composeEvidenceProvider!
        : this.evidenceCollector;
      const evidenceManifest = await provider.collect(input.sourceId);
      let taskWorkspace = await this.taskWorkspaceManager.prepare({
        sourceId: input.sourceId,
        evidenceManifest,
        repoContextManifest: null,
      });
      // Qualifier runs for every origin; compose ignores a soft reject but still uses repoHints for the deep dive.
      const qualification = await this.qualifier.qualify({
        sourceId: input.sourceId,
        sourceJiraKey: source.sourceJiraKey,
        evidenceManifest,
        taskWorkspace,
      });
      await this.repository.recordEvent(
        input.sourceId,
        "draft_generation_qualification_completed",
        this.workerId,
        {
          sourceJiraKey: evidenceManifest.sourceJiraKey,
          qualified: qualification.qualified,
          reasons: qualification.reasons,
          confidence: qualification.confidence,
          summary: qualification.summary,
          evidenceRefs: qualification.evidenceRefs,
          repoHints: qualification.repoHints,
          warnings: qualification.warnings,
          modelMetadata: qualification.modelMetadata,
        },
      );

      if (!qualification.qualified && !isCompose) {
        const qualificationReasons = qualification.reasons.length
          ? qualification.reasons
          : (["needs_information"] satisfies QualificationReason[]);
        const message = notQualifiedMessage(
          qualificationReasons,
          evidenceManifest,
          qualification.summary,
        );
        await this.repository.markSourceNotQualified(
          input.sourceId,
          qualificationReasons,
          message,
        );
        await this.repository.recordEvent(
          input.sourceId,
          "draft_generation_not_qualified",
          this.workerId,
          {
            reasons: qualificationReasons,
            message,
            sourceJiraKey: evidenceManifest.sourceJiraKey,
            loeHours: evidenceManifest.loeHours,
          },
        );
        return null;
      }

      repoContextManifest = this.repoDeepDiveEnabled
        ? await this.repoContextCollector.collect({
            sourceId: input.sourceId,
            evidenceManifest,
            qualification,
          })
        : null;
      const contextRepoIds = repoContextManifest
        ? repoIdsFromContext(repoContextManifest)
        : [];
      const serializableRepoContextManifest =
        stripRepoContextRuntimeHandles(repoContextManifest);

      if (repoContextManifest && contextRepoIds.length === 0 && !isCompose) {
        const message =
          "Spec Factory draft generation requires at least one registered repo workspace";
        await this.repository.markSourceNotQualified(
          input.sourceId,
          ["needs_repo"],
          message,
        );
        await this.repository.recordEvent(
          input.sourceId,
          "draft_generation_not_qualified",
          this.workerId,
          { reasons: ["needs_repo"], message },
        );
        return null;
      }
      if (repoContextManifest) {
        taskWorkspace = await this.taskWorkspaceManager.prepare({
          sourceId: input.sourceId,
          evidenceManifest,
          repoContextManifest: serializableRepoContextManifest,
        });
      }
      const repoIds = [taskWorkspace.repoId, ...contextRepoIds];

      const generated = await this.generator.generate({
        sourceId: input.sourceId,
        sourceJiraKey: source.sourceJiraKey,
        repoIds,
        evidenceManifest,
        repoContextManifest: serializableRepoContextManifest ?? undefined,
        taskWorkspace,
      });

      await this.repository.createDraft({
        sourceId: input.sourceId,
        version: source.nextDraftVersion,
        evidenceSnapshotId: evidenceManifest.snapshotId ?? null,
        bundle: generated.bundle,
        renderedMarkdown: generated.renderedMarkdown,
        evidenceManifest: {
          evidenceManifest,
          qualification,
          repoContextManifest: serializableRepoContextManifest,
          repoDeepDiveEnabled: this.repoDeepDiveEnabled,
          taskWorkspace,
        },
        modelMetadata: generated.modelMetadata,
      });

      return this.repository.getLatestDraft(input.sourceId);
    } catch (error) {
      const message = errorMessage(error);
      if (
        isSdkTimeoutMessage(message) ||
        isAttachmentGenerationBlockedMessage(message)
      ) {
        await this.repository.markDraftGenerationFailed({
          sourceId: input.sourceId,
          stateWithoutReadyDraft: "needs_attention",
          reasons: ["generation_failed"],
          errorMessage: message,
        });
        throw error;
      }
      await this.repository.markDraftGenerationFailed({
        sourceId: input.sourceId,
        stateWithoutReadyDraft: "not_qualified",
        reasons: ["generation_failed"],
        errorMessage: message,
      });
      throw error;
    } finally {
      await cleanupRepoContextWorkspaces({
        sourceId: input.sourceId,
        repoContextManifest,
        repository: this.repository,
        workerId: this.workerId,
      }).catch(() => undefined);
    }
  }

  async approveDraft(input: {
    sourceId: number;
    draftId: number;
    actor: string;
  }): Promise<SpecFactoryDraftDetail | null> {
    if (!this.draftWorkflowV2Enabled) {
      return this.publishDraftImmediately(input);
    }
    requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    const latestDraft = requireLatestDraft(
      await this.repository.getLatestDraft(input.sourceId),
      input.sourceId,
    );
    if (latestDraft.id !== input.draftId) {
      throw new Error(
        `Draft ${input.draftId} is not the latest draft for source ${input.sourceId}`,
      );
    }
    if (latestDraft.status !== "ready" && latestDraft.status !== "approved") {
      throw new Error(
        `Draft ${input.draftId} must be ready before it can be approved`,
      );
    }
    const queued = await this.repository.queueDraftWorkflowApproval(input);
    if (!queued) {
      throw new Error(
        `draft_workflow_not_found:${input.sourceId}:${input.draftId}`,
      );
    }
    await this.repository.recordEvent(
      input.sourceId,
      "draft_publish_queued",
      input.actor,
      {
        workflowId: queued.workflowId,
        draftId: input.draftId,
        deduplicated: queued.deduplicated,
      },
    );
    this.kickProcessing();
    return latestDraft;
  }

  private async publishDraftImmediately(input: {
    sourceId: number;
    draftId: number;
    actor: string;
  }): Promise<SpecFactoryDraftDetail | null> {
    const source = requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    const latestDraft = requireLatestDraft(
      await this.repository.getLatestDraft(input.sourceId),
      input.sourceId,
    );
    if (latestDraft.id !== input.draftId) {
      throw new Error(
        `Draft ${input.draftId} is not the latest draft for source ${input.sourceId}`,
      );
    }

    const existingChildren = latestDraft.childTickets.filter(
      (child) => child.jiraKey !== null,
    );
    const pendingChildren = latestDraft.childTickets.filter(
      (child) => child.jiraKey === null,
    );
    const createdChildren: Array<{ childId: number; jiraKey: string }> = [];
    let epicKeyForEvents = source.approvedEpicKey;
    const retry = Boolean(
      source.approvedEpicKey || existingChildren.length > 0,
    );

    if (latestDraft.status === "approved" && pendingChildren.length === 0) {
      await this.repository.recordEvent(
        input.sourceId,
        "draft_publish_skipped",
        input.actor,
        {
          draftId: input.draftId,
          epicKey: source.approvedEpicKey,
          reason: "already_complete",
          childCount: existingChildren.length,
        },
      );
      return latestDraft;
    }

    if (latestDraft.status !== "ready" && !retry) {
      throw new Error(
        `Draft ${input.draftId} must be ready before it can be approved`,
      );
    }

    await this.repository.recordEvent(
      input.sourceId,
      "draft_publish_started",
      input.actor,
      {
        draftId: input.draftId,
        existingEpicKey: source.approvedEpicKey,
        existingChildren: existingChildren.map((child) => ({
          childId: child.id,
          jiraKey: child.jiraKey,
        })),
        pendingChildCount: pendingChildren.length,
        retry,
      },
    );

    try {
      const approval = await this.publisher.approveDraft(latestDraft, {
        existingEpicKey: source.approvedEpicKey,
        onEpicCreated: async (epicKey) => {
          epicKeyForEvents = epicKey;
          await this.repository.updateSourceApproved(input.sourceId, epicKey);
          await this.repository.recordEvent(
            input.sourceId,
            "draft_publish_epic_created",
            input.actor,
            { draftId: input.draftId, epicKey },
          );
        },
        onChildCreated: async (child) => {
          await this.repository.updateChildCreated(
            child.childId,
            child.jiraKey,
          );
          createdChildren.push(child);
          await this.repository.recordEvent(
            input.sourceId,
            "draft_publish_child_created",
            input.actor,
            { draftId: input.draftId, ...child },
          );
        },
      });
      epicKeyForEvents = approval.epicKey;
      await this.repository.markDraftApproved(input.draftId, input.actor);
      await this.repository.updateSourceApproved(
        input.sourceId,
        approval.epicKey,
      );
      await this.repository.recordEvent(
        input.sourceId,
        "draft_publish_completed",
        input.actor,
        {
          draftId: input.draftId,
          epicKey: approval.epicKey,
          children: approval.children,
        },
      );
      await this.repository.recordEvent(
        input.sourceId,
        "draft_approved",
        input.actor,
        {
          draftId: input.draftId,
          epicKey: approval.epicKey,
          children: approval.children,
        },
      );

      return this.repository.getLatestDraft(input.sourceId);
    } catch (error) {
      const createdChildIds = new Set(
        createdChildren.map((child) => child.childId),
      );
      const remainingChildren = pendingChildren
        .filter((child) => !createdChildIds.has(child.id))
        .map((child) => ({
          childId: child.id,
          repoName: child.repoName,
          summary: child.summary,
        }));
      const failedStep =
        epicKeyForEvents || createdChildren.length > 0 ? "child" : "epic";
      await this.repository.recordEvent(
        input.sourceId,
        "draft_publish_failed",
        input.actor,
        {
          draftId: input.draftId,
          epicKey: epicKeyForEvents,
          failedStep,
          failedChild:
            failedStep === "child" ? (remainingChildren[0] ?? null) : null,
          remainingChildren,
          createdChildren,
          error: errorMessage(error),
        },
      );
      throw error;
    }
  }

  async updateDraft(input: {
    sourceId: number;
    draftId: number;
    draft: SpecFactoryDraftBundle;
    actor: string;
  }): Promise<SpecFactoryDraftDetail | null> {
    requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    const latestDraft = requireLatestDraft(
      await this.repository.getLatestDraft(input.sourceId),
      input.sourceId,
    );
    if (latestDraft.id !== input.draftId) {
      throw new Error(
        `Draft ${input.draftId} is not the latest draft for source ${input.sourceId}`,
      );
    }
    if (latestDraft.status !== "ready") {
      throw new Error(
        `Draft ${input.draftId} must be ready before it can be edited`,
      );
    }

    const validation = validateDraftBundle(input.draft);
    if (!validation.valid || !validation.normalized) {
      throw new Error(
        `Draft edit failed validation: ${validation.errors.join("; ")}`,
      );
    }

    const renderedMarkdown = renderDraftMarkdown(validation.normalized);
    const nextVersion = latestDraft.version + 1;
    const newDraftId = await this.repository.reviseDraft({
      sourceId: input.sourceId,
      previousDraftId: input.draftId,
      version: nextVersion,
      evidenceSnapshotId: latestDraft.evidenceSnapshotId,
      bundle: validation.normalized,
      renderedMarkdown,
      evidenceManifest: latestDraft.evidenceManifest,
      modelMetadata: {
        source: "operator_edit",
        actor: input.actor,
        previousDraftId: input.draftId,
        validationWarnings: validation.warnings,
      },
    });
    await this.repository.recordEvent(
      input.sourceId,
      "draft_edited",
      input.actor,
      {
        previousDraftId: input.draftId,
        draftId: newDraftId,
        version: nextVersion,
        warnings: validation.warnings,
      },
    );

    return this.repository.getLatestDraft(input.sourceId);
  }

  async oneShotNow(input: {
    sourceId: number;
    actor: SpecFactoryActor;
  }): Promise<{ submittedCount: number; results: OneShotSubmitChildResult[] }> {
    const latestDraft = await this.repository.getLatestDraft(input.sourceId);
    const pendingPublishChildren =
      latestDraft?.childTickets.filter((child) => child.jiraKey === null) ?? [];
    if (pendingPublishChildren.length > 0) {
      throw new Error(
        `Spec Factory source ${input.sourceId} still has ${pendingPublishChildren.length} unpublished child ticket${pendingPublishChildren.length === 1 ? "" : "s"}; retry Jira publish before OneShot submission`,
      );
    }

    const children = await this.repository.listApprovedChildren(input.sourceId);
    const readyChildren = children.filter(
      (child) =>
        child.state === "created" &&
        child.jiraKey !== null &&
        child.oneshotRequestId === null &&
        child.oneshotRunId === null,
    );
    if (readyChildren.length === 0) {
      throw new Error(
        `Spec Factory source ${input.sourceId} has no approved child tickets ready for OneShot`,
      );
    }

    const submittedResults: OneShotSubmitChildResult[] = [];
    const persistedChildIds = new Set<number>();
    const persistSubmittedResult = async (result: OneShotSubmitChildResult) => {
      if (persistedChildIds.has(result.childId)) return;
      await this.repository.updateChildSubmitted(
        result.childId,
        result.requestId,
      );
      submittedResults.push(result);
      persistedChildIds.add(result.childId);
      await this.repository.recordEvent(
        input.sourceId,
        "oneshot_child_submitted",
        input.actor.id,
        result,
      );
    };

    try {
      const results = await this.submitter.submitChildren({
        children: readyChildren,
        actor: input.actor,
        onChildSubmitted: persistSubmittedResult,
      });

      for (const result of results) {
        await persistSubmittedResult(result);
      }
    } catch (error) {
      const submittedChildIds = new Set(
        submittedResults.map((result) => result.childId),
      );
      const remainingChildren = readyChildren
        .filter((child) => !submittedChildIds.has(child.id))
        .map((child) => ({
          childId: child.id,
          repoName: child.repoName,
          summary: child.summary,
          jiraKey: child.jiraKey,
        }));
      await this.repository.recordEvent(
        input.sourceId,
        "oneshot_submission_failed",
        input.actor.id,
        {
          submittedResults,
          failedChild: remainingChildren[0] ?? null,
          remainingChildren,
          error: errorMessage(error),
        },
      );
      throw error;
    }

    await this.repository.markSourceOneShotSubmitted(input.sourceId);
    await this.repository.recordEvent(
      input.sourceId,
      "oneshot_submitted",
      input.actor.id,
      {
        results: submittedResults,
      },
    );

    return {
      submittedCount: submittedResults.length,
      results: submittedResults,
    };
  }

  async getLatestDraft(
    sourceId: number,
  ): Promise<SpecFactoryDraftDetail | null> {
    return this.repository.getLatestDraft(sourceId);
  }

  async listSourceEvents(sourceId: number): Promise<SpecFactoryEventSummary[]> {
    requireSource(await this.repository.getSourceById(sourceId), sourceId);
    return this.repository.listSourceEvents(sourceId);
  }

  async listSourceAttachments(
    sourceId: number,
  ): Promise<SpecFactoryAttachmentSummary[]> {
    requireSource(await this.repository.getSourceById(sourceId), sourceId);
    return this.repository.listSourceAttachments(sourceId);
  }

  async retrySourceAttachments(input: {
    sourceId: number;
    actor: string;
  }): Promise<SpecFactoryAttachmentRetryResult> {
    const source = requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    if (source.origin !== "louise") {
      throw new Error(
        "Attachment archive retry is only supported for Louise sources",
      );
    }

    const before = await this.repository.listSourceAttachments(input.sourceId);
    const beforeAttention = before.filter(attachmentNeedsAttention);

    try {
      const manifest = await this.evidenceCollector.collect(input.sourceId);
      const attachments = await this.repository.listSourceAttachments(
        input.sourceId,
      );
      const afterAttentionCount = attachments.filter(
        attachmentNeedsAttention,
      ).length;
      await this.repository.recordEvent(
        input.sourceId,
        "attachment_archive_retried",
        input.actor,
        {
          retriedCount: beforeAttention.length,
          beforeAttentionCount: beforeAttention.length,
          afterAttentionCount,
          retriedAttachmentIds: beforeAttention.map(
            (attachment) => attachment.jiraAttachmentId,
          ),
          snapshotId: manifest.snapshotId ?? null,
          warningCount: manifest.warnings.length,
        },
      );
      return {
        source,
        attachments,
        retriedCount: beforeAttention.length,
        beforeAttentionCount: beforeAttention.length,
        afterAttentionCount,
      };
    } catch (error) {
      await this.repository.recordEvent(
        input.sourceId,
        "attachment_archive_retry_failed",
        input.actor,
        {
          beforeAttentionCount: beforeAttention.length,
          retriedAttachmentIds: beforeAttention.map(
            (attachment) => attachment.jiraAttachmentId,
          ),
          error: errorMessage(error),
        },
      );
      throw error;
    }
  }

  async listOneShotSubmissions(): Promise<
    SpecFactoryOneShotSubmissionSummary[]
  > {
    return this.repository.listOneShotSubmissions?.() ?? [];
  }

  async listArchivedSources(): Promise<SpecFactorySourceSummary[]> {
    return this.repository.listArchivedSources?.() ?? [];
  }

  async discardSource(input: {
    sourceId: number;
    actor: string;
  }): Promise<SpecFactorySourceSummary> {
    requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    await this.repository.archiveSource(input.sourceId);
    await this.repository.recordEvent(
      input.sourceId,
      "source_archived",
      input.actor,
      { sourceId: input.sourceId },
    );
    return requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
  }

  async restoreSource(input: {
    sourceId: number;
    actor: string;
  }): Promise<SpecFactorySourceSummary> {
    requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
    const restored = await this.repository.restoreArchivedSource(
      input.sourceId,
    );
    if (!restored) {
      throw new Error(`Spec Factory source ${input.sourceId} is not archived`);
    }
    await this.repository.recordEvent(
      input.sourceId,
      "source_restored",
      input.actor,
      { sourceId: input.sourceId },
    );
    return requireSource(
      await this.repository.getSourceById(input.sourceId),
      input.sourceId,
    );
  }

  startProcessingLoop(): void {
    if (this.processingTimer) return;
    this.processingTimer = setInterval(
      () => this.kickProcessing(),
      Math.max(1000, this.pollIntervalMs),
    );
    this.kickProcessing();
  }

  async drainProcessingOnce(): Promise<void> {
    await this.processQueuedJobs();
  }

  stopProcessingLoop(): void {
    if (!this.processingTimer) return;
    clearInterval(this.processingTimer);
    this.processingTimer = null;
  }

  private kickProcessing(): void {
    if (this.processing) return;
    this.processing = true;
    void this.processQueuedJobs().finally(() => {
      this.processing = false;
    });
  }

  private async runBoardRefresh(): Promise<RefreshRunResult> {
    try {
      const result = await this.ingestor.refresh();
      const autoQueued = await this.queueNewSourcesForDraftGeneration(
        result.newSources,
      );
      const refresh = { ...result, autoQueued };
      await this.repository.recordIntakeRefresh({
        status: "succeeded",
        scanned: refresh.scanned,
        inserted: refresh.upserted,
        matched: refresh.matched,
        claimed: refresh.claimed,
        claimFailures: refresh.claimFailures,
        autoQueued,
      });
      this.latestRefresh = refresh;
      this.latestRefreshError = null;
      return refresh;
    } catch (error) {
      const message = errorMessage(error);
      this.latestRefreshError = message;
      await this.repository.recordIntakeRefresh({
        status: "failed",
        errorMessage: message,
      });
      throw error;
    }
  }

  private async queueNewSourcesForDraftGeneration(
    newSources: CandidateIngestorNewSource[],
  ): Promise<number> {
    let queued = 0;
    for (const source of newSources) {
      if (this.draftWorkflowV2Enabled) {
        const workflow = await this.repository.createDraftWorkflow({
          sourceId: source.id,
          idempotencyKey: `intake-${source.id}`,
          requestedBy: "spec-factory-intake",
          immutableInput: { sourceId: source.id, intake: true },
        });
        await this.repository.recordEvent(
          source.id,
          "draft_workflow_auto_queued",
          this.workerId,
          { workflowId: workflow.workflowId },
        );
        queued += 1;
        continue;
      }
      await this.repository.markSourceDrafting(source.id);
      const jobId = await this.repository.createProcessingJob({
        sourceId: source.id,
        jobType: DRAFT_GENERATION_JOB,
        requestedBy: "spec-factory-intake",
      });
      await this.repository.recordEvent(
        source.id,
        "draft_generation_auto_queued",
        this.workerId,
        { jobId, sourceJiraKey: source.key },
      );
      queued += 1;
    }

    if (queued > 0) {
      this.kickProcessing();
    }
    return queued;
  }

  private draftWorkflowWorker(): DraftWorkflowWorker {
    return new DraftWorkflowWorker(this.repository, {
      workerId: this.workerId,
      concurrency: this.draftWorkflowConcurrency,
      leaseMs: this.processingJobStaleMs,
      artifactStore: this.draftArtifactStore,
      handlers: {
        evidence_snapshot: (stage) => this.executeEvidenceSnapshotStage(stage),
        qualify: (stage) => this.executeQualificationStage(stage),
        repository_context: (stage) =>
          this.executeRepositoryContextStage(stage),
        draft_synthesize: (stage) => this.executeDraftSynthesisStage(stage),
        validate: (stage) => this.executeDraftValidationStage(stage),
        persist_draft: (stage) => this.executeDraftPersistenceStage(stage),
        jira_publish: (stage) => this.executeJiraPublishStage(stage),
        oneshot_submit: (stage) => this.executeOneShotSubmitStage(stage),
      },
    });
  }

  private async executeEvidenceSnapshotStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const source = requireSource(
      await this.repository.getSourceById(stage.sourceId),
      stage.sourceId,
    );
    const attachmentBlockMessage = priorityAttachmentBlockMessage(
      source.origin === "louise"
        ? await this.repository.listSourceAttachments(stage.sourceId)
        : [],
    );
    if (attachmentBlockMessage) throw new Error(attachmentBlockMessage);
    const isCompose = source.origin === "compose";
    if (isCompose && !this.composeEvidenceProvider) {
      throw new Error(
        `Compose source ${stage.sourceId} requires a composeEvidenceProvider, but none was configured`,
      );
    }
    const provider = isCompose
      ? this.composeEvidenceProvider!
      : this.evidenceCollector;
    const evidenceManifest = await provider.collect(stage.sourceId);
    return {
      output: { source, evidenceManifest, isCompose },
      evidenceSnapshotId: evidenceManifest.snapshotId ?? null,
    };
  }

  private async executeQualificationStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const evidence = requiredStageOutput<{
      source: SpecFactorySourceWithNextDraftVersion;
      evidenceManifest: EvidenceManifest;
      isCompose: boolean;
    }>(stage, "evidence_snapshot");
    const taskWorkspace = await this.taskWorkspaceManager.prepare({
      sourceId: stage.sourceId,
      evidenceManifest: evidence.evidenceManifest,
      repoContextManifest: null,
    });
    const qualification = await this.qualifier.qualify({
      sourceId: stage.sourceId,
      sourceJiraKey: evidence.source.sourceJiraKey,
      evidenceManifest: evidence.evidenceManifest,
      taskWorkspace,
    });
    await this.repository.recordEvent(
      stage.sourceId,
      "draft_generation_qualification_completed",
      this.workerId,
      { workflowId: stage.workflowId, ...qualification },
    );
    if (!qualification.qualified && !evidence.isCompose) {
      const reasons = qualification.reasons.length
        ? qualification.reasons
        : (["needs_information"] satisfies QualificationReason[]);
      const message = notQualifiedMessage(
        reasons,
        evidence.evidenceManifest,
        qualification.summary,
      );
      await this.repository.markSourceNotQualified(
        stage.sourceId,
        reasons,
        message,
      );
      throw new Error(`not_qualified:${message}`);
    }
    return { output: { ...evidence, qualification } };
  }

  private async executeRepositoryContextStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const qualified = requiredStageOutput<{
      source: SpecFactorySourceWithNextDraftVersion;
      evidenceManifest: EvidenceManifest;
      isCompose: boolean;
      qualification: SpecFactoryQualificationDecision;
    }>(stage, "qualify");
    let runtimeManifest: SpecFactoryRepoContextManifest | null = null;
    try {
      runtimeManifest = this.repoDeepDiveEnabled
        ? await this.repoContextCollector.collect({
            sourceId: stage.sourceId,
            evidenceManifest: qualified.evidenceManifest,
            qualification: qualified.qualification,
          })
        : null;
      const repoIds = runtimeManifest
        ? repoIdsFromContext(runtimeManifest)
        : [];
      if (runtimeManifest && repoIds.length === 0 && !qualified.isCompose) {
        throw new Error(
          "needs_repo:Spec Factory draft generation requires at least one registered repo workspace",
        );
      }
      return {
        output: {
          ...qualified,
          repoContextManifest: stripRepoContextRuntimeHandles(runtimeManifest),
          repoDeepDiveEnabled: this.repoDeepDiveEnabled,
        },
      };
    } finally {
      await cleanupRepoContextWorkspaces({
        sourceId: stage.sourceId,
        repoContextManifest: runtimeManifest,
        repository: this.repository,
        workerId: this.workerId,
      }).catch(() => undefined);
    }
  }

  private async executeDraftSynthesisStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const context = requiredStageOutput<{
      source: SpecFactorySourceWithNextDraftVersion;
      evidenceManifest: EvidenceManifest;
      isCompose: boolean;
      qualification: SpecFactoryQualificationDecision;
      repoContextManifest: SpecFactoryRepoContextManifest | null;
      repoDeepDiveEnabled: boolean;
    }>(stage, "repository_context");
    const taskWorkspace = await this.taskWorkspaceManager.prepare({
      sourceId: stage.sourceId,
      evidenceManifest: context.evidenceManifest,
      repoContextManifest: context.repoContextManifest,
    });
    const repoIds = [
      taskWorkspace.repoId,
      ...(context.repoContextManifest
        ? repoIdsFromContext(context.repoContextManifest)
        : []),
    ];
    const generated = await this.generator.generate({
      sourceId: stage.sourceId,
      sourceJiraKey: context.source.sourceJiraKey,
      repoIds,
      evidenceManifest: context.evidenceManifest,
      repoContextManifest: context.repoContextManifest ?? undefined,
      taskWorkspace,
    });
    return { output: { ...context, generated } };
  }

  private async executeDraftValidationStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const synthesized = requiredStageOutput<{
      generated: GenerateDraftResult;
      [key: string]: unknown;
    }>(stage, "draft_synthesize");
    const validation = validateDraftBundle(synthesized.generated.bundle);
    if (!validation.valid || !validation.normalized) {
      throw new Error(
        `draft_validation_failed:${validation.errors.join("; ")}`,
      );
    }
    return {
      output: {
        ...synthesized,
        generated: {
          ...synthesized.generated,
          bundle: validation.normalized,
        },
        validation,
      },
    };
  }

  private async executeDraftPersistenceStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const validated = requiredStageOutput<{
      source: SpecFactorySourceWithNextDraftVersion;
      evidenceManifest: EvidenceManifest;
      qualification: SpecFactoryQualificationDecision;
      repoContextManifest: SpecFactoryRepoContextManifest | null;
      repoDeepDiveEnabled: boolean;
      generated: GenerateDraftResult;
      validation: ReturnType<typeof validateDraftBundle>;
    }>(stage, "validate");
    const currentSource = requireSource(
      await this.repository.getSourceById(stage.sourceId),
      stage.sourceId,
    );
    const draftId = await this.repository.createDraft({
      sourceId: stage.sourceId,
      workflowId: stage.workflowId,
      version: currentSource.nextDraftVersion,
      evidenceSnapshotId: validated.evidenceManifest.snapshotId ?? null,
      bundle: validated.generated.bundle,
      renderedMarkdown: validated.generated.renderedMarkdown,
      evidenceManifest: {
        evidenceManifest: validated.evidenceManifest,
        qualification: validated.qualification,
        repoContextManifest: validated.repoContextManifest,
        repoDeepDiveEnabled: validated.repoDeepDiveEnabled,
      },
      modelMetadata: validated.generated.modelMetadata,
    });
    return {
      output: {
        draftId,
        evidenceSnapshotId: validated.evidenceManifest.snapshotId ?? null,
        validation: validated.validation,
      },
      draftId,
      evidenceSnapshotId: validated.evidenceManifest.snapshotId ?? null,
    };
  }

  private async executeJiraPublishStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const approval = requiredStageOutput<{
      draftId: number;
      actor: string;
    }>(stage, "approval_wait");
    const draft = await this.publishDraftImmediately({
      sourceId: stage.sourceId,
      draftId: approval.draftId,
      actor: approval.actor,
    });
    if (!draft) {
      throw new Error(`draft_publish_missing_result:${stage.workflowId}`);
    }
    const source = requireSource(
      await this.repository.getSourceById(stage.sourceId),
      stage.sourceId,
    );
    if (!source.approvedEpicKey) {
      throw new Error(`draft_publish_missing_epic:${stage.workflowId}`);
    }
    return {
      output: {
        draftId: approval.draftId,
        actor: approval.actor,
        epicKey: source.approvedEpicKey,
        publishedChildren: draft.childTickets.filter(
          (child) => child.jiraKey !== null,
        ).length,
      },
      draftId: approval.draftId,
    };
  }

  private async executeOneShotSubmitStage(
    stage: ClaimedDraftStageRun,
  ): Promise<DraftStageExecutionOutput> {
    const published = requiredStageOutput<{
      draftId: number;
      actor: string;
      epicKey: string;
    }>(stage, "jira_publish");
    const submission = await this.oneShotNow({
      sourceId: stage.sourceId,
      actor: { id: published.actor, display: published.actor },
    });
    return {
      output: {
        draftId: published.draftId,
        epicKey: published.epicKey,
        actor: published.actor,
        submittedCount: submission.submittedCount,
        results: submission.results,
      },
      draftId: published.draftId,
    };
  }

  private async processQueuedJobs(): Promise<void> {
    if (this.draftWorkflowV2Enabled) {
      await this.draftWorkflowWorker().drain();
      return;
    }
    await this.expireStaleDraftGenerationJobs();
    while (true) {
      const job = await this.repository.claimNextProcessingJob({
        jobType: DRAFT_GENERATION_JOB,
        workerId: this.workerId,
      });
      if (!job) return;
      const startedAt = Date.now();
      this.metrics.recordWorkStarted({
        workType: "draft",
        subtype: DRAFT_GENERATION_JOB,
        queuedAt: job.queuedAt,
        startedAt,
      });
      const outcome = await runWithSpecFactoryCorrelation(
        {
          requestId: job.requestId ?? undefined,
          sourceId: job.sourceId,
          workerId: this.workerId,
        },
        () => this.processDraftJob(job),
      );
      this.metrics.recordWorkCompleted({
        workType: "draft",
        subtype: DRAFT_GENERATION_JOB,
        outcome,
        startedAt,
      });
    }
  }

  private async processDraftJob(
    job: ClaimedProcessingJob,
  ): Promise<SpecFactoryWorkOutcome> {
    try {
      const draft = await withSpecFactorySpan("draft.execute", {}, async () =>
        this.generateDraft({ sourceId: job.sourceId }),
      );
      const completed = await this.repository.completeProcessingJob(job.id);
      if (!completed) {
        // The stale sweep already repaired the source; a late result must not
        // contradict that terminal state.
        console.warn(
          `[spec-factory] draft generation job ${job.id} (source ${job.sourceId}) ` +
            `finished after being expired by the stale sweep; success discarded`,
        );
        return "fence_rejected";
      }
      if (draft) {
        await this.repository.recordEvent(
          job.sourceId,
          "draft_generation_succeeded",
          this.workerId,
          { jobId: job.id },
        );
      }
      return "succeeded";
    } catch (error) {
      const message = errorMessage(error);
      const failed = await this.repository.failProcessingJob(job.id, message);
      if (!failed) {
        console.warn(
          `[spec-factory] draft generation job ${job.id} (source ${job.sourceId}) ` +
            `failed after being expired by the stale sweep; failure event skipped`,
        );
        return "fence_rejected";
      }
      await this.repository.recordEvent(
        job.sourceId,
        "draft_generation_failed",
        this.workerId,
        { jobId: job.id, error: message },
      );
      return "failed";
    }
  }

  private async expireStaleDraftGenerationJobs(): Promise<void> {
    await this.repository.expireStaleProcessingJobs({
      jobType: DRAFT_GENERATION_JOB,
      staleStartedBefore: new Date(Date.now() - this.processingJobStaleMs),
      errorMessage: `Spec Factory draft generation exceeded the ${Math.round(
        this.processingJobStaleMs / 60000,
      )} minute processing stale timeout.`,
    });
    // Cover the orthogonal failure mode where a 'queued' job's worker died
    // (e.g. single-replica restart) before claiming it: the running-stale
    // sweep above only touches 'running' jobs, so without this the queued
    // job and its 'drafting' source would sit indefinitely.
    try {
      await this.repository.expireStaleQueuedProcessingJobs({
        jobType: DRAFT_GENERATION_JOB,
        queuedBefore: new Date(Date.now() - this.processingJobQueuedStaleMs),
        errorMessage: `Spec Factory draft generation queued for more than ${Math.round(
          this.processingJobQueuedStaleMs / 60000,
        )} minutes; aged out (worker likely died before claim).`,
      });
    } catch (error) {
      console.warn(
        `[spec-factory] queued-job age-out sweep failed: ${errorMessage(error)}`,
      );
    }
  }
}
