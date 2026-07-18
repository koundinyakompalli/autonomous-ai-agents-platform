import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import { getDatabase } from "../orchestrator/database.js";
import type {
  ComposeContextStatus,
  ComposeContextProjection,
  ComposeContextProjectionSummary,
  ComposeCodeInvestigation,
  ComposeOpenQuestion,
  ComposeReadiness,
  ComposeReadinessDetails,
  ComposeRepoEvidence,
  ComposeSourceEntities,
  ComposeSourceUsefulness,
  ComposeSessionMessageSummary,
  ComposeSourceDeletionSummary,
  ComposeSessionSourceSummary,
  ComposeSessionSummary,
  ComposeSessionWorkflowState,
  ComposeStory,
} from "./compose-types.js";
import type { ComposeEvidenceSourceInput } from "./evidence.js";
import { deriveComposeSourceIntelligence } from "./compose-source-intelligence.js";
import { IdempotencyConflictError } from "./errors.js";
import type {
  UpsertComposeWorkspaceManifestInput,
  WorkspaceManifest,
} from "./compose-workspace.js";
import { currentSpecFactoryCorrelation } from "./telemetry/correlation.js";
import { specFactoryMetrics } from "./telemetry/metrics.js";
import {
  buildConversationContextPatch,
  buildSourceRemovalContextPatch,
} from "./context/context-model.js";
import { appendSpecFactoryOutboxEvent } from "./control-plane/outbox.js";
import { createCanonicalSessionEvent } from "./events/canonical-event.js";
import { isUserFacingClarification } from "./requirements-policy.js";
import {
  SPEC_FACTORY_RUNTIME_MODES,
  type SpecFactoryRuntimeMode,
} from "./runtime-modes.js";

type PoolLike = Pick<mysql.Pool, "query" | "getConnection">;
type TransactionConnection = Pick<
  mysql.PoolConnection,
  "query" | "beginTransaction" | "commit" | "rollback" | "release"
>;
const DEFAULT_CONVERSION_LEASE_MS = 600_000;
const SOURCE_CHUNK_MAX_CHARS = 16_000;
const SOURCE_CHUNK_OVERLAP_CHARS = 500;

export interface SourceMarkdownChunk {
  index: number;
  startOffset: number;
  endOffset: number;
  tokenEstimate: number;
  content: string;
}

export interface ComposeSourceChunk {
  id: number;
  sourceRevisionId: number;
  chunkIndex: number;
  content: string;
  artifactUri: string;
  contentSha256: string;
}

export function chunkSourceMarkdown(markdown: string): SourceMarkdownChunk[] {
  if (!markdown) return [];
  const chunks: SourceMarkdownChunk[] = [];
  let startOffset = 0;
  while (startOffset < markdown.length) {
    let endOffset = Math.min(
      markdown.length,
      startOffset + SOURCE_CHUNK_MAX_CHARS,
    );
    if (endOffset < markdown.length) {
      const boundary = markdown.lastIndexOf("\n", endOffset);
      if (boundary > startOffset + SOURCE_CHUNK_MAX_CHARS / 2) {
        endOffset = boundary + 1;
      }
    }
    const content = markdown.slice(startOffset, endOffset);
    chunks.push({
      index: chunks.length,
      startOffset,
      endOffset,
      tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
      content,
    });
    if (endOffset >= markdown.length) break;
    startOffset = Math.max(
      startOffset + 1,
      endOffset - SOURCE_CHUNK_OVERLAP_CHARS,
    );
  }
  return chunks;
}

function insertedSourceIdForActiveSession(
  result: mysql.ResultSetHeader,
  sessionId: number,
): number {
  if ((result.affectedRows ?? 1) !== 1) {
    throw new Error(`Compose session ${sessionId} was not found`);
  }
  return result.insertId;
}

interface SessionRow extends mysql.RowDataPacket {
  id: number;
  name: string;
  created_by: string | null;
  created_by_display: string | null;
  agent_persona_key: string | null;
  agent_persona_name: string | null;
  status: ComposeSessionSummary["status"];
  claude_session_id: string | null;
  source_id: number | null;
  readiness_json: string | unknown | null;
  last_active_at: Date | string | null;
  last_action: string | null;
  last_actor: string | null;
  active_turn_started_at: Date | string | null;
  latest_context_version: number | string | null;
  context_status: ComposeContextStatus | null;
  password_hash: string | null;
  s3_prefix: string;
  workspace_path: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SourceRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  request_id: string | null;
  kind: ComposeSessionSourceSummary["kind"];
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  source_url: string | null;
  s3_key_raw: string | null;
  converter: ComposeSessionSourceSummary["converter"];
  markdown_path: string | null;
  markdown_content: string | null;
  source_summary: string | null;
  source_entities_json: string | unknown | null;
  source_usefulness: string | null;
  source_contribution: string | null;
  source_origin: string | null;
  generated_by_task_id: number | string | null;
  parent_source_ids_json: string | unknown | null;
  context_version_used: number | string | null;
  evidence_json: string | unknown | null;
  confidence: string | null;
  artifact_uri: string | null;
  artifact_sha256: string | null;
  artifact_bytes: number | string | null;
  current_revision_id: number | string | null;
  content_sha256: string | null;
  deleted_at: Date | string | null;
  deleted_by: string | null;
  deletion_id: number | string | null;
  purged_at: Date | string | null;
  conversion_status: ComposeSessionSourceSummary["conversionStatus"];
  conversion_started_at: Date | string | null;
  conversion_attempts: number | string | null;
  conversion_lease_expires_at: Date | string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessageRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  role: ComposeSessionMessageSummary["role"];
  content: string;
  created_at: Date | string;
}

interface SessionEventRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  event_type: string;
  sequence: number | string | null;
  payload_json: string | unknown;
  payload_bytes: number | string;
  actor_type: string | null;
  actor_id: string | null;
  request_id: string | null;
  turn_job_id: number | string | null;
  agent_task_id: number | string | null;
  context_version: number | string | null;
  created_at: Date | string;
}

interface TurnJobRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  turn_kind: ComposeTurnKind;
  user_message_id: number | string | null;
  status: ComposeTurnJobStatus;
  request_hash: string;
  request_id?: string | null;
  requested_context_version: number | string | null;
  context_version_used: number | string | null;
  latest_context_version?: number | string | null;
  updated_at?: Date | string;
  lease_generation: number | string;
  active_worker_id: string | null;
  lease_active?: number | string | boolean | null;
  research_round_count?: number | string;
  max_research_rounds?: number | string;
}

interface AwaitingClarificationTurnRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  user_message_id: number | string | null;
  status: ComposeTurnJobStatus;
  clarification_expires_at: Date | string | null;
  clarification_answer_message_id: number | string | null;
  clarification_answer_idempotency_key: string | null;
  context_version_used: number | string | null;
}

interface ClarificationAnswerMessageRow extends mysql.RowDataPacket {
  id: number | string;
  turn_job_id: number | string;
  content: string;
  turn_status: ComposeTurnJobStatus;
  user_message_id: number | string | null;
}

interface ResearchBudgetUsageRow extends mysql.RowDataPacket {
  spent_cost_usd: number | string | null;
  reserved_cost_usd: number | string | null;
  research_tasks_24h: number | string | null;
  in_flight_tasks: number | string | null;
}

interface ContextProjectionRow extends mysql.RowDataPacket {
  session_id: number | string;
  version: number | string;
  artifact_uri: string | null;
  structured_artifact_uri: string | null;
  summary_json: string | unknown | null;
  facts_json: string | unknown | null;
  implementation_findings_json: string | unknown | null;
  requirements_json: string | unknown | null;
  constraints_json: string | unknown | null;
  open_questions_json: string | unknown | null;
  conflicts_json: string | unknown | null;
  decisions_json: string | unknown | null;
  risks_json: string | unknown | null;
  source_ids_json: string | unknown | null;
  patch_ids_json: string | unknown | null;
  committed_at: Date | string | null;
}

interface SourceDeletionRow extends mysql.RowDataPacket {
  id: number | string;
  session_id: number | string;
  source_id: number | string;
  source_title: string;
  status: ComposeSourceDeletionSummary["status"];
  undo_until: Date | string;
  invalidated_source_ids_json: string | unknown;
  invalidated_handoff_ids_json: string | unknown;
  created_at: Date | string;
}

interface DeletableSourceRow extends mysql.RowDataPacket {
  id: number | string;
  current_revision_id: number | string | null;
  kind: ComposeSessionSourceSummary["kind"];
  original_filename: string | null;
  source_url: string | null;
  parent_source_ids_json: string | unknown | null;
  generated_by_task_id: number | string | null;
}

export interface ComposeSourceDeletionPurgeCandidate {
  deletionId: number;
  sessionId: number;
  sourceId: number;
  workspacePath: string;
  sourceIds: number[];
  s3Keys: string[];
  artifactUris: string[];
  localPaths: string[];
}

interface TurnOutputRow extends mysql.RowDataPacket {
  turn_job_id: number;
  assistant_message_id: number | string;
}

export interface ComposeHardDeleteRowCounts {
  compose_session_events: number;
  compose_stream_tokens: number;
  compose_turn_jobs: number;
  compose_turn_outputs: number;
  compose_agent_tasks: number;
  compose_agent_runtime_runs: number;
  compose_context_patches: number;
  compose_context_versions: number;
  compose_session_messages: number;
  compose_session_sources: number;
  compose_source_deletions: number;
  compose_source_revisions: number;
  compose_source_chunks: number;
  compose_handoffs: number;
  compose_handoff_snapshots: number;
  compose_workspace_manifests: number;
  spec_factory_llm_calls: number;
  spec_factory_outbox: number;
  spec_factory_queue_receipts: number;
  spec_factory_repair_items: number;
  spec_factory_draft_workflows: number;
  spec_factory_draft_stage_runs: number;
  spec_factory_evidence_snapshots: number;
  spec_factory_drafts: number;
  spec_factory_child_tickets: number;
  spec_factory_events: number;
  spec_factory_processing_jobs: number;
  spec_factory_attachments: number;
  spec_factory_sources: number;
  compose_sessions: number;
}

export interface ComposeHardDeletePlan {
  sessionId: number;
  status: ComposeSessionSummary["status"];
  archivedAt: string | null;
  linkedSourceId: number | null;
  s3Prefix: string;
  workspacePath: string;
  rowCounts: ComposeHardDeleteRowCounts;
  artifactUris: string[];
}

export interface ComposeHardDeleteDbResult {
  sessionId: number;
  deletedRows: ComposeHardDeleteRowCounts;
}

interface HardDeleteSessionRow extends mysql.RowDataPacket {
  id: number;
  status: ComposeSessionSummary["status"];
  source_id: number | string | null;
  s3_prefix: string;
  workspace_path: string;
  archived_at?: Date | string | null;
}

type HardDeleteCountRow = mysql.RowDataPacket & ComposeHardDeleteRowCounts;

interface AgentTaskRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  turn_job_id: number | string | null;
  capability: string;
  executor_type: string | null;
  request_id?: string | null;
  status: ComposeAgentTaskStatus;
  input_json: string | unknown;
  lease_generation: number | string;
  active_worker_id: string | null;
  updated_at?: Date | string;
}

interface AgentTaskSummaryRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  turn_job_id: number | string | null;
  capability: string;
  executor_type: string | null;
  status: ComposeAgentTaskStatus;
  input_json: string | unknown;
  output_source_id: number | string | null;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number | string;
  max_attempts: number | string;
  created_at: Date | string;
  completed_at: Date | string | null;
}

interface SessionArchiveRow extends mysql.RowDataPacket {
  id: number;
  status: ComposeSessionSummary["status"];
  archived_at: Date | string | null;
}

interface SessionContextRow extends mysql.RowDataPacket {
  id: number;
  latest_context_version: number | string | null;
}

interface ContextPatchRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  source_id: number | string | null;
  agent_task_id: number | string | null;
  base_context_version: number | string | null;
  patch_uri: string | null;
  artifact_sha256: string | null;
  artifact_bytes: number | string | null;
  patch_json: string | unknown | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ExpiredTurnLeaseRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  status: ComposeTurnJobStatus;
  attempt_count: number | string;
  max_attempts: number | string;
  output_turn_job_id: number | string | null;
}

interface ExpiredClarificationTurnRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
}

interface ExpiredAgentTaskLeaseRow extends mysql.RowDataPacket {
  id: number;
  session_id: number;
  status: ComposeAgentTaskStatus;
  attempt_count: number | string;
  max_attempts: number | string;
}

interface WorkspaceCleanupRow extends mysql.RowDataPacket {
  id: number;
  name: string;
  s3_prefix: string;
  workspace_path: string;
  archived_at: Date | string;
}

interface ConversionHealthRow extends mysql.RowDataPacket {
  conversion_status: ComposeSessionSourceSummary["conversionStatus"];
  count: number | string;
  oldest_created_at: Date | string | null;
  oldest_started_at: Date | string | null;
}

interface ControlPlaneHealthRow extends mysql.RowDataPacket {
  status: string;
  count: number | string;
  oldest_created_at: Date | string | null;
  oldest_started_at: Date | string | null;
  lease_expired: number | string | null;
}

interface ControlPlaneAgentTaskCapabilityHealthRow extends ControlPlaneHealthRow {
  capability: string | null;
}

interface ControlPlaneFenceHealthRow extends mysql.RowDataPacket {
  turn_lease_fence_rejected: number | string | null;
  agent_task_lease_fence_rejected: number | string | null;
  turn_duplicate_suppressed_today: number | string | null;
}

interface ControlPlaneTurnOutcomeRow extends mysql.RowDataPacket {
  context_version_used: number | string | null;
  completed: number | string | null;
  failed: number | string | null;
  cancelled: number | string | null;
  abandoned: number | string | null;
  total: number | string | null;
}

interface ControlPlaneCoordinatorHealthRow extends mysql.RowDataPacket {
  answer_today: number | string | null;
  dispatch_research_today: number | string | null;
  ask_clarification_today: number | string | null;
  escalate_today: number | string | null;
  rejected_today: number | string | null;
  latest_decision_at: Date | string | null;
}

interface ControlPlaneRetentionHealthRow extends mysql.RowDataPacket {
  pending_workspace_cleanup: number | string | null;
  failed_workspace_cleanup: number | string | null;
  oldest_pending_archived_at: Date | string | null;
  latest_cleanup_error_at: Date | string | null;
  pending_llm_audit_artifacts: number | string | null;
  oldest_pending_llm_audit_artifact_at: Date | string | null;
}

interface ControlPlaneEventHealthRow extends mysql.RowDataPacket {
  durable_published_today: number | string | null;
  durable_persist_failures_today: number | string | null;
  payload_too_large_today: number | string | null;
  latest_published_at: Date | string | null;
  latest_durable_error_at: Date | string | null;
}

interface ControlPlaneStreamTokenHealthRow extends mysql.RowDataPacket {
  active_tokens: number | string | null;
  expired_unrevoked_tokens: number | string | null;
  created_today: number | string | null;
  revoked_today: number | string | null;
  latest_created_at: Date | string | null;
  latest_revoked_at: Date | string | null;
}

interface ControlPlaneResearchHealthRow extends mysql.RowDataPacket {
  running_tasks: number | string | null;
  completed_today: number | string | null;
  failed_today: number | string | null;
  avg_runtime_seconds_today: number | string | null;
  max_runtime_seconds_today: number | string | null;
  oldest_running_started_at: Date | string | null;
  latest_terminal_at: Date | string | null;
}

interface ControlPlaneContextHealthRow extends mysql.RowDataPacket {
  patches_ready: number | string | null;
  patches_building: number | string | null;
  patches_failed: number | string | null;
  oldest_ready_patch_at: Date | string | null;
  versions_committed_today: number | string | null;
  versions_failed_today: number | string | null;
  versions_building: number | string | null;
  latest_committed_version_at: Date | string | null;
  latest_failed_version_at: Date | string | null;
}

interface ControlPlaneLlmHealthRow extends mysql.RowDataPacket {
  calls_today: number | string | null;
  failed_today: number | string | null;
  input_tokens_today: number | string | null;
  output_tokens_today: number | string | null;
  estimated_cost_usd_today: number | string | null;
  latest_call_at: Date | string | null;
}

interface ControlPlaneLlmPurposeHealthRow extends ControlPlaneLlmHealthRow {
  purpose: string | null;
}

interface ControlPlaneWorkerHealthRow extends mysql.RowDataPacket {
  mode: string;
  total: number | string | null;
  live: number | string | null;
  stale: number | string | null;
  latest_heartbeat_at: Date | string | null;
}

export interface ComposeWorkspaceCleanupCandidate {
  id: number;
  name: string;
  s3Prefix: string;
  workspacePath: string;
  archivedAt: string;
}

export interface ComposeConversionQueueHealth {
  byStatus: Record<ComposeSessionSourceSummary["conversionStatus"], number>;
  inFlight: number;
  retryable: number;
  oldestPendingAt: string | null;
  oldestConvertingAt: string | null;
}

export interface ClaimedConversionSource extends ComposeSessionSourceSummary {
  conversionQueuedAt: string;
}

export interface ComposeControlPlaneHealth {
  turns: {
    byStatus: Record<ComposeTurnJobStatus, number>;
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
  };
  agentTasks: {
    byStatus: Record<ComposeAgentTaskStatus, number>;
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
  };
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
  coordinator: {
    decisionsToday: {
      answer: number;
      dispatchResearch: number;
      askClarification: number;
      escalate: number;
      rejected: number;
    };
    latestDecisionAt: string | null;
  };
  retention: {
    pendingWorkspaceCleanup: number;
    failedWorkspaceCleanup: number;
    oldestPendingArchivedAt: string | null;
    latestCleanupErrorAt: string | null;
    pendingLlmAuditArtifacts: number;
    oldestPendingLlmAuditArtifactAt: string | null;
  };
  events: {
    durablePublishedToday: number;
    durablePersistFailuresToday: number;
    payloadTooLargeToday: number;
    liveDeliveredByThisReplica: number;
    replayedByThisReplica: number;
    latestPublishedAt: string | null;
    latestDurableErrorAt: string | null;
  };
  streams: {
    activeSubscribers: number;
    activeSessions: number;
    connectedByThisReplica: number;
    disconnectedByThisReplica: number;
  };
  streamTokens: {
    activeTokens: number;
    expiredUnrevokedTokens: number;
    createdToday: number;
    revokedToday: number;
    latestCreatedAt: string | null;
    latestRevokedAt: string | null;
  };
  research: {
    runningTasks: number;
    completedToday: number;
    failedToday: number;
    avgRuntimeSecondsToday: number;
    maxRuntimeSecondsToday: number;
    oldestRunningStartedAt: string | null;
    latestTerminalAt: string | null;
  };
  context: {
    patchesReady: number;
    patchesBuilding: number;
    patchesFailed: number;
    oldestReadyPatchAt: string | null;
    versionsCommittedToday: number;
    versionsFailedToday: number;
    versionsBuilding: number;
    latestCommittedVersionAt: string | null;
    latestFailedVersionAt: string | null;
  };
}

export interface ComposeSessionEvent {
  id: number;
  sessionId: number;
  eventType: string;
  sequence: number | null;
  payload: unknown;
  payloadBytes: number;
  actorType: string | null;
  actorId: string | null;
  requestId: string | null;
  turnJobId: number | null;
  agentTaskId: number | null;
  contextVersion: number | null;
  createdAt: string;
}

export interface AppendSessionEventInput {
  sessionId: number;
  eventType: string;
  payload: unknown;
  actorType?: string | null;
  actorId?: string | null;
  requestId?: string | null;
  turnJobId?: number | null;
  agentTaskId?: number | null;
  contextVersion?: number | null;
}

export interface CreateStreamTokenInput {
  tokenHash: string;
  sessionId: number;
  expiresAt: Date;
}

export interface VerifyStreamTokenInput {
  tokenHash: string;
  sessionId: number;
}

export interface PurgeExpiredStreamTokensInput {
  expiredBefore: Date;
  limit: number;
}

export interface PurgeStaleWorkerHeartbeatsInput {
  heartbeatBefore: Date;
  limit: number;
}

export interface ArchiveSessionWithWorkCancellationResult {
  archived: boolean;
  cancelledTurnJobIds: number[];
  cancelledAgentTaskIds: number[];
}

export interface CancelTurnJobInput {
  sessionId: number;
  turnJobId: number;
}

export interface CancelTurnJobResult {
  cancelled: boolean;
  cancelledAgentTaskIds: number[];
  status: ComposeTurnJobStatus;
}

export type ComposeTurnKind = "chat" | "analyze";
export type ComposeTurnJobStatus =
  | "queued"
  | "running"
  | "waiting_on_research"
  | "awaiting_user_input"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export interface CreateMessageTurnInput {
  sessionId: number;
  content: string;
  idempotencyKey: string;
  requestHash: string;
  requestId?: string | null;
}

export interface CreateAnalyzeTurnInput {
  sessionId: number;
  idempotencyKey: string;
  requestHash: string;
  requestId?: string | null;
  resetSessionProgress?: boolean;
}

export interface CreatedTurn {
  turnJobId: number;
  messageId: number | null;
  status: ComposeTurnJobStatus;
  deduplicated: boolean;
}

export type ComposeAgentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export interface CreateAgentTaskInput {
  sessionId: number;
  turnJobId?: number | null;
  capability: string;
  executorType?: string | null;
  requestId?: string | null;
  input: unknown;
  priority?: number;
  maxAttempts?: number;
  outputSourceId?: number | null;
}

export interface CreatedHandoffBuildTask {
  handoffId: number;
  agentTaskId: number;
  requestedContextVersion: number | null;
  messageHighWatermarkId: number | null;
  deduplicated: boolean;
}

export interface CommitHandoffSnapshotInput {
  handoffId: number;
  sessionId: number;
  sourceId: number;
  agentTaskId: number;
  workerId: string;
  leaseGeneration: number;
  contextVersionUsed: number | null;
  messageHighWatermarkId: number | null;
  sourceRevisionSetHash: string;
  repositoryManifestHash: string;
  snapshot: unknown;
  artifactUri: string;
  artifactSha256: string;
  artifactBytes: number;
  markdownArtifactUri: string | null;
  markdownArtifactSha256: string | null;
  markdownArtifactBytes: number | null;
  createdBy?: string | null;
}

export interface CompleteSourceConversionInput {
  sourceId: number;
  markdownPath: string | null;
  markdownContent: string;
  distillationTask?: CreateAgentTaskInput & {
    event: Omit<AppendSessionEventInput, "sessionId" | "agentTaskId">;
  };
}

export interface CompleteSourceConversionResult {
  distillationAgentTaskId?: number | null;
  sourceRevisionId?: number;
  chunkCount?: number;
}

export type ParkTurnForResearchTaskInput = Omit<
  CreateAgentTaskInput,
  "sessionId" | "turnJobId"
>;

export interface GetSessionResearchBudgetUsageInput {
  sessionId: number;
  since: Date;
}

export interface GetGlobalResearchBudgetUsageInput {
  since: Date;
}

export interface SessionResearchBudgetUsage {
  spentCostUsd: number;
  reservedCostUsd: number;
  researchTasks24h: number;
  inFlightTasks: number;
}

export type GlobalResearchBudgetUsage = SessionResearchBudgetUsage;

export interface TurnAgentTaskSummary {
  id: number;
  sessionId: number;
  turnJobId: number | null;
  capability: string;
  executorType: string | null;
  status: ComposeAgentTaskStatus;
  input: unknown;
  question: string | null;
  maxCostUsd: number | null;
  outputSourceId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ParkTurnForResearchInput {
  sessionId: number;
  turnJobId: number;
  lease: {
    workerId: string;
    leaseGeneration: number;
  };
  tasks: ParkTurnForResearchTaskInput[];
}

export interface ParkTurnForResearchResult {
  parked: boolean;
  agentTaskIds: number[];
  discardedDueToArchive?: boolean;
}

export interface ParkTurnForClarificationInput {
  sessionId: number;
  turnJobId: number;
  lease: {
    workerId: string;
    leaseGeneration: number;
  };
  question: string;
  reason: string;
  expiresAt: Date;
  contextVersionUsed: number | null;
}

export interface ParkTurnForClarificationResult {
  parked: boolean;
  assistantMessageId: number | null;
  discardedDueToArchive?: boolean;
}

export interface AnswerAwaitingClarificationInput {
  sessionId: number;
  content: string;
  idempotencyKey: string;
}

export interface AnswerAwaitingClarificationResult {
  answered: boolean;
  turnJobId?: number;
  messageId?: number;
  status?: ComposeTurnJobStatus;
  userMessageId?: number | null;
  deduplicated?: boolean;
  expiredTurnId?: number;
}

export interface CreateGeneratedResearchSourceInput {
  sessionId: number;
  generatedByTaskId: number;
  originalFilename: string;
  markdownContent: string;
  artifactUri: string;
  artifactSha256: string;
  artifactBytes: number;
  parentSourceIds?: number[];
  contextVersionUsed?: number | null;
  evidence?: unknown;
  confidence?: string | null;
}

export interface CreateReadyContextPatchInput {
  sessionId: number;
  sourceId?: number | null;
  sourceRevisionId?: number | null;
  agentTaskId?: number | null;
  turnJobId?: number | null;
  baseContextVersion?: number | null;
  schemaVersion?: number;
  patchKind?:
    | "source_distillation"
    | "conversation"
    | "source_removal"
    | "repair";
  idempotencyKey?: string | null;
  messageIds?: number[];
  patch: unknown;
  patchUri?: string | null;
  artifactSha256?: string | null;
  artifactBytes?: number | null;
}

export interface EnqueueContextMergeTaskInput {
  sessionId: number;
  triggerPatchId?: number | null;
  priority?: number;
  maxAttempts?: number;
}

export interface BeginContextVersionBuildInput {
  sessionId: number;
  createdByTaskId?: number | null;
}

export interface ContextVersionBuild {
  contextVersionId: number;
  version: number;
  parentVersion: number | null;
}

export interface ReadyContextPatch {
  id: number;
  sessionId: number;
  sourceId: number | null;
  agentTaskId: number | null;
  baseContextVersion: number | null;
  patchUri: string | null;
  artifactSha256: string | null;
  artifactBytes: number | null;
  patch: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CommitContextVersionInput {
  sessionId: number;
  contextVersionId: number;
  version: number;
  artifactUri: string;
  structuredArtifactUri?: string | null;
  summary?: unknown;
  facts?: unknown;
  implementationFindings?: unknown;
  requirements?: unknown;
  constraints?: unknown;
  openQuestions?: unknown;
  conflicts?: unknown;
  decisions?: unknown;
  risks?: unknown;
  sourceIds?: number[];
  patchIds?: number[];
  artifactSha256: string;
  artifactBytes: number;
}

export interface ClaimedAgentTask {
  id: number;
  sessionId: number;
  turnJobId: number | null;
  capability: string;
  executorType: string | null;
  requestId: string | null;
  status: ComposeAgentTaskStatus;
  input: unknown;
  leaseGeneration: number;
  activeWorkerId: string | null;
  queuedAt: string;
}

export interface CompleteAgentTaskInput {
  agentTaskId: number;
  workerId: string;
  leaseGeneration: number;
  output?: unknown;
  contextVersionUsed?: number | null;
  outputSourceId?: number | null;
}

export interface MarkAgentTaskFailedInput {
  agentTaskId: number;
  workerId: string;
  leaseGeneration: number;
  errorCode: string;
  errorMessage: string;
}

export interface StartAgentRuntimeRunInput {
  sessionId: number;
  agentTaskId: number;
  executorType: string;
  workspaceUri?: string | null;
}

export interface FinishAgentRuntimeRunInput {
  runtimeRunId: number;
  status: "completed" | "failed";
  provider?: string | null;
  model?: string | null;
  traceUri?: string | null;
  outputArtifactUri?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface CompleteTurnWithAssistantMessageInput {
  turnJobId: number;
  sessionId: number;
  content: string;
  contextVersionUsed?: number | null;
  finalPayload?: unknown;
  conversationPatch?: {
    patch: unknown;
    messageIds?: number[];
  };
  lease?: {
    workerId: string;
    leaseGeneration: number;
  };
}

export interface CompleteTurnWithAssistantMessageResult {
  assistantMessageId: number | null;
  deduplicated: boolean;
  discardedDueToArchive?: boolean;
}

export interface ClaimedTurnJob {
  id: number;
  sessionId: number;
  turnKind: ComposeTurnKind;
  userMessageId: number | null;
  status: ComposeTurnJobStatus;
  requestId: string | null;
  requestedContextVersion: number | null;
  contextVersionUsed: number | null;
  leaseGeneration: number;
  activeWorkerId: string | null;
  queuedAt: string;
}

export interface ExpiredTurnLeaseRecoveryResult {
  requeued: number;
  abandoned: number;
  skippedWithOutput: number;
}

export interface ExpiredClarificationTurn {
  turnJobId: number;
  sessionId: number;
}

export interface ExpiredAgentTaskLeaseRecoveryResult {
  requeued: number;
  abandoned: number;
}

const CONVERSION_STATUSES: ComposeSessionSourceSummary["conversionStatus"][] = [
  "awaiting_upload",
  "pending",
  "converting",
  "converted",
  "unsupported",
  "failed",
];
const TURN_JOB_STATUSES: ComposeTurnJobStatus[] = [
  "queued",
  "running",
  "waiting_on_research",
  "awaiting_user_input",
  "synthesizing",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
];
const TURN_JOB_RUNNING_STATUSES: ComposeTurnJobStatus[] = [
  "running",
  "waiting_on_research",
  "awaiting_user_input",
  "synthesizing",
];
const AGENT_TASK_STATUSES: ComposeAgentTaskStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
];
const RESEARCH_CAPABILITIES = [
  "code_research",
  "config_research",
  "devops_research",
];
const RESEARCH_CAPABILITY_SQL_LIST = RESEARCH_CAPABILITIES.map(
  (capability) => `'${capability}'`,
).join(", ");

const MAX_SESSION_EVENT_PAYLOAD_BYTES = 16 * 1024;
const TURN_CREATION_MAX_ATTEMPTS = 2;
const DEFAULT_STREAM_TOKEN_PURGE_LIMIT = 500;
const DEFAULT_WORKER_HEARTBEAT_PURGE_LIMIT = 500;
const DEFAULT_AGENT_TASK_PRIORITY = 100;
const DEFAULT_AGENT_TASK_MAX_ATTEMPTS = 3;

function isDuplicateKeyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062;
}

function isDeadlockError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_LOCK_DEADLOCK" || candidate.errno === 1213;
}

