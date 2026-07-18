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

export type OneShotFailureAttributionLabel =
  | "Ticket Not Ready"
  | "Qualifier Error"
  | "Planning Error"
  | "Review Error"
  | "Implementation Error"
  | "Code Review Error"
  | "Testing Error"
  | "Run Failed"
  | "Mixed Issue"
  | "Needs Triage";

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
  // Legacy: deterministic gate has been removed but historical rows
  // may still carry this code. Read-only support.
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

export type OneShotDeploymentStatus =
  | "not_eligible"
  | "ready"
  | "requested"
  | "awaiting_approval"
  | "building"
  | "pushing"
  | "deploying"
  | "active"
  | "failed"
  | "superseded"
  | "cancelled";

export interface OneShotDeploymentSummary {
  /**
   * Pre-existing "could theoretically be deployed" signal: the run is a
   * core-app run in `pr_open` or `completed` state with a valid branch/SHA.
   * Stays `true` even once a deployment record exists, so consumers that
   * need historical eligibility information remain unaffected.
   */
  eligible: boolean;
  /**
   * Tightened "ready to deploy now" signal: `eligible && no deployment
   * record exists` (active, failed, cancelled, superseded, or in-flight all
   * flip this to `false`). Prefer this for stat cards, filters, and any UI
   * copy that implies action is pending.
   */
  ready: boolean;
  light: OneShotDeploymentLight;
  status: OneShotDeploymentStatus;
  active: boolean;
  previewUrl: string | null;
  workflowUrl: string | null;
  imageUri: string | null;
  deployedCommitSha: string | null;
}

export interface OneShotWorkspaceSummary {
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
}

export interface OneShotRetryCapability {
  stage: Exclude<OneShotProgressStage, "qualification" | "pr_complete">;
  eligible: boolean;
  attemptsUsed: number;
  attemptsRemaining: number;
  maxAttempts: number;
  disabledReason?: string | null;
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
  workspace: OneShotWorkspaceSummary | null;
  reviewLoopCount: number;
  maxReviewLoops: number;
  planReviewLoopCount: number;
  maxPlanReviewLoops: number;
  verificationLoopCount: number;
  maxVerificationLoops: number;
  currentPrUrl: string | null;
  qualificationSummary: string | null;
  qualifierOutcome?: QualifierOutcome | null;
  lastError: string | null;
  /** Human-readable one-liner for the error (Zod arrays collapsed, etc.). */
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
  retry: OneShotRetryCapability | null;
  deployment: OneShotDeploymentSummary;
  createdAt: string;
  lastManualRestartAt: string | null;
  updatedAt: string;
  /** Total tokens consumed across all stages */
  totalTokensUsed: number;
  /** Display cost in USD: actual when tracked, estimated otherwise. */
  estimatedCostUsd: number;
  costSource: OneShotCostSource;
}

export interface OneShotRunsPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  total: number;
}

export interface OneShotRunsByView {
  running: number;
  queued: number;
  waiting: number;
  history: number;
}

export interface OneShotRunsStats {
  inProgress: number;
  failed: number;
  blocked: number;
  deployReady: number;
  byView: OneShotRunsByView;
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
  /** Starts: rows created within the last 24h (throughput window). */
  runs24h: number;
  /**
   * 24h PR-outcome pass count: rows whose PR-open outcome timestamp is within
   * the last 24h AND whose displayState is pr_open or completed. Readiness is
   * NOT consulted and qualification_no_action rows are excluded entirely.
   */
  completed: number;
  /**
   * 24h PR-outcome fail count: rows whose failure outcome timestamp is within
   * the last 24h AND whose displayState is failed or qualification_failed.
   * qualification_no_action and excludedFromDenominator rows are excluded
   * entirely.
   */
  failed: number;
  /** Live count of rows currently executing, across ALL ages (matches Queue view). */
  running: number;
  /** Live count of rows currently queued, across ALL ages (matches Queue view). */
  queued: number;
  /** Live count of rows currently waiting, across ALL ages (matches Queue view). */
  waiting: number;
  /** completed / (completed + failed); 0 when there are no 24h PR-outcome rows. */
  passRate: number;
  /** Average effective-start-to-PR-open time (ms) over pass-outcome rows only; 0 when completed === 0. */
  avgTimeToPrMs: number;
  /** Median effective-start-to-PR-open time (ms) over pass-outcome rows only; 0 when completed === 0. */
  medianTimeToPrMs: number;
  /** 24h token total, matching Costs tab token attribution. */
  totalTokens: number;
  /** 24h spend (USD), matching the Costs tab row-level top-line total. */
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
  /** Absolute count / tokens / dollars in the previous equivalent finite window. */
  priorValue: number;
  /**
   * Signed percent change vs. the prior window. `null` when prior window is zero
   * so the UI can render "new" instead of division-by-zero.
   */
  pctChange: number | null;
}

