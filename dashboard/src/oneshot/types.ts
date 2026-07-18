import type {
  OneShotFailureAttributionByCategory as ServerOneShotFailureAttributionByCategory,
  OneShotFailureAttributionLabel as ServerOneShotFailureAttributionLabel,
  OneShotFailureAttributionSummary as ServerOneShotFailureAttributionSummary,
  OneShotFailureErrorCategory as ServerOneShotFailureErrorCategory,
  OneShotFaultAttribution as ServerOneShotFaultAttribution,
  OneShotModelCost as ServerOneShotModelCost,
  OneShotModelPricing as ServerOneShotModelPricing,
  OneShotMissingSignalImpact as ServerOneShotMissingSignalImpact,
  OneShotOperationalBottleneckRow as ServerOneShotOperationalBottleneckRow,
  OneShotOperationalBottleneckSummary as ServerOneShotOperationalBottleneckSummary,
  OneShotRepoStatusRow as ServerOneShotRepoStatusRow,
  OneShotRepoStatusSummary as ServerOneShotRepoStatusSummary,
  OneShotRowFailureAttribution as ServerOneShotRowFailureAttribution,
  OneShotStatisticsAction as ServerOneShotStatisticsAction,
  OneShotStatisticsBucket as ServerOneShotStatisticsBucket,
  OneShotStatisticsBusinessMetric as ServerOneShotStatisticsBusinessMetric,
  OneShotStatisticsDelta as ServerOneShotStatisticsDelta,
  OneShotStatisticsInsight as ServerOneShotStatisticsInsight,
  OneShotStatisticsJiraExample as ServerOneShotStatisticsJiraExample,
  OneShotStatisticsModelInfo as ServerOneShotStatisticsModelInfo,
  OneShotStatisticsResponse as ServerOneShotStatisticsResponse,
  OneShotStatisticsScorecard as ServerOneShotStatisticsScorecard,
  OneShotStatisticsStatus as ServerOneShotStatisticsStatus,
  OneShotTicketQualityDistributionBucket as ServerOneShotTicketQualityDistributionBucket,
} from "../../server/types/oneshot.js";

export type OneShotDisplayState =
  | "qualification_pending"
  | "repo_confirmation_pending"
  | "qualification_failed"
  | "qualification_no_action"
  | "queued_for_planning"
  | "planning"
  | "queued_for_review"
  | "reviewing"
  | "needs_revision"
  | "approved"
  | "escalated"
  | "blocked"
  | "queued_for_implementation"
  | "implementing"
  | "queued_for_code_review"
  | "code_reviewing"
  | "queued_for_testing"
  | "testing"
  | "replan_required"
  | "pr_open"
  | "completed"
  | "failed";

export type OneShotProgressStage =
  | "qualification"
  | "planning"
  | "review"
  | "implementation"
  | "code_review"
  | "testing"
  | "pr_complete";

export type OneShotDeploymentLight = "grey" | "red" | "amber" | "green";
export type OneShotCostSource = "actual" | "estimated" | "mixed";
export type OneShotTicketType =
  | "story"
  | "defect"
  | "sonar"
  | "security"
  | "retrofit"
  | "documentation"
  | "other"
  | "unknown";
export type OneShotCompletionStatus =
  | "completed_ready"
  | "completed_draft"
  | "completed_needs_review"
  | "completed_with_risks"
  | "completed_no_action";
export type OneShotReadiness =
  | "ready"
  | "draft"
  | "needs_review"
  | "with_risks"
  | "no_action";

export type QualifierOutcomeDisposition =
  | "qualified"
  | "not_qualified"
  | "no_action"
  | "needs_confirmation";

export type QualifierOutcomeReasonCode =
  | "pfos_label_missing_at_processing"
  | "pfos_not_qualified_label_present"
  | "existing_run_not_actionable"
  | "missing_qualifying_run"
  | "repo_unsupported"
  | "repo_resolution_failed"
  | "branch_resolution_failed"
  | "branch_lookup_failed"
  | "gate_hard_fail"
  | "llm_rejected"
  | "llm_qualified"
  | "llm_error_parked"
  | "llm_schema_invalid"
  | "needs_confirmation"
  | "client_ineligible";

