export type WatchdogMode = "jira" | "natural_language" | "manual";

export interface WatchdogScope {
  clientId: string;
  environment: string;
  serviceIds: string[];
  timeWindow: {
    startTs: string;
    endTs: string;
    sourceHint?: string;
  };
  includeKeywords: string[];
  excludeKeywords: string[];
  advancedFilters?: Record<string, unknown>;
}

export interface WatchdogRunAttempt {
  id: string;
  sessionId: string;
  attemptNumber: number;
  trigger: string;
  status: string;
  correlationId: string;
  approvedScope?: WatchdogScope;
  providerKey?: string;
  modelId?: string;
  createdAt: string;
}

export interface WatchdogSession {
  id: string;
  title: string;
  mode: WatchdogMode;
  status: string;
  owner: { id: string; display: string };
  authSource: string;
  jiraKey?: string;
  naturalLanguagePrompt?: string;
  draftScope?: WatchdogScope;
  approvedScope?: WatchdogScope;
  latestRunAttempt?: WatchdogRunAttempt;
  createdAt: string;
  updatedAt: string;
}

export interface WatchdogServerEvent {
  id: string;
  sessionId: string;
  runAttemptId?: string;
  correlationId: string;
  eventType: string;
  sequence: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface WatchdogFinding {
  id: string;
  session_id?: string;
  sessionId?: string;
  run_attempt_id?: string;
  runAttemptId?: string;
  kind: "finding" | "no_evidence" | "limitation";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  summary: string;
  details?: string;
  evidenceIds?: string[];
  evidence_ids?: string[];
  confidence?: number;
  created_at?: string;
  createdAt?: string;
}

export interface WatchdogEvidenceArtifact {
  id: string;
  session_id?: string;
  sessionId?: string;
  run_attempt_id?: string;
  runAttemptId?: string;
  kind: string;
  title: string;
  summary?: string;
  source_tool?: string;
  sourceTool?: string;
  source_ref_json?: unknown;
  sourceRef?: {
    searchId?: string;
    querySpec?: Record<string, unknown>;
    summaryCounts?: {
      total_matches?: number;
      totalMatches?: number;
      returned_samples?: number;
      returnedSamples?: number;
      regions?: Record<string, number>;
      log_groups?: Record<string, number>;
      logGroups?: Record<string, number>;
    };
    warnings?: string[];
  };
  timeWindow?: Record<string, unknown>;
  hasPayload?: boolean;
  s3Bucket?: string;
  s3Key?: string;
  sha256?: string;
  byteCount?: number;
  created_at?: string;
  createdAt?: string;
  expires_at?: string;
  expiresAt?: string;
}

export interface WatchdogClarification {
  id: string;
  sessionId: string;
  runAttemptId: string;
  status: "open" | "answered" | "expired";
  question: string;
  choices: unknown[];
  context: Record<string, unknown>;
  answer?: Record<string, unknown>;
  answeredBy?: string;
  answeredAt?: string;
  expiresAt: string;
  createdAt: string;
}

export interface WatchdogLogSource {
  source_id?: string;
  sourceId?: string;
  client_code?: string;
  clientCode?: string;
  region?: string;
  environment?: string;
  log_group_name?: string;
  logGroupName?: string;
  component?: string;
  log_type?: string;
  logType?: string;
}

export interface WatchdogDarciHandoff {
  id: string;
  sessionId: string;
  runAttemptId: string;
  findingIds: string[];
  requestedBy: string;
  requestedByDisplay: string;
  status: "queued" | "task_created" | "running" | "delivering" | "delivered" | "failed" | "cancelled";
  taskManagementId?: number;
  taskId?: number;
  taskS3Bucket?: string;
  taskS3Key?: string;
  resultS3Bucket?: string;
  resultS3Key?: string;
  resultArtifactId?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchdogDarciMappingDiagnostics {
  sessionId: string;
  scope: WatchdogScope;
  darciAgent: {
    id: number;
    name: string;
    description?: string;
    task_type?: string;
    taskType?: string;
    model?: string;
    is_active?: boolean | number;
    isActive?: boolean | number;
  } | null;
  customerCandidates: Array<{
    id: number;
    customer: string;
    branch: string;
    default?: boolean | number;
  }>;
  repositoryCandidates: Array<{
    id: number;
    repo_name?: string;
    repoName?: string;
    repo_url?: string;
    repoUrl?: string;
    default_branch?: string;
    defaultBranch?: string;
  }>;
  proposed: {
    ready: boolean;
    agentId?: number;
    customerId?: number;
    relatedCode?: string;
    taskType?: string;
    blockers: string[];
  };
}