export interface OneShotStageCost {
  stage: Exclude<OneShotProgressStage, "pr_complete">;
  tokens: number | null;
  usd: number | null;
  share: number | null;
}

export interface OneShotModelPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  blendedUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  sourceModel: string;
}

export interface OneShotModelCost {
  model: string;
  provider: string | null;
  rawModelIds?: string[];
  pricing?: OneShotModelPricing | null;
  tokens: number;
  usd: number;
  share: number;
}

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

export type OneShotStatisticsStatus =
  | "ready"
  | "generating"
  | "deterministic_only"
  | "stale"
  | "invalid"
  | "failed";

export type OneShotStatisticsBucketKind =
  | "repo"
  | "stage"
  | "error_class"
  | "ticket_family"
  | "ticket_readiness"
  | "template_fit"
  | "missing_signal";

export type OneShotTicketReadinessTier =
  | "strong"
  | "adequate"
  | "weak"
  | "missing_description";

export type OneShotTicketTemplateFit =
  | "cpdev_template"
  | "retrofit_template"
  | "non_template_clear"
  | "non_template_weak"
  | "missing_description";

export type OneShotTicketReadinessSignal =
  | "acceptance_criteria"
  | "substantive_description"
  | "expected_behavior_scope"
  | "repo_file_service_hints"
  | "testing_notes"
  | "out_of_scope_constraints";

export interface OneShotTicketQualityRubric {
  rubricVersion: string;
  detectionPatternsVersion: string;
  weights: Record<OneShotTicketReadinessSignal, number>;
  tierCutoffs: {
    strong: number;
    adequate: number;
    weak: number;
  };
  thresholds: {
    bucketClaimMinN: number;
    missingSignalCohortMinN: number;
    weakRecommendationMinShare: number;
    dataHygieneMissingDescriptionMinShare: number;
    dataHygieneMinN: number;
    stratifiedCoverageMinShare: number;
  };
}

export interface OneShotTicketReadinessScore {
  score: number;
  tier: OneShotTicketReadinessTier;
  templateFit: OneShotTicketTemplateFit;
  signals: Record<OneShotTicketReadinessSignal, boolean>;
  breakdown: Record<OneShotTicketReadinessSignal, number>;
  missingSignals: OneShotTicketReadinessSignal[];
  rubricVersion: string;
  detectionPatternsVersion: string;
  sourceTextSha: string;
}

export interface OneShotWilsonInterval {
  low: number;
  high: number;
}

export interface OneShotTicketQualityCohort {
  sampleSize: number;
  terminalCount: number;
  completed: number;
  failed: number;
  noAction: number;
  passRate: number;
  wilson95: OneShotWilsonInterval | null;
}