const DEFAULT_AGENT_PERSONAS = [
  ["bohr", "Bohr"],
  ["herschel", "Herschel"],
  ["huygens", "Huygens"],
  ["godel", "Godel"],
  ["ohm", "Ohm"],
  ["pascal", "Pascal"],
  ["avicenna", "Avicenna"],
  ["mendel", "Mendel"],
] as const;

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonValue(value: string | unknown | null): unknown {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? safeJson(value) : value;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

function dbNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveNumberOrNull(value: unknown): number | null {
  const parsed = dbNumberOrNull(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function dbNumber(value: unknown): number {
  return dbNumberOrNull(value) ?? 0;
}

function zeroStatusCounts<T extends string>(
  statuses: readonly T[],
): Record<T, number> {
  return Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    T,
    number
  >;
}

function minIso(
  current: string | null,
  candidate: string | null,
): string | null {
  if (!candidate) return current;
  if (!current || candidate < current) return candidate;
  return current;
}

function rowIso(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

function summarizeTurnHealth(
  rows: ControlPlaneHealthRow[],
  outcomeRows: ControlPlaneTurnOutcomeRow[],
  leaseFenceRejected = 0,
  duplicateSuppressedToday = 0,
): ComposeControlPlaneHealth["turns"] {
  const byStatus = zeroStatusCounts(TURN_JOB_STATUSES);
  let leaseExpired = 0;
  let oldestQueuedAt: string | null = null;
  let oldestRunningAt: string | null = null;

  for (const row of rows) {
    const status = row.status as ComposeTurnJobStatus;
    if (!TURN_JOB_STATUSES.includes(status)) continue;

    byStatus[status] = dbNumber(row.count);
    leaseExpired += dbNumber(row.lease_expired);

    if (status === "queued") {
      oldestQueuedAt = minIso(oldestQueuedAt, rowIso(row.oldest_created_at));
    }
    if (TURN_JOB_RUNNING_STATUSES.includes(status)) {
      oldestRunningAt = minIso(
        oldestRunningAt,
        rowIso(row.oldest_started_at) ?? rowIso(row.oldest_created_at),
      );
    }
  }

  return {
    byStatus,
    durableQueued: byStatus.queued,
    durableRunning: TURN_JOB_RUNNING_STATUSES.reduce(
      (sum, status) => sum + byStatus[status],
      0,
    ),
    durableAbandoned: byStatus.abandoned,
    legacyInflight: 0,
    legacyQueued: 0,
    duplicateSuppressedToday,
    leaseExpired,
    leaseFenceRejected,
    outcomesByContextVersionToday: outcomeRows.map((row) => ({
      contextVersionUsed: dbNumberOrNull(row.context_version_used),
      completed: dbNumber(row.completed),
      failed: dbNumber(row.failed),
      cancelled: dbNumber(row.cancelled),
      abandoned: dbNumber(row.abandoned),
      total: dbNumber(row.total),
    })),
    oldestQueuedAt,
    oldestRunningAt,
  };
}

function summarizeAgentTaskHealth(
  rows: ControlPlaneHealthRow[],
  capabilityRows: ControlPlaneAgentTaskCapabilityHealthRow[],
  leaseFenceRejected = 0,
): ComposeControlPlaneHealth["agentTasks"] {
  const byStatus = zeroStatusCounts(AGENT_TASK_STATUSES);
  let leaseExpired = 0;
  let oldestQueuedAt: string | null = null;
  let oldestRunningAt: string | null = null;

  for (const row of rows) {
    const status = row.status as ComposeAgentTaskStatus;
    if (!AGENT_TASK_STATUSES.includes(status)) continue;

    byStatus[status] = dbNumber(row.count);
    leaseExpired += dbNumber(row.lease_expired);

    if (status === "queued") {
      oldestQueuedAt = minIso(oldestQueuedAt, rowIso(row.oldest_created_at));
    }
    if (status === "running") {
      oldestRunningAt = minIso(
        oldestRunningAt,
        rowIso(row.oldest_started_at) ?? rowIso(row.oldest_created_at),
      );
    }
  }

  return {
    byStatus,
    queued: byStatus.queued,
    running: byStatus.running,
    completed: byStatus.completed,
    failed: byStatus.failed,
    abandoned: byStatus.abandoned,
    leaseExpired,
    leaseFenceRejected,
    byCapability: summarizeAgentTaskCapabilityHealth(capabilityRows),
    oldestQueuedAt,
    oldestRunningAt,
  };
}

function emptyAgentTaskCapabilityHealth(): ComposeControlPlaneHealth["agentTasks"]["byCapability"][string] {
  return {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    abandoned: 0,
    total: 0,
    leaseExpired: 0,
    oldestQueuedAt: null,
    oldestRunningAt: null,
  };
}

function summarizeAgentTaskCapabilityHealth(
  rows: ControlPlaneAgentTaskCapabilityHealthRow[],
): ComposeControlPlaneHealth["agentTasks"]["byCapability"] {
  const byCapability: ComposeControlPlaneHealth["agentTasks"]["byCapability"] =
    {};

  for (const row of rows) {
    const status = row.status as ComposeAgentTaskStatus;
    if (!AGENT_TASK_STATUSES.includes(status)) continue;

    const capability = row.capability?.trim() || "unknown";
    const bucket = byCapability[capability] ?? emptyAgentTaskCapabilityHealth();
    const count = dbNumber(row.count);
    bucket[status] = count;
    bucket.total += count;
    bucket.leaseExpired += dbNumber(row.lease_expired);

    if (status === "queued") {
      bucket.oldestQueuedAt = minIso(
        bucket.oldestQueuedAt,
        rowIso(row.oldest_created_at),
      );
    }
    if (status === "running") {
      bucket.oldestRunningAt = minIso(
        bucket.oldestRunningAt,
        rowIso(row.oldest_started_at) ?? rowIso(row.oldest_created_at),
      );
    }

    byCapability[capability] = bucket;
  }

  return byCapability;
}

function summarizeLlmHealth(
  rows: ControlPlaneLlmHealthRow[],
  purposeRows: ControlPlaneLlmPurposeHealthRow[],
): ComposeControlPlaneHealth["llm"] {
  const row = rows[0];
  return {
    callsToday: dbNumber(row?.calls_today),
    failedToday: dbNumber(row?.failed_today),
    inputTokensToday: dbNumber(row?.input_tokens_today),
    outputTokensToday: dbNumber(row?.output_tokens_today),
    estimatedCostUsdToday: Number(row?.estimated_cost_usd_today ?? 0),
    latestCallAt: rowIso(row?.latest_call_at ?? null),
    byPurposeToday: summarizeLlmPurposeHealth(purposeRows),
  };
}

function summarizeLlmPurposeHealth(
  rows: ControlPlaneLlmPurposeHealthRow[],
): ComposeControlPlaneHealth["llm"]["byPurposeToday"] {
  const byPurpose: ComposeControlPlaneHealth["llm"]["byPurposeToday"] = {};

  for (const row of rows) {
    const purpose = row.purpose?.trim() || "unknown";
    byPurpose[purpose] = {
      callsToday: dbNumber(row.calls_today),
      failedToday: dbNumber(row.failed_today),
      inputTokensToday: dbNumber(row.input_tokens_today),
      outputTokensToday: dbNumber(row.output_tokens_today),
      estimatedCostUsdToday: Number(row.estimated_cost_usd_today ?? 0),
      latestCallAt: rowIso(row.latest_call_at),
    };
  }

  return byPurpose;
}

function summarizeCoordinatorHealth(
  rows: ControlPlaneCoordinatorHealthRow[],
): ComposeControlPlaneHealth["coordinator"] {
  const row = rows[0];
  return {
    decisionsToday: {
      answer: dbNumber(row?.answer_today),
      dispatchResearch: dbNumber(row?.dispatch_research_today),
      askClarification: dbNumber(row?.ask_clarification_today),
      escalate: dbNumber(row?.escalate_today),
      rejected: dbNumber(row?.rejected_today),
    },
    latestDecisionAt: rowIso(row?.latest_decision_at ?? null),
  };
}

function summarizeRetentionHealth(
  rows: ControlPlaneRetentionHealthRow[],
): ComposeControlPlaneHealth["retention"] {
  const row = rows[0];
  return {
    pendingWorkspaceCleanup: dbNumber(row?.pending_workspace_cleanup),
    failedWorkspaceCleanup: dbNumber(row?.failed_workspace_cleanup),
    oldestPendingArchivedAt: rowIso(row?.oldest_pending_archived_at ?? null),
    latestCleanupErrorAt: rowIso(row?.latest_cleanup_error_at ?? null),
    pendingLlmAuditArtifacts: dbNumber(row?.pending_llm_audit_artifacts),
    oldestPendingLlmAuditArtifactAt: rowIso(
      row?.oldest_pending_llm_audit_artifact_at ?? null,
    ),
  };
}

function summarizeEventHealth(
  rows: ControlPlaneEventHealthRow[],
): ComposeControlPlaneHealth["events"] {
  const row = rows[0];
  return {
    durablePublishedToday: dbNumber(row?.durable_published_today),
    durablePersistFailuresToday: dbNumber(row?.durable_persist_failures_today),
    payloadTooLargeToday: dbNumber(row?.payload_too_large_today),
    liveDeliveredByThisReplica: 0,
    replayedByThisReplica: 0,
    latestPublishedAt: rowIso(row?.latest_published_at ?? null),
    latestDurableErrorAt: rowIso(row?.latest_durable_error_at ?? null),
  };
}

function emptyStreamHealth(): ComposeControlPlaneHealth["streams"] {
  return {
    activeSubscribers: 0,
    activeSessions: 0,
    connectedByThisReplica: 0,
    disconnectedByThisReplica: 0,
  };
}

function summarizeStreamTokenHealth(
  rows: ControlPlaneStreamTokenHealthRow[],
): ComposeControlPlaneHealth["streamTokens"] {
  const row = rows[0];
  return {
    activeTokens: dbNumber(row?.active_tokens),
    expiredUnrevokedTokens: dbNumber(row?.expired_unrevoked_tokens),
    createdToday: dbNumber(row?.created_today),
    revokedToday: dbNumber(row?.revoked_today),
    latestCreatedAt: rowIso(row?.latest_created_at ?? null),
    latestRevokedAt: rowIso(row?.latest_revoked_at ?? null),
  };
}

function summarizeResearchHealth(
  rows: ControlPlaneResearchHealthRow[],
): ComposeControlPlaneHealth["research"] {
  const row = rows[0];
  return {
    runningTasks: dbNumber(row?.running_tasks),
    completedToday: dbNumber(row?.completed_today),
    failedToday: dbNumber(row?.failed_today),
    avgRuntimeSecondsToday: Number(row?.avg_runtime_seconds_today ?? 0),
    maxRuntimeSecondsToday: dbNumber(row?.max_runtime_seconds_today),
    oldestRunningStartedAt: rowIso(row?.oldest_running_started_at ?? null),
    latestTerminalAt: rowIso(row?.latest_terminal_at ?? null),
  };
}

function summarizeContextHealth(
  rows: ControlPlaneContextHealthRow[],
): ComposeControlPlaneHealth["context"] {
  const row = rows[0];
  return {
    patchesReady: dbNumber(row?.patches_ready),
    patchesBuilding: dbNumber(row?.patches_building),
    patchesFailed: dbNumber(row?.patches_failed),
    oldestReadyPatchAt: rowIso(row?.oldest_ready_patch_at ?? null),
    versionsCommittedToday: dbNumber(row?.versions_committed_today),
    versionsFailedToday: dbNumber(row?.versions_failed_today),
    versionsBuilding: dbNumber(row?.versions_building),
    latestCommittedVersionAt: rowIso(row?.latest_committed_version_at ?? null),
    latestFailedVersionAt: rowIso(row?.latest_failed_version_at ?? null),
  };
}

function summarizeWorkerHealth(
  rows: ControlPlaneWorkerHealthRow[],
): ComposeControlPlaneHealth["workers"] {
  const byMode = Object.fromEntries(
    SPEC_FACTORY_RUNTIME_MODES.map((mode) => [
      mode,
      { total: 0, live: 0, stale: 0, latestHeartbeatAt: null },
    ]),
  ) as ComposeControlPlaneHealth["workers"]["byMode"];
  let total = 0;
  let live = 0;
  let stale = 0;

  for (const row of rows) {
    if (
      !SPEC_FACTORY_RUNTIME_MODES.includes(row.mode as SpecFactoryRuntimeMode)
    ) {
      continue;
    }
    const mode = row.mode as keyof typeof byMode;
    const summary = {
      total: dbNumber(row.total),
      live: dbNumber(row.live),
      stale: dbNumber(row.stale),
      latestHeartbeatAt: rowIso(row.latest_heartbeat_at),
    };
    byMode[mode] = summary;
    total += summary.total;
    live += summary.live;
    stale += summary.stale;
  }

  return { total, live, stale, byMode };
}

function hardDeleteRowCounts(
  row: Partial<HardDeleteCountRow>,
): ComposeHardDeleteRowCounts {
  return {
    compose_session_events: dbNumber(row.compose_session_events),
    compose_stream_tokens: dbNumber(row.compose_stream_tokens),
    compose_turn_jobs: dbNumber(row.compose_turn_jobs),
    compose_turn_outputs: dbNumber(row.compose_turn_outputs),
    compose_agent_tasks: dbNumber(row.compose_agent_tasks),
    compose_agent_runtime_runs: dbNumber(row.compose_agent_runtime_runs),
    compose_context_patches: dbNumber(row.compose_context_patches),
    compose_context_versions: dbNumber(row.compose_context_versions),
    compose_session_messages: dbNumber(row.compose_session_messages),
    compose_session_sources: dbNumber(row.compose_session_sources),
    compose_source_deletions: dbNumber(row.compose_source_deletions),
    compose_source_revisions: dbNumber(row.compose_source_revisions),
    compose_source_chunks: dbNumber(row.compose_source_chunks),
    compose_handoffs: dbNumber(row.compose_handoffs),
    compose_handoff_snapshots: dbNumber(row.compose_handoff_snapshots),
    compose_workspace_manifests: dbNumber(row.compose_workspace_manifests),
    spec_factory_llm_calls: dbNumber(row.spec_factory_llm_calls),
    spec_factory_outbox: dbNumber(row.spec_factory_outbox),
    spec_factory_queue_receipts: dbNumber(row.spec_factory_queue_receipts),
    spec_factory_repair_items: dbNumber(row.spec_factory_repair_items),
    spec_factory_draft_workflows: dbNumber(row.spec_factory_draft_workflows),
    spec_factory_draft_stage_runs: dbNumber(row.spec_factory_draft_stage_runs),
    spec_factory_evidence_snapshots: dbNumber(
      row.spec_factory_evidence_snapshots,
    ),
    spec_factory_drafts: dbNumber(row.spec_factory_drafts),
    spec_factory_child_tickets: dbNumber(row.spec_factory_child_tickets),
    spec_factory_events: dbNumber(row.spec_factory_events),
    spec_factory_processing_jobs: dbNumber(row.spec_factory_processing_jobs),
    spec_factory_attachments: dbNumber(row.spec_factory_attachments),
    spec_factory_sources: dbNumber(row.spec_factory_sources),
    compose_sessions: dbNumber(row.compose_sessions),
  };
}

function emptyHardDeleteRowCounts(): ComposeHardDeleteRowCounts {
  return hardDeleteRowCounts({});
}

function addDeletedRows(
  counts: ComposeHardDeleteRowCounts,
  table: keyof ComposeHardDeleteRowCounts,
  result: mysql.ResultSetHeader,
): void {
  counts[table] += result.affectedRows;
}

function uniqueNonEmptyStrings(
  rows: Array<{ artifact_uri: unknown }>,
): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const row of rows) {
    if (typeof row.artifact_uri !== "string") continue;
    const value = row.artifact_uri.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function artifactKey(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("s3://")) return trimmed.replace(/^\/+/, "");
  try {
    return decodeURIComponent(new URL(trimmed).pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => textOrNull(item))
        .filter((item): item is string => Boolean(item))
    : [];
}

function parseNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "number" ? item : Number(item)))
        .filter((item) => Number.isFinite(item))
    : [];
}

function sourceDeletionSummary(
  row: SourceDeletionRow,
): ComposeSourceDeletionSummary {
  const invalidatedSourceIds = parseNumberArray(
    jsonValue(row.invalidated_source_ids_json),
  );
  return {
    id: dbNumber(row.id),
    sessionId: dbNumber(row.session_id),
    sourceId: dbNumber(row.source_id),
    sourceTitle: row.source_title,
    status: row.status,
    undoUntil: toIso(row.undo_until),
    invalidatedSourceIds,
    invalidatedHandoffIds: parseNumberArray(
      jsonValue(row.invalidated_handoff_ids_json),
    ),
    dependentSourceCount: Math.max(0, invalidatedSourceIds.length - 1),
    createdAt: toIso(row.created_at),
  };
}

function invalidatedSourceClosure(
  rows: DeletableSourceRow[],
  rootSourceId: number,
): DeletableSourceRow[] {
  const invalidatedIds = new Set([rootSourceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const id = dbNumber(row.id);
      if (invalidatedIds.has(id) || row.kind !== "generated_research") {
        continue;
      }
      const parents = parseNumberArray(jsonValue(row.parent_source_ids_json));
      if (!parents.some((parentId) => invalidatedIds.has(parentId))) continue;
      invalidatedIds.add(id);
      changed = true;
    }
  }
  return rows.filter((row) => invalidatedIds.has(dbNumber(row.id)));
}

function jsonArray(value: string | unknown | null): unknown[] {
  const raw = jsonValue(value);
  return Array.isArray(raw) ? raw : [];
}

function parseContextProjectionSummary(
  value: string | unknown | null,
): ComposeContextProjectionSummary | null {
  const raw = jsonValue(value);
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const summary = {
    objective: textOrNull(obj.objective),
    problemStatement: textOrNull(obj.problemStatement),
    solution: textOrNull(obj.solution),
    businessRequirements: stringArray(obj.businessRequirements),
    functionalRequirements: stringArray(obj.functionalRequirements),
    challenges: stringArray(obj.challenges),
    stories: parseStories(obj.stories) ?? [],
    recommendedNextActions: stringArray(obj.recommendedNextActions),
  };
  if (
    !summary.objective &&
    !summary.problemStatement &&
    !summary.solution &&
    summary.businessRequirements.length === 0 &&
    summary.functionalRequirements.length === 0 &&
    summary.challenges.length === 0 &&
    summary.stories.length === 0 &&
    summary.recommendedNextActions.length === 0
  ) {
    return null;
  }
  return summary;
}

function parseSourceEntities(
  value: string | unknown | null,
): ComposeSourceEntities | null {
  const raw = jsonValue(value);
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    jiraKeys: stringArray(obj.jiraKeys),
    repositories: stringArray(obj.repositories),
    files: stringArray(obj.files),
    clients: stringArray(obj.clients),
    loeHours: parseNumberArray(obj.loeHours),
    dates: stringArray(obj.dates),
    assumptions: stringArray(obj.assumptions),
  };
}

function parseSourceUsefulness(
  value: string | null,
): ComposeSourceUsefulness | null {
  if (
    value === "high_signal" ||
    value === "needs_clarification" ||
    value === "duplicate" ||
    value === "missing_repo_context" ||
    value === "weak_requirement_detail" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function assignedPersona(seed: string): { key: string; name: string } {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const picked = DEFAULT_AGENT_PERSONAS[hash % DEFAULT_AGENT_PERSONAS.length];
  return { key: picked[0], name: picked[1] };
}

function parseReadinessDetails(value: unknown): ComposeReadinessDetails | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const repositories = Array.isArray(obj.repositories)
    ? obj.repositories
        .map((repo) => textOrNull(repo))
        .filter((repo): repo is string => Boolean(repo))
    : [];
  return {
    module: textOrNull(obj.module),
    repositories,
    difficulty: textOrNull(obj.difficulty),
    loeHours: numberOrNull(obj.loeHours),
    storyPoints: numberOrNull(obj.storyPoints),
  };
}

function parseRepoEvidence(value: unknown): ComposeRepoEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const evidence = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item) => ({
      repoName: typeof item.repoName === "string" ? item.repoName : "",
      headSha: textOrNull(item.headSha),
      techStack: textOrNull(item.techStack),
      inspectedPaths: Array.isArray(item.inspectedPaths)
        ? item.inspectedPaths.filter((p): p is string => typeof p === "string")
        : [],
      keyMatches: Array.isArray(item.keyMatches)
        ? item.keyMatches.filter((m): m is string => typeof m === "string")
        : [],
      warnings: Array.isArray(item.warnings)
        ? item.warnings.filter((w): w is string => typeof w === "string")
        : [],
    }))
    .filter((repo) => repo.repoName.length > 0);
  return evidence.length > 0 ? evidence : null;
}

function parseCodeInvestigation(
  value: unknown,
): ComposeCodeInvestigation | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const filesRead = numberOrNull(obj.filesRead);
  const toolCalls = numberOrNull(obj.toolCalls);
  if (filesRead === null && toolCalls === null) return null;
  return { filesRead: filesRead ?? 0, toolCalls: toolCalls ?? 0 };
}

function parseConfidence(value: unknown): ComposeReadiness["confidence"] {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const score = numberOrNull(obj.score);
  if (score === null) return null;
  return {
    score: Math.min(1, Math.max(0, score)),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

function parseWarnings(value: unknown): ComposeReadiness["validatorWarnings"] {
  if (!Array.isArray(value)) return undefined;
  const warnings = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item) => {
      const code = textOrNull(item.code);
      const message = textOrNull(item.message);
      const severity = item.severity;
      if (
        !code ||
        !message ||
        (severity !== "info" &&
          severity !== "warning" &&
          severity !== "blocker")
      ) {
        return null;
      }
      return { code, message, severity };
    })
    .filter(
      (
        warning,
      ): warning is NonNullable<
        ComposeReadiness["validatorWarnings"]
      >[number] => warning !== null,
    );
  return warnings.length > 0 ? warnings : undefined;
}

function parseQuestions(value: unknown): ComposeOpenQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item) => {
      const id = textOrNull(item.id);
      const question = textOrNull(item.question);
      if (!id || !question) return null;
      const options = Array.isArray(item.options)
        ? item.options
            .map((opt) => textOrNull(opt))
            .filter((opt): opt is string => Boolean(opt))
            .slice(0, 3)
        : undefined;
      const answer = textOrNull(item.answer);
      const questionType =
        item.questionType === "business" ||
        item.questionType === "functional" ||
        item.questionType === "implementation" ||
        item.questionType === "research_consent"
          ? item.questionType
          : undefined;
      return {
        id,
        question,
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof item.answered === "boolean"
          ? { answered: item.answered }
          : {}),
        ...(answer ? { answer } : {}),
        ...(questionType ? { questionType } : {}),
      } satisfies ComposeOpenQuestion;
    })
    .filter((q): q is ComposeOpenQuestion => q !== null);
  return questions.length > 0 ? questions : null;
}

function parseStories(value: unknown): ComposeStory[] | null {
  if (!Array.isArray(value)) return null;
  const stories = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item) => {
      const id = textOrNull(item.id);
      const title = textOrNull(item.title);
      if (!id || !title) return null;
      const repos = Array.isArray(item.repos)
        ? item.repos
            .map((repo) => textOrNull(repo))
            .filter((repo): repo is string => Boolean(repo))
        : undefined;
      const sequence = numberOrNull(item.sequence);
      const acceptanceCriteria = stringArray(item.acceptanceCriteria);
      return {
        id,
        title,
        summary: typeof item.summary === "string" ? item.summary : "",
        ...(repos && repos.length > 0 ? { repos } : {}),
        ...(sequence !== null ? { sequence } : {}),
        ...(textOrNull(item.userStory)
          ? { userStory: textOrNull(item.userStory)! }
          : {}),
        ...(textOrNull(item.businessValue)
          ? { businessValue: textOrNull(item.businessValue)! }
          : {}),
        ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      } satisfies ComposeStory;
    })
    .filter((s): s is ComposeStory => s !== null);
  return stories.length > 0 ? stories : null;
}

function parseReadiness(
  value: string | unknown | null,
): ComposeSessionSummary["readiness"] {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const details = parseReadinessDetails(obj.details);
  const repoEvidence = parseRepoEvidence(obj.repoEvidence);
  const codeInvestigation = parseCodeInvestigation(obj.codeInvestigation);
  const questions = parseQuestions(obj.questions)?.filter(
    isUserFacingClarification,
  );
  const stories = parseStories(obj.stories);
  const ideating = textOrNull(obj.ideating);
  const problem = textOrNull(obj.problem);
  const solution = textOrNull(obj.solution);
  const businessRequirements = stringArray(obj.businessRequirements);
  const functionalRequirements = stringArray(obj.functionalRequirements);
  const challenges = stringArray(obj.challenges);
  const confidence = parseConfidence(obj.confidence);
  const risks = stringArray(obj.risks);
  const assumptions = stringArray(obj.assumptions);
  const missingEvidence = stringArray(obj.missingEvidence);
  const nextStep = textOrNull(obj.nextStep);
  const validatorWarnings = parseWarnings(obj.validatorWarnings);
  return {
    ready: Boolean(obj.ready),
    openQuestions: Array.isArray(obj.openQuestions)
      ? obj.openQuestions.filter(
          (question): question is string =>
            typeof question === "string" && isUserFacingClarification(question),
        )
      : [],
    summary: typeof obj.summary === "string" ? obj.summary : "",
    ...(details ? { details } : {}),
    ...(repoEvidence ? { repoEvidence } : {}),
    ...(codeInvestigation ? { codeInvestigation } : {}),
    ...(questions && questions.length > 0 ? { questions } : {}),
    ...(stories ? { stories } : {}),
    ...(ideating ? { ideating } : {}),
    ...(problem ? { problem } : {}),
    ...(solution ? { solution } : {}),
    ...(businessRequirements.length > 0 ? { businessRequirements } : {}),
    ...(functionalRequirements.length > 0 ? { functionalRequirements } : {}),
    ...(challenges.length > 0 ? { challenges } : {}),
    ...(confidence ? { confidence } : {}),
    ...(risks.length > 0 ? { risks } : {}),
    ...(assumptions.length > 0 ? { assumptions } : {}),
    ...(missingEvidence.length > 0 ? { missingEvidence } : {}),
    ...(nextStep ? { nextStep } : {}),
    ...(validatorWarnings ? { validatorWarnings } : {}),
  };
}

export class ComposeRepository {
  constructor(private readonly pool: PoolLike = getDatabase().getPool()) {}

