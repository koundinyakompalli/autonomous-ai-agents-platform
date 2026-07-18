export type ComposeSessionStatus =
  | "draft"
  | "ready"
  | "handed_off"
  | "archived";
export type ComposeContextStatus = "dirty" | "building" | "clean";
export type ComposeSourceKind =
  | "file"
  | "youtube"
  | "chat"
  | "note"
  | "jira"
  | "confluence"
  | "generated_research";
export type ComposeConversionStatus =
  | "awaiting_upload"
  | "pending"
  | "converting"
  | "converted"
  | "unsupported"
  | "failed";
export type ComposeMessageRole = "user" | "assistant" | "system";

export interface ComposeRepoEvidence {
  repoName: string;
  headSha?: string | null;
  techStack?: string | null;
  inspectedPaths: string[];
  keyMatches: string[];
  warnings: string[];
}

export interface ComposeCodeInvestigation {
  filesRead: number;
  toolCalls: number;
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

export interface ComposeOpenQuestion {
  id: string;
  question: string;
  options?: string[];
  answered?: boolean;
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
  summary: string;
  repos?: string[];
  sequence?: number;
  userStory?: string;
  businessValue?: string;
  acceptanceCriteria?: string[];
}

export interface ComposeReadiness {
  ready: boolean;
  openQuestions: string[];
  summary: string;
  details?: {
    module?: string | null;
    repositories?: string[];
    difficulty?: string | null;
    loeHours?: number | null;
    storyPoints?: number | null;
  } | null;
  confidence?: ComposeReadinessConfidence | null;
  risks?: string[];
  assumptions?: string[];
  missingEvidence?: string[];
  nextStep?: string;
  validatorWarnings?: ComposeReadinessWarning[];
  repoEvidence?: ComposeRepoEvidence[];
  codeInvestigation?: ComposeCodeInvestigation;
  ideating?: string;
  problem?: string;
  solution?: string;
  businessRequirements?: string[];
  functionalRequirements?: string[];
  challenges?: string[];
  questions?: ComposeOpenQuestion[];
  stories?: ComposeStory[];
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

export type ComposeTurnAccepted =
  | {
      accepted: true;
      messageId?: number | null;
      turnJobId?: number;
      status?: string;
    }
  | { accepted: false; reason: "queue_full" | "durable_turn_required" };

export interface ComposeHandoffResult {
  sourceId: number;
  session: ComposeSessionSummary;
  handoffId?: number;
  status?: "snapshot_building";
  contextVersion?: number | null;
  messageHighWatermarkId?: number | null;
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

export interface ComposeSessionSummary {
  id: number;
  name: string;
  createdBy?: string | null;
  createdByDisplay?: string | null;
  agentPersonaKey?: string | null;
  agentPersonaName?: string | null;
  lastActiveAt?: string | null;
  lastAction?: string | null;
  lastActor?: string | null;
  analysisRunning?: boolean;
  status: ComposeSessionStatus;
  sourceId: number | null;
  readiness: ComposeReadiness | null;
  sourceCount: number;
  passwordProtected: boolean;
  latestContextVersion?: number | null;
  contextStatus?: ComposeContextStatus | null;
  createdAt: string;
  updatedAt: string;
  /** Short-lived stream token minted by resume for password-protected sessions. */
  streamToken?: string;
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
  implementationFindings?: unknown[];
  requirements?: unknown[];
  constraints?: unknown[];
  openQuestions: unknown[];
  conflicts: unknown[];
  decisions: unknown[];
  risks?: unknown[];
  sourceIds: number[];
  patchIds: number[];
  committedAt: string | null;
}

export interface ComposeSourceSummary {
  id: number;
  sessionId: number;
  requestId: string | null;
  kind: ComposeSourceKind;
  originalFilename: string | null;
  mimeType?: string | null;
  conversionStatus: ComposeConversionStatus;
  conversionStartedAt?: string | null;
  conversionAttempts?: number;
  conversionLeaseExpiresAt?: string | null;
  errorMessage: string | null;
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

export interface ComposeSourcePreview {
  url: string;
  mimeType: string | null;
  filename: string;
}

export interface ComposeChatMessage {
  id: number;
  sessionId: number;
  role: ComposeMessageRole;
  content: string;
  createdAt: string;
}

export interface ComposeUploadTarget {
  sourceId: number;
  uploadUrl: string;
  s3KeyRaw: string;
  expiresInSeconds: number;
}

export interface ComposeSessionExportSource {
  kind: ComposeSourceKind;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  markdownContent: string;
}

export interface ComposeSessionExportMessage {
  role: ComposeMessageRole;
  content: string;
}

export interface ComposeSessionExportBundle {
  format: "spec-factory.compose-session";
  version: 1;
  exportedAt: string;
  session: {
    name: string;
    createdByDisplay: string | null;
    readiness: ComposeReadiness | null;
  };
  sources: ComposeSessionExportSource[];
  messages: ComposeSessionExportMessage[];
}

export interface ComposeSessionImportResult {
  session: ComposeSessionSummary;
  importedSources: number;
  importedMessages: number;
}

export type ComposeStreamEvent =
  | {
      type: "status";
      status: "thinking" | "idle" | "error";
      mode?: "analyze" | "chat";
      message?: string;
      code?: string;
    }
  | {
      type: "status";
      status: "retrying";
      mode?: "analyze" | "chat";
      message?: string;
      attempt: number;
      maxAttempts: number;
      nextRetryInSeconds: number;
    }
  | { type: "message"; role: ComposeMessageRole; content: string }
  | { type: "readiness"; readiness: ComposeReadiness }
  | { type: "invalidate"; resource: "messages"; role?: ComposeMessageRole }
  | { type: "invalidate"; resource: "readiness" }
  | { type: "session"; status: "archived" };

export interface ComposeCanonicalEvent {
  schemaVersion: 1;
  id: number;
  eventType: string;
  occurredAt: string;
  sessionId: number;
  correlation: {
    turnJobId: number | null;
    agentTaskId: number | null;
    handoffId: number | null;
    workflowId: number | null;
    sourceId: number | null;
    contextVersion: number | null;
    requestId: string | null;
  };
  data: unknown;
}