export interface OneShotTicketQualityDistributionBucket {
  id: OneShotTicketReadinessTier | OneShotTicketTemplateFit;
  label: string;
  sampleSize: number;
  share: number;
  cohort: OneShotTicketQualityCohort;
  averageScore: number;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotMissingSignalImpact {
  /**
   * Stable id for this row. For single-signal rows this equals the signal kind;
   * for collapsed multi-signal rows this is a deterministic composite (e.g.
   * "co:acceptance_criteria+testing_notes"). Old snapshots will only ever
   * carry a single signal kind here.
   */
  signal: OneShotTicketReadinessSignal | string;
  label: string;
  /**
   * Optional. When set, this row represents two or more signals that co-occur
   * with high overlap (≥0.9 Jaccard) so the table can render one combined row
   * instead of repeating identical numbers per signal.
   */
  signals?: OneShotTicketReadinessSignal[];
  missing: OneShotTicketQualityCohort;
  present: OneShotTicketQualityCohort;
  deltaPassRate: number;
  significant: boolean;
  examples: {
    missingFailedOrNoAction: OneShotStatisticsJiraExample[];
    presentPassed: OneShotStatisticsJiraExample[];
  };
}

export interface OneShotReadinessStratum {
  kind: "repo" | "stage";
  label: string;
  weak: OneShotTicketQualityCohort;
  nonWeak: OneShotTicketQualityCohort;
  significantSameDirection: boolean;
}

export interface OneShotStratifiedReadinessGap {
  weak: OneShotTicketQualityCohort;
  nonWeak: OneShotTicketQualityCohort;
  significantOverall: boolean;
  eligibleWeakCoverageShare: number;
  significantWeakCoverageShare: number;
  qualifiesForRecommendation: boolean;
  dominantStrata: OneShotReadinessStratum[];
  recommendationSummary: string | null;
}

export interface OneShotTicketQualityDataHygieneCallout {
  title: string;
  summary: string;
  missingDescriptionCount: number;
  missingDescriptionShare: number;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotTicketQualityAnalysis {
  rubric: OneShotTicketQualityRubric;
  disclaimer: string;
  totalIntake: number;
  averageScore: number;
  readinessDistribution: OneShotTicketQualityDistributionBucket[];
  passRateByTier: OneShotTicketQualityDistributionBucket[];
  templateFit: OneShotTicketQualityDistributionBucket[];
  missingSignalImpact: OneShotMissingSignalImpact[];
  dataHygieneCallout: OneShotTicketQualityDataHygieneCallout | null;
  stratifiedReadinessGap: OneShotStratifiedReadinessGap;
}

export interface OneShotStatisticsDelta {
  currentValue: number;
  priorValue: number;
  delta: number;
  pctChange: number | null;
}

export interface OneShotStatisticsScorecard {
  intake: number;
  qualifiedRuns: number;
  completed: number;
  failed: number;
  noAction: number;
  passRate: number;
  totalTokens: number;
  totalUsd: number;
  p50TimeToPrMs: number;
  p90TimeToPrMs: number;
  deltas: {
    intake: OneShotStatisticsDelta | null;
    passRate: OneShotStatisticsDelta | null;
    completed: OneShotStatisticsDelta | null;
    failed: OneShotStatisticsDelta | null;
    totalUsd: OneShotStatisticsDelta | null;
    totalTokens: OneShotStatisticsDelta | null;
    p50TimeToPrMs: OneShotStatisticsDelta | null;
  };
}

export interface OneShotStatisticsJiraExample {
  jiraKey: string;
  dashboardId: string;
  title: string;
  jiraUrl: string | null;
}

export interface OneShotStatisticsBucket {
  id: string;
  label: string;
  kind: OneShotStatisticsBucketKind;
  sampleSize: number;
  completed: number;
  failed: number;
  noAction: number;
  passRate: number;
  avgTokens: number;
  avgUsd: number;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotStatisticsInsight {
  id: string;
  bucketId: string;
  title: string;
  summary: string;
  reason: string;
  sampleSize: number;
  passRate: number;
  confidence: number;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotStatisticsBusinessMetric {
  id: string;
  title: string;
  summary: string;
  delta: OneShotStatisticsDelta | null;
}

export interface OneShotStatisticsAction {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  summary: string;
  bucketId: string | null;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotStatisticsModelInfo {
  provider: string | null;
  model: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  nextRefreshAt: string | null;
  dataFingerprint: string;
  refreshing: boolean;
  lastError: string | null;
  /**
   * Bumped when the LLM prompt structure or system rules change. Old snapshots
   * default to 0; current prompt is version 1.
   */
  promptVersion?: number;
}

export interface OneShotFailureAttributionNarrative {
  summary: string;
  oneshotPatterns: string[];
  ticketPatterns: string[];
}

export type OneShotFaultAttribution =
  | "oneshot"
  | "ticket"
  | "mixed"
  | "unknown";

export type OneShotFailureErrorCategory =
  | "git_operation"
  | "llm_provider"
  | "llm_output"
  | "s3_storage"
  | "db_operation"
  | "workspace"
  | "github_api"
  | "ticket_quality"
  | "plan_validation"
  | "budget"
  | "agent_logic"
  | "test_runner_skipped"
  | "ci_failure"
  | "unknown";

export interface OneShotFailureAttributionByCategory {
  errorCategory: OneShotFailureErrorCategory;
  attribution: OneShotFaultAttribution;
  sampleSize: number;
  passRateInCohort: number;
  wilson95: OneShotWilsonInterval | null;
  examples: OneShotStatisticsJiraExample[];
  significant: boolean;
}

export interface OneShotRowFailureAttribution {
  attribution: OneShotFaultAttribution;
  errorCategory: OneShotFailureErrorCategory;
  qualifierReasonCode: QualifierOutcomeReasonCode | null;
  label: OneShotFailureAttributionLabel;
  rationale: string;
  excludedFromDenominator: boolean;
}

export interface OneShotFailureAttributionSummary {
  totalFailures: number;
  excludedFromDenominator: number;
  countsByAttribution: {
    oneshot: number;
    ticket: number;
    mixed: number;
    unknown: number;
  };
  byCategory: OneShotFailureAttributionByCategory[];
  attributionVersion: number;
}

export type OneShotSelfFixCandidateStatus =
  | "eligible"
  | "ticket_created"
  | "duplicate"
  | "run_requested"
  | "failed";

export interface OneShotSelfFixCandidate {
  id: string;
  category: OneShotFailureErrorCategory;
  attribution: Extract<OneShotFaultAttribution, "oneshot">;
  sampleSize: number;
  significant: boolean;
  wilson95: OneShotWilsonInterval | null;
  passRateBaseline: number;
  range: OneShotAnalyticsRange;
  examples: OneShotStatisticsJiraExample[];
  ticketKey?: string;
  jiraUrl?: string | null;
  runRequestId?: number;
  status: OneShotSelfFixCandidateStatus;
}

export interface OneShotSelfFixConfig {
  minSampleSize: number;
  autoCreateEnabled: boolean;
  autoRunEnabled: boolean;
  targetEpicKey: string;
  targetRepo: string;
  targetBranch: string;
}

export type OneShotRepoStatusLabel =
  | "healthy"
  | "watch"
  | "blocked"
  | "insufficient_data";

export interface OneShotRepoStatusStageIssue {
  stage: Exclude<OneShotProgressStage, "pr_complete">;
  label: string;
  failed: number;
  noAction: number;
  affected: number;
  shareOfRepoIssues: number;
}

export interface OneShotRepoStatusFailureAttribution {
  attribution: OneShotFaultAttribution;
  errorCategory: OneShotFailureErrorCategory;
  label: OneShotFailureAttributionLabel;
  sampleSize: number;
}

export interface OneShotRepoStatusRow {
  repoKey: string;
  repoLabel: string;
  status: OneShotRepoStatusLabel;
  statusReason: string;
  isUnresolved: boolean;
  sampleSize: number;
  terminalCount: number;
  completed: number;
  failed: number;
  noAction: number;
  passRate: number;
  wilson95: OneShotWilsonInterval | null;
  avgTokens: number;
  avgUsd: number;
  topStageIssue: OneShotRepoStatusStageIssue | null;
  topFailureAttribution: OneShotRepoStatusFailureAttribution | null;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotRepoStatusSummary {
  range: OneShotAnalyticsRange;
  generatedAt: string;
  statusVersion: number;
  rows: OneShotRepoStatusRow[];
}

export type OneShotOperationalBottleneckKind =
  | "repo_resolution"
  | "stage_cluster"
  | "failure_category"
  | "cost_waste";

export type OneShotOperationalBottleneckSeverity = "high" | "medium" | "low";

export interface OneShotOperationalBottleneckFailureAttribution {
  attribution: OneShotFaultAttribution;
  errorCategory: OneShotFailureErrorCategory;
  label: string;
}

export interface OneShotOperationalBottleneckRow {
  id: string;
  kind: OneShotOperationalBottleneckKind;
  severity: OneShotOperationalBottleneckSeverity;
  title: string;
  summary: string;
  nextStep: string;
  affected: number;
  failed: number;
  noAction: number;
  passRate: number;
  wilson95: OneShotWilsonInterval | null;
  repoKey: string | null;
  repoLabel: string | null;
  stage: Exclude<OneShotProgressStage, "pr_complete"> | null;
  stageLabel: string | null;
  failureAttribution: OneShotOperationalBottleneckFailureAttribution | null;
  costUsd: number;
  tokens: number;
  examples: OneShotStatisticsJiraExample[];
}

export interface OneShotOperationalBottleneckSummary {
  range: OneShotAnalyticsRange;
  generatedAt: string;
  bottleneckVersion: number;
  rows: OneShotOperationalBottleneckRow[];
}

export interface OneShotStatisticsResponse {
  status: OneShotStatisticsStatus;
  range: OneShotAnalyticsRange;
  window: OneShotAnalyticsWindow;
  summary: string;
  scorecard: OneShotStatisticsScorecard;
  buckets: OneShotStatisticsBucket[];
  workingWell: OneShotStatisticsInsight[];
  needsImprovement: OneShotStatisticsInsight[];
  businessMetrics: OneShotStatisticsBusinessMetric[];
  ticketQuality: OneShotTicketQualityAnalysis;
  repoStatus: OneShotRepoStatusSummary;
  operationalBottlenecks: OneShotOperationalBottleneckSummary;
  recommendedActions: OneShotStatisticsAction[];
  /**
   * Optional failure-attribution view. Older snapshots written before
   * attributionVersion=1 will not carry this field; UI must treat it as
   * optional and gracefully omit the section when absent.
   */
  failureAttribution?: OneShotFailureAttributionSummary;
  /**
   * Optional LLM-supplied prose describing patterns observed in
   * failureAttribution. Pure narrative — never carries numeric claims.
   * Absent when no LLM has run.
   */
  failureAttributionNarrative?: OneShotFailureAttributionNarrative;
  /**
   * Optional LLM-supplied prose describing the template-fit picture.
   * Absent when no LLM has run.
   */
  templateFitNarrative?: string;
  selfFixCandidates: OneShotSelfFixCandidate[];
  selfFixConfig: OneShotSelfFixConfig;
  minSampleSize: number;
  modelInfo: OneShotStatisticsModelInfo;
}

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
  createdAt?: string | null;
  updatedAt?: string | null;
  labels?: string[];
  clientName?: string | null;
  environment?: string | null;
  codeVersion?: string | null;
  descriptionText?: string | null;
  commentText?: string | null;
}

export interface OneShotRunsResponse {
  runs: OneShotDashboardRow[];
  artifactRuns: OneShotArtifactRun[];
  pagination: OneShotRunsPagination;
  stats: OneShotRunsStats;
  capabilities: OneShotDashboardCapabilities;
  analytics: OneShotDashboardAnalytics;
}

export interface OneShotRunsQuery {
  limit: number;
  offset: number;
  state?: string;
  repo?: string;
  jiraKey?: string;
  deployment?: string;
  ticketType?: OneShotTicketType | "all";
  view?: "running" | "queued" | "waiting" | "history" | "all";
  range?: OneShotAnalyticsRange;
  snapshot?: "dashboard";
}