  async createSession(input: {
    name: string;
    createdBy: string | null;
    createdByDisplay: string | null;
    s3Prefix: string;
    workspacePath: string;
    passwordHash: string | null;
  }): Promise<number> {
    const persona = assignedPersona(`${input.createdBy ?? ""}:${input.name}`);
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_sessions
       (name, created_by, created_by_display, agent_persona_key, agent_persona_name,
        status, last_active_at, last_action, last_actor, s3_prefix, workspace_path, password_hash)
       VALUES (?, ?, ?, ?, ?, 'draft', CURRENT_TIMESTAMP(3), 'session_created', ?, ?, ?, ?)`,
      [
        input.name,
        input.createdBy,
        input.createdByDisplay,
        persona.key,
        persona.name,
        input.createdBy,
        input.s3Prefix,
        input.workspacePath,
        input.passwordHash,
      ],
    );
    return result.insertId;
  }

  async updateSessionPaths(input: {
    sessionId: number;
    s3Prefix: string;
    workspacePath: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET s3_prefix = ?, workspace_path = ?
       WHERE id = ?`,
      [input.s3Prefix, input.workspacePath, input.sessionId],
    );
  }

  async recordSessionActivity(input: {
    sessionId: number;
    action: string;
    actor: string | null;
    activeTurn?: "started" | "finished";
  }): Promise<void> {
    const activeTurnSql =
      input.activeTurn === "started"
        ? ", active_turn_started_at = CURRENT_TIMESTAMP(3)"
        : input.activeTurn === "finished"
          ? ", active_turn_started_at = NULL"
          : "";
    await this.pool.query(
      `UPDATE compose_sessions
       SET last_active_at = CURRENT_TIMESTAMP(3),
           last_action = ?,
           last_actor = ?${activeTurnSql}
       WHERE id = ?
         AND status <> 'archived'`,
      [input.action, input.actor, input.sessionId],
    );
  }

  async appendSessionEvent(
    input: AppendSessionEventInput,
  ): Promise<ComposeSessionEvent | null> {
    const requestId =
      input.requestId ?? currentSpecFactoryCorrelation().requestId ?? null;
    const payloadJson = JSON.stringify(input.payload);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes > MAX_SESSION_EVENT_PAYLOAD_BYTES) {
      throw new Error(
        `Compose session event payload exceeds ${MAX_SESSION_EVENT_PAYLOAD_BYTES} bytes`,
      );
    }

    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    const occurredAt = new Date().toISOString();
    try {
      await connection.beginTransaction();
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_session_events
       (session_id, event_type, sequence, payload_json, payload_bytes,
        actor_type, actor_id, request_id, turn_job_id, agent_task_id,
        context_version)
       SELECT ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?
       FROM compose_sessions
       WHERE id = ?
         AND (status <> 'archived'
              OR ? IN ('session.archived', 'turn.cancelling',
                       'turn.cancelled', 'task.cancelled',
                       'turn.lease_fence_rejected',
                       'task.lease_fence_rejected',
                       'turn.discarded_due_to_archive',
                       'assistant.discarded_due_to_archive'))
       LIMIT 1`,
        [
          input.sessionId,
          input.eventType,
          null,
          payloadJson,
          payloadBytes,
          input.actorType ?? null,
          input.actorId ?? null,
          requestId,
          input.turnJobId ?? null,
          input.agentTaskId ?? null,
          input.contextVersion ?? null,
          input.sessionId,
          input.eventType,
        ],
      );
      if (result.affectedRows === 0) {
        await connection.commit();
        return null;
      }
      const payloadRecord =
        input.payload && typeof input.payload === "object"
          ? (input.payload as Record<string, unknown>)
          : {};
      const canonicalEvent = createCanonicalSessionEvent({
        id: result.insertId,
        sessionId: input.sessionId,
        eventType: input.eventType,
        occurredAt,
        requestId,
        turnJobId: input.turnJobId ?? null,
        agentTaskId: input.agentTaskId ?? null,
        contextVersion: input.contextVersion ?? null,
        handoffId: positiveNumberOrNull(payloadRecord.handoffId),
        workflowId: positiveNumberOrNull(payloadRecord.workflowId),
        sourceId: positiveNumberOrNull(payloadRecord.sourceId),
        data: input.payload,
      });
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "session_event",
        aggregateId: result.insertId,
        eventType: input.eventType,
        dedupeKey: `session-event:${result.insertId}`,
        payload: { canonicalEvent },
      });
      await connection.commit();
      return {
        id: result.insertId,
        sessionId: input.sessionId,
        eventType: input.eventType,
        sequence: null,
        payload: input.payload,
        payloadBytes,
        actorType: input.actorType ?? null,
        actorId: input.actorId ?? null,
        requestId,
        turnJobId: input.turnJobId ?? null,
        agentTaskId: input.agentTaskId ?? null,
        contextVersion: input.contextVersion ?? null,
        createdAt: occurredAt,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listSessionEventsAfter(
    sessionId: number,
    afterEventId = 0,
    limit = 100,
  ): Promise<ComposeSessionEvent[]> {
    const safeAfter = Number.isFinite(afterEventId)
      ? Math.max(0, Math.trunc(afterEventId))
      : 0;
    const safeLimit = Number.isFinite(limit)
      ? Math.min(500, Math.max(1, Math.trunc(limit)))
      : 100;
    const [rows] = await this.pool.query<SessionEventRow[]>(
      `SELECT id, session_id, event_type, sequence, payload_json, payload_bytes,
              actor_type, actor_id, request_id, turn_job_id, agent_task_id,
              context_version, created_at
       FROM compose_session_events
       WHERE session_id = ?
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [sessionId, safeAfter, safeLimit],
    );
    return rows.map((row) => this.mapSessionEvent(row));
  }

  async getLatestSessionEventId(sessionId: number): Promise<number> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: unknown }>
    >(
      `SELECT COALESCE(MAX(id), 0) AS id
       FROM compose_session_events
       WHERE session_id = ?`,
      [sessionId],
    );
    const id = Number(rows[0]?.id ?? 0);
    return Number.isInteger(id) && id >= 0 ? id : 0;
  }

  async listSessionEventsForCursors(
    cursors: Array<{ sessionId: number; afterEventId: number }>,
    limit = 5_000,
  ): Promise<ComposeSessionEvent[]> {
    const normalized = [
      ...new Map(
        cursors
          .filter(
            (cursor) =>
              Number.isInteger(cursor.sessionId) && cursor.sessionId > 0,
          )
          .map((cursor) => [
            cursor.sessionId,
            {
              sessionId: cursor.sessionId,
              afterEventId: Number.isFinite(cursor.afterEventId)
                ? Math.max(0, Math.trunc(cursor.afterEventId))
                : 0,
            },
          ]),
      ).values(),
    ].slice(0, 100);
    if (normalized.length === 0) return [];
    const safeLimit = Number.isFinite(limit)
      ? Math.min(5_000, Math.max(1, Math.trunc(limit)))
      : 5_000;
    const cursorTable = normalized
      .map(() => "SELECT ? AS session_id, ? AS after_event_id")
      .join(" UNION ALL ");
    const parameters = normalized.flatMap((cursor) => [
      cursor.sessionId,
      cursor.afterEventId,
    ]);
    const [rows] = await this.pool.query<SessionEventRow[]>(
      `SELECT event.id, event.session_id, event.event_type, event.sequence,
              event.payload_json, event.payload_bytes, event.actor_type,
              event.actor_id, event.request_id, event.turn_job_id,
              event.agent_task_id, event.context_version, event.created_at
       FROM compose_session_events event
       JOIN (${cursorTable}) session_cursor
         ON session_cursor.session_id = event.session_id
        AND event.id > session_cursor.after_event_id
       ORDER BY event.id ASC
       LIMIT ?`,
      [...parameters, safeLimit],
    );
    return rows.map((row) => this.mapSessionEvent(row));
  }

  async createStreamToken(input: CreateStreamTokenInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO compose_stream_tokens (token_hash, session_id, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         session_id = VALUES(session_id),
         expires_at = VALUES(expires_at),
         revoked_at = NULL,
         last_used_at = NULL`,
      [input.tokenHash, input.sessionId, input.expiresAt],
    );
  }

  async verifyStreamTokenHash(input: VerifyStreamTokenInput): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_stream_tokens
       SET last_used_at = CURRENT_TIMESTAMP(3)
       WHERE token_hash = ?
         AND session_id = ?
         AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP(3)`,
      [input.tokenHash, input.sessionId],
    );
    return result.affectedRows === 1;
  }

  async revokeSessionStreamTokens(sessionId: number): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_stream_tokens
       SET revoked_at = CURRENT_TIMESTAMP(3)
       WHERE session_id = ?
         AND revoked_at IS NULL`,
      [sessionId],
    );
    return result.affectedRows;
  }

  async purgeExpiredStreamTokens(
    input: PurgeExpiredStreamTokensInput,
  ): Promise<number> {
    const safeLimit = Number.isFinite(input.limit)
      ? Math.min(5000, Math.max(1, Math.trunc(input.limit)))
      : DEFAULT_STREAM_TOKEN_PURGE_LIMIT;
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `DELETE FROM compose_stream_tokens
       WHERE expires_at < ?
       ORDER BY expires_at ASC
       LIMIT ?`,
      [input.expiredBefore, safeLimit],
    );
    return result.affectedRows;
  }

  async purgeStaleWorkerHeartbeats(
    input: PurgeStaleWorkerHeartbeatsInput,
  ): Promise<number> {
    const safeLimit = Number.isFinite(input.limit)
      ? Math.min(5000, Math.max(1, Math.trunc(input.limit)))
      : DEFAULT_WORKER_HEARTBEAT_PURGE_LIMIT;
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `DELETE FROM spec_factory_worker_heartbeats
       WHERE heartbeat_at < ?
       ORDER BY heartbeat_at ASC
       LIMIT ?`,
      [input.heartbeatBefore, safeLimit],
    );
    return result.affectedRows;
  }

  async upsertWorkspaceManifest(
    input: UpsertComposeWorkspaceManifestInput,
  ): Promise<void> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_workspace_manifests
       (session_id, workspace_path, manifest_json, manifest_bytes, manifest_sha256)
       SELECT ?, ?, CAST(? AS JSON), ?, ?
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1
       ON DUPLICATE KEY UPDATE
         workspace_path = VALUES(workspace_path),
         manifest_json = VALUES(manifest_json),
         manifest_bytes = VALUES(manifest_bytes),
         manifest_sha256 = VALUES(manifest_sha256),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        input.sessionId,
        input.workspacePath,
        JSON.stringify(input.manifestJson),
        input.manifestBytes,
        input.manifestSha256,
        input.sessionId,
      ],
    );
    if ((result.affectedRows ?? 0) === 0) {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1`,
        [input.sessionId],
      );
      if (rows.length === 0) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
    }
  }

  async getWorkspaceManifest(
    sessionId: number,
  ): Promise<WorkspaceManifest | null> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { manifest_json: string | unknown }>
    >(
      `SELECT manifest_json
       FROM compose_workspace_manifests manifest
       JOIN compose_sessions session ON session.id = manifest.session_id
       WHERE manifest.session_id = ?
         AND session.status <> 'archived'
       LIMIT 1`,
      [sessionId],
    );
    const value = jsonValue(rows[0]?.manifest_json ?? null);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const manifest = value as Partial<WorkspaceManifest>;
    if (
      (manifest.manifestVersion !== 1 && manifest.manifestVersion !== 2) ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.sourceInventory)
    ) {
      throw new Error(`invalid_workspace_manifest:${sessionId}`);
    }
    return manifest as WorkspaceManifest;
  }

  async createMessageTurn(input: CreateMessageTurnInput): Promise<CreatedTurn> {
    for (let attempt = 1; attempt <= TURN_CREATION_MAX_ATTEMPTS; attempt += 1) {
      const connection =
        (await this.pool.getConnection()) as TransactionConnection;
      try {
        await connection.beginTransaction();
        const existing = await this.findTurnByIdempotency(connection, {
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          const created = this.createdTurnFromExisting(
            existing,
            input.requestHash,
          );
          await connection.commit();
          return created;
        }

        const requestedContextVersion = await this.lockSessionContextVersion(
          connection,
          input.sessionId,
        );

        const [messageResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_session_messages
             (session_id, role, content, message_kind)
             VALUES (?, ?, ?, ?)`,
          [input.sessionId, "user", input.content, "user"],
        );
        const messageId = messageResult.insertId;
        const [turnResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_turn_jobs
           (session_id, turn_kind, user_message_id, requested_context_version,
            idempotency_key, request_hash, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            input.sessionId,
            "chat",
            messageId,
            requestedContextVersion,
            input.idempotencyKey,
            input.requestHash,
            input.requestId ??
              currentSpecFactoryCorrelation().requestId ??
              null,
          ],
        );
        await connection.query(
          `UPDATE compose_session_messages
           SET turn_job_id = ?
           WHERE id = ?`,
          [turnResult.insertId, messageId],
        );
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "turn",
          aggregateId: turnResult.insertId,
          eventType: "turn.queued",
          dedupeKey: `turn:${turnResult.insertId}:queued:g1`,
          payload: {
            sessionId: input.sessionId,
            turnJobId: turnResult.insertId,
            turnKind: "chat",
            userMessageId: messageId,
            requestedContextVersion,
            queueGeneration: 1,
          },
        });
        await connection.commit();
        specFactoryMetrics.recordWorkAccepted({
          workType: "turn",
          subtype: "chat",
        });
        return {
          turnJobId: turnResult.insertId,
          messageId,
          status: "queued",
          deduplicated: false,
        };
      } catch (error) {
        await connection.rollback();
        if (isDuplicateKeyError(error)) {
          const existing = await this.findTurnByIdempotency(connection, {
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
          });
          if (existing) {
            return this.createdTurnFromExisting(existing, input.requestHash);
          }
        }
        if (isDeadlockError(error) && attempt < TURN_CREATION_MAX_ATTEMPTS) {
          continue;
        }
        throw error;
      } finally {
        connection.release();
      }
    }
    throw new Error("turn_creation_retry_exhausted");
  }

  async createAnalyzeTurn(input: CreateAnalyzeTurnInput): Promise<CreatedTurn> {
    for (let attempt = 1; attempt <= TURN_CREATION_MAX_ATTEMPTS; attempt += 1) {
      const connection =
        (await this.pool.getConnection()) as TransactionConnection;
      try {
        await connection.beginTransaction();
        const existing = await this.findTurnByIdempotency(connection, {
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          const created = this.createdTurnFromExisting(
            existing,
            input.requestHash,
          );
          await connection.commit();
          return created;
        }

        if (input.resetSessionProgress) {
          await this.resetSessionProgressInTransaction(
            connection,
            input.sessionId,
          );
        }
        const requestedContextVersion = await this.lockSessionContextVersion(
          connection,
          input.sessionId,
        );

        const [turnResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_turn_jobs
           (session_id, turn_kind, user_message_id, requested_context_version,
            idempotency_key, request_hash, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            input.sessionId,
            "analyze",
            null,
            requestedContextVersion,
            input.idempotencyKey,
            input.requestHash,
            input.requestId ??
              currentSpecFactoryCorrelation().requestId ??
              null,
          ],
        );
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "turn",
          aggregateId: turnResult.insertId,
          eventType: "turn.queued",
          dedupeKey: `turn:${turnResult.insertId}:queued:g1`,
          payload: {
            sessionId: input.sessionId,
            turnJobId: turnResult.insertId,
            turnKind: "analyze",
            requestedContextVersion,
            queueGeneration: 1,
          },
        });
        await connection.commit();
        specFactoryMetrics.recordWorkAccepted({
          workType: "turn",
          subtype: "analyze",
        });
        return {
          turnJobId: turnResult.insertId,
          messageId: null,
          status: "queued",
          deduplicated: false,
        };
      } catch (error) {
        await connection.rollback();
        if (isDuplicateKeyError(error)) {
          const existing = await this.findTurnByIdempotency(connection, {
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
          });
          if (existing) {
            return this.createdTurnFromExisting(existing, input.requestHash);
          }
        }
        if (isDeadlockError(error) && attempt < TURN_CREATION_MAX_ATTEMPTS) {
          continue;
        }
        throw error;
      } finally {
        connection.release();
      }
    }
    throw new Error("turn_creation_retry_exhausted");
  }

  async createAgentTask(input: CreateAgentTaskInput): Promise<number> {
    const priority = Number.isFinite(input.priority)
      ? Math.trunc(input.priority as number)
      : DEFAULT_AGENT_TASK_PRIORITY;
    const maxAttempts = Number.isFinite(input.maxAttempts)
      ? Math.max(1, Math.trunc(input.maxAttempts as number))
      : DEFAULT_AGENT_TASK_MAX_ATTEMPTS;
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_agent_tasks
         (session_id, turn_job_id, capability, executor_type, request_id,
          priority, input_json, max_attempts, output_source_id)
         SELECT ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1`,
        [
          input.sessionId,
          input.turnJobId ?? null,
          input.capability,
          input.executorType ?? null,
          input.requestId ?? currentSpecFactoryCorrelation().requestId ?? null,
          priority,
          JSON.stringify(input.input ?? null),
          maxAttempts,
          input.outputSourceId ?? null,
          input.sessionId,
        ],
      );
      if ((result.affectedRows ?? 1) !== 1) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "agent_task",
        aggregateId: result.insertId,
        eventType: "task.queued",
        dedupeKey: `agent-task:${result.insertId}:queued:g1`,
        payload: {
          sessionId: input.sessionId,
          turnJobId: input.turnJobId ?? null,
          agentTaskId: result.insertId,
          capability: input.capability,
          executorType: input.executorType ?? null,
          queueGeneration: 1,
        },
      });
      await connection.commit();
      specFactoryMetrics.recordWorkAccepted({
        workType: "agent_task",
        subtype: input.capability,
      });
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createHandoffBuildTask(input: {
    sessionId: number;
    sourceId: number;
    idempotencyKey: string;
    requestedBy: string | null;
    reusedExistingSource: boolean;
  }): Promise<CreatedHandoffBuildTask> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            latest_context_version: number | string | null;
          }
        >
      >(
        `SELECT id, latest_context_version
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      const requestedContextVersion = dbNumberOrNull(
        session.latest_context_version,
      );
      const [messageRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            message_high_watermark_id: number | string | null;
          }
        >
      >(
        `SELECT MAX(id) AS message_high_watermark_id
         FROM compose_session_messages
         WHERE session_id = ?`,
        [input.sessionId],
      );
      const messageHighWatermarkId = dbNumberOrNull(
        messageRows[0]?.message_high_watermark_id,
      );
      const [existingRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            source_id: number | string | null;
            build_agent_task_id: number | string | null;
            requested_context_version: number | string | null;
            message_high_watermark_id: number | string | null;
          }
        >
      >(
        `SELECT id, source_id, build_agent_task_id,
                requested_context_version, message_high_watermark_id
         FROM compose_handoffs
         WHERE session_id = ?
           AND idempotency_key = ?
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId, input.idempotencyKey],
      );
      const existing = existingRows[0];
      if (existing) {
        if (dbNumberOrNull(existing.source_id) !== input.sourceId) {
          throw new IdempotencyConflictError();
        }
        const agentTaskId = dbNumberOrNull(existing.build_agent_task_id);
        if (agentTaskId === null) {
          throw new Error("handoff_build_task_missing");
        }
        await connection.commit();
        return {
          handoffId: dbNumber(existing.id),
          agentTaskId,
          requestedContextVersion: dbNumberOrNull(
            existing.requested_context_version,
          ),
          messageHighWatermarkId: dbNumberOrNull(
            existing.message_high_watermark_id,
          ),
          deduplicated: true,
        };
      }

      const [handoffResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_handoffs
         (session_id, source_id, idempotency_key, requested_by, status,
          requested_context_version, message_high_watermark_id)
         VALUES (?, ?, ?, ?, 'snapshot_building', ?, ?)`,
        [
          input.sessionId,
          input.sourceId,
          input.idempotencyKey,
          input.requestedBy,
          requestedContextVersion,
          messageHighWatermarkId,
        ],
      );
      const handoffId = handoffResult.insertId;
      const requestedAt = new Date().toISOString();
      const taskInput = {
        handoffId,
        sourceId: input.sourceId,
        actor: input.requestedBy,
        contextVersionUsed: requestedContextVersion,
        messageHighWatermarkId,
        requestedAt,
        reusedExistingSource: input.reusedExistingSource,
      };
      const [taskResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_agent_tasks
         (session_id, turn_job_id, capability, executor_type, request_id,
          priority, input_json, max_attempts)
         VALUES (?, NULL, 'handoff_build', 'handoff_build', ?, 60,
                 CAST(? AS JSON), 2)`,
        [
          input.sessionId,
          currentSpecFactoryCorrelation().requestId ?? null,
          JSON.stringify(taskInput),
        ],
      );
      const agentTaskId = taskResult.insertId;
      await connection.query(
        `UPDATE compose_handoffs
         SET build_agent_task_id = ?
         WHERE id = ?`,
        [agentTaskId, handoffId],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "handoff",
        aggregateId: handoffId,
        eventType: "handoff.snapshot_building",
        dedupeKey: `handoff:${handoffId}:snapshot-building`,
        payload: {
          sessionId: input.sessionId,
          sourceId: input.sourceId,
          handoffId,
          agentTaskId,
          contextVersion: requestedContextVersion,
          messageHighWatermarkId,
        },
      });
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "agent_task",
        aggregateId: agentTaskId,
        eventType: "task.queued",
        dedupeKey: `agent-task:${agentTaskId}:queued:g1`,
        payload: {
          sessionId: input.sessionId,
          agentTaskId,
          handoffId,
          capability: "handoff_build",
          executorType: "handoff_build",
          queueGeneration: 1,
        },
      });
      await connection.commit();
      specFactoryMetrics.recordWorkAccepted({
        workType: "agent_task",
        subtype: "handoff_build",
      });
      return {
        handoffId,
        agentTaskId,
        requestedContextVersion,
        messageHighWatermarkId,
        deduplicated: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async commitHandoffSnapshot(
    input: CommitHandoffSnapshotInput,
  ): Promise<number> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            snapshot_id: number | string | null;
            status: string;
          }
        >
      >(
        `SELECT handoff.snapshot_id, handoff.status
         FROM compose_handoffs handoff
         JOIN compose_sessions session ON session.id = handoff.session_id
         JOIN compose_agent_tasks task ON task.id = handoff.build_agent_task_id
         WHERE handoff.id = ?
           AND handoff.session_id = ?
           AND handoff.source_id = ?
           AND task.id = ?
           AND task.status = 'running'
           AND task.active_worker_id = ?
           AND task.lease_generation = ?
           AND task.lease_until >= CURRENT_TIMESTAMP(3)
           AND session.status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [
          input.handoffId,
          input.sessionId,
          input.sourceId,
          input.agentTaskId,
          input.workerId,
          input.leaseGeneration,
        ],
      );
      const handoff = rows[0];
      if (!handoff) {
        throw new Error("agent_task_lease_lost");
      }
      const existingSnapshotId = dbNumberOrNull(handoff.snapshot_id);
      if (existingSnapshotId !== null) {
        await connection.commit();
        return existingSnapshotId;
      }
      const [snapshotResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_handoff_snapshots
         (handoff_id, session_id, source_id, schema_version, context_version,
          message_high_watermark_id, source_revision_set_hash,
          repository_manifest_hash, snapshot_json, artifact_uri,
          artifact_sha256, artifact_bytes, markdown_artifact_uri,
          markdown_artifact_sha256, markdown_artifact_bytes, status,
          created_by, committed_at)
         VALUES (?, ?, ?, 2, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?,
                 'ready', ?, CURRENT_TIMESTAMP(3))`,
        [
          input.handoffId,
          input.sessionId,
          input.sourceId,
          input.contextVersionUsed,
          input.messageHighWatermarkId,
          input.sourceRevisionSetHash,
          input.repositoryManifestHash,
          JSON.stringify(input.snapshot),
          input.artifactUri,
          input.artifactSha256,
          input.artifactBytes,
          input.markdownArtifactUri,
          input.markdownArtifactSha256,
          input.markdownArtifactBytes,
          input.createdBy ?? null,
        ],
      );
      const snapshotId = snapshotResult.insertId;
      await connection.query(
        `UPDATE compose_handoffs
         SET status = 'snapshot_ready',
             context_version_used = ?,
             message_high_watermark_id = ?,
             source_revision_set_hash = ?,
             repository_manifest_hash = ?,
             snapshot_id = ?,
             error_code = NULL,
             error_message = NULL
         WHERE id = ?`,
        [
          input.contextVersionUsed,
          input.messageHighWatermarkId,
          input.sourceRevisionSetHash,
          input.repositoryManifestHash,
          snapshotId,
          input.handoffId,
        ],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "handoff",
        aggregateId: input.handoffId,
        eventType: "handoff.snapshot_ready",
        dedupeKey: `handoff:${input.handoffId}:snapshot-ready`,
        payload: {
          sessionId: input.sessionId,
          sourceId: input.sourceId,
          handoffId: input.handoffId,
          snapshotId,
          contextVersion: input.contextVersionUsed,
          messageHighWatermarkId: input.messageHighWatermarkId,
        },
      });
      await connection.commit();
      return snapshotId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markHandoffDraftQueued(input: {
    handoffId: number;
    draftWorkflowId?: number | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_handoffs
       SET status = 'draft_queued',
           draft_workflow_id = COALESCE(?, draft_workflow_id),
           error_code = NULL,
           error_message = NULL
       WHERE id = ?
         AND status IN ('snapshot_ready','draft_queued')`,
      [input.draftWorkflowId ?? null, input.handoffId],
    );
  }

  async getSessionResearchBudgetUsage(
    input: GetSessionResearchBudgetUsageInput,
  ): Promise<SessionResearchBudgetUsage> {
    const researchCapabilityPlaceholders = RESEARCH_CAPABILITIES.map(
      () => "?",
    ).join(", ");
    const [rows] = await this.pool.query<ResearchBudgetUsageRow[]>(
      `SELECT
         COALESCE((
           SELECT SUM(spent.estimated_cost_usd)
           FROM (
             SELECT estimated_cost_usd
             FROM spec_factory_llm_calls
             WHERE session_id = ?
               AND created_at >= ?
               AND estimated_cost_usd IS NOT NULL
             UNION ALL
             SELECT runtime_run.estimated_cost_usd
             FROM compose_agent_runtime_runs runtime_run
             JOIN compose_agent_tasks runtime_task
               ON runtime_task.id = runtime_run.agent_task_id
             WHERE runtime_run.session_id = ?
               AND runtime_run.completed_at >= ?
               AND runtime_run.estimated_cost_usd IS NOT NULL
               AND runtime_task.capability IN (${researchCapabilityPlaceholders})
           ) spent
         ), 0) AS spent_cost_usd,
         COALESCE((
           SELECT SUM(
             COALESCE(
               CAST(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.maxCostUsd')) AS DECIMAL(12,6)),
               0
             )
           )
           FROM compose_agent_tasks
           WHERE session_id = ?
             AND created_at >= ?
             AND capability IN (${researchCapabilityPlaceholders})
             AND status IN ('queued', 'running')
         ), 0) AS reserved_cost_usd,
         COALESCE((
           SELECT COUNT(*)
           FROM compose_agent_tasks
           WHERE session_id = ?
             AND created_at >= ?
             AND capability IN (${researchCapabilityPlaceholders})
         ), 0) AS research_tasks_24h,
         COALESCE((
           SELECT COUNT(*)
           FROM compose_agent_tasks
           WHERE session_id = ?
             AND capability IN (${researchCapabilityPlaceholders})
             AND status IN ('queued', 'running')
         ), 0) AS in_flight_tasks`,
      [
        input.sessionId,
        input.since,
        input.sessionId,
        input.since,
        ...RESEARCH_CAPABILITIES,
        input.sessionId,
        input.since,
        ...RESEARCH_CAPABILITIES,
        input.sessionId,
        input.since,
        ...RESEARCH_CAPABILITIES,
        input.sessionId,
        ...RESEARCH_CAPABILITIES,
      ],
    );
    const row = rows[0];
    return {
      spentCostUsd: Number(row?.spent_cost_usd ?? 0),
      reservedCostUsd: Number(row?.reserved_cost_usd ?? 0),
      researchTasks24h: Number(row?.research_tasks_24h ?? 0),
      inFlightTasks: Number(row?.in_flight_tasks ?? 0),
    };
  }

  async getGlobalResearchBudgetUsage(
    input: GetGlobalResearchBudgetUsageInput,
  ): Promise<GlobalResearchBudgetUsage> {
    const researchCapabilityPlaceholders = RESEARCH_CAPABILITIES.map(
      () => "?",
    ).join(", ");
    const [rows] = await this.pool.query<ResearchBudgetUsageRow[]>(
      `SELECT
         COALESCE((
           SELECT SUM(spent.estimated_cost_usd)
           FROM (
             SELECT estimated_cost_usd
             FROM spec_factory_llm_calls
             WHERE created_at >= ?
               AND estimated_cost_usd IS NOT NULL
             UNION ALL
             SELECT runtime_run.estimated_cost_usd
             FROM compose_agent_runtime_runs runtime_run
             JOIN compose_agent_tasks runtime_task
               ON runtime_task.id = runtime_run.agent_task_id
             WHERE runtime_run.completed_at >= ?
               AND runtime_run.estimated_cost_usd IS NOT NULL
               AND runtime_task.capability IN (${researchCapabilityPlaceholders})
           ) spent
         ), 0) AS spent_cost_usd,
         COALESCE((
           SELECT SUM(
             COALESCE(
               CAST(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.maxCostUsd')) AS DECIMAL(12,6)),
               0
             )
           )
           FROM compose_agent_tasks
           WHERE created_at >= ?
             AND capability IN (${researchCapabilityPlaceholders})
             AND status IN ('queued', 'running')
         ), 0) AS reserved_cost_usd,
         COALESCE((
           SELECT COUNT(*)
           FROM compose_agent_tasks
           WHERE created_at >= ?
             AND capability IN (${researchCapabilityPlaceholders})
         ), 0) AS research_tasks_24h,
         COALESCE((
           SELECT COUNT(*)
           FROM compose_agent_tasks
           WHERE capability IN (${researchCapabilityPlaceholders})
             AND status IN ('queued', 'running')
         ), 0) AS in_flight_tasks`,
      [
        input.since,
        input.since,
        ...RESEARCH_CAPABILITIES,
        input.since,
        ...RESEARCH_CAPABILITIES,
        input.since,
        ...RESEARCH_CAPABILITIES,
        ...RESEARCH_CAPABILITIES,
      ],
    );
    const row = rows[0];
    return {
      spentCostUsd: Number(row?.spent_cost_usd ?? 0),
      reservedCostUsd: Number(row?.reserved_cost_usd ?? 0),
      researchTasks24h: Number(row?.research_tasks_24h ?? 0),
      inFlightTasks: Number(row?.in_flight_tasks ?? 0),
    };
  }

  async listTurnAgentTasks(turnJobId: number): Promise<TurnAgentTaskSummary[]> {
    const [rows] = await this.pool.query<AgentTaskSummaryRow[]>(
      `SELECT id, session_id, turn_job_id, capability, executor_type, status,
              input_json, output_source_id, error_code, error_message,
              attempt_count, max_attempts, created_at, completed_at
       FROM compose_agent_tasks
       WHERE turn_job_id = ?
       ORDER BY created_at ASC, id ASC`,
      [turnJobId],
    );
    return rows.map((row) => this.mapTurnAgentTaskSummary(row));
  }

  async parkTurnForResearch(
    input: ParkTurnForResearchInput,
  ): Promise<ParkTurnForResearchResult | null> {
    if (input.tasks.length === 0) {
      throw new Error("research_tasks_required");
    }
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [jobRows] = await connection.query<TurnJobRow[]>(
        `SELECT id, session_id, turn_kind, user_message_id, status,
                request_hash, lease_generation, active_worker_id,
                research_round_count, max_research_rounds,
                (lease_until >= CURRENT_TIMESTAMP(3)) AS lease_active
         FROM compose_turn_jobs
         WHERE id = ?
           AND session_id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.turnJobId, input.sessionId],
      );
      const job = jobRows[0];
      if (!job) {
        throw new Error(`Compose turn job ${input.turnJobId} was not found`);
      }
      const leaseMatches =
        job.active_worker_id === input.lease.workerId &&
        Number(job.lease_generation) === input.lease.leaseGeneration &&
        job.status === "running" &&
        Boolean(Number(job.lease_active));
      if (!leaseMatches) {
        await connection.commit();
        return null;
      }
      if (
        Number(job.research_round_count ?? 0) >=
        Number(job.max_research_rounds ?? 3)
      ) {
        throw new Error("coordinator_decision_rejected:max_research_rounds");
      }

      const [sessionRows] = await connection.query<SessionArchiveRow[]>(
        `SELECT id, status, archived_at
         FROM compose_sessions
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      if (session.status === "archived" || session.archived_at !== null) {
        await connection.query(
          `UPDATE compose_turn_jobs
           SET status = 'cancelled',
               cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
               error_code = 'session_archived',
               error_message = 'Session archived before research dispatch was saved',
               active_worker_id = NULL,
               lease_until = NULL,
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?
             AND status NOT IN ('completed', 'cancelled', 'abandoned')`,
          [input.turnJobId],
        );
        await connection.commit();
        return {
          parked: false,
          agentTaskIds: [],
          discardedDueToArchive: true,
        };
      }

      const agentTaskIds: number[] = [];
      const requestId = currentSpecFactoryCorrelation().requestId ?? null;
      for (const task of input.tasks) {
        const priority = Number.isFinite(task.priority)
          ? Math.trunc(task.priority as number)
          : DEFAULT_AGENT_TASK_PRIORITY;
        const maxAttempts = Number.isFinite(task.maxAttempts)
          ? Math.max(1, Math.trunc(task.maxAttempts as number))
          : DEFAULT_AGENT_TASK_MAX_ATTEMPTS;
        const [taskResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_agent_tasks
           (session_id, turn_job_id, capability, executor_type, request_id,
            priority, input_json, max_attempts, output_source_id)
           SELECT ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?
           FROM compose_sessions
           WHERE id = ?
             AND status <> 'archived'
           LIMIT 1`,
          [
            input.sessionId,
            input.turnJobId,
            task.capability,
            task.executorType ?? null,
            task.requestId ?? requestId,
            priority,
            JSON.stringify(task.input ?? null),
            maxAttempts,
            task.outputSourceId ?? null,
            input.sessionId,
          ],
        );
        if ((taskResult.affectedRows ?? 1) !== 1) {
          throw new Error(`Compose session ${input.sessionId} was not found`);
        }
        agentTaskIds.push(taskResult.insertId);
      }

      const [parkResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_turn_jobs
         SET status = 'waiting_on_research',
             research_round_count = research_round_count + 1,
             active_worker_id = NULL,
             lease_until = NULL,
             error_code = NULL,
             error_message = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'running'`,
        [input.turnJobId],
      );
      if (parkResult.affectedRows !== 1) {
        throw new Error(`Compose turn job ${input.turnJobId} was not parked`);
      }

      await connection.commit();
      for (const task of input.tasks) {
        specFactoryMetrics.recordWorkAccepted({
          workType: "agent_task",
          subtype: task.capability,
        });
      }
      return { parked: true, agentTaskIds };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async parkTurnForClarification(
    input: ParkTurnForClarificationInput,
  ): Promise<ParkTurnForClarificationResult | null> {
    const question = input.question.trim();
    if (!question) {
      throw new Error("clarification_question_required");
    }
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [jobRows] = await connection.query<TurnJobRow[]>(
        `SELECT id, session_id, turn_kind, user_message_id, status,
                request_hash, lease_generation, active_worker_id,
                (lease_until >= CURRENT_TIMESTAMP(3)) AS lease_active
         FROM compose_turn_jobs
         WHERE id = ?
           AND session_id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.turnJobId, input.sessionId],
      );
      const job = jobRows[0];
      if (!job) {
        throw new Error(`Compose turn job ${input.turnJobId} was not found`);
      }
      const leaseMatches =
        job.active_worker_id === input.lease.workerId &&
        Number(job.lease_generation) === input.lease.leaseGeneration &&
        job.status === "running" &&
        Boolean(Number(job.lease_active));
      if (!leaseMatches) {
        await connection.commit();
        return null;
      }

      const [sessionRows] = await connection.query<SessionArchiveRow[]>(
        `SELECT id, status, archived_at
         FROM compose_sessions
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      if (session.status === "archived" || session.archived_at !== null) {
        await connection.query(
          `UPDATE compose_turn_jobs
           SET status = 'cancelled',
               cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
               error_code = 'session_archived',
               error_message = 'Session archived before clarification was saved',
               active_worker_id = NULL,
               lease_until = NULL,
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?
             AND status NOT IN ('completed', 'cancelled', 'abandoned')`,
          [input.turnJobId],
        );
        await connection.commit();
        return {
          parked: false,
          assistantMessageId: null,
          discardedDueToArchive: true,
        };
      }

      const [messageResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_session_messages
           (session_id, role, content, turn_job_id, context_version_used,
            message_kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          "assistant",
          question,
          input.turnJobId,
          input.contextVersionUsed ?? null,
          "clarification_question",
        ],
      );
      const [parkResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_turn_jobs
         SET status = 'awaiting_user_input',
             context_version_used = ?,
             clarification_expires_at = ?,
             active_worker_id = NULL,
             lease_until = NULL,
             error_code = NULL,
             error_message = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'running'`,
        [input.contextVersionUsed ?? null, input.expiresAt, input.turnJobId],
      );
      if (parkResult.affectedRows !== 1) {
        throw new Error(
          `Compose turn job ${input.turnJobId} was not parked for clarification`,
        );
      }

      await connection.commit();
      return { parked: true, assistantMessageId: messageResult.insertId };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async answerAwaitingClarification(
    input: AnswerAwaitingClarificationInput,
  ): Promise<AnswerAwaitingClarificationResult | null> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("clarification_answer_required");
    }
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        return null;
      }

      const existingAnswer = await this.findClarificationAnswerByIdempotency(
        connection,
        {
          sessionId: input.sessionId,
          idempotencyKey: input.idempotencyKey,
        },
      );
      if (existingAnswer) {
        const result = this.clarificationAnswerFromExisting(
          existingAnswer,
          content,
        );
        await connection.commit();
        return result;
      }

      const [rows] = await connection.query<AwaitingClarificationTurnRow[]>(
        `SELECT j.id, j.session_id, j.user_message_id, j.status,
                j.clarification_expires_at,
                j.clarification_answer_message_id,
                j.clarification_answer_idempotency_key,
                j.context_version_used
         FROM compose_turn_jobs j
         WHERE j.session_id = ?
           AND j.status = 'awaiting_user_input'
         ORDER BY j.updated_at DESC, j.id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const turn = rows[0];
      if (!turn) {
        await connection.commit();
        return null;
      }

      const expiresAt =
        turn.clarification_expires_at === null
          ? null
          : new Date(turn.clarification_expires_at);
      if (
        expiresAt &&
        Number.isFinite(expiresAt.getTime()) &&
        expiresAt < new Date()
      ) {
        await connection.query(
          `UPDATE compose_turn_jobs
           SET status = 'abandoned',
               active_worker_id = NULL,
               lease_until = NULL,
               error_code = 'clarification_expired',
               error_message = 'Clarification expired before the user answered',
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?
             AND status = 'awaiting_user_input'`,
          [turn.id],
        );
        await connection.commit();
        return {
          answered: false,
          expiredTurnId: Number(turn.id),
        };
      }

      const [messageResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_session_messages
           (session_id, role, content, turn_job_id, message_kind,
            clarification_idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          "user",
          content,
          Number(turn.id),
          "clarification_answer",
          input.idempotencyKey,
        ],
      );
      const [updateResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_turn_jobs
         SET status = 'queued',
             clarification_answer_message_id = ?,
             clarification_answer_idempotency_key = ?,
             active_worker_id = NULL,
             lease_until = NULL,
             attempt_count = 0,
             error_code = NULL,
             error_message = NULL,
             started_at = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'awaiting_user_input'`,
        [messageResult.insertId, input.idempotencyKey, Number(turn.id)],
      );
      if (updateResult.affectedRows !== 1) {
        throw new Error(
          `Compose turn job ${turn.id} was not requeued after clarification`,
        );
      }

      const conversationPatch = buildConversationContextPatch({
        turnJobId: Number(turn.id),
        userMessageId: messageResult.insertId,
        userMessage: content,
        assistantMessage: "",
        clarificationAnswer: true,
      });
      if (conversationPatch) {
        const [patchResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_context_patches
             (session_id, turn_job_id, base_context_version, schema_version,
              patch_kind, idempotency_key, message_ids_json, status, patch_json)
             VALUES (?, ?, ?, 4, 'conversation', ?, CAST(? AS JSON), 'ready',
                     CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
          [
            input.sessionId,
            Number(turn.id),
            dbNumberOrNull(turn.context_version_used),
            `turn:${turn.id}:clarification:${messageResult.insertId}:v4`,
            JSON.stringify([messageResult.insertId]),
            JSON.stringify(conversationPatch),
          ],
        );
        await connection.query(
          `UPDATE compose_sessions
           SET context_status = 'patch_ready',
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?
             AND status <> 'archived'`,
          [input.sessionId],
        );
        await connection.query(
          `INSERT INTO compose_agent_tasks
           (session_id, turn_job_id, capability, executor_type, request_id,
            priority, input_json, max_attempts)
           SELECT ?, ?, 'context_merge', 'context_merge', ?, 90,
                  CAST(? AS JSON), 3
           WHERE NOT EXISTS (
             SELECT 1 FROM compose_agent_tasks
             WHERE session_id = ?
               AND capability = 'context_merge'
               AND status IN ('queued', 'running')
           )`,
          [
            input.sessionId,
            Number(turn.id),
            currentSpecFactoryCorrelation().requestId ?? null,
            JSON.stringify({
              sessionId: input.sessionId,
              triggerPatchId: patchResult.insertId,
            }),
            input.sessionId,
          ],
        );
      }

      await connection.commit();
      return {
        answered: true,
        turnJobId: Number(turn.id),
        messageId: messageResult.insertId,
        status: "queued",
        userMessageId: dbNumberOrNull(turn.user_message_id),
        deduplicated: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async expireStaleClarificationTurns(input: {
    expiredBefore: Date;
    limit: number;
  }): Promise<ExpiredClarificationTurn[]> {
    const requestedLimit = Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : 100;
    const limit = Math.max(1, Math.min(500, requestedLimit));
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<ExpiredClarificationTurnRow[]>(
        `SELECT j.id, j.session_id
         FROM compose_turn_jobs j
         JOIN compose_sessions s
           ON s.id = j.session_id
          AND s.status <> 'archived'
         WHERE j.status = 'awaiting_user_input'
           AND j.clarification_expires_at IS NOT NULL
           AND j.clarification_expires_at < ?
         ORDER BY j.clarification_expires_at ASC, j.id ASC
         LIMIT ?
         FOR UPDATE`,
        [input.expiredBefore, limit],
      );
      if (rows.length === 0) {
        await connection.commit();
        return [];
      }

      const ids = rows.map((row) => Number(row.id));
      const placeholders = ids.map(() => "?").join(", ");
      await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_turn_jobs
         SET status = 'abandoned',
             active_worker_id = NULL,
             lease_until = NULL,
             error_code = 'clarification_expired',
             error_message = 'Clarification expired before the user answered',
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id IN (${placeholders})
           AND status = 'awaiting_user_input'`,
        ids,
      );
      await connection.commit();
      return rows.map((row) => ({
        turnJobId: Number(row.id),
        sessionId: Number(row.session_id),
      }));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimNextAgentTask(input: {
    workerId: string;
    leaseUntil: Date;
    capabilities?: string[];
  }): Promise<ClaimedAgentTask | null> {
    const capabilities = (input.capabilities ?? [])
      .map((capability) => capability.trim())
      .filter(Boolean);
    const capabilitySql =
      capabilities.length > 0
        ? `AND t.capability IN (${capabilities.map(() => "?").join(", ")})`
        : "";
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<AgentTaskRow[]>(
        `SELECT t.id, t.session_id, t.turn_job_id, t.capability, t.executor_type,
                t.request_id, t.status, t.input_json, t.lease_generation,
                t.active_worker_id, t.updated_at
         FROM compose_agent_tasks t
         WHERE t.status = 'queued'
           AND EXISTS (
             SELECT 1
             FROM compose_sessions s
             WHERE s.id = t.session_id
               AND s.status <> 'archived'
           )
           AND (t.lease_until IS NULL OR t.lease_until < CURRENT_TIMESTAMP(3))
           ${capabilitySql}
         ORDER BY t.priority ASC, t.created_at ASC, t.id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        capabilities,
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_agent_tasks
         SET status = 'running',
             active_worker_id = ?,
             lease_generation = lease_generation + 1,
             lease_until = ?,
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'queued'`,
        [input.workerId, input.leaseUntil, row.id],
      );
      if (result.affectedRows !== 1) {
        await connection.commit();
        return null;
      }

      const [claimedRows] = await connection.query<AgentTaskRow[]>(
        `SELECT id, session_id, turn_job_id, capability, executor_type,
                request_id, status, input_json, lease_generation,
                active_worker_id
         FROM compose_agent_tasks
         WHERE id = ?
         LIMIT 1`,
        [row.id],
      );
      await connection.commit();
      return claimedRows[0]
        ? this.mapClaimedAgentTask(claimedRows[0], row.updated_at)
        : null;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async completeAgentTask(input: CompleteAgentTaskInput): Promise<boolean> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_agent_tasks
         SET status = 'completed',
             output_json = CAST(? AS JSON),
             context_version_used = ?,
             output_source_id = ?,
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND active_worker_id = ?
           AND lease_generation = ?
           AND status = 'running'
           AND lease_until >= CURRENT_TIMESTAMP(3)
           AND EXISTS (
             SELECT 1
             FROM compose_sessions s
             WHERE s.id = compose_agent_tasks.session_id
               AND s.status <> 'archived'
           )`,
        [
          JSON.stringify(input.output ?? null),
          input.contextVersionUsed ?? null,
          input.outputSourceId ?? null,
          input.agentTaskId,
          input.workerId,
          input.leaseGeneration,
        ],
      );
      if (result.affectedRows !== 1) {
        await connection.commit();
        return false;
      }
      await this.queueTurnWhenResearchTasksTerminal(
        connection,
        input.agentTaskId,
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async startAgentRuntimeRun(
    input: StartAgentRuntimeRunInput,
  ): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_agent_runtime_runs
         (session_id, agent_task_id, executor_type, workspace_uri,
          status, started_at)
       VALUES (?, ?, ?, ?, 'running', CURRENT_TIMESTAMP(3))`,
      [
        input.sessionId,
        input.agentTaskId,
        input.executorType.slice(0, 64),
        input.workspaceUri ?? null,
      ],
    );
    return result.insertId;
  }

  async finishAgentRuntimeRun(
    input: FinishAgentRuntimeRunInput,
  ): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_agent_runtime_runs
       SET status = ?,
           provider = ?,
           model = ?,
           trace_uri = ?,
           output_artifact_uri = ?,
           input_tokens = ?,
           output_tokens = ?,
           estimated_cost_usd = ?,
           error_code = ?,
           error_message = ?,
           completed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'running'`,
      [
        input.status,
        input.provider?.slice(0, 64) ?? null,
        input.model?.slice(0, 128) ?? null,
        input.traceUri ?? null,
        input.outputArtifactUri ?? null,
        numberOrNull(input.inputTokens),
        numberOrNull(input.outputTokens),
        numberOrNull(input.estimatedCostUsd),
        input.errorCode?.slice(0, 128) ?? null,
        input.errorMessage?.slice(0, 2048) ?? null,
        input.runtimeRunId,
      ],
    );
    return result.affectedRows === 1;
  }

  async confirmAgentTaskLease(input: {
    agentTaskId: number;
    workerId: string;
    leaseGeneration: number;
  }): Promise<boolean> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number }>
    >(
      `SELECT t.id
       FROM compose_agent_tasks t
       JOIN compose_sessions s ON s.id = t.session_id
       WHERE t.id = ?
         AND t.active_worker_id = ?
         AND t.lease_generation = ?
         AND t.status = 'running'
         AND t.lease_until >= CURRENT_TIMESTAMP(3)
         AND s.status <> 'archived'
       LIMIT 1`,
      [input.agentTaskId, input.workerId, input.leaseGeneration],
    );
    return rows.length === 1;
  }

  async markAgentTaskFailed(input: MarkAgentTaskFailedInput): Promise<boolean> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_agent_tasks
         SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
             error_code = ?,
             error_message = ?,
             active_worker_id = NULL,
             lease_until = NULL,
             started_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE started_at END,
             completed_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE CURRENT_TIMESTAMP(3) END,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND active_worker_id = ?
           AND lease_generation = ?
           AND status = 'running'
           AND lease_until >= CURRENT_TIMESTAMP(3)
           AND EXISTS (
             SELECT 1
             FROM compose_sessions s
             WHERE s.id = compose_agent_tasks.session_id
               AND s.status <> 'archived'
           )`,
        [
          input.errorCode.slice(0, 64),
          input.errorMessage.slice(0, 2048),
          input.agentTaskId,
          input.workerId,
          input.leaseGeneration,
        ],
      );
      if (result.affectedRows !== 1) {
        await connection.commit();
        return false;
      }
      await this.queueTurnWhenResearchTasksTerminal(
        connection,
        input.agentTaskId,
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async queueTurnWhenResearchTasksTerminal(
    connection: TransactionConnection,
    agentTaskId: number,
  ): Promise<void> {
    await connection.query(
      `UPDATE compose_turn_jobs j
       JOIN compose_agent_tasks completed
         ON completed.turn_job_id = j.id
        AND completed.id = ?
       SET j.status = 'queued',
           j.active_worker_id = NULL,
           j.lease_until = NULL,
           j.attempt_count = 0,
           j.error_code = NULL,
           j.error_message = NULL,
           j.completed_at = NULL,
           j.updated_at = CURRENT_TIMESTAMP(3)
       WHERE completed.id = ?
         AND j.status = 'waiting_on_research'
         AND NOT EXISTS (
           SELECT 1
           FROM compose_agent_tasks pending
           WHERE pending.turn_job_id = j.id
             AND pending.status IN ('queued', 'running')
         )`,
      [agentTaskId, agentTaskId],
    );
  }

  async recoverExpiredAgentTaskLeases(input: {
    expiredBefore: Date;
    limit: number;
    abandonedErrorMessage?: string;
  }): Promise<ExpiredAgentTaskLeaseRecoveryResult> {
    const requestedLimit = Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : 100;
    const limit = Math.max(1, Math.min(500, requestedLimit));
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<ExpiredAgentTaskLeaseRow[]>(
        `SELECT t.id, t.session_id, t.status, t.attempt_count, t.max_attempts
         FROM compose_agent_tasks t
         JOIN compose_sessions s ON s.id = t.session_id
         WHERE t.status = 'running'
           AND t.lease_until IS NOT NULL
           AND t.lease_until < ?
           AND s.status <> 'archived'
         ORDER BY t.lease_until ASC, t.id ASC
         LIMIT ?
         FOR UPDATE`,
        [input.expiredBefore, limit],
      );
      if (rows.length === 0) {
        await connection.commit();
        return { requeued: 0, abandoned: 0 };
      }

      const retryableRows = rows.filter(
        (row) => Number(row.attempt_count) < Number(row.max_attempts),
      );
      const exhaustedRows = rows.filter(
        (row) => Number(row.attempt_count) >= Number(row.max_attempts),
      );

      let requeued = 0;
      if (retryableRows.length > 0) {
        const placeholders = retryableRows.map(() => "?").join(", ");
        const [result] = await connection.query<mysql.ResultSetHeader>(
          `UPDATE compose_agent_tasks
           SET status = 'queued',
               active_worker_id = NULL,
               lease_until = NULL,
               error_code = NULL,
               error_message = NULL,
               started_at = NULL,
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id IN (${placeholders})
             AND status = 'running'`,
          retryableRows.map((row) => row.id),
        );
        requeued = result.affectedRows;
      }

      let abandoned = 0;
      if (exhaustedRows.length > 0) {
        const placeholders = exhaustedRows.map(() => "?").join(", ");
        const [result] = await connection.query<mysql.ResultSetHeader>(
          `UPDATE compose_agent_tasks
           SET status = 'abandoned',
               active_worker_id = NULL,
               lease_until = NULL,
               error_code = 'lease_expired',
               error_message = ?,
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id IN (${placeholders})
             AND status = 'running'`,
          [
            (
              input.abandonedErrorMessage ??
              "Agent task lease expired before completion"
            ).slice(0, 2048),
            ...exhaustedRows.map((row) => row.id),
          ],
        );
        abandoned = result.affectedRows;
        for (const row of exhaustedRows) {
          await this.queueTurnWhenResearchTasksTerminal(
            connection,
            Number(row.id),
          );
        }
      }

      await connection.commit();
      return { requeued, abandoned };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markTurnJobRunning(input: {
    turnJobId: number;
    workerId: string;
    leaseUntil: Date;
  }): Promise<{ leaseGeneration: number } | null> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_turn_jobs
       SET status = 'running',
           active_worker_id = ?,
           lease_generation = lease_generation + 1,
           lease_until = ?,
           attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'queued'
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_turn_jobs.session_id
             AND s.status <> 'archived'
         )`,
      [input.workerId, input.leaseUntil, input.turnJobId],
    );
    if (result.affectedRows !== 1) return null;
    const [rows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & { id: number; lease_generation: number | string }
      >
    >(
      `SELECT id, lease_generation
       FROM compose_turn_jobs
       WHERE id = ?
       LIMIT 1`,
      [input.turnJobId],
    );
    const row = rows[0];
    return row ? { leaseGeneration: Number(row.lease_generation) } : null;
  }

  async markTurnJobFailed(input: {
    turnJobId: number;
    errorMessage: string;
    lease?: { workerId: string; leaseGeneration: number };
  }): Promise<boolean> {
    const params: Array<string | number> = [
      input.errorMessage.slice(0, 2048),
      input.turnJobId,
    ];
    let leasePredicate = "";
    if (input.lease) {
      leasePredicate = `
         AND j.active_worker_id = ?
         AND j.lease_generation = ?
         AND j.status IN ('running', 'waiting_on_research', 'synthesizing')
         AND (j.lease_until IS NULL OR j.lease_until >= CURRENT_TIMESTAMP(3))`;
      params.push(input.lease.workerId, input.lease.leaseGeneration);
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_turn_jobs j
       JOIN compose_sessions s ON s.id = j.session_id
       SET j.status = 'failed',
           j.error_code = 'legacy_executor_failed',
           j.error_message = ?,
           j.completed_at = CURRENT_TIMESTAMP(3),
           j.updated_at = CURRENT_TIMESTAMP(3)
       WHERE j.id = ?
         AND s.status <> 'archived'
         AND j.status NOT IN ('completed', 'cancelled', 'abandoned')${leasePredicate}`,
      params,
    );
    return result.affectedRows === 1;
  }

  async claimNextTurnJob(input: {
    workerId: string;
    leaseUntil: Date;
  }): Promise<ClaimedTurnJob | null> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<TurnJobRow[]>(
        `SELECT j.id, j.session_id, j.turn_kind, j.user_message_id, j.status,
                j.request_hash, j.request_id, j.lease_generation,
                j.active_worker_id, j.requested_context_version,
                j.context_version_used, s.latest_context_version, j.updated_at
         FROM compose_turn_jobs j
         JOIN compose_sessions s ON s.id = j.session_id
         WHERE j.status = 'queued'
           AND s.status <> 'archived'
           AND j.attempt_count < j.max_attempts
           AND (j.lease_until IS NULL OR j.lease_until < CURRENT_TIMESTAMP(3))
           AND NOT EXISTS (
             SELECT 1
             FROM compose_turn_jobs active
             WHERE active.session_id = j.session_id
               AND active.id <> j.id
               AND active.status IN ('running', 'waiting_on_research',
                                     'awaiting_user_input', 'synthesizing')
               AND (active.lease_until IS NULL
                    OR active.lease_until > CURRENT_TIMESTAMP(3))
           )
         ORDER BY j.created_at ASC, j.id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_turn_jobs
         SET status = 'running',
             active_worker_id = ?,
             lease_generation = lease_generation + 1,
             lease_until = ?,
             context_version_used = ?,
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'queued'`,
        [
          input.workerId,
          input.leaseUntil,
          dbNumberOrNull(row.latest_context_version),
          row.id,
        ],
      );
      if (result.affectedRows !== 1) {
        await connection.commit();
        return null;
      }

      const [claimedRows] = await connection.query<TurnJobRow[]>(
        `SELECT id, session_id, turn_kind, user_message_id, status,
                request_hash, request_id, requested_context_version,
                context_version_used, lease_generation, active_worker_id
         FROM compose_turn_jobs
         WHERE id = ?
         LIMIT 1`,
        [row.id],
      );
      await connection.commit();
      return claimedRows[0]
        ? this.mapClaimedTurnJob(claimedRows[0], row.updated_at)
        : null;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async renewTurnLease(input: {
    turnJobId: number;
    workerId: string;
    leaseGeneration: number;
    leaseUntil: Date;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_turn_jobs j
       JOIN compose_sessions s ON s.id = j.session_id
       SET j.lease_until = ?,
           j.updated_at = CURRENT_TIMESTAMP(3)
       WHERE j.id = ?
         AND s.status <> 'archived'
         AND j.active_worker_id = ?
         AND j.lease_generation = ?
         AND j.status IN ('running', 'waiting_on_research', 'synthesizing')
         AND j.lease_until >= CURRENT_TIMESTAMP(3)`,
      [
        input.leaseUntil,
        input.turnJobId,
        input.workerId,
        input.leaseGeneration,
      ],
    );
    return result.affectedRows === 1;
  }

  async confirmTurnLease(input: {
    turnJobId: number;
    workerId: string;
    leaseGeneration: number;
  }): Promise<boolean> {
    const [rows] = await this.pool.query<TurnJobRow[]>(
      `SELECT j.id, j.session_id, j.turn_kind, j.user_message_id, j.status,
              j.request_hash, j.lease_generation, j.active_worker_id
       FROM compose_turn_jobs j
       JOIN compose_sessions s ON s.id = j.session_id
       WHERE j.id = ?
         AND s.status <> 'archived'
         AND j.active_worker_id = ?
         AND j.lease_generation = ?
         AND j.status IN ('running', 'waiting_on_research', 'synthesizing')
         AND j.lease_until >= CURRENT_TIMESTAMP(3)
       LIMIT 1`,
      [input.turnJobId, input.workerId, input.leaseGeneration],
    );
    return rows.length === 1;
  }

  async recoverExpiredTurnLeases(input: {
    expiredBefore: Date;
    limit: number;
    abandonedErrorMessage?: string;
  }): Promise<ExpiredTurnLeaseRecoveryResult> {
    const requestedLimit = Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : 100;
    const limit = Math.max(1, Math.min(500, requestedLimit));
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<ExpiredTurnLeaseRow[]>(
        `SELECT j.id, j.session_id, j.status, j.attempt_count, j.max_attempts,
                o.turn_job_id AS output_turn_job_id
         FROM compose_turn_jobs j
         JOIN compose_sessions s ON s.id = j.session_id
         LEFT JOIN compose_turn_outputs o ON o.turn_job_id = j.id
         WHERE j.status IN ('running', 'waiting_on_research', 'synthesizing')
           AND j.lease_until IS NOT NULL
           AND j.lease_until < ?
           AND s.status <> 'archived'
         ORDER BY j.lease_until ASC, j.id ASC
         LIMIT ?
         FOR UPDATE`,
        [input.expiredBefore, limit],
      );
      if (rows.length === 0) {
        await connection.commit();
        return { requeued: 0, abandoned: 0, skippedWithOutput: 0 };
      }

      const pendingRows = rows.filter((row) => row.output_turn_job_id == null);
      const skippedWithOutput = rows.length - pendingRows.length;
      const retryableRows = pendingRows.filter(
        (row) => Number(row.attempt_count) < Number(row.max_attempts),
      );
      const exhaustedRows = pendingRows.filter(
        (row) => Number(row.attempt_count) >= Number(row.max_attempts),
      );

      let requeued = 0;
      if (retryableRows.length > 0) {
        const placeholders = retryableRows.map(() => "?").join(", ");
        const [result] = await connection.query<mysql.ResultSetHeader>(
          `UPDATE compose_turn_jobs
           SET status = 'queued',
               active_worker_id = NULL,
               lease_until = NULL,
               error_code = NULL,
               error_message = NULL,
               started_at = NULL,
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id IN (${placeholders})
             AND status IN ('running', 'waiting_on_research', 'synthesizing')`,
          retryableRows.map((row) => row.id),
        );
        requeued = result.affectedRows;
      }

      let abandoned = 0;
      if (exhaustedRows.length > 0) {
        const placeholders = exhaustedRows.map(() => "?").join(", ");
        const [result] = await connection.query<mysql.ResultSetHeader>(
          `UPDATE compose_turn_jobs
           SET status = 'abandoned',
               active_worker_id = NULL,
               lease_until = NULL,
               error_code = 'lease_expired',
               error_message = ?,
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id IN (${placeholders})
             AND status IN ('running', 'waiting_on_research', 'synthesizing')`,
          [
            (
              input.abandonedErrorMessage ??
              "Turn lease expired before completion"
            ).slice(0, 2048),
            ...exhaustedRows.map((row) => row.id),
          ],
        );
        abandoned = result.affectedRows;
      }

      const affectedSessionIds = [
        ...new Set(pendingRows.map((row) => Number(row.session_id))),
      ];
      if (affectedSessionIds.length > 0) {
        const placeholders = affectedSessionIds.map(() => "?").join(", ");
        await connection.query(
          `UPDATE compose_sessions s
           SET active_turn_started_at = NULL
           WHERE s.id IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1
               FROM compose_turn_jobs active
               WHERE active.session_id = s.id
                 AND active.status IN ('running', 'waiting_on_research',
                                       'synthesizing')
                 AND (active.lease_until IS NULL
                      OR active.lease_until >= CURRENT_TIMESTAMP(3))
             )`,
          affectedSessionIds,
        );
      }

      await connection.commit();
      return { requeued, abandoned, skippedWithOutput };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async completeTurnWithAssistantMessage(
    input: CompleteTurnWithAssistantMessageInput,
  ): Promise<CompleteTurnWithAssistantMessageResult | null> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [jobRows] = await connection.query<TurnJobRow[]>(
        `SELECT id, session_id, turn_kind, user_message_id, status,
                request_hash, lease_generation, active_worker_id
         FROM compose_turn_jobs
         WHERE id = ?
           AND session_id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.turnJobId, input.sessionId],
      );
      if (!jobRows[0]) {
        throw new Error(`Compose turn job ${input.turnJobId} was not found`);
      }
      if (input.lease) {
        const job = jobRows[0];
        const leaseMatches =
          job.active_worker_id === input.lease.workerId &&
          Number(job.lease_generation) === input.lease.leaseGeneration &&
          ["running", "waiting_on_research", "synthesizing"].includes(
            job.status,
          );
        if (!leaseMatches) {
          await connection.commit();
          return null;
        }
      }

      const [sessionRows] = await connection.query<SessionArchiveRow[]>(
        `SELECT id, status, archived_at
         FROM compose_sessions
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      if (session.status === "archived" || session.archived_at !== null) {
        await connection.query(
          `UPDATE compose_turn_jobs
           SET status = 'cancelled',
               cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
               error_code = 'session_archived',
               error_message = 'Session archived before final response was saved',
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?
             AND status NOT IN ('completed', 'cancelled', 'abandoned')`,
          [input.turnJobId],
        );
        await connection.commit();
        return {
          assistantMessageId: null,
          deduplicated: false,
          discardedDueToArchive: true,
        };
      }

      const [outputRows] = await connection.query<TurnOutputRow[]>(
        `SELECT turn_job_id, assistant_message_id
         FROM compose_turn_outputs
         WHERE turn_job_id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.turnJobId],
      );
      const existingOutput = outputRows[0];
      if (existingOutput) {
        await connection.commit();
        return {
          assistantMessageId: Number(existingOutput.assistant_message_id),
          deduplicated: true,
        };
      }

      const [messageResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_session_messages
           (session_id, role, content, turn_job_id, context_version_used,
            message_kind)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          "assistant",
          input.content,
          input.turnJobId,
          input.contextVersionUsed ?? null,
          "final",
        ],
      );
      const payloadJson =
        input.finalPayload === undefined
          ? null
          : JSON.stringify(input.finalPayload);
      await connection.query(
        `INSERT INTO compose_turn_outputs
         (turn_job_id, session_id, assistant_message_id, context_version_used,
          final_payload_json)
         VALUES (?, ?, ?, ?, CAST(? AS JSON))`,
        [
          input.turnJobId,
          input.sessionId,
          messageResult.insertId,
          input.contextVersionUsed ?? null,
          payloadJson,
        ],
      );
      if (input.conversationPatch) {
        const patchRecord =
          input.conversationPatch.patch &&
          typeof input.conversationPatch.patch === "object"
            ? {
                ...(input.conversationPatch.patch as Record<string, unknown>),
              }
            : {};
        const messageIds = [
          ...new Set([
            ...(input.conversationPatch.messageIds ?? []),
            messageResult.insertId,
          ]),
        ];
        patchRecord.provenance = {
          ...(patchRecord.provenance &&
          typeof patchRecord.provenance === "object"
            ? (patchRecord.provenance as Record<string, unknown>)
            : {}),
          turnJobId: input.turnJobId,
          messageIds,
        };
        const [patchResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_context_patches
             (session_id, turn_job_id, base_context_version, schema_version,
              patch_kind, idempotency_key, message_ids_json, status, patch_json)
             VALUES (?, ?, ?, 4, 'conversation', ?, CAST(? AS JSON), 'ready',
                     CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
          [
            input.sessionId,
            input.turnJobId,
            input.contextVersionUsed ?? null,
            `turn:${input.turnJobId}:conversation:v4`,
            JSON.stringify(messageIds),
            JSON.stringify(patchRecord),
          ],
        );
        await connection.query(
          `UPDATE compose_sessions
           SET context_status = 'patch_ready',
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?
             AND status <> 'archived'`,
          [input.sessionId],
        );
        await connection.query(
          `INSERT INTO compose_agent_tasks
           (session_id, capability, executor_type, request_id, priority,
            input_json, max_attempts)
           SELECT ?, 'context_merge', 'context_merge', ?, 90,
                  CAST(? AS JSON), 3
           WHERE NOT EXISTS (
             SELECT 1
             FROM compose_agent_tasks
             WHERE session_id = ?
               AND capability = 'context_merge'
               AND status IN ('queued', 'running')
           )`,
          [
            input.sessionId,
            currentSpecFactoryCorrelation().requestId ?? null,
            JSON.stringify({
              sessionId: input.sessionId,
              triggerPatchId: patchResult.insertId,
            }),
            input.sessionId,
          ],
        );
      }
      await connection.query(
        `UPDATE compose_turn_jobs
         SET status = 'completed',
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [input.turnJobId],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "turn",
        aggregateId: input.turnJobId,
        eventType: "turn.completed",
        dedupeKey: `turn:${input.turnJobId}:completed`,
        payload: {
          sessionId: input.sessionId,
          turnJobId: input.turnJobId,
          assistantMessageId: messageResult.insertId,
          contextVersionUsed: input.contextVersionUsed ?? null,
        },
      });
      await connection.commit();
      return {
        assistantMessageId: messageResult.insertId,
        deduplicated: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getSession(sessionId: number): Promise<ComposeSessionSummary | null> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT s.id, s.name, s.created_by, s.created_by_display, s.status,
              s.claude_session_id, s.source_id, s.readiness_json,
              s.agent_persona_key, s.agent_persona_name, s.last_active_at,
              s.last_action, s.last_actor, s.active_turn_started_at,
              s.latest_context_version, s.context_status,
              s.password_hash, s.s3_prefix, s.workspace_path,
              s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM compose_session_sources cs
                WHERE cs.session_id = s.id
                  AND cs.deleted_at IS NULL) AS source_count
       FROM compose_sessions s
       WHERE s.id = ?
       LIMIT 1`,
      [sessionId],
    );
    const row = rows[0];
    return row ? this.mapSession(row) : null;
  }

  async listSessions(): Promise<ComposeSessionSummary[]> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT s.id, s.name, s.created_by, s.created_by_display, s.status,
              s.claude_session_id, s.source_id, s.readiness_json,
              s.agent_persona_key, s.agent_persona_name, s.last_active_at,
              s.last_action, s.last_actor, s.active_turn_started_at,
              s.latest_context_version, s.context_status,
              s.password_hash, s.s3_prefix, s.workspace_path,
              s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM compose_session_sources cs
                WHERE cs.session_id = s.id
                  AND cs.deleted_at IS NULL) AS source_count
       FROM compose_sessions s
       WHERE s.status <> 'archived'
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT 200`,
    );
    return rows.map((row) => this.mapSession(row));
  }

  async getSessionPasswordHash(sessionId: number): Promise<string | null> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { password_hash: string | null }>
    >(
      `SELECT password_hash
       FROM compose_sessions
       WHERE id = ?
       LIMIT 1`,
      [sessionId],
    );
    return rows[0]?.password_hash ?? null;
  }

  async archiveSessionWithWorkCancellation(
    sessionId: number,
  ): Promise<ArchiveSessionWithWorkCancellationResult> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        return {
          archived: false,
          cancelledTurnJobIds: [],
          cancelledAgentTaskIds: [],
        };
      }

      const [turnRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_turn_jobs
         WHERE session_id = ?
           AND status IN ('queued', 'running', 'waiting_on_research',
                          'awaiting_user_input', 'synthesizing')
         FOR UPDATE`,
        [sessionId],
      );
      const cancelledTurnJobIds = turnRows.map((row) => dbNumber(row.id));
      await connection.query(
        `UPDATE compose_turn_jobs
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'session_archived',
             error_message = 'Session archived before turn completed',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND status IN ('queued', 'running', 'waiting_on_research',
                          'awaiting_user_input', 'synthesizing')`,
        [sessionId],
      );

      const [taskRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_agent_tasks
         WHERE session_id = ?
           AND status IN ('queued', 'running')
         FOR UPDATE`,
        [sessionId],
      );
      const cancelledAgentTaskIds = taskRows.map((row) => dbNumber(row.id));
      await connection.query(
        `UPDATE compose_agent_tasks
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'session_archived',
             error_message = 'Session archived before task completed',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND status IN ('queued', 'running')`,
        [sessionId],
      );

      const [archiveResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_sessions
         SET status = 'archived',
             archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP(3))
         WHERE id = ?`,
        [sessionId],
      );
      await connection.commit();
      return {
        archived: archiveResult.affectedRows === 1,
        cancelledTurnJobIds,
        cancelledAgentTaskIds,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async cancelTurnJob(
    input: CancelTurnJobInput,
  ): Promise<CancelTurnJobResult | null> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [turnRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            status: ComposeTurnJobStatus;
          }
        >
      >(
        `SELECT id, status
         FROM compose_turn_jobs
         WHERE id = ?
           AND session_id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.turnJobId, input.sessionId],
      );
      const turn = turnRows[0];
      if (!turn) {
        await connection.commit();
        return null;
      }
      const cancellableStatuses: ComposeTurnJobStatus[] = [
        "queued",
        "running",
        "waiting_on_research",
        "awaiting_user_input",
        "synthesizing",
      ];
      if (!cancellableStatuses.includes(turn.status)) {
        await connection.commit();
        return {
          cancelled: false,
          cancelledAgentTaskIds: [],
          status: turn.status,
        };
      }

      const [taskRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_agent_tasks
         WHERE turn_job_id = ?
           AND session_id = ?
           AND status IN ('queued', 'running')
         FOR UPDATE`,
        [input.turnJobId, input.sessionId],
      );
      const cancelledAgentTaskIds = taskRows.map((row) => dbNumber(row.id));
      await connection.query(
        `UPDATE compose_agent_tasks
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'operator_cancelled',
             error_message = 'Turn cancelled by operator',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE turn_job_id = ?
           AND session_id = ?
           AND status IN ('queued', 'running')`,
        [input.turnJobId, input.sessionId],
      );

      await connection.query(
        `UPDATE compose_turn_jobs
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'operator_cancelled',
             error_message = 'Turn cancelled by operator',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND session_id = ?
           AND status IN ('queued', 'running', 'waiting_on_research',
                          'awaiting_user_input', 'synthesizing')`,
        [input.turnJobId, input.sessionId],
      );

      await connection.commit();
      return {
        cancelled: true,
        cancelledAgentTaskIds,
        status: "cancelled",
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listArchivedSessionsForWorkspaceCleanup(input: {
    archivedBefore: Date;
    limit: number;
  }): Promise<ComposeWorkspaceCleanupCandidate[]> {
    const requestedLimit = Number.isFinite(input.limit)
      ? Math.floor(input.limit)
      : 50;
    const limit = Math.max(1, Math.min(500, requestedLimit));
    const [rows] = await this.pool.query<WorkspaceCleanupRow[]>(
      `SELECT id, name, s3_prefix, workspace_path, archived_at
       FROM compose_sessions
       WHERE status = 'archived'
         AND archived_at IS NOT NULL
         AND archived_at < ?
         AND workspace_cleaned_at IS NULL
       ORDER BY archived_at ASC, id ASC
       LIMIT ?`,
      [input.archivedBefore, limit],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      s3Prefix: row.s3_prefix,
      workspacePath: row.workspace_path,
      archivedAt: toIso(row.archived_at),
    }));
  }

  async markWorkspaceCleaned(sessionId: number): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET workspace_cleaned_at = CURRENT_TIMESTAMP(3),
           workspace_cleanup_error = NULL
       WHERE id = ?`,
      [sessionId],
    );
  }

  async markWorkspaceCleanupFailed(input: {
    sessionId: number;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET workspace_cleanup_error = ?
       WHERE id = ?`,
      [input.errorMessage.slice(0, 8000), input.sessionId],
    );
  }

  async findSessionBySourceId(
    sourceId: number,
  ): Promise<ComposeSessionSummary | null> {
    const [rows] = await this.pool.query<SessionRow[]>(
      `SELECT s.id, s.name, s.created_by, s.created_by_display, s.status,
              s.claude_session_id, s.source_id, s.readiness_json,
              s.agent_persona_key, s.agent_persona_name, s.last_active_at,
              s.last_action, s.last_actor, s.active_turn_started_at,
              s.password_hash, s.s3_prefix, s.workspace_path,
              s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM compose_session_sources cs
                WHERE cs.session_id = s.id
                  AND cs.deleted_at IS NULL) AS source_count
       FROM compose_sessions s
       WHERE s.source_id = ?
       LIMIT 1`,
      [sourceId],
    );
    const row = rows[0];
    return row ? this.mapSession(row) : null;
  }

  async addNoteSource(input: {
    sessionId: number;
    filename: string;
    content: string;
  }): Promise<number> {
    const intelligence = deriveComposeSourceIntelligence({
      kind: "note",
      filename: input.filename,
      markdown: input.content,
    });
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, request_id, kind, original_filename, converter, conversion_status,
        markdown_content, source_summary, source_entities_json, source_usefulness,
        source_contribution)
       SELECT ?, ?, 'note', ?, 'none', 'converted', ?, ?, CAST(? AS JSON), ?, ?
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1`,
      [
        input.sessionId,
        currentSpecFactoryCorrelation().requestId ?? null,
        input.filename,
        input.content,
        intelligence.summary,
        JSON.stringify(intelligence.entities),
        intelligence.usefulness,
        intelligence.contribution,
        input.sessionId,
      ],
    );
    return insertedSourceIdForActiveSession(result, input.sessionId);
  }

  async createJiraSource(input: {
    sessionId: number;
    jiraKey: string;
    title: string;
    sourceUrl: string;
    markdownContent: string;
  }): Promise<number> {
    const intelligence = deriveComposeSourceIntelligence({
      kind: "jira",
      filename: input.title || input.jiraKey,
      markdown: input.markdownContent,
    });
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, request_id, kind, original_filename, source_url, converter, conversion_status,
        markdown_content, source_summary, source_entities_json, source_usefulness,
        source_contribution)
       SELECT ?, ?, 'jira', ?, ?, 'none', 'converted', ?, ?, CAST(? AS JSON), ?, ?
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1`,
      [
        input.sessionId,
        currentSpecFactoryCorrelation().requestId ?? null,
        input.title || input.jiraKey,
        input.sourceUrl,
        input.markdownContent,
        intelligence.summary,
        JSON.stringify(intelligence.entities),
        intelligence.usefulness,
        intelligence.contribution,
        input.sessionId,
      ],
    );
    return insertedSourceIdForActiveSession(result, input.sessionId);
  }

  async createConfluenceSource(input: {
    sessionId: number;
    url: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, request_id, kind, original_filename, source_url, converter, conversion_status)
       SELECT ?, ?, 'confluence', ?, ?, 'markitdown', 'pending'
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1`,
      [
        input.sessionId,
        currentSpecFactoryCorrelation().requestId ?? null,
        input.url,
        input.url,
        input.sessionId,
      ],
    );
    const sourceId = insertedSourceIdForActiveSession(result, input.sessionId);
    specFactoryMetrics.recordWorkAccepted({
      workType: "conversion",
      subtype: "confluence",
    });
    return sourceId;
  }

  async restoreConvertedSource(input: {
    sessionId: number;
    kind: ComposeSessionSourceSummary["kind"];
    originalFilename: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    sourceUrl: string | null;
    markdownContent: string;
  }): Promise<number> {
    const intelligence = deriveComposeSourceIntelligence({
      kind: input.kind,
      filename: input.originalFilename,
      markdown: input.markdownContent,
    });
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, request_id, kind, original_filename, mime_type, size_bytes, source_url,
        converter, conversion_status, markdown_content, source_summary,
        source_entities_json, source_usefulness, source_contribution)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'none', 'converted', ?, ?, CAST(? AS JSON), ?, ?
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1`,
      [
        input.sessionId,
        currentSpecFactoryCorrelation().requestId ?? null,
        input.kind,
        input.originalFilename,
        input.mimeType,
        input.sizeBytes,
        input.sourceUrl,
        input.markdownContent,
        intelligence.summary,
        JSON.stringify(intelligence.entities),
        intelligence.usefulness,
        intelligence.contribution,
        input.sessionId,
      ],
    );
    return insertedSourceIdForActiveSession(result, input.sessionId);
  }

  async createGeneratedResearchSource(
    input: CreateGeneratedResearchSourceInput,
  ): Promise<number> {
    const intelligence = deriveComposeSourceIntelligence({
      kind: "generated_research",
      filename: input.originalFilename,
      markdown: input.markdownContent,
    });
    const parentSourceIds = [
      ...new Set(
        (input.parentSourceIds ?? [])
          .map((sourceId) => Math.trunc(sourceId))
          .filter((sourceId) => Number.isFinite(sourceId) && sourceId > 0),
      ),
    ];
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      if (parentSourceIds.length > 0) {
        const placeholders = parentSourceIds.map(() => "?").join(", ");
        const [parentRows] = await connection.query<
          Array<mysql.RowDataPacket & { id: number | string }>
        >(
          `SELECT id
           FROM compose_session_sources
           WHERE session_id = ?
             AND id IN (${placeholders})
             AND deleted_at IS NULL
           ORDER BY id ASC
           FOR UPDATE`,
          [input.sessionId, ...parentSourceIds],
        );
        if (parentRows.length !== parentSourceIds.length) {
          throw new Error("generated_research_parent_source_unavailable");
        }
      }
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_session_sources
         (session_id, request_id, kind, original_filename, converter, conversion_status,
          markdown_content, source_summary, source_entities_json, source_usefulness,
          source_contribution, source_origin, generated_by_task_id,
          parent_source_ids_json, context_version_used, evidence_json, confidence,
          artifact_uri, artifact_sha256, artifact_bytes)
         VALUES (?, ?, 'generated_research', ?, 'none', 'converted', ?, ?, CAST(? AS JSON), ?, ?,
                 'agent', ?, CAST(? AS JSON), ?, CAST(? AS JSON), ?, ?, ?, ?)`,
        [
          input.sessionId,
          currentSpecFactoryCorrelation().requestId ?? null,
          input.originalFilename,
          input.markdownContent,
          intelligence.summary,
          JSON.stringify(intelligence.entities),
          intelligence.usefulness,
          intelligence.contribution,
          input.generatedByTaskId,
          JSON.stringify(parentSourceIds),
          input.contextVersionUsed ?? null,
          JSON.stringify(input.evidence ?? null),
          input.confidence ?? null,
          input.artifactUri,
          input.artifactSha256,
          input.artifactBytes,
        ],
      );
      await connection.commit();
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getGeneratedResearchSourceByTaskId(
    agentTaskId: number,
  ): Promise<ComposeSessionSourceSummary | null> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, session_id, request_id, kind, original_filename, mime_type, size_bytes,
              source_url, s3_key_raw, converter, markdown_path, markdown_content,
              source_summary, source_entities_json, source_usefulness, source_contribution,
              source_origin, generated_by_task_id, parent_source_ids_json,
              context_version_used, evidence_json, confidence, artifact_uri,
              artifact_sha256, artifact_bytes,
              current_revision_id, content_sha256,
              conversion_status, conversion_started_at, conversion_attempts,
              conversion_lease_expires_at, error_message, created_at, updated_at
       FROM compose_session_sources
       WHERE generated_by_task_id = ?
         AND kind = 'generated_research'
         AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT 1`,
      [agentTaskId],
    );
    return rows[0] ? this.mapSource(rows[0]) : null;
  }

  async createReadyContextPatch(
    input: CreateReadyContextPatchInput,
  ): Promise<number> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    let committed = false;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        committed = true;
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      if (input.sourceId != null) {
        const [sourceRows] = await connection.query<
          Array<mysql.RowDataPacket & { id: number | string }>
        >(
          `SELECT id
           FROM compose_session_sources
           WHERE id = ?
             AND session_id = ?
             AND deleted_at IS NULL
           LIMIT 1
           FOR UPDATE`,
          [input.sourceId, input.sessionId],
        );
        if (!sourceRows[0]) {
          throw new Error(
            `Compose source ${input.sourceId} is no longer active in session ${input.sessionId}`,
          );
        }
      }
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_context_patches
         (session_id, source_id, source_revision_id, agent_task_id, turn_job_id,
          base_context_version, schema_version, patch_kind, idempotency_key,
          message_ids_json, status, patch_uri, artifact_sha256, artifact_bytes,
          patch_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'ready', ?, ?, ?,
                 CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [
          input.sessionId,
          input.sourceId ?? null,
          input.sourceRevisionId ?? null,
          input.agentTaskId ?? null,
          input.turnJobId ?? null,
          input.baseContextVersion ?? null,
          input.schemaVersion ?? 4,
          input.patchKind ?? "source_distillation",
          input.idempotencyKey ?? null,
          JSON.stringify(input.messageIds ?? []),
          input.patchUri ?? null,
          input.artifactSha256 ?? null,
          input.artifactBytes ?? null,
          JSON.stringify(input.patch ?? null),
        ],
      );
      await connection.query(
        `UPDATE compose_sessions
         SET context_status = 'patch_ready',
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status <> 'archived'`,
        [input.sessionId],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "context_patch",
        aggregateId: result.insertId,
        eventType: "context.patch.created",
        dedupeKey: `context-patch:${result.insertId}:ready`,
        payload: {
          sessionId: input.sessionId,
          patchId: result.insertId,
          sourceId: input.sourceId ?? null,
          sourceRevisionId: input.sourceRevisionId ?? null,
          turnJobId: input.turnJobId ?? null,
          patchKind: input.patchKind ?? "source_distillation",
        },
      });
      await connection.commit();
      committed = true;
      return result.insertId;
    } catch (error) {
      if (!committed) {
        await connection.rollback();
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async enqueueContextMergeTaskIfNeeded(
    input: EnqueueContextMergeTaskInput,
  ): Promise<number | null> {
    const priority = Number.isFinite(input.priority)
      ? Math.trunc(input.priority as number)
      : 90;
    const maxAttempts = Number.isFinite(input.maxAttempts)
      ? Math.max(1, Math.trunc(input.maxAttempts as number))
      : DEFAULT_AGENT_TASK_MAX_ATTEMPTS;
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<SessionContextRow[]>(
        `SELECT id, latest_context_version
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
           AND EXISTS (
             SELECT 1
             FROM compose_context_patches ready_patch
             WHERE ready_patch.session_id = compose_sessions.id
               AND ready_patch.status = 'ready'
           )
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        return null;
      }

      const [existingRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number }>
      >(
        `SELECT id
         FROM compose_agent_tasks
         WHERE session_id = ?
           AND capability = 'context_merge'
           AND status IN ('queued', 'running')
         ORDER BY id ASC
         LIMIT 1`,
        [input.sessionId],
      );
      if (existingRows[0]) {
        await connection.commit();
        return null;
      }

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_agent_tasks
         (session_id, capability, executor_type, request_id, priority,
          input_json, max_attempts)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
        [
          input.sessionId,
          "context_merge",
          "context_merge",
          currentSpecFactoryCorrelation().requestId ?? null,
          priority,
          JSON.stringify({
            sessionId: input.sessionId,
            triggerPatchId: input.triggerPatchId ?? null,
          }),
          maxAttempts,
        ],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "agent_task",
        aggregateId: result.insertId,
        eventType: "task.queued",
        dedupeKey: `agent-task:${result.insertId}:queued:g1`,
        payload: {
          sessionId: input.sessionId,
          agentTaskId: result.insertId,
          capability: "context_merge",
          executorType: "context_merge",
          triggerPatchId: input.triggerPatchId ?? null,
          queueGeneration: 1,
        },
      });
      await connection.commit();
      specFactoryMetrics.recordWorkAccepted({
        workType: "agent_task",
        subtype: "context_merge",
      });
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async recoverStrandedContextMerges(
    input: {
      limit?: number;
    } = {},
  ): Promise<{ inspected: number; queued: number }> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number | string }>
    >(
      `SELECT session.id
       FROM compose_sessions session
       WHERE session.status <> 'archived'
         AND session.context_status = 'patch_ready'
         AND EXISTS (
           SELECT 1
           FROM compose_context_patches ready_patch
           WHERE ready_patch.session_id = session.id
             AND ready_patch.status = 'ready'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM compose_agent_tasks active_merge
           WHERE active_merge.session_id = session.id
             AND active_merge.capability = 'context_merge'
             AND active_merge.status IN ('queued', 'running')
         )
         AND 2 > (
           SELECT COUNT(*)
           FROM compose_agent_tasks recent_failure
           WHERE recent_failure.session_id = session.id
             AND recent_failure.capability = 'context_merge'
             AND recent_failure.status = 'failed'
             AND recent_failure.updated_at >= CURRENT_TIMESTAMP(3) - INTERVAL 1 DAY
         )
       ORDER BY session.updated_at ASC, session.id ASC
       LIMIT ?`,
      [limit],
    );
    let queued = 0;
    for (const row of rows) {
      const taskId = await this.enqueueContextMergeTaskIfNeeded({
        sessionId: Number(row.id),
      });
      if (taskId !== null) queued += 1;
    }
    return { inspected: rows.length, queued };
  }

  async beginContextVersionBuild(
    input: BeginContextVersionBuildInput,
  ): Promise<ContextVersionBuild> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<SessionContextRow[]>(
        `SELECT id, latest_context_version
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      const parentVersion = dbNumberOrNull(session.latest_context_version);
      const [existingVersionRows] = await connection.query<
        Array<mysql.RowDataPacket & { version: number | string | null }>
      >(
        `SELECT version
         FROM compose_context_versions
         WHERE session_id = ?
         ORDER BY version DESC
         LIMIT 1`,
        [input.sessionId],
      );
      const highestExistingVersion = dbNumberOrNull(
        existingVersionRows[0]?.version,
      );
      const version =
        Math.max(parentVersion ?? 0, highestExistingVersion ?? 0) + 1;
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_context_versions
         (session_id, version, schema_version, status, parent_version,
          created_by_task_id)
         VALUES (?, ?, 4, 'building', ?, ?)`,
        [
          input.sessionId,
          version,
          parentVersion,
          input.createdByTaskId ?? null,
        ],
      );
      await connection.query(
        `UPDATE compose_sessions
         SET context_status = 'building',
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status <> 'archived'`,
        [input.sessionId],
      );
      await connection.commit();
      return {
        contextVersionId: result.insertId,
        version,
        parentVersion,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async failContextVersionBuild(input: {
    sessionId: number;
    contextVersionId: number;
    version: number;
    errorMessage: string;
  }): Promise<boolean> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        return false;
      }
      const [versionResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_context_versions
         SET status = 'failed',
             error_message = ?
         WHERE id = ?
           AND session_id = ?
           AND version = ?
           AND status = 'building'`,
        [
          input.errorMessage.slice(0, 8000),
          input.contextVersionId,
          input.sessionId,
          input.version,
        ],
      );
      if (versionResult.affectedRows !== 1) {
        await connection.commit();
        return false;
      }
      await connection.query(
        `UPDATE compose_sessions
         SET context_status = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM compose_context_patches ready_patch
                 WHERE ready_patch.session_id = compose_sessions.id
                   AND ready_patch.status = 'ready'
                 LIMIT 1
               ) THEN 'patch_ready'
               WHEN latest_context_version IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM compose_context_versions committed_context
                  WHERE committed_context.session_id = compose_sessions.id
                    AND committed_context.version = compose_sessions.latest_context_version
                    AND committed_context.status = 'committed'
                  LIMIT 1
                ) THEN 'clean'
               ELSE 'dirty'
             END,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status <> 'archived'
           AND NOT EXISTS (
             SELECT 1
             FROM compose_context_versions active_build
             WHERE active_build.session_id = compose_sessions.id
               AND active_build.status = 'building'
             LIMIT 1
           )`,
        [input.sessionId],
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async commitContextVersion(
    input: CommitContextVersionInput,
  ): Promise<boolean> {
    const patchIds = Array.isArray(input.patchIds)
      ? input.patchIds
          .map((patchId) => Math.trunc(patchId))
          .filter((patchId) => Number.isFinite(patchId) && patchId > 0)
      : [];
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        return false;
      }
      const [versionResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_context_versions
         SET status = 'committed',
             artifact_uri = ?,
             structured_artifact_uri = ?,
             summary_json = CAST(? AS JSON),
             facts_json = CAST(? AS JSON),
             implementation_findings_json = CAST(? AS JSON),
             requirements_json = CAST(? AS JSON),
             constraints_json = CAST(? AS JSON),
             open_questions_json = CAST(? AS JSON),
             conflicts_json = CAST(? AS JSON),
             decisions_json = CAST(? AS JSON),
             risks_json = CAST(? AS JSON),
             source_ids_json = CAST(? AS JSON),
             patch_ids_json = CAST(? AS JSON),
             artifact_sha256 = ?,
             artifact_bytes = ?,
             committed_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND session_id = ?
           AND version = ?
           AND status = 'building'`,
        [
          input.artifactUri,
          input.structuredArtifactUri ?? null,
          JSON.stringify(input.summary ?? null),
          JSON.stringify(input.facts ?? []),
          JSON.stringify(input.implementationFindings ?? []),
          JSON.stringify(input.requirements ?? []),
          JSON.stringify(input.constraints ?? []),
          JSON.stringify(input.openQuestions ?? []),
          JSON.stringify(input.conflicts ?? []),
          JSON.stringify(input.decisions ?? []),
          JSON.stringify(input.risks ?? []),
          JSON.stringify(input.sourceIds ?? []),
          JSON.stringify(patchIds),
          input.artifactSha256,
          input.artifactBytes,
          input.contextVersionId,
          input.sessionId,
          input.version,
        ],
      );
      if (versionResult.affectedRows !== 1) {
        await connection.commit();
        return false;
      }

      if (patchIds.length > 0) {
        const placeholders = patchIds.map(() => "?").join(", ");
        await connection.query(
          `UPDATE compose_context_patches
           SET status = 'superseded',
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE session_id = ?
             AND id IN (${placeholders})
             AND status = 'ready'`,
          [input.sessionId, ...patchIds],
        );
      }

      const [sessionResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_sessions
         SET latest_context_version = ?,
             context_status = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM compose_context_patches ready_patch
                 WHERE ready_patch.session_id = compose_sessions.id
                   AND ready_patch.status = 'ready'
                 LIMIT 1
               )
               THEN 'patch_ready'
               ELSE 'clean'
             END,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status <> 'archived'
           AND (latest_context_version IS NULL OR latest_context_version < ?)`,
        [input.version, input.sessionId, input.version],
      );
      await connection.commit();
      return sessionResult.affectedRows === 1;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getLatestContextProjection(
    sessionId: number,
  ): Promise<ComposeContextProjection | null> {
    const [rows] = await this.pool.query<ContextProjectionRow[]>(
      `SELECT session_id, version, artifact_uri, structured_artifact_uri,
              summary_json, facts_json, implementation_findings_json,
              requirements_json, constraints_json, open_questions_json,
              conflicts_json, decisions_json, risks_json, source_ids_json,
              patch_ids_json, committed_at
       FROM compose_context_versions
       WHERE session_id = ?
         AND status = 'committed'
       ORDER BY version DESC, id DESC
       LIMIT 1`,
      [sessionId],
    );
    const row = rows[0];
    return row ? this.mapContextProjection(row) : null;
  }

  async getContextProjection(
    sessionId: number,
    version: number,
  ): Promise<ComposeContextProjection | null> {
    const [rows] = await this.pool.query<ContextProjectionRow[]>(
      `SELECT session_id, version, artifact_uri, structured_artifact_uri,
              summary_json, facts_json, implementation_findings_json,
              requirements_json, constraints_json, open_questions_json,
              conflicts_json, decisions_json, risks_json, source_ids_json,
              patch_ids_json, committed_at
       FROM compose_context_versions
       WHERE session_id = ?
         AND version = ?
         AND status = 'committed'
       LIMIT 1`,
      [sessionId, version],
    );
    const row = rows[0];
    return row ? this.mapContextProjection(row) : null;
  }

  async listReadyContextPatches(
    sessionId: number,
  ): Promise<ReadyContextPatch[]> {
    const [rows] = await this.pool.query<ContextPatchRow[]>(
      `SELECT id, session_id, source_id, agent_task_id, base_context_version,
              patch_uri, artifact_sha256, artifact_bytes, patch_json,
              created_at, updated_at
       FROM compose_context_patches
       WHERE session_id = ?
         AND status = 'ready'
       ORDER BY created_at ASC, id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: Number(row.session_id),
      sourceId: dbNumberOrNull(row.source_id),
      agentTaskId: dbNumberOrNull(row.agent_task_id),
      baseContextVersion: dbNumberOrNull(row.base_context_version),
      patchUri: row.patch_uri,
      artifactSha256: row.artifact_sha256,
      artifactBytes: dbNumberOrNull(row.artifact_bytes),
      patch: jsonValue(row.patch_json),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    }));
  }

  async listSessionSourceContents(
    sessionId: number,
  ): Promise<ComposeEvidenceSourceInput[]> {
    const [rows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          id: number;
          original_filename: string | null;
          markdown_content: string | null;
        }
      >
    >(
      `SELECT id, original_filename, markdown_content
       FROM compose_session_sources
       WHERE session_id = ?
         AND conversion_status = 'converted'
         AND deleted_at IS NULL
       ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      sourceId: row.id,
      filename: row.original_filename ?? "source.md",
      content: row.markdown_content ?? "",
    }));
  }

  async linkSource(input: {
    sessionId: number;
    sourceId: number;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_sessions
       SET source_id = ?, status = 'handed_off'
       WHERE id = ?
         AND source_id IS NULL
         AND status <> 'archived'`,
      [input.sourceId, input.sessionId],
    );
    return result.affectedRows === 1;
  }

  async appendMessage(input: {
    sessionId: number;
    role: ComposeSessionMessageSummary["role"];
    content: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_messages (session_id, role, content)
       VALUES (?, ?, ?)`,
      [input.sessionId, input.role, input.content],
    );
    return result.insertId;
  }

  async appendAssistantMessageIfSessionActive(input: {
    sessionId: number;
    content: string;
    contextVersionUsed?: number | null;
  }): Promise<CompleteTurnWithAssistantMessageResult> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<SessionArchiveRow[]>(
        `SELECT id, status, archived_at
         FROM compose_sessions
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${input.sessionId} was not found`);
      }
      if (session.status === "archived" || session.archived_at !== null) {
        await connection.commit();
        return {
          assistantMessageId: null,
          deduplicated: false,
          discardedDueToArchive: true,
        };
      }

      const [messageResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_session_messages
           (session_id, role, content, context_version_used, message_kind)
         VALUES (?, ?, ?, ?, ?)`,
        [
          input.sessionId,
          "assistant",
          input.content,
          input.contextVersionUsed ?? null,
          "final",
        ],
      );
      await connection.commit();
      return {
        assistantMessageId: messageResult.insertId,
        deduplicated: false,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listMessages(
    sessionId: number,
  ): Promise<ComposeSessionMessageSummary[]> {
    const [rows] = await this.pool.query<MessageRow[]>(
      `SELECT id, session_id, role, content, created_at
       FROM compose_session_messages
       WHERE session_id = ?
       ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: toIso(row.created_at),
    }));
  }

  async getSessionWorkflowState(
    sessionId: number,
  ): Promise<ComposeSessionWorkflowState | null> {
    const [sessionRows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          id: number | string;
          context_status: string;
        }
      >
    >(
      `SELECT id, context_status FROM compose_sessions
       WHERE id = ? AND status <> 'archived'
       LIMIT 1`,
      [sessionId],
    );
    if (!sessionRows[0]) return null;
    const [turnRows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          id: number | string;
          turn_kind: "chat" | "analyze";
          status: string;
          attempt_count: number | string;
          max_attempts: number | string;
          requested_context_version: number | string | null;
          context_version_used: number | string | null;
          queued_at: Date | string;
          started_at: Date | string | null;
          completed_at: Date | string | null;
          clarification_expires_at: Date | string | null;
          error_code: string | null;
          error_message: string | null;
          queue_position: number | string | null;
        }
      >
    >(
      `SELECT turn.id, turn.turn_kind, turn.status, turn.attempt_count,
              turn.max_attempts, turn.requested_context_version,
              turn.context_version_used, turn.created_at AS queued_at,
              turn.started_at,
              turn.completed_at, turn.clarification_expires_at,
              turn.error_code, turn.error_message,
              CASE WHEN turn.status = 'queued' THEN (
                SELECT COUNT(*) + 1
                FROM compose_turn_jobs ahead
                WHERE ahead.status = 'queued'
                  AND (ahead.created_at < turn.created_at
                       OR (ahead.created_at = turn.created_at
                           AND ahead.id < turn.id))
              ) ELSE NULL END AS queue_position
       FROM compose_turn_jobs turn
       WHERE turn.session_id = ?
       ORDER BY turn.id DESC
       LIMIT 1`,
      [sessionId],
    );
    const [handoffRows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          id: number | string;
          source_id: number | string | null;
          status: string;
          context_version_used: number | string | null;
          message_high_watermark_id: number | string | null;
          snapshot_id: number | string | null;
          draft_workflow_id: number | string | null;
          workflow_status: string | null;
          current_stage: string | null;
          draft_id: number | string | null;
          approved_epic_key: string | null;
          error_code: string | null;
          error_message: string | null;
          updated_at: Date | string;
        }
      >
    >(
      `SELECT handoff.id, handoff.source_id, handoff.status,
              handoff.context_version_used, handoff.message_high_watermark_id,
              handoff.snapshot_id, handoff.draft_workflow_id,
              workflow.status AS workflow_status,
              workflow.current_stage, workflow.draft_id,
              source.approved_epic_key,
              COALESCE(workflow.error_code, handoff.error_code) AS error_code,
              COALESCE(workflow.error_message, handoff.error_message) AS error_message,
              handoff.updated_at
       FROM compose_handoffs handoff
       LEFT JOIN spec_factory_draft_workflows workflow
         ON workflow.id = handoff.draft_workflow_id
       LEFT JOIN spec_factory_sources source ON source.id = handoff.source_id
       WHERE handoff.session_id = ?
       ORDER BY handoff.id DESC
       LIMIT 1`,
      [sessionId],
    );
    const [activeTaskRows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          capability: string;
          status: string;
          count: number | string;
        }
      >
    >(
      `SELECT capability, status, COUNT(*) AS count
       FROM compose_agent_tasks
       WHERE session_id = ?
         AND status IN ('queued','running')
       GROUP BY capability, status`,
      [sessionId],
    );
    const [sourceStateRows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          conversion_status: string;
          count: number | string;
        }
      >
    >(
      `SELECT conversion_status, COUNT(*) AS count
       FROM compose_session_sources
       WHERE session_id = ?
         AND deleted_at IS NULL
       GROUP BY conversion_status`,
      [sessionId],
    );
    const turn = turnRows[0];
    const handoff = handoffRows[0];
    const activeTaskCount = (capabilities: Set<string>): number =>
      activeTaskRows.reduce(
        (count, row) =>
          capabilities.has(row.capability)
            ? count + dbNumber(row.count)
            : count,
        0,
      );
    const sourceCount = (statuses: Set<string>): number =>
      sourceStateRows.reduce(
        (count, row) =>
          statuses.has(row.conversion_status)
            ? count + dbNumber(row.count)
            : count,
        0,
      );
    const sourceWorking = sourceCount(
      new Set(["awaiting_upload", "pending", "converting"]),
    );
    const sourceFailures = sourceCount(new Set(["failed", "unsupported"]));
    const requirementsWorking = activeTaskCount(
      new Set(["source_distillation", "context_merge", "critic_review"]),
    );
    const researchWorking = activeTaskCount(
      new Set(["code_research", "config_research", "devops_research"]),
    );
    const turnWorking = Boolean(
      turn && ["queued", "running", "synthesizing"].includes(turn.status),
    );
    const turnAwaitingUser = turn?.status === "awaiting_user_input";
    const researchTurnWorking = turn?.status === "waiting_on_research";
    const handoffWorking = Boolean(
      handoff &&
      ([
        "requested",
        "snapshot_building",
        "snapshot_ready",
        "draft_queued",
        "drafting",
        "publishing",
      ].includes(handoff.status) ||
        handoff.workflow_status === "queued" ||
        handoff.workflow_status === "running" ||
        handoff.workflow_status === "publishing"),
    );
    return {
      sessionId,
      generatedAt: new Date().toISOString(),
      turn: turn
        ? {
            id: dbNumber(turn.id),
            kind: turn.turn_kind,
            status: turn.status,
            attemptCount: dbNumber(turn.attempt_count),
            maxAttempts: dbNumber(turn.max_attempts),
            queuePosition: dbNumberOrNull(turn.queue_position),
            requestedContextVersion: dbNumberOrNull(
              turn.requested_context_version,
            ),
            contextVersionUsed: dbNumberOrNull(turn.context_version_used),
            queuedAt: toIso(turn.queued_at),
            startedAt: turn.started_at ? toIso(turn.started_at) : null,
            completedAt: turn.completed_at ? toIso(turn.completed_at) : null,
            clarificationExpiresAt: turn.clarification_expires_at
              ? toIso(turn.clarification_expires_at)
              : null,
            errorCode: turn.error_code,
            errorMessage: turn.error_message,
          }
        : null,
      handoff: handoff
        ? {
            id: dbNumber(handoff.id),
            sourceId: dbNumberOrNull(handoff.source_id),
            status: handoff.status,
            contextVersionUsed: dbNumberOrNull(handoff.context_version_used),
            messageHighWatermarkId: dbNumberOrNull(
              handoff.message_high_watermark_id,
            ),
            snapshotId: dbNumberOrNull(handoff.snapshot_id),
            draftWorkflowId: dbNumberOrNull(handoff.draft_workflow_id),
            workflowStatus: handoff.workflow_status,
            workflowStage: handoff.current_stage,
            draftId: dbNumberOrNull(handoff.draft_id),
            epicKey: handoff.approved_epic_key,
            errorCode: handoff.error_code,
            errorMessage: handoff.error_message,
            updatedAt: toIso(handoff.updated_at),
          }
        : null,
      agents: [
        {
          key: "sources",
          label: "Sources",
          status:
            sourceWorking > 0
              ? "working"
              : sourceFailures > 0
                ? "attention"
                : "idle",
          detail:
            sourceWorking > 0
              ? `${sourceWorking} source${sourceWorking === 1 ? "" : "s"} processing`
              : sourceFailures > 0
                ? `${sourceFailures} source${sourceFailures === 1 ? "" : "s"} need attention`
                : "Up to date",
          activeCount: sourceWorking,
        },
        {
          key: "requirements",
          label: "Requirements",
          status:
            requirementsWorking > 0 || turnWorking
              ? "working"
              : turnAwaitingUser
                ? "waiting"
                : sessionRows[0].context_status === "failed" ||
                    turn?.status === "failed"
                  ? "attention"
                  : sessionRows[0].context_status === "clean"
                    ? "idle"
                    : "waiting",
          detail:
            requirementsWorking > 0
              ? "Updating requirements context"
              : turnWorking
                ? "Working with your guidance"
                : turnAwaitingUser
                  ? "Waiting for your answer"
                  : sessionRows[0].context_status === "failed" ||
                      turn?.status === "failed"
                    ? "Requirements update needs attention"
                    : sessionRows[0].context_status === "clean"
                      ? "Context current"
                      : "Context update queued",
          activeCount: requirementsWorking + (turnWorking ? 1 : 0),
        },
        {
          key: "research",
          label: "Research",
          status:
            researchWorking > 0 || researchTurnWorking ? "working" : "idle",
          detail:
            researchWorking > 0 || researchTurnWorking
              ? "Inspecting implementation evidence"
              : "Waiting for approval",
          activeCount: researchWorking + (researchTurnWorking ? 1 : 0),
        },
        {
          key: "draft",
          label: "Draft",
          status: handoff?.error_code
            ? "attention"
            : handoffWorking
              ? "working"
              : "idle",
          detail: handoff?.error_code
            ? "Needs attention"
            : handoffWorking
              ? (handoff.current_stage ?? handoff.status).replaceAll("_", " ")
              : handoff?.approved_epic_key
                ? `Published ${handoff.approved_epic_key}`
                : "Not started",
          activeCount: handoffWorking ? 1 : 0,
        },
      ],
    };
  }

  async setClaudeSessionId(input: {
    sessionId: number;
    claudeSessionId: string | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET claude_session_id = ?
       WHERE id = ?
         AND status <> 'archived'`,
      [input.claudeSessionId, input.sessionId],
    );
  }

  // Promotion-only: ready=true promotes status to 'ready'; a later ready=false
  // only updates readiness_json and never demotes the row status (the live
  // readiness is always read from readiness_json; this avoids the board status
  // flip-flopping mid-conversation). handed_off/archived are terminal elsewhere.
  async setReadiness(input: {
    sessionId: number;
    readiness: ComposeReadiness;
  }): Promise<void> {
    if (input.readiness.ready) {
      await this.pool.query(
        `UPDATE compose_sessions
         SET readiness_json = CAST(? AS JSON), status = 'ready'
         WHERE id = ?
           AND status <> 'archived'`,
        [JSON.stringify(input.readiness), input.sessionId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE compose_sessions
       SET readiness_json = CAST(? AS JSON)
       WHERE id = ?
         AND status <> 'archived'`,
      [JSON.stringify(input.readiness), input.sessionId],
    );
  }

  async createUploadSource(input: {
    sessionId: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    s3KeyRaw: string;
    converter: ComposeSessionSourceSummary["converter"];
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, request_id, kind, original_filename, mime_type, size_bytes, s3_key_raw, converter, conversion_status)
       SELECT ?, ?, 'file', ?, ?, ?, ?, ?, 'awaiting_upload'
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1`,
      [
        input.sessionId,
        currentSpecFactoryCorrelation().requestId ?? null,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.s3KeyRaw,
        input.converter,
        input.sessionId,
      ],
    );
    return insertedSourceIdForActiveSession(result, input.sessionId);
  }

  async markSourceUploaded(input: {
    sessionId: number;
    sourceId: number;
  }): Promise<void> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_session_sources
       SET conversion_status = 'pending',
           request_id = COALESCE(?, request_id)
       WHERE id = ?
         AND session_id = ?
         AND conversion_status = 'awaiting_upload'
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [
        currentSpecFactoryCorrelation().requestId ?? null,
        input.sourceId,
        input.sessionId,
      ],
    );
    if (result.affectedRows !== 1) {
      throw new Error(
        `Compose source ${input.sourceId} was not found in session ${input.sessionId} or is not awaiting upload`,
      );
    }
    specFactoryMetrics.recordWorkAccepted({
      workType: "conversion",
      subtype: "file",
    });
  }

  async createYoutubeSource(input: {
    sessionId: number;
    url: string;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO compose_session_sources
       (session_id, request_id, kind, original_filename, source_url, converter, conversion_status)
       SELECT ?, ?, 'youtube', ?, ?, 'markitdown', 'pending'
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1`,
      [
        input.sessionId,
        currentSpecFactoryCorrelation().requestId ?? null,
        input.url,
        input.url,
        input.sessionId,
      ],
    );
    const sourceId = insertedSourceIdForActiveSession(result, input.sessionId);
    specFactoryMetrics.recordWorkAccepted({
      workType: "conversion",
      subtype: "youtube",
    });
    return sourceId;
  }

  async deleteSessionSource(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
    undoWindowMinutes?: number;
  }): Promise<ComposeSourceDeletionSummary | null> {
    const undoWindowMinutes = Math.max(
      1,
      Math.min(10_080, Math.trunc(input.undoWindowMinutes ?? 10)),
    );
    const undoUntil = new Date(Date.now() + undoWindowMinutes * 60 * 1000);
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      if (!sessionRows[0]) {
        await connection.commit();
        return null;
      }

      const [sourceRows] = await connection.query<DeletableSourceRow[]>(
        `SELECT id, current_revision_id, kind, original_filename, source_url,
                parent_source_ids_json, generated_by_task_id
         FROM compose_session_sources
         WHERE session_id = ?
           AND deleted_at IS NULL
         ORDER BY id ASC
         FOR UPDATE`,
        [input.sessionId],
      );
      const source = sourceRows.find(
        (row) => dbNumber(row.id) === input.sourceId,
      );
      if (!source) {
        await connection.commit();
        return null;
      }
      const invalidatedSources = invalidatedSourceClosure(
        sourceRows,
        input.sourceId,
      );
      const invalidatedSourceIds = invalidatedSources.map((row) =>
        dbNumber(row.id),
      );
      const sourcePlaceholders = invalidatedSourceIds.map(() => "?").join(", ");

      const [handoffRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            source_id: number | string | null;
            draft_workflow_id: number | string | null;
          }
        >
      >(
        `SELECT id, source_id, draft_workflow_id
         FROM compose_handoffs
         WHERE session_id = ?
         FOR UPDATE`,
        [input.sessionId],
      );
      const invalidatedHandoffIds = handoffRows.map((row) => dbNumber(row.id));
      const workflowIds = handoffRows
        .map((row) => dbNumberOrNull(row.draft_workflow_id))
        .filter((id): id is number => id !== null);
      const specSourceIds = handoffRows
        .map((row) => dbNumberOrNull(row.source_id))
        .filter((id): id is number => id !== null);

      const sourceTitle = (
        source.original_filename?.trim() ||
        source.source_url?.trim() ||
        `Source ${input.sourceId}`
      ).slice(0, 400);
      const deletedBy = input.actor?.trim().slice(0, 128) || null;
      const [deletionResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_source_deletions
         (session_id, source_id, source_title, deleted_by, status, undo_until,
          invalidated_source_ids_json, invalidated_handoff_ids_json)
         VALUES (?, ?, ?, ?, 'undoable', ?, CAST(? AS JSON), CAST(? AS JSON))`,
        [
          input.sessionId,
          input.sourceId,
          sourceTitle,
          deletedBy,
          undoUntil,
          JSON.stringify(invalidatedSourceIds),
          JSON.stringify(invalidatedHandoffIds),
        ],
      );
      const deletionId = deletionResult.insertId;

      const [contextRows] = await connection.query<ContextProjectionRow[]>(
        `SELECT session_id, version, artifact_uri, structured_artifact_uri,
                summary_json, facts_json, implementation_findings_json,
                requirements_json, constraints_json, open_questions_json,
                conflicts_json, decisions_json, risks_json, source_ids_json,
                patch_ids_json, committed_at
         FROM compose_context_versions
         WHERE session_id = ?
           AND status = 'committed'
         ORDER BY version DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const projection = contextRows[0]
        ? this.mapContextProjection(contextRows[0])
        : null;

      await connection.query(
        `UPDATE compose_context_patches
         SET status = 'superseded',
             error_message = 'Source deleted before patch could be applied',
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND source_id IN (${sourcePlaceholders})
           AND status IN ('building', 'ready')`,
        [input.sessionId, ...invalidatedSourceIds],
      );

      const removalPatchIds: number[] = [];
      for (const invalidatedSource of invalidatedSources) {
        const sourceId = dbNumber(invalidatedSource.id);
        const revisionId = dbNumberOrNull(
          invalidatedSource.current_revision_id,
        );
        const patch = buildSourceRemovalContextPatch({
          sourceId,
          sourceRevisionId: revisionId,
          parent: projection ?? {},
        });
        const [patchResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_context_patches
             (session_id, source_id, source_revision_id, base_context_version,
              schema_version, patch_kind, idempotency_key, status, patch_json)
             VALUES (?, ?, ?, ?, 4, 'source_removal', ?, 'ready', CAST(? AS JSON))
             ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
          [
            input.sessionId,
            sourceId,
            revisionId,
            projection?.version ?? null,
            `source:${sourceId}:revision:${revisionId ?? 0}:deletion:${deletionId}:removal:v4`,
            JSON.stringify(patch),
          ],
        );
        removalPatchIds.push(patchResult.insertId);
      }

      await connection.query(
        `UPDATE compose_session_sources
         SET deleted_at = CURRENT_TIMESTAMP(3),
             deleted_by = ?,
             deletion_id = ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND id IN (${sourcePlaceholders})
           AND deleted_at IS NULL`,
        [deletedBy, deletionId, input.sessionId, ...invalidatedSourceIds],
      );
      await connection.query(
        `UPDATE compose_source_revisions
         SET status = 'deleted'
         WHERE source_id IN (${sourcePlaceholders})`,
        invalidatedSourceIds,
      );
      await connection.query(
        `UPDATE compose_source_chunks
         SET status = 'deleted'
         WHERE source_id IN (${sourcePlaceholders})`,
        invalidatedSourceIds,
      );

      await connection.query(
        `UPDATE compose_context_versions
         SET status = 'superseded',
             error_message = 'Source set changed during context build'
         WHERE session_id = ?
           AND status = 'building'`,
        [input.sessionId],
      );
      await connection.query(
        `UPDATE compose_agent_tasks
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'source_deleted',
             error_message = 'Turn invalidated because the source set changed',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND turn_job_id IS NOT NULL
           AND status IN ('queued', 'running')`,
        [input.sessionId],
      );
      await connection.query(
        `UPDATE compose_turn_jobs
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'source_deleted',
             error_message = 'Turn invalidated because the source set changed',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND status IN ('queued', 'running', 'waiting_on_research',
                          'awaiting_user_input', 'synthesizing')`,
        [input.sessionId],
      );
      await connection.query(
        `UPDATE compose_agent_tasks
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'source_deleted',
             error_message = 'Task invalidated because a source was deleted',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND status IN ('queued', 'running')
           AND (
             capability IN ('context_merge', 'critic_review', 'handoff_build')
             OR (
               capability = 'source_distillation'
               AND CAST(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.sourceId')) AS UNSIGNED)
                   IN (${sourcePlaceholders})
             )
             OR (
               capability IN ('code_research', 'config_research', 'devops_research')
               AND JSON_OVERLAPS(
                 COALESCE(JSON_EXTRACT(input_json, '$.parentSourceIds'), JSON_ARRAY()),
                 CAST(? AS JSON)
               )
             )
           )`,
        [
          input.sessionId,
          ...invalidatedSourceIds,
          JSON.stringify(invalidatedSourceIds),
        ],
      );

      if (workflowIds.length > 0) {
        const workflowPlaceholders = workflowIds.map(() => "?").join(", ");
        await connection.query(
          `UPDATE spec_factory_draft_stage_runs
           SET status = 'skipped',
               active_worker_id = NULL,
               lease_until = NULL,
               error_code = 'source_deleted',
               error_message = 'Draft stage invalidated because the source set changed',
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE workflow_id IN (${workflowPlaceholders})
             AND status IN ('blocked', 'queued', 'running', 'waiting')`,
          workflowIds,
        );
        await connection.query(
          `UPDATE spec_factory_draft_workflows
           SET status = 'cancelled',
               error_code = 'source_deleted',
               error_message = 'Draft invalidated because the source set changed',
               completed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id IN (${workflowPlaceholders})
             AND status NOT IN ('published', 'failed', 'cancelled')`,
          workflowIds,
        );
      }
      if (specSourceIds.length > 0) {
        const specSourcePlaceholders = specSourceIds.map(() => "?").join(", ");
        await connection.query(
          `UPDATE spec_factory_drafts
           SET status = 'superseded',
               error_message = 'Draft invalidated because the source set changed',
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE source_id IN (${specSourcePlaceholders})
             AND status IN ('generating', 'ready')`,
          specSourceIds,
        );
        await connection.query(
          `UPDATE spec_factory_sources
           SET state = 'needs_attention',
               error_message = 'Compose source deleted; regenerate from current context',
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id IN (${specSourcePlaceholders})
             AND state NOT IN ('oneshot_submitted', 'archived')`,
          specSourceIds,
        );
      }
      await connection.query(
        `UPDATE compose_handoff_snapshots
         SET status = 'superseded'
         WHERE session_id = ?
           AND status IN ('building', 'ready')`,
        [input.sessionId],
      );
      await connection.query(
        `UPDATE compose_handoffs
         SET status = 'cancelled',
             error_code = 'source_deleted',
             error_message = 'Handoff invalidated because the source set changed',
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND status NOT IN ('published', 'failed', 'cancelled')`,
        [input.sessionId],
      );

      await connection.query(
        `UPDATE compose_sessions
         SET context_status = 'patch_ready',
             readiness_json = NULL,
             status = CASE
               WHEN status IN ('ready', 'handed_off') THEN 'draft'
               ELSE status
             END,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status <> 'archived'`,
        [input.sessionId],
      );
      const [mergeTaskResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_agent_tasks
         (session_id, capability, executor_type, request_id, priority,
          input_json, max_attempts)
         VALUES (?, 'context_merge', 'context_merge', ?, 90, CAST(? AS JSON), 3)`,
        [
          input.sessionId,
          currentSpecFactoryCorrelation().requestId ?? null,
          JSON.stringify({
            sessionId: input.sessionId,
            triggerPatchId: removalPatchIds[0] ?? null,
            sourceDeletionId: deletionId,
          }),
        ],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "agent_task",
        aggregateId: mergeTaskResult.insertId,
        eventType: "task.queued",
        dedupeKey: `agent-task:${mergeTaskResult.insertId}:queued:g1`,
        payload: {
          sessionId: input.sessionId,
          agentTaskId: mergeTaskResult.insertId,
          capability: "context_merge",
          executorType: "context_merge",
          triggerPatchId: removalPatchIds[0] ?? null,
          sourceDeletionId: deletionId,
          queueGeneration: 1,
        },
      });
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "source_deletion",
        aggregateId: deletionId,
        eventType: "source.deleted",
        dedupeKey: `source-deletion:${deletionId}:deleted`,
        payload: {
          sessionId: input.sessionId,
          sourceId: input.sourceId,
          deletionId,
          undoUntil: undoUntil.toISOString(),
          invalidatedSourceIds,
          invalidatedHandoffIds,
        },
      });
      for (const dependentSourceId of invalidatedSourceIds.slice(1)) {
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "source_deletion",
          aggregateId: deletionId,
          eventType: "source.invalidated",
          dedupeKey: `source-deletion:${deletionId}:invalidated:${dependentSourceId}`,
          payload: {
            sessionId: input.sessionId,
            sourceId: dependentSourceId,
            parentSourceId: input.sourceId,
            deletionId,
          },
        });
      }
      await connection.commit();
      return {
        id: deletionId,
        sessionId: input.sessionId,
        sourceId: input.sourceId,
        sourceTitle,
        status: "undoable",
        undoUntil: undoUntil.toISOString(),
        invalidatedSourceIds,
        invalidatedHandoffIds,
        dependentSourceCount: Math.max(0, invalidatedSourceIds.length - 1),
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listUndoableSourceDeletions(
    sessionId: number,
  ): Promise<ComposeSourceDeletionSummary[]> {
    const [rows] = await this.pool.query<SourceDeletionRow[]>(
      `SELECT deletion.id, deletion.session_id, deletion.source_id,
              deletion.source_title, deletion.status, deletion.undo_until,
              deletion.invalidated_source_ids_json,
              deletion.invalidated_handoff_ids_json, deletion.created_at
       FROM compose_source_deletions deletion
       JOIN compose_session_sources source
         ON source.id = deletion.source_id
        AND source.deletion_id = deletion.id
        AND source.deleted_at IS NOT NULL
       JOIN compose_sessions session ON session.id = deletion.session_id
       WHERE deletion.session_id = ?
         AND deletion.status = 'undoable'
         AND deletion.undo_until > CURRENT_TIMESTAMP(3)
         AND session.status <> 'archived'
       ORDER BY deletion.created_at DESC, deletion.id DESC`,
      [sessionId],
    );
    return rows.map(sourceDeletionSummary);
  }

  async restoreSessionSource(input: {
    sessionId: number;
    sourceId: number;
    actor?: string | null;
  }): Promise<ComposeSourceDeletionSummary | null> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            latest_context_version: number | string | null;
          }
        >
      >(
        `SELECT id, latest_context_version
         FROM compose_sessions
         WHERE id = ?
           AND status <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        await connection.commit();
        return null;
      }

      const [rows] = await connection.query<
        Array<
          SourceDeletionRow & {
            current_revision_id: number | string | null;
            conversion_status: ComposeSessionSourceSummary["conversionStatus"];
          }
        >
      >(
        `SELECT deletion.id, deletion.session_id, deletion.source_id,
                deletion.source_title, deletion.status, deletion.undo_until,
                deletion.invalidated_source_ids_json,
                deletion.invalidated_handoff_ids_json, deletion.created_at,
                source.current_revision_id, source.conversion_status
         FROM compose_source_deletions deletion
         JOIN compose_session_sources source
           ON source.id = deletion.source_id
          AND source.deletion_id = deletion.id
          AND source.deleted_at IS NOT NULL
         WHERE deletion.session_id = ?
           AND deletion.source_id = ?
           AND deletion.status = 'undoable'
           AND deletion.undo_until > CURRENT_TIMESTAMP(3)
         ORDER BY deletion.id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.sessionId, input.sourceId],
      );
      const deletion = rows[0];
      if (!deletion) {
        await connection.commit();
        return null;
      }
      const deletionId = dbNumber(deletion.id);
      const currentRevisionId = dbNumberOrNull(deletion.current_revision_id);
      const baseContextVersion = dbNumberOrNull(session.latest_context_version);
      const invalidatedSourceIds = parseNumberArray(
        jsonValue(deletion.invalidated_source_ids_json),
      );
      const dependentSourceCount = Math.max(0, invalidatedSourceIds.length - 1);
      const conversionNeedsRestart =
        deletion.conversion_status === "pending" ||
        deletion.conversion_status === "converting" ||
        (deletion.conversion_status === "converted" &&
          currentRevisionId === null);

      await connection.query(
        `UPDATE compose_agent_tasks
         SET status = 'cancelled',
             cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP(3)),
             error_code = 'source_restored',
             error_message = 'Context merge replaced because a source was restored',
             active_worker_id = NULL,
             lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND capability = 'context_merge'
           AND status IN ('queued', 'running')`,
        [input.sessionId],
      );
      await connection.query(
        `UPDATE compose_context_versions
         SET status = 'superseded',
             error_message = 'Source restored during context build'
         WHERE session_id = ?
           AND status = 'building'`,
        [input.sessionId],
      );
      await connection.query(
        `UPDATE compose_context_patches
         SET status = 'superseded',
             error_message = 'Source deletion was undone',
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE session_id = ?
           AND source_id = ?
           AND patch_kind = 'source_removal'
           AND status IN ('building', 'ready')`,
        [input.sessionId, input.sourceId],
      );
      await connection.query(
        `UPDATE compose_session_sources
         SET deleted_at = NULL,
             deleted_by = NULL,
             deletion_id = NULL,
             purged_at = NULL,
             conversion_status = CASE
               WHEN conversion_status = 'converting'
                 OR (conversion_status = 'converted' AND current_revision_id IS NULL)
               THEN 'pending'
               ELSE conversion_status
             END,
             conversion_started_at = NULL,
             conversion_lease_expires_at = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND session_id = ?
           AND deletion_id = ?
           AND deleted_at IS NOT NULL`,
        [input.sourceId, input.sessionId, deletionId],
      );
      await connection.query(
        `UPDATE compose_source_revisions
         SET status = CASE WHEN id = ? THEN 'ready' ELSE 'superseded' END
         WHERE source_id = ?`,
        [currentRevisionId ?? -1, input.sourceId],
      );
      await connection.query(
        `UPDATE compose_source_chunks
         SET status = CASE
           WHEN source_revision_id = ? THEN 'ready'
           ELSE 'superseded'
         END
         WHERE source_id = ?`,
        [currentRevisionId ?? -1, input.sourceId],
      );
      await connection.query(
        `UPDATE compose_source_deletions
         SET status = 'restored',
             restored_by = ?,
             restored_at = CURRENT_TIMESTAMP(3),
             purge_error = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'undoable'`,
        [input.actor?.trim().slice(0, 128) || null, deletionId],
      );
      await connection.query(
        `UPDATE compose_sessions
         SET context_status = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM compose_context_patches ready_patch
                 WHERE ready_patch.session_id = compose_sessions.id
                   AND ready_patch.status = 'ready'
                 LIMIT 1
               ) THEN 'patch_ready'
               ELSE 'dirty'
             END,
             readiness_json = NULL,
             status = CASE
               WHEN status IN ('ready', 'handed_off') THEN 'draft'
               ELSE status
             END,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status <> 'archived'`,
        [input.sessionId],
      );

      let distillationTaskId: number | null = null;
      let contextMergeTaskId: number | null = null;
      if (dependentSourceCount > 0) {
        const [mergeResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_agent_tasks
           (session_id, capability, executor_type, request_id, priority,
            input_json, max_attempts)
           VALUES (?, 'context_merge', 'context_merge', ?, 90,
                   CAST(? AS JSON), 3)`,
          [
            input.sessionId,
            currentSpecFactoryCorrelation().requestId ?? null,
            JSON.stringify({
              sessionId: input.sessionId,
              sourceDeletionId: deletionId,
              sourceRestored: true,
            }),
          ],
        );
        contextMergeTaskId = mergeResult.insertId;
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "agent_task",
          aggregateId: contextMergeTaskId,
          eventType: "task.queued",
          dedupeKey: `agent-task:${contextMergeTaskId}:queued:g1`,
          payload: {
            sessionId: input.sessionId,
            agentTaskId: contextMergeTaskId,
            capability: "context_merge",
            executorType: "context_merge",
            sourceDeletionId: deletionId,
            sourceRestored: true,
            queueGeneration: 1,
          },
        });
      }
      if (
        deletion.conversion_status === "converted" &&
        currentRevisionId !== null
      ) {
        const [taskResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_agent_tasks
           (session_id, capability, executor_type, request_id, priority,
            input_json, max_attempts)
           VALUES (?, 'source_distillation', 'source_distillation', ?, 80,
                   CAST(? AS JSON), 3)`,
          [
            input.sessionId,
            currentSpecFactoryCorrelation().requestId ?? null,
            JSON.stringify({
              sourceId: input.sourceId,
              sourceRevisionId: currentRevisionId,
              baseContextVersion,
              restoredFromDeletionId: deletionId,
            }),
          ],
        );
        distillationTaskId = taskResult.insertId;
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "agent_task",
          aggregateId: distillationTaskId,
          eventType: "task.queued",
          dedupeKey: `agent-task:${distillationTaskId}:queued:g1`,
          payload: {
            sessionId: input.sessionId,
            agentTaskId: distillationTaskId,
            capability: "source_distillation",
            executorType: "source_distillation",
            sourceId: input.sourceId,
            sourceRevisionId: currentRevisionId,
            baseContextVersion,
            queueGeneration: 1,
          },
        });
      }
      if (conversionNeedsRestart) {
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "source_conversion",
          aggregateId: input.sourceId,
          eventType: "source.conversion.queued",
          dedupeKey: `source-conversion:${input.sourceId}:restore:${deletionId}`,
          payload: {
            sessionId: input.sessionId,
            sourceId: input.sourceId,
            sourceDeletionId: deletionId,
            reason: "source_restored",
          },
        });
      }
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "source_deletion",
        aggregateId: deletionId,
        eventType: "source.restored",
        dedupeKey: `source-deletion:${deletionId}:restored`,
        payload: {
          sessionId: input.sessionId,
          sourceId: input.sourceId,
          deletionId,
          distillationTaskId,
          contextMergeTaskId,
          conversionQueued: conversionNeedsRestart,
          dependentSourcesRemainInvalidated: dependentSourceCount,
        },
      });
      await connection.commit();
      return {
        ...sourceDeletionSummary(deletion),
        status: "restored",
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimNextSourceDeletionPurge(): Promise<ComposeSourceDeletionPurgeCandidate | null> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const eligibleWhere = `(
        status IN ('undoable', 'restored')
        OR (
          status = 'failed'
          AND updated_at < CURRENT_TIMESTAMP(3) - INTERVAL 5 MINUTE
        )
        OR (
          status = 'purging'
          AND purge_started_at < CURRENT_TIMESTAMP(3) - INTERVAL 15 MINUTE
        )
      )
      AND undo_until <= CURRENT_TIMESTAMP(3)`;
      const [candidateRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            session_id: number | string;
            source_id: number | string;
          }
        >
      >(
        `SELECT id, session_id, source_id
         FROM compose_source_deletions
         WHERE ${eligibleWhere}
         ORDER BY undo_until ASC, id ASC
         LIMIT 1`,
      );
      const candidate = candidateRows[0];
      if (!candidate) {
        await connection.commit();
        return null;
      }
      const sessionId = dbNumber(candidate.session_id);
      const deletionId = dbNumber(candidate.id);
      const [sessionRows] = await connection.query<
        Array<mysql.RowDataPacket & { workspace_path: string }>
      >(
        `SELECT workspace_path
         FROM compose_sessions
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        await connection.commit();
        return null;
      }
      const [lockedRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM compose_source_deletions
         WHERE id = ?
           AND ${eligibleWhere}
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [deletionId],
      );
      if (!lockedRows[0]) {
        await connection.commit();
        return null;
      }
      await connection.query(
        `UPDATE compose_source_deletions
         SET status = 'purging',
             purge_started_at = CURRENT_TIMESTAMP(3),
             purge_error = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [deletionId],
      );
      const [sourceRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            s3_key_raw: string | null;
            markdown_path: string | null;
            artifact_uri: string | null;
          }
        >
      >(
        `SELECT id, s3_key_raw, markdown_path, artifact_uri
         FROM compose_session_sources
         WHERE deletion_id = ?
           AND deleted_at IS NOT NULL
         ORDER BY id ASC`,
        [deletionId],
      );
      const sourceIds = sourceRows.map((sourceRow) => dbNumber(sourceRow.id));
      const artifactUris = sourceRows
        .map((sourceRow) => sourceRow.artifact_uri?.trim() ?? "")
        .filter(Boolean);
      const localPaths = sourceRows
        .map((sourceRow) => sourceRow.markdown_path?.trim() ?? "")
        .filter(Boolean);
      if (sourceIds.length > 0) {
        const placeholders = sourceIds.map(() => "?").join(", ");
        const [derivedRows] = await connection.query<
          Array<mysql.RowDataPacket & { artifact_uri: string | null }>
        >(
          `SELECT artifact_uri
           FROM compose_source_revisions
           WHERE source_id IN (${placeholders})
           UNION ALL
           SELECT artifact_uri
           FROM compose_source_chunks
           WHERE source_id IN (${placeholders})`,
          [...sourceIds, ...sourceIds],
        );
        artifactUris.push(
          ...derivedRows
            .map((derivedRow) => derivedRow.artifact_uri?.trim() ?? "")
            .filter(Boolean),
        );
      }
      await connection.commit();
      return {
        deletionId,
        sessionId,
        sourceId: dbNumber(candidate.source_id),
        workspacePath: session.workspace_path,
        sourceIds,
        s3Keys: sourceRows
          .map((sourceRow) => sourceRow.s3_key_raw?.trim() ?? "")
          .filter(Boolean),
        artifactUris: [...new Set(artifactUris)],
        localPaths: [...new Set(localPaths)],
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markSourceDeletionPurged(input: {
    deletionId: number;
    deletedFileCount: number;
    deletedObjectCount: number;
  }): Promise<boolean> {
    const emptySha256 = createHash("sha256").update("").digest("hex");
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            session_id: number | string;
            source_id: number | string;
          }
        >
      >(
        `SELECT id, session_id, source_id
         FROM compose_source_deletions
         WHERE id = ?
           AND status = 'purging'
         LIMIT 1
         FOR UPDATE`,
        [input.deletionId],
      );
      if (!rows[0]) {
        await connection.commit();
        return false;
      }
      await connection.query(
        `UPDATE compose_source_chunks
         SET content_text = '',
             token_estimate = 0,
             artifact_uri = CONCAT('purged://source-deletion/', ?, '/chunk/', id),
             artifact_sha256 = ?,
             artifact_bytes = 0,
             status = 'deleted'
         WHERE source_id IN (
           SELECT id
           FROM compose_session_sources
           WHERE deletion_id = ?
             AND deleted_at IS NOT NULL
         )`,
        [input.deletionId, emptySha256, input.deletionId],
      );
      await connection.query(
        `UPDATE compose_source_revisions
         SET artifact_uri = CONCAT('purged://source-deletion/', ?, '/revision/', id),
             artifact_sha256 = ?,
             artifact_bytes = 0,
             status = 'deleted'
         WHERE source_id IN (
           SELECT id
           FROM compose_session_sources
           WHERE deletion_id = ?
             AND deleted_at IS NOT NULL
         )`,
        [input.deletionId, emptySha256, input.deletionId],
      );
      await connection.query(
        `UPDATE compose_session_sources
         SET s3_key_raw = NULL,
             markdown_path = NULL,
             markdown_content = NULL,
             source_summary = NULL,
             source_entities_json = NULL,
             source_contribution = NULL,
             evidence_json = NULL,
             confidence = NULL,
             artifact_uri = NULL,
             artifact_sha256 = NULL,
             artifact_bytes = NULL,
             content_sha256 = NULL,
             purged_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE deletion_id = ?
           AND deleted_at IS NOT NULL`,
        [input.deletionId],
      );
      await connection.query(
        `UPDATE compose_source_deletions
         SET status = 'purged',
             purged_at = CURRENT_TIMESTAMP(3),
             purge_error = NULL,
             deleted_file_count = ?,
             deleted_object_count = ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'purging'`,
        [
          Math.max(0, Math.trunc(input.deletedFileCount)),
          Math.max(0, Math.trunc(input.deletedObjectCount)),
          input.deletionId,
        ],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "source_deletion",
        aggregateId: input.deletionId,
        eventType: "source.purged",
        dedupeKey: `source-deletion:${input.deletionId}:purged`,
        payload: {
          sessionId: dbNumber(rows[0].session_id),
          sourceId: dbNumber(rows[0].source_id),
          deletionId: input.deletionId,
          deletedFileCount: Math.max(0, Math.trunc(input.deletedFileCount)),
          deletedObjectCount: Math.max(0, Math.trunc(input.deletedObjectCount)),
        },
      });
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markSourceDeletionPurgeFailed(input: {
    deletionId: number;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_source_deletions
       SET status = 'failed',
           purge_error = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'purging'`,
      [input.errorMessage.slice(0, 8000), input.deletionId],
    );
  }

  async markSessionContextDirty(sessionId: number): Promise<void> {
    await this.pool.query(
      `UPDATE compose_sessions
       SET readiness_json = NULL,
           claude_session_id = NULL,
           status = CASE WHEN status = 'ready' THEN 'draft' ELSE status END
       WHERE id = ?
         AND status <> 'archived'`,
      [sessionId],
    );
  }

  // Full reset for re-analyze: drop the conversation and the derived state so a
  // fresh analyze starts a brand-new Claude session from the sources only.
  // Sources are intentionally untouched.
  async resetSessionProgress(sessionId: number): Promise<void> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      await this.resetSessionProgressInTransaction(connection, sessionId);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async resetSessionProgressInTransaction(
    connection: TransactionConnection,
    sessionId: number,
  ): Promise<void> {
    await connection.query(
      `DELETE FROM compose_turn_outputs WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `UPDATE compose_context_patches
       SET source_id = NULL,
           source_revision_id = NULL,
           agent_task_id = NULL,
           turn_job_id = NULL,
           status = 'superseded'
       WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `UPDATE compose_handoffs
       SET build_agent_task_id = NULL
       WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `UPDATE compose_agent_tasks
       SET output_source_id = NULL
       WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `DELETE deletion
       FROM compose_source_deletions deletion
       JOIN compose_session_sources source ON source.id = deletion.source_id
       WHERE source.session_id = ?
         AND source.source_origin = 'agent'`,
      [sessionId],
    );
    await connection.query(
      `DELETE chunks
       FROM compose_source_chunks chunks
       JOIN compose_session_sources source ON source.id = chunks.source_id
       WHERE source.session_id = ?
         AND source.source_origin = 'agent'`,
      [sessionId],
    );
    await connection.query(
      `DELETE revisions
       FROM compose_source_revisions revisions
       JOIN compose_session_sources source ON source.id = revisions.source_id
       WHERE source.session_id = ?
         AND source.source_origin = 'agent'`,
      [sessionId],
    );
    await connection.query(
      `DELETE FROM compose_session_sources
       WHERE session_id = ?
         AND source_origin = 'agent'`,
      [sessionId],
    );
    await connection.query(
      `DELETE FROM compose_agent_runtime_runs WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `DELETE FROM compose_agent_tasks WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `DELETE FROM compose_turn_jobs WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `DELETE FROM compose_session_messages WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `DELETE FROM compose_workspace_manifests WHERE session_id = ?`,
      [sessionId],
    );
    await connection.query(
      `UPDATE compose_sessions
       SET readiness_json = NULL,
           claude_session_id = NULL,
           status = CASE WHEN status = 'ready' THEN 'draft' ELSE status END
       WHERE id = ?
         AND status <> 'archived'`,
      [sessionId],
    );
  }

  async getHardDeletePlan(sessionId: number): Promise<ComposeHardDeletePlan> {
    const [sessionRows] = await this.pool.query<HardDeleteSessionRow[]>(
      `SELECT id, status, archived_at, source_id, s3_prefix, workspace_path
       FROM compose_sessions
       WHERE id = ?
       LIMIT 1`,
      [sessionId],
    );
    const session = sessionRows[0];
    if (!session) {
      throw new Error(`Compose session ${sessionId} was not found`);
    }

    const [countRows] = await this.pool.query<HardDeleteCountRow[]>(
      `SELECT
         (SELECT COUNT(*) FROM compose_session_events WHERE session_id = ?) AS compose_session_events,
         (SELECT COUNT(*) FROM compose_stream_tokens WHERE session_id = ?) AS compose_stream_tokens,
         (SELECT COUNT(*) FROM compose_turn_jobs WHERE session_id = ?) AS compose_turn_jobs,
         (SELECT COUNT(*) FROM compose_turn_outputs WHERE session_id = ?) AS compose_turn_outputs,
         (SELECT COUNT(*) FROM compose_agent_tasks WHERE session_id = ?) AS compose_agent_tasks,
         (SELECT COUNT(*) FROM compose_agent_runtime_runs WHERE session_id = ?) AS compose_agent_runtime_runs,
         (SELECT COUNT(*) FROM compose_context_patches WHERE session_id = ?) AS compose_context_patches,
         (SELECT COUNT(*) FROM compose_context_versions WHERE session_id = ?) AS compose_context_versions,
         (SELECT COUNT(*) FROM compose_session_messages WHERE session_id = ?) AS compose_session_messages,
         (SELECT COUNT(*) FROM compose_session_sources WHERE session_id = ?) AS compose_session_sources,
         (SELECT COUNT(*) FROM compose_source_deletions WHERE session_id = ?) AS compose_source_deletions,
         (SELECT COUNT(*) FROM compose_source_revisions WHERE session_id = ?) AS compose_source_revisions,
         (SELECT COUNT(*) FROM compose_source_chunks WHERE session_id = ?) AS compose_source_chunks,
         (SELECT COUNT(*) FROM compose_handoffs WHERE session_id = ?) AS compose_handoffs,
         (SELECT COUNT(*) FROM compose_handoff_snapshots WHERE session_id = ?) AS compose_handoff_snapshots,
         (SELECT COUNT(*) FROM compose_workspace_manifests WHERE session_id = ?) AS compose_workspace_manifests,
         (SELECT COUNT(*) FROM spec_factory_llm_calls WHERE session_id = ?) AS spec_factory_llm_calls,
         (SELECT COUNT(*) FROM spec_factory_outbox
           WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sessionId')) = CAST(? AS CHAR)
              OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.canonicalEvent.sessionId')) = CAST(? AS CHAR)) AS spec_factory_outbox,
         (SELECT COUNT(*) FROM spec_factory_queue_receipts receipt
           JOIN spec_factory_outbox outbox ON outbox.id = receipt.outbox_id
          WHERE JSON_UNQUOTE(JSON_EXTRACT(outbox.payload_json, '$.sessionId')) = CAST(? AS CHAR)
             OR JSON_UNQUOTE(JSON_EXTRACT(outbox.payload_json, '$.canonicalEvent.sessionId')) = CAST(? AS CHAR)) AS spec_factory_queue_receipts,
         (SELECT COUNT(*) FROM spec_factory_repair_items WHERE session_id = ?) AS spec_factory_repair_items,
         (SELECT COUNT(*) FROM spec_factory_draft_workflows workflow
           JOIN compose_handoffs handoff ON handoff.draft_workflow_id = workflow.id
          WHERE handoff.session_id = ?) AS spec_factory_draft_workflows,
         (SELECT COUNT(*) FROM spec_factory_draft_stage_runs stage
           JOIN spec_factory_draft_workflows workflow ON workflow.id = stage.workflow_id
           JOIN compose_handoffs handoff ON handoff.draft_workflow_id = workflow.id
          WHERE handoff.session_id = ?) AS spec_factory_draft_stage_runs,
         (SELECT COUNT(*) FROM spec_factory_evidence_snapshots evidence
           JOIN compose_sessions compose ON compose.source_id = evidence.source_id
          WHERE compose.id = ?) AS spec_factory_evidence_snapshots,
         (SELECT COUNT(*) FROM spec_factory_drafts draft
           JOIN compose_sessions compose ON compose.source_id = draft.source_id
          WHERE compose.id = ?) AS spec_factory_drafts,
         (SELECT COUNT(*) FROM spec_factory_child_tickets child
           JOIN compose_sessions compose ON compose.source_id = child.source_id
          WHERE compose.id = ?) AS spec_factory_child_tickets,
         (SELECT COUNT(*) FROM spec_factory_events event
           JOIN compose_sessions compose ON compose.source_id = event.source_id
          WHERE compose.id = ?) AS spec_factory_events,
         (SELECT COUNT(*) FROM spec_factory_processing_jobs job
           JOIN compose_sessions compose ON compose.source_id = job.source_id
          WHERE compose.id = ?) AS spec_factory_processing_jobs,
         (SELECT COUNT(*) FROM spec_factory_attachments attachment
           JOIN compose_sessions compose ON compose.source_id = attachment.source_id
          WHERE compose.id = ?) AS spec_factory_attachments,
         (SELECT COUNT(*) FROM spec_factory_sources source
           JOIN compose_sessions compose ON compose.source_id = source.id
          WHERE compose.id = ?) AS spec_factory_sources,
         (SELECT COUNT(*) FROM compose_sessions WHERE id = ?) AS compose_sessions`,
      Array.from({ length: 32 }, () => sessionId),
    );

    const [artifactRows] = await this.pool.query<
      Array<mysql.RowDataPacket & { artifact_uri: string | null }>
    >(
      `SELECT artifact_uri
       FROM (
         SELECT s3_key_raw AS artifact_uri
         FROM compose_session_sources
         WHERE session_id = ? AND s3_key_raw IS NOT NULL
         UNION ALL
         SELECT markdown_path AS artifact_uri
         FROM compose_session_sources
         WHERE session_id = ? AND markdown_path IS NOT NULL
         UNION ALL
         SELECT artifact_uri
         FROM compose_session_sources
         WHERE session_id = ? AND artifact_uri IS NOT NULL
         UNION ALL
         SELECT patch_uri AS artifact_uri
         FROM compose_context_patches
         WHERE session_id = ? AND patch_uri IS NOT NULL
         UNION ALL
         SELECT artifact_uri
         FROM compose_context_versions
         WHERE session_id = ? AND artifact_uri IS NOT NULL
         UNION ALL
         SELECT structured_artifact_uri AS artifact_uri
         FROM compose_context_versions
         WHERE session_id = ? AND structured_artifact_uri IS NOT NULL
         UNION ALL
         SELECT trace_uri AS artifact_uri
         FROM compose_agent_runtime_runs
         WHERE session_id = ? AND trace_uri IS NOT NULL
         UNION ALL
         SELECT output_artifact_uri AS artifact_uri
         FROM compose_agent_runtime_runs
         WHERE session_id = ? AND output_artifact_uri IS NOT NULL
         UNION ALL
         SELECT artifact_uri
         FROM compose_source_revisions
         WHERE session_id = ? AND artifact_uri IS NOT NULL
         UNION ALL
         SELECT artifact_uri
         FROM compose_source_chunks
         WHERE session_id = ? AND artifact_uri IS NOT NULL
         UNION ALL
         SELECT artifact_uri
         FROM compose_handoff_snapshots
         WHERE session_id = ? AND artifact_uri IS NOT NULL
         UNION ALL
         SELECT markdown_artifact_uri AS artifact_uri
         FROM compose_handoff_snapshots
         WHERE session_id = ? AND markdown_artifact_uri IS NOT NULL
         UNION ALL
         SELECT stage.output_artifact_uri AS artifact_uri
         FROM spec_factory_draft_stage_runs stage
         JOIN spec_factory_draft_workflows workflow ON workflow.id = stage.workflow_id
         JOIN compose_handoffs handoff ON handoff.draft_workflow_id = workflow.id
         WHERE handoff.session_id = ? AND stage.output_artifact_uri IS NOT NULL
         UNION ALL
         SELECT redacted_prompt_uri AS artifact_uri
         FROM spec_factory_llm_calls
         WHERE session_id = ? AND redacted_prompt_uri IS NOT NULL
         UNION ALL
         SELECT redacted_response_uri AS artifact_uri
         FROM spec_factory_llm_calls
         WHERE session_id = ? AND redacted_response_uri IS NOT NULL
       ) hard_delete_artifacts
       WHERE artifact_uri IS NOT NULL AND artifact_uri <> ''`,
      Array.from({ length: 15 }, () => sessionId),
    );

    return {
      sessionId: session.id,
      status: session.status,
      archivedAt: session.archived_at ? toIso(session.archived_at) : null,
      linkedSourceId: dbNumberOrNull(session.source_id),
      s3Prefix: session.s3_prefix,
      workspacePath: session.workspace_path,
      rowCounts: hardDeleteRowCounts(countRows[0] ?? {}),
      artifactUris: uniqueNonEmptyStrings(artifactRows),
    };
  }

  async hardDeleteArchivedSession(
    sessionId: number,
  ): Promise<ComposeHardDeleteDbResult> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    const deletedRows = emptyHardDeleteRowCounts();

    try {
      await connection.beginTransaction();
      const [sessionRows] = await connection.query<HardDeleteSessionRow[]>(
        `SELECT id, status, source_id, s3_prefix, workspace_path
         FROM compose_sessions
         WHERE id = ?
         FOR UPDATE`,
        [sessionId],
      );
      const session = sessionRows[0];
      if (!session) {
        throw new Error(`Compose session ${sessionId} was not found`);
      }
      if (session.status !== "archived") {
        throw new Error("compose_hard_delete_requires_archived_session");
      }

      const deleteRows = async (
        table: keyof ComposeHardDeleteRowCounts,
        sql: string,
      ): Promise<void> => {
        const [result] = await connection.query<mysql.ResultSetHeader>(sql, [
          sessionId,
        ]);
        addDeletedRows(deletedRows, table, result);
      };

      const linkedSourceId = dbNumberOrNull(session.source_id);

      const [receiptResult] = await connection.query<mysql.ResultSetHeader>(
        `DELETE receipt
         FROM spec_factory_queue_receipts receipt
         JOIN spec_factory_outbox outbox ON outbox.id = receipt.outbox_id
         WHERE JSON_UNQUOTE(JSON_EXTRACT(outbox.payload_json, '$.sessionId')) = CAST(? AS CHAR)
            OR JSON_UNQUOTE(JSON_EXTRACT(outbox.payload_json, '$.canonicalEvent.sessionId')) = CAST(? AS CHAR)`,
        [sessionId, sessionId],
      );
      addDeletedRows(deletedRows, "spec_factory_queue_receipts", receiptResult);
      const [outboxResult] = await connection.query<mysql.ResultSetHeader>(
        `DELETE FROM spec_factory_outbox
         WHERE JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sessionId')) = CAST(? AS CHAR)
            OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.canonicalEvent.sessionId')) = CAST(? AS CHAR)`,
        [sessionId, sessionId],
      );
      addDeletedRows(deletedRows, "spec_factory_outbox", outboxResult);

      await deleteRows(
        "spec_factory_repair_items",
        `DELETE FROM spec_factory_repair_items WHERE session_id = ?`,
      );
      await connection.query(
        `DELETE repair_run
         FROM spec_factory_repair_runs repair_run
         LEFT JOIN spec_factory_repair_items item
           ON item.repair_run_id = repair_run.id
         WHERE item.id IS NULL`,
      );

      await connection.query(
        `UPDATE compose_handoffs
         SET snapshot_id = NULL, draft_workflow_id = NULL
         WHERE session_id = ?`,
        [sessionId],
      );
      if (linkedSourceId !== null) {
        await connection.query(
          `UPDATE spec_factory_drafts SET workflow_id = NULL WHERE source_id = ?`,
          [linkedSourceId],
        );
        await connection.query(
          `UPDATE spec_factory_draft_workflows
           SET draft_id = NULL, evidence_snapshot_id = NULL
           WHERE source_id = ?`,
          [linkedSourceId],
        );
        const deleteSourceRows = async (
          table: keyof ComposeHardDeleteRowCounts,
          sql: string,
        ): Promise<void> => {
          const [result] = await connection.query<mysql.ResultSetHeader>(sql, [
            linkedSourceId,
          ]);
          addDeletedRows(deletedRows, table, result);
        };
        await deleteSourceRows(
          "spec_factory_child_tickets",
          `DELETE FROM spec_factory_child_tickets WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_drafts",
          `DELETE FROM spec_factory_drafts WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_draft_stage_runs",
          `DELETE FROM spec_factory_draft_stage_runs WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_draft_workflows",
          `DELETE FROM spec_factory_draft_workflows WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_evidence_snapshots",
          `DELETE FROM spec_factory_evidence_snapshots WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_events",
          `DELETE FROM spec_factory_events WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_processing_jobs",
          `DELETE FROM spec_factory_processing_jobs WHERE source_id = ?`,
        );
        await deleteSourceRows(
          "spec_factory_attachments",
          `DELETE FROM spec_factory_attachments WHERE source_id = ?`,
        );
      }

      await deleteRows(
        "compose_handoff_snapshots",
        `DELETE FROM compose_handoff_snapshots WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_handoffs",
        `DELETE FROM compose_handoffs WHERE session_id = ?`,
      );

      await deleteRows(
        "compose_session_events",
        `DELETE FROM compose_session_events WHERE session_id = ?`,
      );
      await deleteRows(
        "spec_factory_llm_calls",
        `DELETE FROM spec_factory_llm_calls WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_workspace_manifests",
        `DELETE FROM compose_workspace_manifests WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_stream_tokens",
        `DELETE FROM compose_stream_tokens WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_turn_outputs",
        `DELETE FROM compose_turn_outputs WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_context_versions",
        `DELETE FROM compose_context_versions WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_context_patches",
        `DELETE FROM compose_context_patches WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_agent_runtime_runs",
        `DELETE FROM compose_agent_runtime_runs WHERE session_id = ?`,
      );
      await connection.query(
        `UPDATE compose_agent_tasks
         SET output_source_id = NULL
         WHERE session_id = ?`,
        [sessionId],
      );
      await deleteRows(
        "compose_source_chunks",
        `DELETE FROM compose_source_chunks WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_source_revisions",
        `DELETE FROM compose_source_revisions WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_source_deletions",
        `DELETE FROM compose_source_deletions WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_session_sources",
        `DELETE FROM compose_session_sources WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_agent_tasks",
        `DELETE FROM compose_agent_tasks WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_turn_jobs",
        `DELETE FROM compose_turn_jobs WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_session_messages",
        `DELETE FROM compose_session_messages WHERE session_id = ?`,
      );
      await deleteRows(
        "compose_sessions",
        `DELETE FROM compose_sessions
         WHERE id = ? AND status = 'archived'`,
      );

      if (deletedRows.compose_sessions !== 1) {
        throw new Error("compose_hard_delete_session_delete_failed");
      }
      if (linkedSourceId !== null) {
        const [sourceResult] = await connection.query<mysql.ResultSetHeader>(
          `DELETE FROM spec_factory_sources
           WHERE id = ? AND origin = 'compose'`,
          [linkedSourceId],
        );
        addDeletedRows(deletedRows, "spec_factory_sources", sourceResult);
      }

      await connection.commit();
      return { sessionId, deletedRows };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listComposeS3Prefixes(input: {
    rootPrefix: string;
    limit: number;
  }): Promise<string[]> {
    const root = input.rootPrefix.trim().replace(/^\/+/, "");
    const prefix = root.endsWith("/") ? root : `${root}/`;
    const limit =
      Number.isFinite(input.limit) && input.limit > 0
        ? Math.floor(input.limit)
        : 1000;
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { s3_prefix: string | null }>
    >(
      `SELECT DISTINCT s3_prefix
       FROM compose_sessions
       WHERE s3_prefix LIKE ?
       ORDER BY s3_prefix ASC
       LIMIT ?`,
      [`${prefix}%`, limit],
    );
    return [
      ...new Set(
        rows
          .map((row) => row.s3_prefix?.trim() ?? "")
          .filter((value) => value.length > 0),
      ),
    ];
  }

  async listReferencedArtifactKeys(input: {
    rootPrefix: string;
    limit: number;
  }): Promise<{ keys: string[]; truncated: boolean }> {
    const rootPrefix = input.rootPrefix.trim().replace(/^\/+/, "");
    if (!rootPrefix) {
      throw new Error("artifact_reachability_unsafe_prefix");
    }
    const prefix = rootPrefix.endsWith("/") ? rootPrefix : `${rootPrefix}/`;
    const limit = Math.max(1, Math.min(100_000, Math.trunc(input.limit)));
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { artifact_uri: string | null }>
    >(
      `SELECT artifact_uri
       FROM (
         SELECT artifact_uri FROM compose_session_sources WHERE artifact_uri IS NOT NULL
         UNION ALL SELECT patch_uri FROM compose_context_patches WHERE patch_uri IS NOT NULL
         UNION ALL SELECT artifact_uri FROM compose_context_versions WHERE artifact_uri IS NOT NULL
         UNION ALL SELECT structured_artifact_uri FROM compose_context_versions WHERE structured_artifact_uri IS NOT NULL
         UNION ALL SELECT trace_uri FROM compose_agent_runtime_runs WHERE trace_uri IS NOT NULL
         UNION ALL SELECT output_artifact_uri FROM compose_agent_runtime_runs WHERE output_artifact_uri IS NOT NULL
         UNION ALL SELECT artifact_uri FROM compose_source_revisions WHERE artifact_uri IS NOT NULL
         UNION ALL SELECT artifact_uri FROM compose_source_chunks WHERE artifact_uri IS NOT NULL
         UNION ALL SELECT artifact_uri FROM compose_handoff_snapshots WHERE artifact_uri IS NOT NULL
         UNION ALL SELECT markdown_artifact_uri FROM compose_handoff_snapshots WHERE markdown_artifact_uri IS NOT NULL
         UNION ALL SELECT output_artifact_uri FROM spec_factory_draft_stage_runs WHERE output_artifact_uri IS NOT NULL
         UNION ALL SELECT redacted_prompt_uri FROM spec_factory_llm_calls WHERE redacted_prompt_uri IS NOT NULL
         UNION ALL SELECT redacted_response_uri FROM spec_factory_llm_calls WHERE redacted_response_uri IS NOT NULL
         UNION ALL SELECT report_uri FROM spec_factory_repair_runs WHERE report_uri IS NOT NULL
         UNION ALL
         SELECT workspace_file.artifact_uri
         FROM compose_workspace_manifests manifest
         JOIN JSON_TABLE(
           manifest.manifest_json,
           '$.files[*]' COLUMNS(artifact_uri TEXT PATH '$.artifactUri')
         ) workspace_file
         WHERE workspace_file.artifact_uri IS NOT NULL
       ) referenced_artifacts
       WHERE artifact_uri <> ''
       LIMIT ?`,
      [limit + 1],
    );
    const truncated = rows.length > limit;
    const keys = [
      ...new Set(
        rows
          .slice(0, limit)
          .map((row) => artifactKey(row.artifact_uri))
          .filter((key): key is string => Boolean(key?.startsWith(prefix))),
      ),
    ];
    return { keys, truncated };
  }

  async updateSourceS3Key(input: {
    sourceId: number;
    s3KeyRaw: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources SET s3_key_raw = ? WHERE id = ?`,
      [input.s3KeyRaw, input.sourceId],
    );
  }

  async getSessionSource(
    sourceId: number,
  ): Promise<ComposeSessionSourceSummary | null> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, session_id, request_id, kind, original_filename, mime_type, size_bytes,
              source_url, s3_key_raw, converter, markdown_path, markdown_content,
              source_summary, source_entities_json, source_usefulness, source_contribution,
              source_origin, generated_by_task_id, parent_source_ids_json,
              context_version_used, evidence_json, confidence, artifact_uri,
              artifact_sha256, artifact_bytes,
              current_revision_id, content_sha256,
              conversion_status, conversion_started_at, conversion_attempts,
              conversion_lease_expires_at, error_message, created_at, updated_at
       FROM compose_session_sources
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [sourceId],
    );
    return rows[0] ? this.mapSource(rows[0]) : null;
  }

  async listSessionSources(
    sessionId: number,
  ): Promise<ComposeSessionSourceSummary[]> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, session_id, request_id, kind, original_filename, mime_type, size_bytes,
              source_url, s3_key_raw, converter, markdown_path, markdown_content,
              source_summary, source_entities_json, source_usefulness, source_contribution,
              source_origin, generated_by_task_id, parent_source_ids_json,
              context_version_used, evidence_json, confidence, artifact_uri,
              artifact_sha256, artifact_bytes,
              current_revision_id, content_sha256,
              conversion_status, conversion_started_at, conversion_attempts,
              conversion_lease_expires_at, error_message, created_at, updated_at
       FROM compose_session_sources
       WHERE session_id = ?
         AND deleted_at IS NULL
       ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map((row) => this.mapSource(row));
  }

  // Optimistic claim (vs. the FOR UPDATE transaction in claimNextProcessingJob):
  // a conditional UPDATE — only one concurrent worker gets affectedRows===1;
  // the loser returns null and the drain loop re-claims. Avoids holding a
  // connection during the follow-up getSessionSource read.
  async claimNextPendingSource(
    input: {
      leaseMs?: number;
    } = {},
  ): Promise<ClaimedConversionSource | null> {
    const leaseSeconds = Math.max(
      1,
      Math.ceil((input.leaseMs ?? DEFAULT_CONVERSION_LEASE_MS) / 1000),
    );
    const [pending] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          id: number;
          session_id: number;
          queued_at: Date | string;
        }
      >
    >(
      `SELECT src.id, src.session_id,
              CASE
                WHEN src.conversion_status = 'pending' THEN src.updated_at
                ELSE src.conversion_lease_expires_at
              END AS queued_at
       FROM compose_session_sources src
       JOIN compose_sessions s ON s.id = src.session_id
       WHERE s.status <> 'archived'
         AND src.deleted_at IS NULL
         AND (
           src.conversion_status = 'pending'
           OR (
             src.conversion_status = 'converting'
             AND src.conversion_lease_expires_at < CURRENT_TIMESTAMP(3)
           )
          )
       ORDER BY src.id ASC
       LIMIT 1`,
    );
    const row = pending[0];
    if (!row) return null;

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_session_sources
       SET conversion_status = 'converting',
           conversion_started_at = CURRENT_TIMESTAMP(3),
           conversion_attempts = conversion_attempts + 1,
           conversion_lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)
       WHERE id = ?
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )
         AND (
           conversion_status = 'pending'
           OR (
             conversion_status = 'converting'
             AND conversion_lease_expires_at < CURRENT_TIMESTAMP(3)
           )
         )`,
      [leaseSeconds, row.id],
    );
    if (result.affectedRows !== 1) return null;

    const source = await this.getSessionSource(row.id);
    return source
      ? { ...source, conversionQueuedAt: toIso(row.queued_at) }
      : null;
  }

  async markSourceConverted(input: {
    sourceId: number;
    markdownPath: string | null;
    markdownContent: string;
  }): Promise<void> {
    const existing = await this.getSessionSource(input.sourceId);
    const intelligence = deriveComposeSourceIntelligence({
      kind: existing?.kind ?? "file",
      filename: existing?.originalFilename ?? "source",
      markdown: input.markdownContent,
    });
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'converted',
           markdown_path = ?,
           markdown_content = ?,
           source_summary = ?,
           source_entities_json = CAST(? AS JSON),
           source_usefulness = ?,
           source_contribution = ?,
           conversion_started_at = NULL,
           conversion_lease_expires_at = NULL,
           error_message = NULL
       WHERE id = ?
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [
        input.markdownPath,
        input.markdownContent,
        intelligence.summary,
        JSON.stringify(intelligence.entities),
        intelligence.usefulness,
        intelligence.contribution,
        input.sourceId,
      ],
    );
  }

  async completeSourceConversion(
    input: CompleteSourceConversionInput,
  ): Promise<CompleteSourceConversionResult> {
    const existing = await this.getSessionSource(input.sourceId);
    if (!existing) {
      throw new Error(`Compose source ${input.sourceId} was not found`);
    }
    const intelligence = deriveComposeSourceIntelligence({
      kind: existing.kind,
      filename: existing.originalFilename ?? "source",
      markdown: input.markdownContent,
    });
    const contentSha256 = createHash("sha256")
      .update(input.markdownContent)
      .digest("hex");
    const artifactBytes = Buffer.byteLength(input.markdownContent, "utf8");
    const chunks = chunkSourceMarkdown(input.markdownContent);
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sourceResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE compose_session_sources
         SET conversion_status = 'converted',
             markdown_path = ?,
             markdown_content = ?,
             source_summary = ?,
             source_entities_json = CAST(? AS JSON),
             source_usefulness = ?,
             source_contribution = ?,
             content_sha256 = ?,
             conversion_started_at = NULL,
             conversion_lease_expires_at = NULL,
             error_message = NULL
         WHERE id = ?
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM compose_sessions s
             WHERE s.id = compose_session_sources.session_id
               AND s.status <> 'archived'
           )`,
        [
          input.markdownPath,
          input.markdownContent,
          intelligence.summary,
          JSON.stringify(intelligence.entities),
          intelligence.usefulness,
          intelligence.contribution,
          contentSha256,
          input.sourceId,
        ],
      );
      if ((sourceResult.affectedRows ?? 0) !== 1) {
        throw new Error(
          `Compose source ${input.sourceId} was not found or is archived`,
        );
      }

      const [revisionRows] = await connection.query<
        Array<mysql.RowDataPacket & { revision_number: number | string }>
      >(
        `SELECT revision_number
         FROM compose_source_revisions
         WHERE source_id = ?
         ORDER BY revision_number DESC
         LIMIT 1
         FOR UPDATE`,
        [input.sourceId],
      );
      const revisionNumber = Number(revisionRows[0]?.revision_number ?? 0) + 1;
      const artifactUri =
        input.markdownPath ??
        `db://compose/sessions/${existing.sessionId}/sources/${input.sourceId}/revisions/${revisionNumber}`;
      const [revisionResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO compose_source_revisions
           (session_id, source_id, revision_number, content_sha256,
            artifact_uri, artifact_sha256, artifact_bytes, content_type,
            status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'text/markdown', 'ready', ?)
           ON DUPLICATE KEY UPDATE
             id = LAST_INSERT_ID(id),
             status = 'ready'`,
        [
          existing.sessionId,
          input.sourceId,
          revisionNumber,
          contentSha256,
          artifactUri,
          contentSha256,
          artifactBytes,
          "compose-conversion-worker",
        ],
      );
      const sourceRevisionId = revisionResult.insertId;
      await connection.query(
        `UPDATE compose_source_revisions
         SET status = 'superseded'
         WHERE source_id = ?
           AND id <> ?
           AND status = 'ready'`,
        [input.sourceId, sourceRevisionId],
      );
      for (const chunk of chunks) {
        const chunkSha256 = createHash("sha256")
          .update(chunk.content)
          .digest("hex");
        await connection.query(
          `INSERT INTO compose_source_chunks
           (session_id, source_id, source_revision_id, chunk_index,
            start_offset, end_offset, token_estimate, content_text,
            content_sha256, artifact_uri, artifact_sha256, artifact_bytes,
            status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
           ON DUPLICATE KEY UPDATE id = id`,
          [
            existing.sessionId,
            input.sourceId,
            sourceRevisionId,
            chunk.index,
            chunk.startOffset,
            chunk.endOffset,
            chunk.tokenEstimate,
            chunk.content,
            chunkSha256,
            `${artifactUri}#chunk-${chunk.index}`,
            chunkSha256,
            Buffer.byteLength(chunk.content, "utf8"),
          ],
        );
      }
      await connection.query(
        `UPDATE compose_session_sources
         SET current_revision_id = ?,
             content_sha256 = ?
         WHERE id = ?
           AND session_id = ?`,
        [sourceRevisionId, contentSha256, input.sourceId, existing.sessionId],
      );

      let distillationAgentTaskId: number | null = null;
      if (input.distillationTask) {
        const task = input.distillationTask;
        const requestId =
          task.requestId ?? currentSpecFactoryCorrelation().requestId ?? null;
        const priority = Number.isFinite(task.priority)
          ? Math.trunc(task.priority as number)
          : DEFAULT_AGENT_TASK_PRIORITY;
        const maxAttempts = Number.isFinite(task.maxAttempts)
          ? Math.max(1, Math.trunc(task.maxAttempts as number))
          : DEFAULT_AGENT_TASK_MAX_ATTEMPTS;
        const [taskResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_agent_tasks
           (session_id, turn_job_id, capability, executor_type, request_id,
            priority, input_json, max_attempts, output_source_id)
           SELECT ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?
           FROM compose_sessions
           WHERE id = ?
             AND status <> 'archived'
           LIMIT 1`,
          [
            task.sessionId,
            task.turnJobId ?? null,
            task.capability,
            task.executorType ?? null,
            requestId,
            priority,
            JSON.stringify({
              ...(task.input && typeof task.input === "object"
                ? (task.input as Record<string, unknown>)
                : {}),
              sourceRevisionId,
              chunkCount: chunks.length,
            }),
            maxAttempts,
            task.outputSourceId ?? null,
            task.sessionId,
          ],
        );
        if ((taskResult.affectedRows ?? 1) !== 1) {
          throw new Error(`Compose session ${task.sessionId} was not found`);
        }
        distillationAgentTaskId = taskResult.insertId;

        const payloadJson = JSON.stringify(task.event.payload);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
        if (payloadBytes > MAX_SESSION_EVENT_PAYLOAD_BYTES) {
          throw new Error(
            `Compose session event payload exceeds ${MAX_SESSION_EVENT_PAYLOAD_BYTES} bytes`,
          );
        }
        const [eventResult] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO compose_session_events
           (session_id, event_type, sequence, payload_json, payload_bytes,
            actor_type, actor_id, request_id, turn_job_id, agent_task_id,
            context_version)
           SELECT ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?, ?
           FROM compose_sessions
           WHERE id = ?
             AND (status <> 'archived'
                  OR ? IN ('session.archived', 'turn.cancelling',
                           'turn.cancelled', 'task.cancelled',
                           'turn.lease_fence_rejected',
                           'task.lease_fence_rejected',
                           'turn.discarded_due_to_archive',
                           'assistant.discarded_due_to_archive'))
           LIMIT 1`,
          [
            task.sessionId,
            task.event.eventType,
            null,
            payloadJson,
            payloadBytes,
            task.event.actorType ?? null,
            task.event.actorId ?? null,
            task.event.requestId ?? requestId,
            task.event.turnJobId ?? null,
            distillationAgentTaskId,
            task.event.contextVersion ?? null,
            task.sessionId,
            task.event.eventType,
          ],
        );
        if ((eventResult.affectedRows ?? 1) !== 1) {
          throw new Error(
            `Compose session event ${task.event.eventType} was not inserted`,
          );
        }
        await appendSpecFactoryOutboxEvent(connection, {
          aggregateType: "agent_task",
          aggregateId: distillationAgentTaskId,
          eventType: task.event.eventType,
          dedupeKey: `agent-task:${distillationAgentTaskId}:${task.event.eventType}:g1`,
          payload: {
            ...(task.event.payload && typeof task.event.payload === "object"
              ? (task.event.payload as Record<string, unknown>)
              : { payload: task.event.payload }),
            sessionId: task.sessionId,
            agentTaskId: distillationAgentTaskId,
            sourceRevisionId,
            queueGeneration: 1,
          },
        });
      }

      await connection.commit();
      if (input.distillationTask) {
        specFactoryMetrics.recordWorkAccepted({
          workType: "agent_task",
          subtype: input.distillationTask.capability,
        });
      }
      return {
        distillationAgentTaskId,
        sourceRevisionId,
        chunkCount: chunks.length,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async listSourceChunks(
    sourceRevisionId: number,
  ): Promise<ComposeSourceChunk[]> {
    const [rows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          id: number | string;
          source_revision_id: number | string;
          chunk_index: number | string;
          content_text: string;
          artifact_uri: string;
          content_sha256: string;
        }
      >
    >(
      `SELECT id, source_revision_id, chunk_index, content_text, artifact_uri,
              content_sha256
       FROM compose_source_chunks
       WHERE source_revision_id = ?
         AND status = 'ready'
       ORDER BY chunk_index ASC, id ASC`,
      [sourceRevisionId],
    );
    return rows.map((row) => ({
      id: dbNumber(row.id),
      sourceRevisionId: dbNumber(row.source_revision_id),
      chunkIndex: dbNumber(row.chunk_index),
      content: row.content_text,
      artifactUri: row.artifact_uri,
      contentSha256: row.content_sha256,
    }));
  }

  async markSourceFailed(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'failed',
           conversion_started_at = NULL,
           conversion_lease_expires_at = NULL,
           error_message = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [input.errorMessage, input.sourceId],
    );
  }

  async markSourceUnsupported(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'unsupported',
           conversion_started_at = NULL,
           conversion_lease_expires_at = NULL,
           error_message = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [input.errorMessage, input.sourceId],
    );
  }

  /**
   * Schedule a transient-failure retry without a schema change: keep the row
   * `converting` but push its lease `retryDelayMs` into the future and record
   * the error. claimNextPendingSource only re-picks a `converting` row once its
   * lease has expired, so the future lease acts as the backoff gate. The
   * already-incremented conversion_attempts bounds how many times this happens.
   */
  async markSourceForRetry(input: {
    sourceId: number;
    errorMessage: string;
    retryDelayMs: number;
  }): Promise<void> {
    const delaySeconds = Math.max(1, Math.ceil(input.retryDelayMs / 1000));
    await this.pool.query(
      `UPDATE compose_session_sources
       SET conversion_status = 'converting',
           conversion_started_at = NULL,
           conversion_lease_expires_at =
             DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND),
           error_message = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [delaySeconds, input.errorMessage, input.sourceId],
    );
  }

  async reconvertSource(input: {
    sessionId: number;
    sourceId: number;
  }): Promise<void> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_session_sources
       SET conversion_status = 'pending',
           request_id = COALESCE(?, request_id),
           conversion_started_at = NULL,
           conversion_lease_expires_at = NULL,
           error_message = NULL
       WHERE id = ?
         AND session_id = ?
         AND conversion_status IN ('failed','unsupported')
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [
        currentSpecFactoryCorrelation().requestId ?? null,
        input.sourceId,
        input.sessionId,
      ],
    );
    if (result.affectedRows !== 1) {
      throw new Error(
        `Compose source ${input.sourceId} was not found in session ${input.sessionId} or is not failed/unsupported`,
      );
    }
    specFactoryMetrics.recordWorkAccepted({
      workType: "conversion",
      subtype: "reconvert",
    });
  }

  async reconvertFailedSessionSources(sessionId: number): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE compose_session_sources
       SET conversion_status = 'pending',
           request_id = COALESCE(?, request_id),
           conversion_started_at = NULL,
           conversion_lease_expires_at = NULL,
           error_message = NULL
       WHERE session_id = ?
         AND conversion_status IN ('failed','unsupported')
         AND EXISTS (
           SELECT 1
           FROM compose_sessions s
           WHERE s.id = compose_session_sources.session_id
             AND s.status <> 'archived'
         )`,
      [currentSpecFactoryCorrelation().requestId ?? null, sessionId],
    );
    for (let i = 0; i < result.affectedRows; i += 1) {
      specFactoryMetrics.recordWorkAccepted({
        workType: "conversion",
        subtype: "reconvert",
      });
    }
    return result.affectedRows;
  }

  async getConversionQueueHealth(): Promise<ComposeConversionQueueHealth> {
    const [rows] = await this.pool.query<ConversionHealthRow[]>(
      `SELECT conversion_status,
              COUNT(*) AS count,
              MIN(created_at) AS oldest_created_at,
              MIN(conversion_started_at) AS oldest_started_at
       FROM compose_session_sources
       WHERE deleted_at IS NULL
       GROUP BY conversion_status`,
    );

    const byStatus = Object.fromEntries(
      CONVERSION_STATUSES.map((status) => [status, 0]),
    ) as ComposeConversionQueueHealth["byStatus"];
    let oldestPendingAt: string | null = null;
    let oldestConvertingAt: string | null = null;

    for (const row of rows) {
      const count = Number(row.count);
      byStatus[row.conversion_status] = Number.isFinite(count) ? count : 0;
      if (
        row.conversion_status === "awaiting_upload" ||
        row.conversion_status === "pending"
      ) {
        const iso = row.oldest_created_at ? toIso(row.oldest_created_at) : null;
        if (iso && (!oldestPendingAt || iso < oldestPendingAt)) {
          oldestPendingAt = iso;
        }
      }
      if (row.conversion_status === "converting") {
        oldestConvertingAt = row.oldest_started_at
          ? toIso(row.oldest_started_at)
          : row.oldest_created_at
            ? toIso(row.oldest_created_at)
            : null;
      }
    }

    return {
      byStatus,
      inFlight:
        byStatus.awaiting_upload + byStatus.pending + byStatus.converting,
      retryable: byStatus.failed + byStatus.unsupported,
      oldestPendingAt,
      oldestConvertingAt,
    };
  }

  async getControlPlaneHealth(): Promise<ComposeControlPlaneHealth> {
    const [
      turnResult,
      agentTaskResult,
      agentTaskCapabilityResult,
      llmResult,
      llmPurposeResult,
      workerResult,
      fenceResult,
      outcomeResult,
      coordinatorResult,
      retentionResult,
      eventResult,
      streamTokenResult,
      researchResult,
      contextResult,
    ] = await Promise.all([
      this.pool.query<ControlPlaneHealthRow[]>(
        `SELECT status,
                COUNT(*) AS count,
                MIN(created_at) AS oldest_created_at,
                MIN(started_at) AS oldest_started_at,
                SUM(CASE WHEN error_code = 'lease_expired' THEN 1 ELSE 0 END)
                  AS lease_expired
         FROM compose_turn_jobs
         GROUP BY status`,
      ),
      this.pool.query<ControlPlaneHealthRow[]>(
        `SELECT status,
                COUNT(*) AS count,
                MIN(created_at) AS oldest_created_at,
                MIN(started_at) AS oldest_started_at,
                SUM(CASE WHEN error_code = 'lease_expired' THEN 1 ELSE 0 END)
                AS lease_expired
         FROM compose_agent_tasks
         GROUP BY status`,
      ),
      this.pool.query<ControlPlaneAgentTaskCapabilityHealthRow[]>(
        `SELECT capability,
                status,
                COUNT(*) AS count,
                MIN(created_at) AS oldest_created_at,
                MIN(started_at) AS oldest_started_at,
                SUM(CASE WHEN error_code = 'lease_expired' THEN 1 ELSE 0 END)
                  AS lease_expired
         FROM compose_agent_tasks
         GROUP BY capability, status
         ORDER BY capability ASC, status ASC`,
      ),
      this.pool.query<ControlPlaneLlmHealthRow[]>(
        `SELECT COUNT(*) AS calls_today,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
                  AS failed_today,
                COALESCE(SUM(input_tokens), 0) AS input_tokens_today,
                COALESCE(SUM(output_tokens), 0) AS output_tokens_today,
                COALESCE(SUM(estimated_cost_usd), 0)
                  AS estimated_cost_usd_today,
                MAX(created_at) AS latest_call_at
         FROM spec_factory_llm_calls
         WHERE created_at >= UTC_DATE()`,
      ),
      this.pool.query<ControlPlaneLlmPurposeHealthRow[]>(
        `SELECT purpose,
                COUNT(*) AS calls_today,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
                  AS failed_today,
                COALESCE(SUM(input_tokens), 0) AS input_tokens_today,
                COALESCE(SUM(output_tokens), 0) AS output_tokens_today,
                COALESCE(SUM(estimated_cost_usd), 0)
                  AS estimated_cost_usd_today,
                MAX(created_at) AS latest_call_at
         FROM spec_factory_llm_calls
         WHERE created_at >= UTC_DATE()
         GROUP BY purpose
         ORDER BY estimated_cost_usd_today DESC, calls_today DESC
         LIMIT 25`,
      ),
      this.pool.query<ControlPlaneWorkerHealthRow[]>(
        `SELECT mode,
                COUNT(*) AS total,
                SUM(CASE
                      WHEN heartbeat_at >= CURRENT_TIMESTAMP(3) - INTERVAL 45 SECOND
                      THEN 1 ELSE 0 END) AS live,
                SUM(CASE
                      WHEN heartbeat_at < CURRENT_TIMESTAMP(3) - INTERVAL 45 SECOND
                      THEN 1 ELSE 0 END) AS stale,
                MAX(heartbeat_at) AS latest_heartbeat_at
         FROM spec_factory_worker_heartbeats
         GROUP BY mode`,
      ),
      this.pool.query<ControlPlaneFenceHealthRow[]>(
        `SELECT
              SUM(CASE WHEN event_type = 'turn.lease_fence_rejected' THEN 1 ELSE 0 END)
                AS turn_lease_fence_rejected,
              SUM(CASE WHEN event_type = 'task.lease_fence_rejected' THEN 1 ELSE 0 END)
                AS agent_task_lease_fence_rejected,
              SUM(CASE
                    WHEN event_type = 'turn.duplicate_suppressed'
                     AND created_at >= UTC_DATE()
                    THEN 1 ELSE 0
                  END) AS turn_duplicate_suppressed_today
         FROM compose_session_events
         WHERE event_type IN ('turn.lease_fence_rejected',
                              'task.lease_fence_rejected',
                              'turn.duplicate_suppressed')`,
      ),
      this.pool.query<ControlPlaneTurnOutcomeRow[]>(
        `SELECT context_version_used,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
                  AS completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)
                  AS failed,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)
                  AS cancelled,
                SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END)
                  AS abandoned,
                COUNT(*) AS total
         FROM compose_turn_jobs
         WHERE completed_at >= UTC_DATE()
           AND status IN ('completed', 'failed', 'cancelled', 'abandoned')
         GROUP BY context_version_used
         ORDER BY context_version_used IS NULL ASC,
                  context_version_used DESC
         LIMIT 25`,
      ),
      this.pool.query<ControlPlaneCoordinatorHealthRow[]>(
        `SELECT
              SUM(CASE
                    WHEN event_type = 'turn.completed'
                     AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.coordinatorAction')) = 'answer'
                    THEN 1 ELSE 0
                  END) AS answer_today,
              COUNT(DISTINCT CASE
                    WHEN event_type = 'task.queued'
                     AND actor_id = 'chat_coordinator'
                     AND turn_job_id IS NOT NULL
                    THEN turn_job_id ELSE NULL
                  END) AS dispatch_research_today,
              SUM(CASE
                    WHEN event_type = 'turn.awaiting_user_input'
                     AND actor_id = 'chat_coordinator'
                    THEN 1 ELSE 0
                  END) AS ask_clarification_today,
              SUM(CASE
                    WHEN event_type = 'turn.completed'
                     AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.coordinatorAction')) = 'escalate'
                    THEN 1 ELSE 0
                  END) AS escalate_today,
              SUM(CASE
                    WHEN event_type = 'coordinator.decision.rejected'
                    THEN 1 ELSE 0
                  END) AS rejected_today,
              MAX(created_at) AS latest_decision_at
         FROM compose_session_events
         WHERE created_at >= UTC_DATE()
           AND (event_type IN ('turn.completed',
                               'turn.awaiting_user_input',
                               'coordinator.decision.rejected')
                OR (event_type = 'task.queued'
                    AND actor_id = 'chat_coordinator'))`,
      ),
      this.pool.query<ControlPlaneRetentionHealthRow[]>(
        `SELECT
              COUNT(*) AS pending_workspace_cleanup,
              SUM(CASE
                    WHEN workspace_cleanup_error IS NOT NULL
                     AND workspace_cleanup_error <> ''
                    THEN 1 ELSE 0
                  END) AS failed_workspace_cleanup,
              MIN(archived_at) AS oldest_pending_archived_at,
              MAX(CASE
                    WHEN workspace_cleanup_error IS NOT NULL
                     AND workspace_cleanup_error <> ''
                    THEN updated_at ELSE NULL
                  END) AS latest_cleanup_error_at,
              (SELECT COUNT(*)
                 FROM spec_factory_llm_calls
                WHERE redacted_prompt_uri IS NOT NULL
                   OR redacted_response_uri IS NOT NULL)
                AS pending_llm_audit_artifacts,
              (SELECT MIN(created_at)
                 FROM spec_factory_llm_calls
                WHERE redacted_prompt_uri IS NOT NULL
                   OR redacted_response_uri IS NOT NULL)
                AS oldest_pending_llm_audit_artifact_at
         FROM compose_sessions
         WHERE status = 'archived'
           AND archived_at IS NOT NULL
           AND workspace_cleaned_at IS NULL`,
      ),
      this.pool.query<ControlPlaneEventHealthRow[]>(
        `SELECT
              COUNT(*) AS durable_published_today,
              SUM(CASE
                    WHEN JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.code')) = 'event_persist_failed'
                    THEN 1 ELSE 0
                  END) AS durable_persist_failures_today,
              SUM(CASE
                    WHEN JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.code')) = 'payload_too_large'
                    THEN 1 ELSE 0
                  END) AS payload_too_large_today,
              MAX(created_at) AS latest_published_at,
              MAX(CASE
                    WHEN event_type = 'error'
                     AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.code'))
                       IN ('event_persist_failed', 'payload_too_large')
                    THEN created_at ELSE NULL
                  END) AS latest_durable_error_at
         FROM compose_session_events
         WHERE created_at >= UTC_DATE()`,
      ),
      this.pool.query<ControlPlaneStreamTokenHealthRow[]>(
        `SELECT
              SUM(CASE
                    WHEN revoked_at IS NULL
                     AND expires_at > CURRENT_TIMESTAMP(3)
                    THEN 1 ELSE 0
                  END) AS active_tokens,
              SUM(CASE
                    WHEN revoked_at IS NULL
                     AND expires_at <= CURRENT_TIMESTAMP(3)
                    THEN 1 ELSE 0
                  END) AS expired_unrevoked_tokens,
              SUM(CASE WHEN created_at >= UTC_DATE() THEN 1 ELSE 0 END)
                AS created_today,
              SUM(CASE WHEN revoked_at >= UTC_DATE() THEN 1 ELSE 0 END)
                AS revoked_today,
              MAX(created_at) AS latest_created_at,
              MAX(revoked_at) AS latest_revoked_at
         FROM compose_stream_tokens`,
      ),
      this.pool.query<ControlPlaneResearchHealthRow[]>(
        `SELECT
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END)
                AS running_tasks,
              SUM(CASE
                    WHEN status = 'completed'
                     AND completed_at >= UTC_DATE()
                    THEN 1 ELSE 0
                  END) AS completed_today,
              SUM(CASE
                    WHEN status = 'failed'
                     AND completed_at >= UTC_DATE()
                    THEN 1 ELSE 0
                  END) AS failed_today,
              AVG(CASE
                    WHEN status IN ('completed', 'failed')
                     AND started_at IS NOT NULL
                     AND completed_at IS NOT NULL
                     AND completed_at >= UTC_DATE()
                    THEN TIMESTAMPDIFF(SECOND, started_at, completed_at)
                    ELSE NULL
                  END) AS avg_runtime_seconds_today,
              MAX(CASE
                    WHEN status IN ('completed', 'failed')
                     AND started_at IS NOT NULL
                     AND completed_at IS NOT NULL
                     AND completed_at >= UTC_DATE()
                    THEN TIMESTAMPDIFF(SECOND, started_at, completed_at)
                    ELSE NULL
                  END) AS max_runtime_seconds_today,
              MIN(CASE
                    WHEN status = 'running' THEN started_at ELSE NULL
                  END) AS oldest_running_started_at,
              MAX(CASE
                    WHEN status IN ('completed', 'failed')
                    THEN completed_at ELSE NULL
                  END) AS latest_terminal_at
         FROM compose_agent_tasks
         WHERE capability IN (${RESEARCH_CAPABILITY_SQL_LIST})`,
      ),
      this.pool.query<ControlPlaneContextHealthRow[]>(
        `SELECT
              SUM(CASE WHEN p.status = 'ready' THEN 1 ELSE 0 END)
                AS patches_ready,
              SUM(CASE WHEN p.status = 'building' THEN 1 ELSE 0 END)
                AS patches_building,
              SUM(CASE WHEN p.status = 'failed' THEN 1 ELSE 0 END)
                AS patches_failed,
              MIN(CASE WHEN p.status = 'ready' THEN p.created_at ELSE NULL END)
                AS oldest_ready_patch_at,
              (SELECT COUNT(*)
                 FROM compose_context_versions v
                WHERE v.status = 'committed'
                  AND COALESCE(v.committed_at, v.created_at) >= UTC_DATE())
                AS versions_committed_today,
              (SELECT COUNT(*)
                 FROM compose_context_versions v
                WHERE v.status = 'failed'
                  AND v.created_at >= UTC_DATE())
                AS versions_failed_today,
              (SELECT COUNT(*)
                 FROM compose_context_versions v
                WHERE v.status = 'building')
                AS versions_building,
              (SELECT MAX(COALESCE(v.committed_at, v.created_at))
                 FROM compose_context_versions v
                WHERE v.status = 'committed')
                AS latest_committed_version_at,
              (SELECT MAX(v.created_at)
                 FROM compose_context_versions v
                WHERE v.status = 'failed')
                AS latest_failed_version_at
         FROM compose_context_patches p`,
      ),
    ]);
    const [turnRows] = turnResult;
    const [agentTaskRows] = agentTaskResult;
    const [agentTaskCapabilityRows] = agentTaskCapabilityResult;
    const [llmRows] = llmResult;
    const [llmPurposeRows] = llmPurposeResult;
    const [workerRows] = workerResult;
    const [fenceRows] = fenceResult;
    const [outcomeRows] = outcomeResult;
    const [coordinatorRows] = coordinatorResult;
    const [retentionRows] = retentionResult;
    const [eventRows] = eventResult;
    const [streamTokenRows] = streamTokenResult;
    const [researchRows] = researchResult;
    const [contextRows] = contextResult;
    return {
      turns: summarizeTurnHealth(
        turnRows,
        outcomeRows,
        dbNumber(fenceRows[0]?.turn_lease_fence_rejected),
        dbNumber(fenceRows[0]?.turn_duplicate_suppressed_today),
      ),
      agentTasks: summarizeAgentTaskHealth(
        agentTaskRows,
        agentTaskCapabilityRows,
        dbNumber(fenceRows[0]?.agent_task_lease_fence_rejected),
      ),
      llm: summarizeLlmHealth(llmRows, llmPurposeRows),
      workers: summarizeWorkerHealth(workerRows),
      coordinator: summarizeCoordinatorHealth(coordinatorRows),
      retention: summarizeRetentionHealth(retentionRows),
      events: summarizeEventHealth(eventRows),
      streams: emptyStreamHealth(),
      streamTokens: summarizeStreamTokenHealth(streamTokenRows),
      research: summarizeResearchHealth(researchRows),
      context: summarizeContextHealth(contextRows),
    };
  }

  private mapSource(row: SourceRow): ComposeSessionSourceSummary {
    const conversionAttempts = Number(row.conversion_attempts ?? 0);
    return {
      id: row.id,
      sessionId: row.session_id,
      requestId: row.request_id,
      kind: row.kind,
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      sourceUrl: row.source_url,
      s3KeyRaw: row.s3_key_raw,
      converter: row.converter,
      markdownPath: row.markdown_path,
      markdownContent: row.markdown_content,
      sourceSummary: row.source_summary,
      sourceEntities: parseSourceEntities(row.source_entities_json),
      sourceUsefulness: parseSourceUsefulness(row.source_usefulness),
      sourceContribution: row.source_contribution,
      sourceOrigin: row.source_origin,
      generatedByTaskId: dbNumberOrNull(row.generated_by_task_id),
      parentSourceIds: parseNumberArray(jsonValue(row.parent_source_ids_json)),
      contextVersionUsed: dbNumberOrNull(row.context_version_used),
      evidence: jsonValue(row.evidence_json),
      confidence: row.confidence,
      artifactUri: row.artifact_uri,
      artifactSha256: row.artifact_sha256,
      artifactBytes: dbNumberOrNull(row.artifact_bytes),
      currentRevisionId: dbNumberOrNull(row.current_revision_id),
      contentSha256: row.content_sha256 ?? null,
      deletedAt: row.deleted_at ? toIso(row.deleted_at) : null,
      conversionStatus: row.conversion_status,
      conversionStartedAt: row.conversion_started_at
        ? toIso(row.conversion_started_at)
        : null,
      conversionAttempts: Number.isFinite(conversionAttempts)
        ? conversionAttempts
        : 0,
      conversionLeaseExpiresAt: row.conversion_lease_expires_at
        ? toIso(row.conversion_lease_expires_at)
        : null,
      errorMessage: row.error_message,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private mapSessionEvent(row: SessionEventRow): ComposeSessionEvent {
    return {
      id: Number(row.id),
      sessionId: Number(row.session_id),
      eventType: row.event_type,
      sequence: dbNumberOrNull(row.sequence),
      payload: jsonValue(row.payload_json),
      payloadBytes: Number(row.payload_bytes),
      actorType: row.actor_type,
      actorId: row.actor_id,
      requestId: row.request_id,
      turnJobId: dbNumberOrNull(row.turn_job_id),
      agentTaskId: dbNumberOrNull(row.agent_task_id),
      contextVersion: dbNumberOrNull(row.context_version),
      createdAt: toIso(row.created_at),
    };
  }

  private async findTurnByIdempotency(
    connection: TransactionConnection,
    input: { sessionId: number; idempotencyKey: string },
  ): Promise<TurnJobRow | null> {
    // Do not lock a missing key here. InnoDB turns a locking miss into a
    // next-key gap lock, so unrelated sessions inserting new turns can
    // deadlock. The unique key is the race fence; callers recover its
    // duplicate-key loser after rolling back.
    const [rows] = await connection.query<TurnJobRow[]>(
      `SELECT id, session_id, turn_kind, user_message_id, status,
              request_hash, lease_generation, active_worker_id
       FROM compose_turn_jobs
       WHERE session_id = ?
         AND idempotency_key = ?
       LIMIT 1`,
      [input.sessionId, input.idempotencyKey],
    );
    return rows[0] ?? null;
  }

  private async findClarificationAnswerByIdempotency(
    connection: TransactionConnection,
    input: { sessionId: number; idempotencyKey: string },
  ): Promise<ClarificationAnswerMessageRow | null> {
    const [rows] = await connection.query<ClarificationAnswerMessageRow[]>(
      `SELECT m.id,
              m.turn_job_id,
              m.content,
              j.status AS turn_status,
              j.user_message_id
       FROM compose_session_messages m
       JOIN compose_turn_jobs j
         ON j.id = m.turn_job_id
       WHERE m.session_id = ?
         AND m.message_kind = 'clarification_answer'
         AND m.clarification_idempotency_key = ?
       LIMIT 1`,
      [input.sessionId, input.idempotencyKey],
    );
    return rows[0] ?? null;
  }

  private clarificationAnswerFromExisting(
    row: ClarificationAnswerMessageRow,
    content: string,
  ): AnswerAwaitingClarificationResult {
    if (row.content !== content) {
      throw new IdempotencyConflictError();
    }
    return {
      answered: true,
      turnJobId: Number(row.turn_job_id),
      messageId: Number(row.id),
      status: row.turn_status,
      userMessageId: dbNumberOrNull(row.user_message_id),
      deduplicated: true,
    };
  }

  private async lockSessionContextVersion(
    connection: TransactionConnection,
    sessionId: number,
  ): Promise<number | null> {
    const [rows] = await connection.query<SessionContextRow[]>(
      `SELECT id, latest_context_version
       FROM compose_sessions
       WHERE id = ?
         AND status <> 'archived'
       LIMIT 1
       FOR UPDATE`,
      [sessionId],
    );
    if (!rows[0]) {
      throw new Error(`Compose session ${sessionId} was not found`);
    }
    return dbNumberOrNull(rows[0].latest_context_version);
  }

  private createdTurnFromExisting(
    row: TurnJobRow,
    requestHash: string,
  ): CreatedTurn {
    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    return {
      turnJobId: Number(row.id),
      messageId: dbNumberOrNull(row.user_message_id),
      status: row.status,
      deduplicated: true,
    };
  }

  private mapClaimedTurnJob(
    row: TurnJobRow,
    queuedAt: Date | string | undefined,
  ): ClaimedTurnJob {
    if (!queuedAt) {
      throw new Error(`Compose turn job ${row.id} is missing queued_at`);
    }
    return {
      id: Number(row.id),
      sessionId: Number(row.session_id),
      turnKind: row.turn_kind,
      userMessageId: dbNumberOrNull(row.user_message_id),
      status: row.status,
      requestId: row.request_id ?? null,
      requestedContextVersion: dbNumberOrNull(row.requested_context_version),
      contextVersionUsed: dbNumberOrNull(row.context_version_used),
      leaseGeneration: Number(row.lease_generation),
      activeWorkerId: row.active_worker_id,
      queuedAt: toIso(queuedAt),
    };
  }

  private mapClaimedAgentTask(
    row: AgentTaskRow,
    queuedAt: Date | string | undefined,
  ): ClaimedAgentTask {
    if (!queuedAt) {
      throw new Error(`Compose agent task ${row.id} is missing queued_at`);
    }
    return {
      id: Number(row.id),
      sessionId: Number(row.session_id),
      turnJobId: dbNumberOrNull(row.turn_job_id),
      capability: row.capability,
      executorType: row.executor_type,
      requestId: row.request_id ?? null,
      status: row.status,
      input: jsonValue(row.input_json),
      leaseGeneration: Number(row.lease_generation),
      activeWorkerId: row.active_worker_id,
      queuedAt: toIso(queuedAt),
    };
  }

  private mapTurnAgentTaskSummary(
    row: AgentTaskSummaryRow,
  ): TurnAgentTaskSummary {
    const input = jsonValue(row.input_json);
    const inputObject =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    return {
      id: Number(row.id),
      sessionId: Number(row.session_id),
      turnJobId: dbNumberOrNull(row.turn_job_id),
      capability: row.capability,
      executorType: row.executor_type,
      status: row.status,
      input,
      question: textOrNull(inputObject.question),
      maxCostUsd: numberOrNull(inputObject.maxCostUsd),
      outputSourceId: dbNumberOrNull(row.output_source_id),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      createdAt: toIso(row.created_at),
      completedAt: row.completed_at ? toIso(row.completed_at) : null,
    };
  }

  private mapContextProjection(
    row: ContextProjectionRow,
  ): ComposeContextProjection {
    return {
      sessionId: dbNumber(row.session_id),
      version: dbNumber(row.version),
      artifactUri: textOrNull(row.artifact_uri),
      structuredArtifactUri: textOrNull(row.structured_artifact_uri),
      summary: parseContextProjectionSummary(row.summary_json),
      facts: jsonArray(row.facts_json),
      implementationFindings: jsonArray(row.implementation_findings_json),
      requirements: jsonArray(row.requirements_json),
      constraints: jsonArray(row.constraints_json),
      openQuestions: jsonArray(row.open_questions_json),
      conflicts: jsonArray(row.conflicts_json),
      decisions: jsonArray(row.decisions_json),
      risks: jsonArray(row.risks_json),
      sourceIds: parseNumberArray(jsonValue(row.source_ids_json)),
      patchIds: parseNumberArray(jsonValue(row.patch_ids_json)),
      committedAt: row.committed_at ? toIso(row.committed_at) : null,
    };
  }

  private mapSession(row: SessionRow): ComposeSessionSummary {
    const sourceCount = Number(
      (row as SessionRow & { source_count?: number }).source_count ?? 0,
    );
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdByDisplay: row.created_by_display,
      agentPersonaKey: row.agent_persona_key ?? null,
      agentPersonaName: row.agent_persona_name ?? null,
      lastActiveAt: row.last_active_at ? toIso(row.last_active_at) : null,
      lastAction: row.last_action ?? null,
      lastActor: row.last_actor ?? null,
      analysisRunning: Boolean(row.active_turn_started_at),
      status: row.status,
      claudeSessionId: row.claude_session_id,
      sourceId: row.source_id,
      readiness: parseReadiness(row.readiness_json),
      s3Prefix: row.s3_prefix,
      workspacePath: row.workspace_path,
      sourceCount,
      passwordProtected: Boolean(row.password_hash),
      latestContextVersion: dbNumberOrNull(row.latest_context_version),
      contextStatus: row.context_status ?? null,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}