export interface QualifierOutcome {
  disposition: QualifierOutcomeDisposition;
  reasonCode: QualifierOutcomeReasonCode;
  reason: string;
  qualifierMode: "fresh" | "force_approve" | "replan" | null;
  labels: string[];
  latestRunState: string | null;
  repoResolution?: {
    disposition: string;
    source: string;
    matchedRepos: string[];
    candidateRepos: string[];
    evidence: string[];
  };
  gateScore?: number;
  gateDisposition?: "hard_fail" | "direct_qualify" | "code_adjudicate";
  acceptanceCriteriaPresent?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface OneShotRunGroupRepo {
  repo_id: number;
  repo_name: string;
  branch_name: string;
  base_commit_sha: string;
}

export interface OneShotRunGroupMetadata {
  mode: string;
  repos: OneShotRunGroupRepo[];
  mergeOrder?: Record<string, number>;
  sourceJiraKey?: string;
  sourceBranch?: string;
  repo?: {
    repo_id: number;
    repo_name: string;
  };
  targetBranches?: Array<{
    targetBranch: string;
    targetOrder: number;
  }>;
  skippedTargetBranches?: string[];
}

export interface OneShotDashboardRow {
  dashboardId: string;
  jiraKey: string;
  title: string;
  jiraIssueType: string | null;
  ticketType: OneShotTicketType;
  ticketTypeSource: string;
  ticketTypeUpdatedBy: string | null;
  ticketTypeUpdatedAt: string | null;
  sourceTaskManagementId: number;
  oneshotRunId: number | null;
  runGroupId?: number | null;
  groupMetadata?: OneShotRunGroupMetadata | null;
  customerName: string | null;
  displayState: OneShotDisplayState;
  progressStage: OneShotProgressStage;
  progressPercent: number;
  repoName: string | null;
  repoUrl: string | null;
  baseBranch: string | null;
  baseCommitSha: string | null;
  implementationBranch: string | null;
  implementationCommitSha: string | null;
	  workspace: {
	    mode: "v2" | null;
	    runBranchName: string | null;
	    runBranchBaseSha: string | null;
	    runBranchCreatedAt: string | null;
	    phase: string | null;
    headSha: string | null;
    currentCandidateVersion: number | null;
    currentCandidateSha: string | null;
    lastRepoFetchAt: string | null;
    lastRemoteHeadSha: string | null;
  } | null;
  reviewLoopCount: number;
  maxReviewLoops: number;
  planReviewLoopCount?: number;
  maxPlanReviewLoops?: number;
  verificationLoopCount?: number;
  maxVerificationLoops?: number;
  currentPrUrl: string | null;
  qualificationSummary: string | null;
  qualifierOutcome?: QualifierOutcome | null;
  lastError: string | null;
  lastErrorSummary: string | null;
  failureAttribution?: OneShotRowFailureAttribution | null;
  retryPending?: boolean;
  retryPendingStage?: OneShotProgressStage | null;
  retryPendingNextRetryAt?: string | null;
  retryPendingDelaySeconds?: number | null;
  retryPendingAttempt?: number | null;
  retryPendingMaxAttempts?: number | null;
  retryPendingVisibilityStatus?: "success" | "failed" | null;
  staleRouter?: boolean;
  completionStatus?: OneShotCompletionStatus | null;
  readiness?: OneShotReadiness | null;
  readinessReasons?: string[];
  riskAssessment?: Record<string, unknown> | null;
  externalSpecEvidence?: Record<string, unknown> | null;
  ciStatus?: Record<string, unknown> | null;
  unverifiedTests?: string[];
  plannerAttemptDiagnostics?: Record<string, unknown> | null;
  sdkLifecycleSummary?: Record<string, unknown> | null;
  retry: {
    stage: Exclude<OneShotProgressStage, "qualification" | "pr_complete">;
    eligible: boolean;
    attemptsUsed: number;
    attemptsRemaining: number;
    maxAttempts: number;
    disabledReason?: string | null;
  } | null;
  deployment: {
    /** Pre-existing "could be deployed" signal; true for any eligible run regardless of existing deployment records. */
    eligible: boolean;
    /** Tightened "no deploy record exists yet AND eligible" signal. Use this for stat cards, filters, and "Ready to deploy" copy. */
    ready: boolean;
    light: OneShotDeploymentLight;
    status: string;
    active: boolean;
    previewUrl: string | null;
    workflowUrl: string | null;
    imageUri: string | null;
    deployedCommitSha: string | null;
  };
  createdAt: string;
  lastManualRestartAt: string | null;
  updatedAt: string;
  totalTokensUsed: number;
  estimatedCostUsd: number;
  costSource: OneShotCostSource;
}

export interface OneShotRunsStats {
  inProgress: number;
  failed: number;
  blocked: number;
  deployReady: number;
  byView: {
    running: number;
    queued: number;
    waiting: number;
    history: number;
  };
}

export type OneShotArtifactRunMode =
  | "wiz"
  | "sonar"
  | "wiz_sast"
  | "documentation";

export interface OneShotArtifactRunTicket {
  key: string;
  title: string | null;
  kind: string | null;
  status: string | null;
  jiraUrl: string | null;
  oneshotRunDashboardId: string | null;
  oneshotRunState: OneShotDisplayState | null;
  currentPrUrl: string | null;
}

export interface OneShotArtifactRun {
  id: string;
  sourceKey: string;
  sourceParentKey: string | null;
  mode: OneShotArtifactRunMode;
  status: string;
  title: string;
  generatedCount: number;
  generatedTickets: OneShotArtifactRunTicket[];
  oneshotRunCount: number;
  humanReviewRequired: boolean;
  humanReviewCount: number;
  reviewItems: string[];
  evidence: Record<string, unknown> | null;
  artifactRefs: Record<string, unknown> | null;
  jiraSummary: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OneShotCreateRunMode = "request" | "mock";
export type OneShotAnalyticsRange = "24h" | "7d" | "30d" | "all";

export interface OneShotAnalyticsWindow {
  range: OneShotAnalyticsRange;
  label: string;
  shortLabel: string;
  bucketLabel: string;
  isAllTime: boolean;
}

export interface OneShotDashboardCapabilities {
  createRun: boolean;
  createRunMode: OneShotCreateRunMode;
  deployPreviewAvailable: boolean;
  deployPreview: boolean;
}

export interface OneShotOverviewAnalytics {
  /** Starts: rows created within the last 24h. */
  runs24h: number;
  /** PR-open outcome count in the last 24h. */
  completed: number;
  /** Failed outcome count in the last 24h, excluding denominator-excluded rows. */
  failed: number;
  running: number;
  queued: number;
  waiting: number;
  /** completed / (completed + failed). */
  passRate: number;
  /** Average effective-start-to-PR-open time for PR-open outcome rows. */
  avgTimeToPrMs: number;
  /** Median effective-start-to-PR-open time for PR-open outcome rows. */
  medianTimeToPrMs: number;
  /** 24h token total matching Costs tab token attribution. */
  totalTokens: number;
  /** 24h USD total matching the Costs tab row-level top-line total. */
  estimatedCostUsd: number;
  costSource: OneShotCostSource;
  throughputBuckets: number[];
  attemptFailures24h: number;
}

export type OneShotAgentSampleTone =
  | "success"
  | "running"
  | "failed"
  | "warning"
  | "no_action";

export interface OneShotAgentSample {
  dashboardId: string;
  durationMs: number;
  tone: OneShotAgentSampleTone;
}

export interface OneShotAgentAnalyticsEntry {
  stage: Exclude<OneShotProgressStage, "pr_complete">;
  runs: number;
  avgLatencyMs: number;
  failRate: number;
  avgTokens: number;
  recentSamples: OneShotAgentSample[];
}

export interface OneShotQueueAnalytics {
  queued: number;
  running: number;
  waiting: number;
  recentlyFinished: number;
  workerCapacity: number;
}

export interface OneShotTrendDelta {
  priorValue: number;
  pctChange: number | null;
}

export interface OneShotStageCost {
  stage: Exclude<OneShotProgressStage, "pr_complete">;
  tokens: number | null;
  usd: number | null;
  share: number | null;
}

export type OneShotModelPricing = ServerOneShotModelPricing;
export type OneShotModelCost = ServerOneShotModelCost;

export interface OneShotTopCostRun {
  dashboardId: string;
  jiraKey: string;
  title: string;
  totalTokensUsed: number;
  estimatedCostUsd: number;
  costSource: OneShotCostSource;
  progressStage: OneShotProgressStage;
  displayState: OneShotDisplayState;
}

export interface OneShotCostsAnalytics {
  window: OneShotAnalyticsWindow;
  totalUsd: number;
  totalTokens: number;
  costSource: OneShotCostSource;
  trend: OneShotTrendDelta | null;
  byStage: OneShotStageCost[];
  byModel: OneShotModelCost[];
  topRuns: OneShotTopCostRun[];
}

export interface OneShotFailureStageCount {
  stage: Exclude<OneShotProgressStage, "pr_complete">;
  count: number;
}

export interface OneShotFailureCluster {
  signature: string;
  code: string | null;
  headline: string;
  count: number;
  representativeDashboardId: string;
  jiraKeys: string[];
  stageCounts: OneShotFailureStageCount[];
  buckets: number[];
  lastSeenMs: number;
}

export interface OneShotFailuresAnalytics {
  window: OneShotAnalyticsWindow;
  totalFailures: number;
  clusters: OneShotFailureCluster[];
}

export interface OneShotStageCompletion {
  stage: Exclude<OneShotProgressStage, "pr_complete">;
  attempts: number;
  completions: number;
  failures: number;
}

export interface OneShotThroughputAnalytics {
  window: OneShotAnalyticsWindow;
  buckets: number[];
  totalRuns: number;
  trend: OneShotTrendDelta | null;
  p50TimeToPrMs: number;
  p90TimeToPrMs: number;
  stageCompletion: OneShotStageCompletion[];
}

export interface OneShotDashboardAnalytics {
  overview24h: OneShotOverviewAnalytics;
  agents: OneShotAgentAnalyticsEntry[];
  queue: OneShotQueueAnalytics;
  throughput: OneShotThroughputAnalytics;
  costs: OneShotCostsAnalytics;
  failures: OneShotFailuresAnalytics;
}

export type OneShotStatisticsStatus = ServerOneShotStatisticsStatus;
export type OneShotStatisticsDelta = ServerOneShotStatisticsDelta;
export type OneShotStatisticsScorecard = ServerOneShotStatisticsScorecard;
export type OneShotStatisticsJiraExample = ServerOneShotStatisticsJiraExample;
export type OneShotStatisticsBucket = ServerOneShotStatisticsBucket;
export type OneShotStatisticsInsight = ServerOneShotStatisticsInsight;
export type OneShotStatisticsBusinessMetric =
  ServerOneShotStatisticsBusinessMetric;
export type OneShotStatisticsAction = ServerOneShotStatisticsAction;
export type OneShotStatisticsModelInfo = ServerOneShotStatisticsModelInfo;
export type OneShotStatisticsResponse = ServerOneShotStatisticsResponse;
export type OneShotOperationalBottleneckRow =
  ServerOneShotOperationalBottleneckRow;
export type OneShotOperationalBottleneckSummary =
  ServerOneShotOperationalBottleneckSummary;
export type OneShotRepoStatusRow = ServerOneShotRepoStatusRow;
export type OneShotRepoStatusSummary = ServerOneShotRepoStatusSummary;
export type OneShotMissingSignalImpact = ServerOneShotMissingSignalImpact;
export type OneShotFailureAttributionSummary =
  ServerOneShotFailureAttributionSummary;
export type OneShotFailureAttributionByCategory =
  ServerOneShotFailureAttributionByCategory;
export type OneShotFailureErrorCategory = ServerOneShotFailureErrorCategory;
export type OneShotFaultAttribution = ServerOneShotFaultAttribution;
export type OneShotFailureAttributionLabel =
  ServerOneShotFailureAttributionLabel;
export type OneShotRowFailureAttribution = ServerOneShotRowFailureAttribution;
export type OneShotTicketQualityDistributionBucket =
  ServerOneShotTicketQualityDistributionBucket;

export type OneShotTimelineStageState =
  | "completed"
  | "skipped"
  | "running"
  | "queued"
  | "waiting"
  | "failed"
  | "pending";

export interface OneShotStageDetail {
  stage: OneShotProgressStage;
  state: OneShotTimelineStageState;
  attempts: number;
  latestVersion: number | null;
  artifactStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  totalTokensUsed: number | null;
  totalCostUsd: number | null;
  totalCostSource: OneShotCostSource | null;
  provider: string | null;
  model: string | null;
  metadataSummary: string[];
  eventCount: number;
  lastEventAt: string | null;
}

export type OneShotTimelineEventTone =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "muted";

export interface OneShotTimelineEvent {
  id: string;
  occurredAt: string;
  eventType: string;
  stage: OneShotProgressStage | null;
  fromState: string | null;
  toState: string | null;
  tone: OneShotTimelineEventTone;
  label: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface OneShotRunTimelineResponse {
  dashboardId: string;
  oneshotRunId: number | null;
  updatedAt: string;
  isFallback: boolean;
  completionStatus?: OneShotCompletionStatus | null;
  readiness?: OneShotReadiness | null;
  readinessReasons?: string[];
  stages: OneShotStageDetail[];
  events: OneShotTimelineEvent[];
}

export type OneShotRunRequestStatus =
  | "queued"
  | "processing"
  | "task_created"
  | "failed";

export interface OneShotRunRequestSummary {
  id: number;
  jiraKey: string;
  status: OneShotRunRequestStatus;
  submittedAt: string;
}

export interface OneShotRunRequestDetail extends OneShotRunRequestSummary {
  error: string | null;
  taskManagementId: number | null;
  dashboardId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface OneShotRunRequestValidation {
  jiraKey: string;
  title: string;
  statusName: string;
  labels?: string[];
  clientName?: string | null;
  environment?: string | null;
  codeVersion?: string | null;
}

export interface OneShotRunsResponse {
  runs: OneShotDashboardRow[];
  artifactRuns?: OneShotArtifactRun[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    total: number;
  };
  stats: OneShotRunsStats;
  capabilities: OneShotDashboardCapabilities;
  analytics: OneShotDashboardAnalytics;
}
