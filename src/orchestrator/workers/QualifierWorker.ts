import type { EventEmitter } from "events";
import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import type {
  CodeRepository,
  CustomerBranch,
  TaskManagement,
} from "../database.js";
import {
  DEFAULT_QUALIFIER_MODEL,
  QualifierAgent,
  type QualifierAssessmentMetrics,
  type QualifierRepoRoutingOverride,
} from "../../agents/qualifier/index.js";
import { createLogger } from "../../utils/logger.js";
import {
  resolveBranchForQualification,
  type BranchResolutionResult,
} from "../../oneshot/branch-resolution.js";
import {
  resolveExplicitRepoHint,
  type ExplicitRepoResolution,
} from "../../oneshot/explicit-repo-resolution.js";
import { OneShotService } from "../../oneshot/service.js";
import {
  AI_AGENTS_REPO_SLUG,
  getOneShotRepoMetadata,
  isOneShotRepoEnabled,
} from "../../oneshot/repo-metadata.js";
import {
  getQualifierMode,
  ONESHOT_FACTORY_BUILDER_LABEL,
  isFactoryBuilderTicket,
  isOneShotIntakeTicket,
  isPfosReplanEligibleRun,
  normalizeJiraLabels,
  PFOS_LABEL,
  PFOS_FORCE_APPROVE_LABEL,
  PFOS_NOT_QUALIFIED_LABEL,
  PFOS_REPLAN_LABEL,
  PFOS_DONE_LABEL,
  PFOS_FAILED_LABEL,
  PFOS_BLOCKED_LABEL,
  SONAR_AUTOFIX_LABEL,
  SONAR_NOT_QUALIFIED_LABEL,
  type QualifierMode,
} from "../../oneshot/contracts.js";
import {
  CLIENT_ELIGIBILITY_JIRA_EXPAND,
  evaluateClientEligibility,
} from "../../oneshot/client-eligibility.js";
import {
  extractGitHubPullRequestUrlsFromText,
  RetrofitSourceEvidenceLookupError,
  resolveRetrofitRepoMatches,
  type RetrofitRepoResolutionMatch,
  type RetrofitSourcePullRequestCandidate,
} from "../../oneshot/retrofit-repo-resolution.js";
import type { RetrofitSourceEvidence } from "../../oneshot/retrofit-source-evidence.js";
import {
  parseGitHubPullRequestUrl,
  parseGitHubRepoUrl,
} from "../../oneshot/github.js";
import {
  buildBranchDriftComment,
  buildForceApproveComment,
  buildHandoffExhaustedComment,
  buildQualificationNotReadyComment,
  buildQualificationReadyComment,
  buildReplanQueuedComment,
  wrapOneShotQualifierComment,
} from "../../oneshot/jira-comments.js";
import {
  formatProfiledRepoSummariesForPrompt,
  getProfiledRepoSummariesForLlm,
} from "../../oneshot/qualifier-repo-context.js";
import { buildQualifierConfirmationPlan } from "../../oneshot/qualifier-confirmation-plan.js";
import {
  TICKET_EVIDENCE_SCHEMA_VERSION,
  deriveTicketEvidenceKey,
  isTicketEvidenceStats,
  type TicketEvidenceRef,
  type TicketEvidenceV1,
} from "../../oneshot/ticket-evidence.js";
import {
  parseQualificationAssessment,
  type QualificationAssessment,
  type MultiBranchRetrofitPlan,
  type MultiRepoSlice,
  type RepoSelection,
} from "../../oneshot/schema/qualification.js";
import type { OneShotRun } from "../../oneshot/types.js";

const logger = createLogger("qualifier-worker");

// QUALIFIER model fallback. Imported from the agent so the metadata column
// always matches the model the agent actually invoked.
const FALLBACK_QUALIFIER_MODEL = DEFAULT_QUALIFIER_MODEL;

export interface QualifierJiraIssue {
  key: string;
  names?: Record<string, string>;
  fields: {
    summary: string;
    description?: unknown;
    labels?: string[];
    issuetype?: { name?: string };
    [key: string]: unknown;
  };
}

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
  | "needs_confirmation"
  | "llm_qualified"
  | "llm_error_parked"
  | "llm_schema_invalid"
  | "llm_rejected"
  | "client_ineligible";

export interface QualifierOutcome {
  disposition: QualifierOutcomeDisposition;
  reasonCode: QualifierOutcomeReasonCode;
  reason: string;
  qualifierMode: QualifierMode | null;
  labels: string[];
  latestRunState: string | null;
  acceptanceCriteriaPresent?: boolean;
  templateMatched?: QualificationAssessment["templateMatched"];
  repoSelectionType?: RepoSelection["type"];
  selectedRepoIds?: number[];
}

const ACCEPTANCE_CRITERIA_FIELD_PATTERNS = [
  /\bacceptance\s+criteria\b/i,
  /\bdefinition\s+of\s+done\b/i,
  /\bdone\s+when\b/i,
];

function flattenJiraFieldValue(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenJiraFieldValue(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];

    if (typeof record.text === "string") {
      const text = record.text.trim();
      if (text) {
        parts.push(text);
      }
    }

    if (typeof record.value === "string") {
      const text = record.value.trim();
      if (text) {
        parts.push(text);
      }
    }

    if (typeof record.name === "string") {
      const text = record.name.trim();
      if (text) {
        parts.push(text);
      }
    }

    if (Array.isArray(record.content)) {
      parts.push(
        ...record.content.flatMap((item) => flattenJiraFieldValue(item)),
      );
    }

    return parts;
  }

  return [];
}

export function stringifyJiraFieldValue(value: unknown): string {
  return flattenJiraFieldValue(value).join("\n").trim();
}

export function extractAcceptanceCriteriaText(
  issue: QualifierJiraIssue,
): string | undefined {
  const legacyField = stringifyJiraFieldValue(
    issue.fields.customfield_acceptance_criteria,
  );
  if (legacyField) {
    return legacyField;
  }

  const names = issue.names ?? {};
  for (const [fieldId, fieldName] of Object.entries(names)) {
    if (
      !ACCEPTANCE_CRITERIA_FIELD_PATTERNS.some((pattern) =>
        pattern.test(fieldName),
      )
    ) {
      continue;
    }

    const fieldText = stringifyJiraFieldValue(issue.fields[fieldId]);
    if (fieldText) {
      return fieldText;
    }
  }

  return undefined;
}

export function extractParentEpicTitle(
  issue: QualifierJiraIssue,
): string | undefined {
  const parent = issue.fields.parent;
  if (!parent || typeof parent !== "object") {
    return undefined;
  }

  const fields = ((parent as Record<string, unknown>).fields ?? {}) as Record<
    string,
    unknown
  >;
  const summary = stringifyJiraFieldValue(fields.summary);
  return summary || undefined;
}

export function extractEpicKey(issue: QualifierJiraIssue): string | undefined {
  const issueType = issue.fields.issuetype;
  const issueTypeName = issueType?.name?.trim().toLowerCase();
  if (issueTypeName === "epic") {
    return issue.key;
  }
  if ((issueType as Record<string, unknown> | undefined)?.subtask === true) {
    return undefined;
  }

  const parent = issue.fields.parent;
  if (!parent || typeof parent !== "object") {
    return undefined;
  }

  const parentKey = (parent as Record<string, unknown>).key;
  return typeof parentKey === "string" && parentKey.trim().length > 0
    ? parentKey.trim()
    : undefined;
}

export function buildRawQualificationText(issue: QualifierJiraIssue): string {
  const lines = [
    issue.fields.summary,
    extractParentEpicTitle(issue),
    stringifyJiraFieldValue(issue.fields.description),
    extractAcceptanceCriteriaText(issue),
    ...(issue.fields.labels ?? []),
    ...flattenJiraFieldValue(issue.fields.fixVersions),
    ...flattenJiraFieldValue(issue.fields.components),
  ];

  return lines
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildQualifierMetrics(
  startTime: number,
  qualifierOutcome: QualifierOutcome,
  llmMetrics?: QualifierAssessmentMetrics,
): NonNullable<ProcessResult["metrics"]> {
  const input = llmMetrics?.tokensUsed?.input ?? 0;
  const output = llmMetrics?.tokensUsed?.output ?? 0;
  return {
    durationMs: Date.now() - startTime,
    qualifierOutcome: { ...qualifierOutcome },
    ...(llmMetrics?.tokensUsed
      ? {
          totalTokens: { input, output },
          tokensUsed: llmMetrics.tokensUsed,
        }
      : {}),
    ...(typeof llmMetrics?.costUsd === "number"
      ? { cost: llmMetrics.costUsd, costUsd: llmMetrics.costUsd }
      : {}),
    ...(llmMetrics?.modelUsed ? { modelUsed: llmMetrics.modelUsed } : {}),
    ...(llmMetrics ? { provider: "anthropic" } : {}),
  };
}

function buildQualifierOutcome(input: {
  disposition: QualifierOutcomeDisposition;
  reasonCode: QualifierOutcomeReasonCode;
  reason: string;
  qualifierMode: QualifierMode | null;
  labels?: string[];
  latestRunState?: string | null;
  acceptanceCriteriaPresent?: boolean;
  templateMatched?: QualificationAssessment["templateMatched"];
  repoSelectionType?: RepoSelection["type"];
  selectedRepoIds?: number[];
}): QualifierOutcome {
  return {
    disposition: input.disposition,
    reasonCode: input.reasonCode,
    reason: input.reason,
    qualifierMode: input.qualifierMode,
    labels: input.labels ?? [],
    latestRunState: input.latestRunState ?? null,
    ...(input.acceptanceCriteriaPresent !== undefined
      ? { acceptanceCriteriaPresent: input.acceptanceCriteriaPresent }
      : {}),
    ...(input.templateMatched
      ? { templateMatched: input.templateMatched }
      : {}),
    ...(input.repoSelectionType
      ? { repoSelectionType: input.repoSelectionType }
      : {}),
    ...(input.selectedRepoIds
      ? { selectedRepoIds: input.selectedRepoIds }
      : {}),
  };
}

export function classifyQualifierNoActionReason(
  labels: string[] | undefined,
  latestRunState: string | null | undefined,
): Pick<QualifierOutcome, "reasonCode" | "reason"> {
  const normalizedLabels = normalizeJiraLabels(labels);

  if (!isOneShotIntakeTicket(labels)) {
    return {
      reasonCode: "pfos_label_missing_at_processing",
      reason: `No OneShot action was taken because neither ${PFOS_LABEL} nor ${SONAR_AUTOFIX_LABEL} was present when QUALIFIER processed the task.`,
    };
  }

  const notQualifiedLabel = getNotQualifiedLabelForLabels(labels);
  const replanCommandPresent =
    normalizedLabels.has(PFOS_LABEL) &&
    normalizedLabels.has(PFOS_REPLAN_LABEL);
  if (!latestRunState && replanCommandPresent) {
    return {
      reasonCode: "missing_qualifying_run",
      reason: `No OneShot action was taken because ${PFOS_REPLAN_LABEL} requires an existing same-run replan target.`,
    };
  }
  if (!latestRunState && normalizedLabels.has(notQualifiedLabel)) {
    return {
      reasonCode: "pfos_not_qualified_label_present",
      reason: `No OneShot action was taken because ${notQualifiedLabel} is still present on a fresh ticket.`,
    };
  }

  const hasControlLabel =
    normalizedLabels.has(PFOS_FORCE_APPROVE_LABEL) ||
    normalizedLabels.has(PFOS_REPLAN_LABEL);
  return {
    reasonCode: "existing_run_not_actionable",
    reason: hasControlLabel
      ? `No OneShot action was taken because the requested control-label action is not valid for the current run state${latestRunState ? ` (${latestRunState})` : ""}.`
      : `No OneShot action was taken because an existing OneShot run is not in an actionable state${latestRunState ? ` (${latestRunState})` : ""}.`,
  };
}

function getNotQualifiedLabelForLabels(labels: string[] | undefined): string {
  const normalizedLabels = normalizeJiraLabels(labels);
  if (normalizedLabels.has(SONAR_AUTOFIX_LABEL)) {
    return SONAR_NOT_QUALIFIED_LABEL;
  }
  if (normalizedLabels.has(PFOS_LABEL)) {
    return PFOS_NOT_QUALIFIED_LABEL;
  }
  throw new Error(
    `Cannot resolve OneShot not-qualified label without ${PFOS_LABEL} or ${SONAR_AUTOFIX_LABEL}.`,
  );
}

function emptyQualificationAssessment(
  blockingReasons: string[],
  nonBlockingWarnings: string[],
): QualificationAssessment {
  return parseQualificationAssessment({
    qualified: false,
    templateMatched: "none",
    requirementsSummary: [],
    acceptanceCriteriaPresent: false,
    blockingReasons,
    nonBlockingWarnings,
    qualificationReasoning: "",
    repoSelection: {
      type: "no_match",
      selectedRepoIds: [],
      candidateSummaries: [],
      repoReasoning: "",
    },
  });
}

/**
 * Heuristic to detect schema/parse failures coming back from the LLM
 * call. Zod throws `ZodError` (constructor name + .issues array). The
 * agent also wraps json-repair failures into errors whose message
 * contains "schema" or "parse". Anything else is treated as infra
 * (Bedrock 5xx, network, timeout).
 */
function isLikelySchemaError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (
    error.name === "ZodError" ||
    Array.isArray((error as { issues?: unknown }).issues)
  ) {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("zod") ||
    message.includes("schema") ||
    message.includes("invalid json") ||
    message.includes("failed to parse")
  );
}

/**
 * Checks semantic invariants beyond schema validation. The schema lets
 * `needs_confirmation` come back with empty selectedRepoIds, and lets
 * `explicit_github` come back without `explicitRepoRef` — both produce
 * useless parking rows. Returns a human-readable error message when an
 * invariant is violated, or null when the assessment is usable.
 */
function detectQualifierLlmSemanticIssue(
  assessment: QualificationAssessment,
): string | null {
  const selection = assessment.repoSelection;
  if (
    selection.type === "needs_confirmation" &&
    selection.selectedRepoIds.length < 2
  ) {
    return `repoSelection.type=needs_confirmation requires 2+ selectedRepoIds, got ${selection.selectedRepoIds.length}`;
  }
  if (
    selection.type === "explicit_github" &&
    (!selection.explicitRepoRef || selection.explicitRepoRef.trim() === "")
  ) {
    return "repoSelection.type=explicit_github requires explicitRepoRef";
  }
  if (
    selection.type === "profiled_repo" &&
    selection.selectedRepoIds.length !== 1
  ) {
    return `repoSelection.type=profiled_repo requires exactly 1 selectedRepoId, got ${selection.selectedRepoIds.length}`;
  }
  if (selection.type === "multi_repo") {
    const plan = assessment.multiRepoPlan;
    if (!plan || plan.length === 0) {
      return "repoSelection.type=multi_repo requires multiRepoPlan to be present";
    }
    if (plan.length < 2) {
      return `repoSelection.type=multi_repo requires at least 2 repo slices in multiRepoPlan, got ${plan.length}`;
    }
    const seenRefs = new Set<string>();
    for (let i = 0; i < plan.length; i++) {
      const slice = plan[i];
      if (!slice.repoRef || slice.repoRef.trim() === "") {
        return `multiRepoPlan[${i}].repoRef must not be blank`;
      }
      const normalizedRef = slice.repoRef.trim();
      if (seenRefs.has(normalizedRef)) {
        return `multiRepoPlan contains duplicate repoRef: ${normalizedRef}`;
      }
      seenRefs.add(normalizedRef);
      if (!slice.objective || slice.objective.trim() === "") {
        return `multiRepoPlan[${i}].objective must not be blank`;
      }
      if (!slice.acceptanceCriteria || slice.acceptanceCriteria.length === 0) {
        return `multiRepoPlan[${i}].acceptanceCriteria must not be empty`;
      }
      if (!Number.isInteger(slice.mergeOrder) || slice.mergeOrder <= 0) {
        return `multiRepoPlan[${i}].mergeOrder must be a positive integer, got ${slice.mergeOrder}`;
      }
    }
  }
  if (assessment.multiBranchRetrofitPlan) {
    const plan = assessment.multiBranchRetrofitPlan;
    if (assessment.templateMatched !== "retrofit_template") {
      return "multiBranchRetrofitPlan requires templateMatched=retrofit_template";
    }
    if (
      selection.type !== "profiled_repo" &&
      selection.type !== "explicit_github"
    ) {
      return "multiBranchRetrofitPlan requires a single concrete repository selection";
    }
    if (selection.type === "profiled_repo" && selection.selectedRepoIds.length !== 1) {
      return `multiBranchRetrofitPlan with profiled_repo requires exactly 1 selectedRepoId, got ${selection.selectedRepoIds.length}`;
    }
    if (selection.type === "explicit_github" && !selection.explicitRepoRef?.trim()) {
      return "multiBranchRetrofitPlan with explicit_github requires explicitRepoRef";
    }
    if (!plan.repoRef.trim()) {
      return "multiBranchRetrofitPlan.repoRef must not be blank";
    }
    if (!plan.sourceJiraKey.trim()) {
      return "multiBranchRetrofitPlan.sourceJiraKey must not be blank";
    }
    if (!plan.sourceBranch.trim()) {
      return "multiBranchRetrofitPlan.sourceBranch must not be blank";
    }
    if (plan.targetBranches.length < 2 || plan.targetBranches.length > 7) {
      return `multiBranchRetrofitPlan requires 2 to 7 targetBranches, got ${plan.targetBranches.length}`;
    }
    const seenTargetBranches = new Set<string>();
    for (const targetBranch of plan.targetBranches) {
      const normalizedTargetBranch = targetBranch.trim().toLowerCase();
      if (!normalizedTargetBranch) {
        return "multiBranchRetrofitPlan.targetBranches must not contain blank targetBranch";
      }
      if (seenTargetBranches.has(normalizedTargetBranch)) {
        return `multiBranchRetrofitPlan contains duplicate targetBranch: ${targetBranch.trim()}`;
      }
      seenTargetBranches.add(normalizedTargetBranch);
    }
  }
  return null;
}

function isFactoryBuilderOverridableSemanticIssue(error: string): boolean {
  return (
    error.startsWith("repoSelection.type=") ||
    error.startsWith("multiRepoPlan") ||
    error.startsWith("multiBranchRetrofitPlan")
  );
}

function repoSelectionIsConcrete(selection: RepoSelection): boolean {
  if (
    selection.type === "profiled_repo" &&
    selection.selectedRepoIds.length === 1
  ) {
    return true;
  }
  if (
    selection.type === "explicit_github" &&
    typeof selection.explicitRepoRef === "string" &&
    selection.explicitRepoRef.trim() !== ""
  ) {
    return true;
  }
  if (selection.type === "multi_repo") {
    return selection.selectedRepoIds.length >= 2;
  }
  return false;
}

function isAttachmentEvidenceGapReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  const hardBlockerPattern =
    /\b(acceptance|ambiguous_goal|ambiguous scope|scope_too_broad|too broad|repo|repository|branch|retrofit|template|missing requirement|requirements_missing)\b/;
  if (hardBlockerPattern.test(normalized)) {
    return false;
  }
  return (
    normalized.includes("file_format") ||
    normalized.includes("file format") ||
    normalized.includes("format unspecified") ||
    normalized.includes("format unconfirmed") ||
    normalized.includes("column_list") ||
    normalized.includes("column list") ||
    normalized.includes("column structure") ||
    normalized.includes("binary attachment") ||
    normalized.includes("not fully parsed") ||
    normalized.includes("unsupported attachment") ||
    normalized.includes("unsupported file") ||
    normalized.includes("spreadsheet") ||
    normalized.includes(".xls") ||
    normalized.includes(".xlsx") ||
    normalized.includes("attachment extraction") ||
    normalized.includes("extraction failed")
  );
}

export function normalizeAttachmentGapOnlyQualificationRejection(
  assessment: QualificationAssessment,
): QualificationAssessment {
  if (assessment.qualified || assessment.blockingReasons.length === 0) {
    return assessment;
  }
  if (!assessment.acceptanceCriteriaPresent) {
    return assessment;
  }
  if (assessment.requirementsSummary.length === 0) {
    return assessment;
  }
  if (!repoSelectionIsConcrete(assessment.repoSelection)) {
    return assessment;
  }
  if (
    !assessment.blockingReasons.every((reason) =>
      isAttachmentEvidenceGapReason(reason),
    )
  ) {
    return assessment;
  }

  const warnings = assessment.blockingReasons.map(
    (reason) => `Attachment evidence gap (non-blocking): ${reason}`,
  );
  return {
    ...assessment,
    qualified: true,
    blockingReasons: [],
    nonBlockingWarnings: Array.from(
      new Set([...assessment.nonBlockingWarnings, ...warnings]),
    ),
    qualificationReasoning: [
      assessment.qualificationReasoning,
      "Attachment format/column extraction gaps were preserved as non-blocking evidence gaps because the ticket goal, acceptance criteria, and repository selection were otherwise clear.",
    ]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" "),
  };
}

interface QualifierLlmContext {
  jiraIssue: QualifierJiraIssue;
  taskDescription: string;
  additionalContext: string;
  taskRoutingPath: string;
  taskManagement: TaskManagement;
  customerBranch: CustomerBranch;
}

function deriveTicketEvidenceRefFromTaskManagement(
  taskManagement: TaskManagement,
): TicketEvidenceRef | undefined {
  if (!taskManagement.task_s3_bucket || !taskManagement.task_s3_key) {
    return undefined;
  }
  return {
    schemaVersion: TICKET_EVIDENCE_SCHEMA_VERSION,
    bucket: taskManagement.task_s3_bucket,
    key: deriveTicketEvidenceKey(taskManagement.task_s3_key),
  };
}

/**
 * Distinguishes LLM-call failure modes so the dispatcher can park the
 * ticket with the right reasonCode and Jira comment text:
 * - "infra": Bedrock 5xx, timeout, network — likely retry succeeds.
 * - "schema": LLM returned syntactically valid output that fails our Zod
 *   schema. Indicates a prompt or schema regression. Operator should
 *   investigate before retrying.
 * - "profile": Failed to load profiled-repo catalog (missing YAML in
 *   prod). The LLM never ran; the ticket is parked while ops fixes the
 *   config.
 */
type QualifierLlmFailureKind = "infra" | "schema" | "profile";

interface QualifierLlmResult {
  assessment: QualificationAssessment;
  metrics?: QualifierAssessmentMetrics;
  /** Set when the LLM call itself failed; pairs with failureKind. */
  failureMessage?: string;
  failureKind?: QualifierLlmFailureKind;
}

interface FactoryBuilderRoutingMetadata {
  label: string;
  targetRepoId: number;
  targetRepoName: string;
  targetGithubSlug: string;
  originalRepoSelection: RepoSelection;
  demotedBlockingReasons?: string[];
}

export class QualifierWorker extends AgentWorker {
  private qualifierAgent: QualifierAgent | null = null;

  constructor(repositoryPath: string, enableStatusServer = false) {
    super({
      agentName: "QUALIFIER",
      repositoryPath,
      pollingIntervalMs: 10000,
      batchSize: 1,
      enableStatusServer,
    });
  }

  private async buildTicketEvidenceRefFromTaskManagement(
    taskManagement: TaskManagement,
    jiraKey: string,
  ): Promise<TicketEvidenceRef | undefined> {
    const ref = deriveTicketEvidenceRefFromTaskManagement(taskManagement);
    if (!ref) {
      return undefined;
    }

    try {
      const raw = await this.storage.downloadResult(ref.bucket, ref.key);
      const parsed = JSON.parse(raw) as TicketEvidenceV1;
      if (
        parsed.schemaVersion === TICKET_EVIDENCE_SCHEMA_VERSION &&
        parsed.jiraKey === jiraKey &&
        isTicketEvidenceStats(parsed.stats)
      ) {
        return {
          ...ref,
          stats: parsed.stats,
        };
      }
      logger.warn(
        {
          jira: jiraKey,
          bucket: ref.bucket,
          key: ref.key,
          schemaVersion: parsed.schemaVersion,
          evidenceJiraKey: parsed.jiraKey,
        },
        "Ticket evidence stats unavailable or mismatched; omitting evidence ref",
      );
    } catch (error) {
      logger.warn(
        {
          jira: jiraKey,
          bucket: ref.bucket,
          key: ref.key,
          error: error instanceof Error ? error.message : String(error),
        },
        "Ticket evidence stats could not be loaded; omitting evidence ref",
      );
    }

    return undefined;
  }

  private pullRequestUrlMatchesRepo(
    prUrl: string,
    repo: CodeRepository,
  ): boolean {
    try {
      const pr = parseGitHubPullRequestUrl(prUrl);
      const repoRef = parseGitHubRepoUrl(repo.repo_url);
      return (
        pr.owner.toLowerCase() === repoRef.owner.toLowerCase() &&
        pr.repo.toLowerCase() === repoRef.repo.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  private async buildRetrofitSourcePullRequestCandidates(input: {
    sourceJiraKey: string;
    repo: CodeRepository;
    oneShotService: OneShotService;
    sourcePrUrl?: string;
    ticketText?: string;
  }): Promise<RetrofitSourcePullRequestCandidate[]> {
    const candidates: RetrofitSourcePullRequestCandidate[] = [];
    const addCandidate = (
      prUrl: string | null | undefined,
      method: RetrofitSourcePullRequestCandidate["method"],
    ) => {
      const normalized = prUrl?.trim();
      if (!normalized || !this.pullRequestUrlMatchesRepo(normalized, input.repo)) {
        return;
      }
      if (
        candidates.some(
          (candidate) =>
            candidate.prUrl.toLowerCase() === normalized.toLowerCase(),
        )
      ) {
        return;
      }
      candidates.push({ prUrl: normalized, method });
    };

    addCandidate(input.sourcePrUrl, "source_pr");
    for (const prUrl of extractGitHubPullRequestUrlsFromText(
      input.ticketText ?? "",
    )) {
      addCandidate(prUrl, "source_pr");
    }
    if (candidates.length > 0) {
      return candidates;
    }

    const getLatestRunWithPrByJiraKey = (
      input.oneShotService as {
        getLatestRunWithPrByJiraKey?: OneShotService["getLatestRunWithPrByJiraKey"];
      }
    ).getLatestRunWithPrByJiraKey;
    const getLatestRunByJiraKey = (
      input.oneShotService as {
        getLatestRunByJiraKey?: OneShotService["getLatestRunByJiraKey"];
      }
    ).getLatestRunByJiraKey;
    const getSourceRunWithPr =
      typeof getLatestRunWithPrByJiraKey === "function"
        ? getLatestRunWithPrByJiraKey
        : getLatestRunByJiraKey;
    if (typeof getSourceRunWithPr === "function") {
      try {
        const sourceRun = await getSourceRunWithPr.call(
          input.oneShotService,
          input.sourceJiraKey,
        );
        addCandidate(sourceRun?.current_pr_url, "source_run_pr");
        if (sourceRun?.current_pr_url) {
          logger.info(
            {
              sourceJiraKey: input.sourceJiraKey,
              sourceRunId: sourceRun.id,
              repoName: input.repo.repo_name,
              accepted: this.pullRequestUrlMatchesRepo(
                sourceRun.current_pr_url,
                input.repo,
              ),
            },
            "[QUALIFIER_RETROFIT_SOURCE_PR_SOURCE_RUN] Checked source OneShot run PR",
          );
        }
      } catch (error) {
        throw new RetrofitSourceEvidenceLookupError(
          `source_pr_lookup_failed: Could not load prior OneShot run for source Jira ${input.sourceJiraKey}.`,
          error instanceof Error ? error.message : String(error),
          "source_pr_lookup_failed",
        );
      }
    }
    if (candidates.length > 0) {
      return candidates;
    }

    if (
      process.env.JIRA_BASE_URL?.trim() &&
      this.agentJiraUsername &&
      this.agentJiraToken
    ) {
      try {
        const sourceIssue = await this.getJiraIssue(input.sourceJiraKey);
        const sourceIssueText = [
          buildRawQualificationText(sourceIssue),
          stringifyJiraFieldValue(sourceIssue.fields.comment),
        ]
          .filter(Boolean)
          .join("\n");
        for (const prUrl of extractGitHubPullRequestUrlsFromText(
          sourceIssueText,
        )) {
          addCandidate(prUrl, "jira_pr_link");
        }
      } catch (error) {
        throw new RetrofitSourceEvidenceLookupError(
          `source_pr_lookup_failed: Could not inspect source Jira ${input.sourceJiraKey} for pull request links.`,
          error instanceof Error ? error.message : String(error),
          "source_pr_lookup_failed",
        );
      }
    }

    return candidates;
  }

  private buildRetrofitSourceLookupFailureResult(
    input: {
      jiraIssue: QualifierJiraIssue;
      reason: string;
      causeDescription?: string;
      startTime: number;
      assessment: QualificationAssessment;
      metrics: QualifierAssessmentMetrics | undefined;
      latestRun: Pick<OneShotRun, "state"> | null;
    },
  ): ProcessResult {
    const reason =
      `${input.reason}` +
      (input.causeDescription ? ` ${input.causeDescription}` : "");
    const outcome = buildQualifierOutcome({
      disposition: "no_action",
      reasonCode: "repo_resolution_failed",
      reason,
      qualifierMode: "fresh",
      labels: input.jiraIssue.fields.labels ?? [],
      latestRunState: input.latestRun?.state ?? null,
      acceptanceCriteriaPresent: input.assessment.acceptanceCriteriaPresent,
      templateMatched: input.assessment.templateMatched,
      repoSelectionType: input.assessment.repoSelection.type,
    });

    return {
      success: false,
      error: reason,
      output: wrapOneShotQualifierComment(
        [
          "## OneShot | Retrofit Source Lookup Failed",
          `**Ticket:** \`${input.jiraIssue.key}\``,
          "",
          "QUALIFIER approved this retrofit ticket, but source PR/commit evidence lookup failed before OneShot could create the run. The task will be retried by the worker instead of marking the ticket not qualified.",
          "",
          `**Reason:** ${reason}`,
        ].join("\n"),
      ),
      metrics: buildQualifierMetrics(
        input.startTime,
        outcome,
        input.metrics,
      ),
    };
  }

  protected async process(
    jiraNumber: string,
    taskId: number,
    taskDescription: string,
    additionalContext: string,
    repositoryPath: string,
    _eventEmitter?: EventEmitter,
  ): Promise<ProcessResult> {
    const startTime = Date.now();
    const logContext = {
      jira: jiraNumber,
      taskId,
      agent: "QUALIFIER",
    };

    const taskManagement = await this.db.getTaskManagementByTaskId(taskId);
    if (!taskManagement) {
      throw new Error(`No task_management row found for task ${taskId}`);
    }

    const customerBranch = await this.db.getCustomerBranchById(
      taskManagement.customer_id,
    );
    if (!customerBranch) {
      throw new Error(
        `Customer branch not found for customer_id=${taskManagement.customer_id}`,
      );
    }

    const jiraIssue = await this.getJiraIssue(jiraNumber);
    const oneShotService = new OneShotService(this.db);
    const latestRun = await oneShotService.getLatestRunByJiraKey(jiraNumber);
    const mode = getQualifierMode(jiraIssue.fields.labels, latestRun);

    logger.info(
      {
        ...logContext,
        mode,
        latestRunState: latestRun?.state,
        labels: jiraIssue.fields.labels ?? [],
      },
      "[QUALIFIER_MODE]",
    );

    if (!mode) {
      const normalizedLabels = normalizeJiraLabels(jiraIssue.fields.labels);
      const replanCommandPresent = this.hasPfosReplanCommand(
        jiraIssue.fields.labels,
      );
      const noAction = classifyQualifierNoActionReason(
        jiraIssue.fields.labels,
        latestRun?.state ?? null,
      );
      if (replanCommandPresent) {
        const cleanupReason = latestRun
          ? isPfosReplanEligibleRun(latestRun)
            ? "replan_already_in_flight"
            : "replan_not_eligible"
          : "missing_qualifying_run";
        if (latestRun) {
          await oneShotService.recordControlReplanNoop(
            latestRun,
            cleanupReason,
            {
              latestRunState: latestRun.state,
              currentPrUrl: latestRun.current_pr_url ?? null,
            },
          );
        }
        await this.consumeReplanLabelBestEffort(
          jiraIssue,
          oneShotService,
          latestRun,
          cleanupReason,
        );
      } else if (latestRun && normalizedLabels.has(PFOS_LABEL)) {
        await oneShotService.recordReplanLabelCleanupObserved(
          latestRun,
          "pfos_replan_label_absent",
        );
      }
      const outcome = buildQualifierOutcome({
        disposition: "no_action",
        reasonCode: noAction.reasonCode,
        reason: noAction.reason,
        qualifierMode: null,
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
      });

      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          jiraNumber,
          [outcome.reason],
          [],
          replanCommandPresent
            ? `${PFOS_REPLAN_LABEL} was consumed without creating a new run. Use it again only after an eligible same-run replan target exists.`
            : `Add ${PFOS_LABEL} or ${SONAR_AUTOFIX_LABEL} when the ticket is ready to enter the OneShot flow.`,
        ),
        metrics: buildQualifierMetrics(startTime, outcome),
      };
    }

    if (mode === "fresh") {
      const clientEligibility = await evaluateClientEligibility(
        jiraIssue,
        this.db.getPool(),
        logger,
      );
      if (clientEligibility.status === "ineligible") {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason = `Client '${clientEligibility.blockedClientDisplayName}' is not eligible for OneShot autonomous runs (client_ineligible)`;
        const outcome = buildQualifierOutcome({
          disposition: "not_qualified",
          reasonCode: "client_ineligible",
          reason,
          qualifierMode: "fresh",
          labels: jiraIssue.fields.labels ?? [],
          latestRunState: latestRun?.state ?? null,
        });
        logger.info(
          { jira: jiraIssue.key, clientKey: clientEligibility.clientKey },
          "[QUALIFIER_CLIENT_INELIGIBLE]",
        );
        return {
          success: true,
          output: this.buildQualificationFailureOutput(
            jiraNumber,
            [reason],
            [],
            "Contact the OneShot team if you believe this client should be eligible.",
          ),
          metrics: buildQualifierMetrics(startTime, outcome),
        };
      }

      return this.handleFreshQualification(
        {
          jiraIssue,
          taskDescription,
          additionalContext,
          taskRoutingPath: repositoryPath,
          taskManagement,
          customerBranch,
        },
        oneShotService,
        latestRun,
        startTime,
      );
    }

    if (!latestRun) {
      const reason =
        "The requested control-label action could not proceed because no qualifying OneShot run was found.";
      const outcome = buildQualifierOutcome({
        disposition: "no_action",
        reasonCode: "missing_qualifying_run",
        reason,
        qualifierMode: mode,
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: null,
      });

      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          jiraNumber,
          [reason],
          [],
          "Verify that a qualifying OneShot run exists before using control-label actions.",
        ),
        metrics: buildQualifierMetrics(startTime, outcome),
      };
    }

    if (mode === "force_approve") {
      return this.handleForceApprove(latestRun, oneShotService, startTime);
    }

    return this.handleReplan(latestRun, oneShotService, startTime);
  }

  /**
   * Fresh OneShot intake qualification — the LLM is the single decision maker
   * for both repo intent and qualification readiness. Deterministic code only
   * validates schema, fetches GitHub for explicit repo names, runs branch
   * resolution, and persists state.
   */
  private async handleFreshQualification(
    context: QualifierLlmContext,
    oneShotService: OneShotService,
    latestRun: Pick<
      OneShotRun,
      "state" | "repo_id" | "last_error" | "final_disposition"
    > | null,
    startTime: number,
  ): Promise<ProcessResult> {
    const { jiraIssue, taskDescription, taskManagement, customerBranch } =
      context;
    const notQualifiedLabel = getNotQualifiedLabelForLabels(
      jiraIssue.fields.labels,
    );
    const retryInstruction =
      `Resolve the blocking items and then remove \`${notQualifiedLabel}\` ` +
      "to ask QUALIFIER to review the ticket again.";

    const availableRepos = await this.db.getAllRepositories();
    const factoryBuilderActive = isFactoryBuilderTicket(jiraIssue.fields.labels);
    const factoryBuilderRepo = factoryBuilderActive
      ? this.resolveFactoryBuilderRepo(availableRepos)
      : null;
    if (factoryBuilderActive && !factoryBuilderRepo) {
      await this.ensureNotQualifiedLabel(jiraIssue);
      const reason =
        "factory_builder_repo_unsupported: Factory Builder requires the OneShot-enabled Ai-agents repository (enterprise-ai-agent-platform), but it is not available.";
      const outcome = buildQualifierOutcome({
        disposition: "not_qualified",
        reasonCode: "repo_unsupported",
        reason,
        qualifierMode: "fresh",
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
        templateMatched: "none",
        repoSelectionType: "no_match",
      });
      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          jiraIssue.key,
          [reason],
          [],
          retryInstruction,
        ),
        metrics: buildQualifierMetrics(startTime, outcome),
      };
    }

    const ticketText = this.buildQualifierTicketText(context);
    const llmResult = await this.runQualifierLlm(context, availableRepos, {
      ticketText,
      repoRoutingOverride: factoryBuilderRepo
        ? this.buildFactoryBuilderRepoRoutingOverride(factoryBuilderRepo)
        : undefined,
    });
    let assessment = llmResult.assessment;
    const normalizedAssessment =
      normalizeAttachmentGapOnlyQualificationRejection(assessment);
    if (normalizedAssessment !== assessment) {
      logger.info(
        {
          jira: jiraIssue.key,
          originalBlockingReasons: assessment.blockingReasons,
          nonBlockingWarnings: normalizedAssessment.nonBlockingWarnings,
        },
        "[QUALIFIER_ATTACHMENT_GAPS_DEMOTED] Attachment-only extraction gaps treated as non-blocking",
      );
      assessment = normalizedAssessment;
    }

    logger.info(
      {
        jira: jiraIssue.key,
        qualified: assessment.qualified,
        templateMatched: assessment.templateMatched,
        repoSelectionType: assessment.repoSelection.type,
        explicitRepoRef: assessment.repoSelection.explicitRepoRef,
        selectedRepoIds: assessment.repoSelection.selectedRepoIds,
        llmFailure: llmResult.failureMessage,
      },
      "[QUALIFIER_LLM_DECISION]",
    );

    // Bedrock outage / timeout / schema failure / profile-load failure: park
    // for human review, never apply a not-qualified label. The LLM result was
    // not authoritative.
    if (llmResult.failureMessage) {
      const candidateRepoIds = availableRepos
        .filter(isOneShotRepoEnabled)
        .map((repo) => repo.id);

      // M9-F: zero enabled repos means we can't park usefully — there's
      // nothing for a human to pick. Surface as a not_qualified outcome
      // with the source-specific not-qualified label so ops fixes the fleet
      // config.
      if (candidateRepoIds.length === 0) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          "QUALIFIER LLM call failed AND no OneShot-enabled repos exist; cannot park for confirmation.";
        const outcome = buildQualifierOutcome({
          disposition: "not_qualified",
          reasonCode: "repo_unsupported",
          reason,
          qualifierMode: "fresh",
          labels: jiraIssue.fields.labels ?? [],
          latestRunState: latestRun?.state ?? null,
          templateMatched: "none",
          repoSelectionType: "no_match",
        });
        return {
          success: true,
          output: this.buildQualificationFailureOutput(
            jiraIssue.key,
            [reason, llmResult.failureMessage],
            [],
            retryInstruction,
          ),
          metrics: buildQualifierMetrics(startTime, outcome, llmResult.metrics),
        };
      }

      const failureKind = llmResult.failureKind ?? "infra";
      const reasonCode =
        failureKind === "schema"
          ? ("llm_schema_invalid" as const)
          : ("llm_error_parked" as const);
      const reason =
        failureKind === "schema"
          ? `QUALIFIER LLM returned an invalid response: ${llmResult.failureMessage}`
          : failureKind === "profile"
            ? `QUALIFIER profile catalog could not be loaded: ${llmResult.failureMessage}`
            : `QUALIFIER LLM call failed: ${llmResult.failureMessage}`;
      const commentHeader =
        failureKind === "schema"
          ? "QUALIFIER returned an invalid response. Please file a bug with the run id; the ticket has been parked."
          : failureKind === "profile"
            ? "QUALIFIER profile catalog is unavailable (likely a missing or invalid repo profile YAML). Ops should fix the config; the ticket has been parked."
            : "QUALIFIER LLM was unavailable. The ticket has been parked so a human can either re-run QUALIFIER or pick a repository directly.";
      const outcome = buildQualifierOutcome({
        disposition: "needs_confirmation",
        reasonCode,
        reason,
        qualifierMode: "fresh",
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
        templateMatched: "none",
        repoSelectionType: "needs_confirmation",
        selectedRepoIds: candidateRepoIds,
      });
      const notQualifiedLabel = getNotQualifiedLabelForLabels(
        jiraIssue.fields.labels,
      );
      const commentBody = [
        "## OneShot | Repository Confirmation Needed",
        "",
        `**Ticket:** \`${jiraIssue.key}\``,
        "",
        commentHeader,
        "",
        `**Reason:** ${llmResult.failureMessage}`,
        "",
        "### Next Step",
        failureKind === "schema"
          ? `- File a QUALIFIER bug with the run id, then retry by removing ${notQualifiedLabel}, or pick the right repository in the OneShot Dashboard.`
          : failureKind === "profile"
            ? `- Ops should restore the missing repo profile YAML, then retry by removing ${notQualifiedLabel}, or pick the right repository in the OneShot Dashboard.`
            : `- Retry by removing ${notQualifiedLabel} if QUALIFIER service has recovered, or pick the right repository in the OneShot Dashboard.`,
      ].join("\n");
      return this.parkForRepoConfirmation({
        jiraIssue,
        taskManagement,
        availableRepos,
        candidateRepoIds,
        reason,
        commentBody,
        outcome,
        metrics: llmResult.metrics,
        startTime,
        evidence: [
          {
            type: "qualifier_llm_failure",
            failureKind,
            detail: llmResult.failureMessage,
          },
        ],
      });
    }

    let factoryBuilderMetadata: FactoryBuilderRoutingMetadata | null = null;
    if (factoryBuilderRepo) {
      const normalizedFactoryAssessment =
        this.normalizeFactoryBuilderAssessment(assessment, factoryBuilderRepo);
      assessment = normalizedFactoryAssessment.assessment;
      factoryBuilderMetadata = normalizedFactoryAssessment.metadata;
    }

    if (!assessment.qualified) {
      await this.ensureNotQualifiedLabel(jiraIssue);
      const outcome = buildQualifierOutcome({
        disposition: "not_qualified",
        reasonCode: "llm_rejected",
        reason:
          assessment.blockingReasons.join(" ") ||
          "QUALIFIER rejected the ticket for template/scope reasons.",
        qualifierMode: "fresh",
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
        acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
        templateMatched: assessment.templateMatched,
        repoSelectionType: assessment.repoSelection.type,
      });
      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          jiraIssue.key,
          assessment.blockingReasons,
          assessment.nonBlockingWarnings,
          retryInstruction,
        ),
        metrics: buildQualifierMetrics(startTime, outcome, llmResult.metrics),
      };
    }

    // qualified=true. Resolve repo per repoSelection.type.
    const selection = assessment.repoSelection;

    if (selection.type === "no_match") {
      await this.ensureNotQualifiedLabel(jiraIssue);
      const reason =
        selection.repoReasoning ||
        "No matching profiled repository and no explicit Repo field.";
      const outcome = buildQualifierOutcome({
        disposition: "not_qualified",
        reasonCode: "repo_resolution_failed",
        reason,
        qualifierMode: "fresh",
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
        templateMatched: assessment.templateMatched,
        repoSelectionType: selection.type,
      });
      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          jiraIssue.key,
          [reason],
          assessment.nonBlockingWarnings,
          retryInstruction,
        ),
        metrics: buildQualifierMetrics(startTime, outcome, llmResult.metrics),
      };
    }

    if (assessment.multiBranchRetrofitPlan) {
      const multiRepoEnabled =
        process.env.ONESHOT_MULTI_REPO_ENABLED === "true";
      if (!multiRepoEnabled) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          "scope_too_broad: multi-branch retrofit execution is not enabled";
        const outcome = buildQualifierOutcome({
          disposition: "not_qualified",
          reasonCode: "llm_rejected",
          reason,
          qualifierMode: "fresh",
          labels: jiraIssue.fields.labels ?? [],
          latestRunState: latestRun?.state ?? null,
          acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
          templateMatched: assessment.templateMatched,
          repoSelectionType: selection.type,
        });
        return {
          success: true,
          output: this.buildQualificationFailureOutput(
            jiraIssue.key,
            [reason],
            assessment.nonBlockingWarnings,
            retryInstruction,
          ),
          metrics: buildQualifierMetrics(startTime, outcome, llmResult.metrics),
        };
      }

      return this.handleMultiBranchRetrofitQualification(
        context,
        assessment,
        availableRepos,
        oneShotService,
        latestRun,
        startTime,
        llmResult.metrics,
        retryInstruction,
      );
    }

    // Multi-repo routing runs after the qualified=true gate and before single-repo dispatch.
    // The LLM owns repo intent; deterministic code only binds the selected refs.
    if (selection.type === "multi_repo") {
      return this.handleMultiRepoQualification(
        context,
        assessment,
        availableRepos,
        oneShotService,
        latestRun,
        startTime,
        llmResult.metrics,
        retryInstruction,
      );
    }

    if (selection.type === "needs_confirmation") {
      const candidateRepos = await Promise.all(
        selection.selectedRepoIds.map((id) =>
          this.db.getRepositoryById(id).catch(() => null),
        ),
      );
      const candidateLines = selection.selectedRepoIds.map((repoId, idx) => {
        const repo = candidateRepos[idx];
        const summary = selection.candidateSummaries[idx] ?? "";
        const repoLabel = repo?.repo_name ?? `repo-${repoId}`;
        return summary
          ? `- \`${repoLabel}\`: ${summary}`
          : `- \`${repoLabel}\``;
      });
      const reason =
        selection.repoReasoning ||
        "QUALIFIER could not confidently pick a single repository.";
      const outcome = buildQualifierOutcome({
        disposition: "needs_confirmation",
        reasonCode: "needs_confirmation",
        reason,
        qualifierMode: "fresh",
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
        acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
        templateMatched: assessment.templateMatched,
        repoSelectionType: selection.type,
        selectedRepoIds: selection.selectedRepoIds,
      });
      const commentBody = [
        "## OneShot | Repository Confirmation Needed",
        "",
        `**Ticket:** \`${jiraIssue.key}\``,
        "",
        "QUALIFIER could not confidently pick a single repository for this ticket.",
        "",
        "### Candidates",
        ...candidateLines,
        "",
        selection.repoReasoning
          ? `**Reasoning:** ${selection.repoReasoning}`
          : "",
        "",
        "### Next Step",
        "- A human will pick the right repository in the OneShot Dashboard, after which QUALIFIER will resume.",
      ]
        .filter(Boolean)
        .join("\n");
      return this.parkForRepoConfirmation({
        jiraIssue,
        taskManagement,
        availableRepos,
        candidateRepoIds: selection.selectedRepoIds,
        reason,
        commentBody,
        outcome,
        metrics: llmResult.metrics,
        startTime,
        evidence: selection.candidateSummaries.map((summary, idx) => ({
          type: "qualifier_candidate_summary",
          repoId: selection.selectedRepoIds[idx],
          summary,
        })),
      });
    }

    // Resolve to a single repo: explicit_github or profiled_repo.
    let resolvedRepo: CodeRepository | null = null;
    let nonBlockingWarnings: string[] = [...assessment.nonBlockingWarnings];

    if (selection.type === "explicit_github") {
      const explicitRepoRef = selection.explicitRepoRef?.trim();
      if (!explicitRepoRef) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          "QUALIFIER returned repoSelection.type=explicit_github without explicitRepoRef.";
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [],
          retryInstruction,
          startTime,
          assessment,
          llmResult.metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }

      const githubResolution = await resolveExplicitRepoHint(
        this.db,
        explicitRepoRef,
        availableRepos,
      );

      if (!githubResolution.repo) {
        return this.handleExplicitRepoResolutionFailure({
          jiraIssue,
          taskManagement,
          availableRepos,
          explicitRepoRef,
          githubResolution,
          assessment,
          metrics: llmResult.metrics,
          startTime,
          retryInstruction,
          latestRun,
        });
      }

      resolvedRepo = githubResolution.repo;
    } else {
      // profiled_repo.
      const repoIds = selection.selectedRepoIds;
      if (repoIds.length !== 1) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          "QUALIFIER returned repoSelection.type=profiled_repo without exactly one repository id.";
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [],
          retryInstruction,
          startTime,
          assessment,
          llmResult.metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }
      const repo = availableRepos.find(
        (candidate) => candidate.id === repoIds[0],
      );
      if (!repo || !isOneShotRepoEnabled(repo)) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason = repo
          ? `Selected repository ${repo.repo_name} is not enabled for OneShot.`
          : `Selected repository id ${repoIds[0]} could not be found.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [],
          retryInstruction,
          startTime,
          assessment,
          llmResult.metrics,
          "repo_unsupported",
          latestRun,
        );
      }
      resolvedRepo = repo;
    }

    let retrofitSourceEvidence: RetrofitSourceEvidence | null = null;

    // Explicit retrofit tickets must be anchored to source commit evidence.
    // Repo profile routing can identify candidates, but it is not proof that
    // the original source patch was found.
    if (assessment.retrofitContext) {
      let sourcePullRequestCandidates: RetrofitSourcePullRequestCandidate[];
      try {
        sourcePullRequestCandidates =
          await this.buildRetrofitSourcePullRequestCandidates({
            sourceJiraKey: assessment.retrofitContext.sourceJiraKey,
            repo: resolvedRepo,
            oneShotService,
            sourcePrUrl: assessment.retrofitContext.sourcePrUrl,
            ticketText: [
              buildRawQualificationText(jiraIssue),
              taskDescription,
            ].join("\n"),
          });
      } catch (error) {
        if (error instanceof RetrofitSourceEvidenceLookupError) {
          logger.warn(
            {
              jira: jiraIssue.key,
              retrofitContext: assessment.retrofitContext,
              error: error.message,
            },
            "[QUALIFIER_RETROFIT_SOURCE_PR_CANDIDATE_FAILED] Retrofit source PR candidate lookup failed",
          );
          return this.buildRetrofitSourceLookupFailureResult({
            jiraIssue,
            reason: error.message,
            causeDescription: error.causeDescription,
            startTime,
            assessment,
            metrics: llmResult.metrics,
            latestRun,
          });
        }
        throw error;
      }
      logger.info(
        {
          jira: jiraIssue.key,
          sourceJiraKey: assessment.retrofitContext.sourceJiraKey,
          repoName: resolvedRepo.repo_name,
          candidateCount: sourcePullRequestCandidates.length,
          candidateMethods: sourcePullRequestCandidates.map(
            (candidate) => candidate.method,
          ),
        },
        "[QUALIFIER_RETROFIT_SOURCE_PR_CANDIDATES] Built source PR candidates",
      );
      let retrofitResolution: Awaited<
        ReturnType<typeof resolveRetrofitRepoMatches>
      > | null = null;
      try {
        retrofitResolution = await resolveRetrofitRepoMatches(
          {
            ...assessment.retrofitContext,
            ...(sourcePullRequestCandidates[0]
              ? { sourcePrUrl: sourcePullRequestCandidates[0].prUrl }
              : {}),
          },
          availableRepos,
          { sourcePullRequestCandidates },
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            jira: jiraIssue.key,
            retrofitContext: assessment.retrofitContext,
            error: errorMessage,
          },
          "[QUALIFIER_RETROFIT_SOURCE_EVIDENCE_FAILED] Retrofit source-evidence resolver threw",
        );
        if (error instanceof RetrofitSourceEvidenceLookupError) {
          return this.buildRetrofitSourceLookupFailureResult({
            jiraIssue,
            reason: error.message,
            causeDescription: error.causeDescription,
            startTime,
            assessment,
            metrics: llmResult.metrics,
            latestRun,
          });
        }
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `retrofit_source_evidence_unavailable: Could not resolve source evidence for ` +
          `${assessment.retrofitContext.sourceJiraKey}: ${errorMessage}`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          llmResult.metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }

      if (retrofitResolution && retrofitResolution.matches.length > 1) {
        return this.handleRetrofitSourceEvidenceRunGroup({
          context,
          assessment,
          sourceMatches: retrofitResolution.matches,
          oneShotService,
          latestRun,
          startTime,
          metrics: llmResult.metrics,
          retryInstruction,
        });
      }

      const evidenceMatch = retrofitResolution?.matches[0];
      if (!evidenceMatch?.sourceEvidence) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `source_commit_not_found: Could not find exact source commit evidence ` +
          `for ${assessment.retrofitContext.sourceJiraKey} on ${assessment.retrofitContext.sourceBranch}.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason, ...(retrofitResolution?.warnings ?? [])],
          retryInstruction,
          startTime,
          assessment,
          llmResult.metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }
      retrofitSourceEvidence = evidenceMatch.sourceEvidence;
      if (evidenceMatch.repo.id !== resolvedRepo.id) {
        nonBlockingWarnings.push(
          `Retrofit commit evidence selected ${evidenceMatch.repo.repo_name}, overriding QUALIFIER's pick of ${resolvedRepo.repo_name}.`,
        );
        resolvedRepo = evidenceMatch.repo;
      }
    }

    // Branch resolution.
    const branchResolution = await resolveBranchForQualification(
      this.db,
      resolvedRepo,
      customerBranch,
      this.buildBranchHintText(jiraIssue, assessment),
    );

    if (!branchResolution.branchName || !branchResolution.baseCommitSha) {
      const reason =
        branchResolution.blockingReasons.join(" ") ||
        "Branch resolution failed.";
      if (branchResolution.failureKind === "branch_lookup_failed") {
        return this.buildBranchLookupFailureResult({
          jiraIssue,
          reason,
          startTime,
          assessment,
          metrics: llmResult.metrics,
          latestRun,
        });
      }
      await this.ensureNotQualifiedLabel(jiraIssue);
      return this.buildQualificationFailureResult(
        jiraIssue,
        reason,
        branchResolution.blockingReasons,
        retryInstruction,
        startTime,
        assessment,
        llmResult.metrics,
        "branch_resolution_failed",
        latestRun,
      );
    }

    assessment.repoId = resolvedRepo.id;
    assessment.branchName = branchResolution.branchName;
    assessment.baseCommitSha = branchResolution.baseCommitSha;
    assessment.nonBlockingWarnings = Array.from(
      new Set([
        ...assessment.nonBlockingWarnings,
        ...nonBlockingWarnings,
        ...this.branchResolutionWarnings(branchResolution),
      ]),
    );

    const repoSelectionMetadata = this.buildRepoSelectionMetadata(
      assessment,
      branchResolution,
      resolvedRepo,
      retrofitSourceEvidence,
      factoryBuilderMetadata,
    );
    const epicKey = extractEpicKey(jiraIssue);

    const ticketEvidenceRef =
      await this.buildTicketEvidenceRefFromTaskManagement(
        taskManagement,
        jiraIssue.key,
      );

    const runCreation = await oneShotService.createQualifiedRun({
      jiraKey: jiraIssue.key,
      epicKey,
      ticketSummary: jiraIssue.fields.summary,
      taskDescription,
      ticketEvidenceRef,
      jiraIssueType: jiraIssue.fields.issuetype?.name ?? null,
      jiraLabels: jiraIssue.fields.labels ?? [],
      sourceTaskManagementId: taskManagement.id,
      customerId: customerBranch.id,
      repo: resolvedRepo,
      branchName: branchResolution.branchName,
      baseCommitSha: branchResolution.baseCommitSha,
      qualification: assessment,
      qualificationProvider: "qualifier_llm",
      qualificationModel:
        this.agentModel ||
        process.env.ANTHROPIC_MODEL ||
        FALLBACK_QUALIFIER_MODEL,
      qualificationMetrics: llmResult.metrics,
      repoSelectionMetadata,
    });

    const outcome = buildQualifierOutcome({
      disposition: "qualified",
      reasonCode: "llm_qualified",
      reason:
        assessment.qualificationReasoning || "Qualified by QUALIFIER LLM.",
      qualifierMode: "fresh",
      labels: jiraIssue.fields.labels ?? [],
      latestRunState: latestRun?.state ?? null,
      acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
      templateMatched: assessment.templateMatched,
      repoSelectionType: selection.type,
      selectedRepoIds: [resolvedRepo.id],
    });

    const output = runCreation.publishError
      ? wrapOneShotQualifierComment(
          buildHandoffExhaustedComment({
            assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
            jiraKey: jiraIssue.key,
            runId: runCreation.runId,
            failureType: runCreation.publishError.includes(
              "Initial run branch workspace setup failed",
            )
              ? "workspace_setup_failed"
              : "planning_publish_failed",
            error: runCreation.publishError,
          }),
        )
      : this.buildQualificationSuccessOutput(
          jiraIssue.key,
          resolvedRepo.repo_name,
          branchResolution.branchName,
          branchResolution.baseCommitSha,
          runCreation.runId,
          assessment.nonBlockingWarnings,
          assessment,
        );

    return {
      success: true,
      output,
      metrics: buildQualifierMetrics(startTime, outcome, llmResult.metrics),
    };
  }

  private buildQualifierTicketText(context: QualifierLlmContext): string {
    const { jiraIssue, taskDescription } = context;
    return [
      stringifyJiraFieldValue(jiraIssue.fields.description),
      extractAcceptanceCriteriaText(jiraIssue),
      taskDescription,
      ...((jiraIssue.fields.labels ?? []).length > 0
        ? [`Labels: ${jiraIssue.fields.labels!.join(", ")}`]
        : []),
      ...flattenJiraFieldValue(jiraIssue.fields.fixVersions).map(
        (entry) => `Fix version: ${entry}`,
      ),
      ...flattenJiraFieldValue(jiraIssue.fields.components).map(
        (entry) => `Component: ${entry}`,
      ),
    ]
      .map((line) => line?.trim())
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
  }

  private async handleExplicitRepoResolutionFailure(input: {
    jiraIssue: QualifierJiraIssue;
    taskManagement: TaskManagement;
    availableRepos: CodeRepository[];
    explicitRepoRef: string;
    githubResolution: ExplicitRepoResolution;
    assessment: QualificationAssessment;
    metrics: QualifierAssessmentMetrics | undefined;
    startTime: number;
    retryInstruction: string;
    latestRun: Pick<OneShotRun, "state"> | null;
  }): Promise<ProcessResult> {
    const {
      jiraIssue,
      taskManagement,
      availableRepos,
      explicitRepoRef,
      githubResolution,
      assessment,
      metrics,
      startTime,
      retryInstruction,
      latestRun,
    } = input;

    const githubMatchCount = githubResolution.githubCandidates.length;
    const registeredMatchCount = githubResolution.registeredCandidates.length;
    const registeredCandidateIds = availableRepos
      .filter((repo) =>
        githubResolution.registeredCandidates.includes(repo.repo_name),
      )
      .map((repo) => repo.id);
    const isMultiMatch = githubMatchCount > 1 || registeredMatchCount > 1;
    const candidateRepoIds =
      registeredCandidateIds.length > 0
        ? registeredCandidateIds
        : availableRepos.filter(isOneShotRepoEnabled).map((repo) => repo.id);

    if (candidateRepoIds.length > 0) {
      const reason = isMultiMatch
        ? `Explicit repo ${explicitRepoRef} matched multiple GitHub repositories.`
        : githubResolution.blockingReasons.join(" ") ||
          `Explicit repo ${explicitRepoRef} could not be resolved to one registered repository.`;
      const outcome = buildQualifierOutcome({
        disposition: "needs_confirmation",
        reasonCode: "needs_confirmation",
        reason,
        qualifierMode: "fresh",
        labels: jiraIssue.fields.labels ?? [],
        latestRunState: latestRun?.state ?? null,
        templateMatched: assessment.templateMatched,
        repoSelectionType: assessment.repoSelection.type,
        selectedRepoIds: candidateRepoIds,
      });
      const candidateNames = candidateRepoIds
        .map(
          (id) =>
            availableRepos.find((candidate) => candidate.id === id)?.repo_name,
        )
        .filter((name): name is string => Boolean(name));
      const bindingDiagnostics = [
        ...githubResolution.blockingReasons,
        ...(githubResolution.githubCandidates.length > 0
          ? [
              `GitHub candidates: ${githubResolution.githubCandidates.join(", ")}`,
            ]
          : []),
      ];
      const commentBody = [
        "## OneShot | Repository Confirmation Needed",
        "",
        `**Ticket:** \`${jiraIssue.key}\``,
        "",
        isMultiMatch
          ? `Explicit repository \`${explicitRepoRef}\` matched multiple GitHub repositories. A human must pick the right one.`
          : `QUALIFIER selected explicit repository \`${explicitRepoRef}\`, but it could not be bound to one registered OneShot repo. A human must pick the right one.`,
        "",
        ...(bindingDiagnostics.length > 0
          ? [
              "### Binding Diagnostics",
              ...bindingDiagnostics.map((entry) => `- ${entry}`),
              "",
            ]
          : []),
        "",
        "### Candidates",
        ...candidateNames.map((name) => `- \`${name}\``),
      ].join("\n");
      return this.parkForRepoConfirmation({
        jiraIssue,
        taskManagement,
        availableRepos,
        candidateRepoIds,
        reason,
        commentBody,
        outcome,
        metrics,
        startTime,
        evidence: [
          {
            type: "explicit_github_multi_match",
            explicitRepoRef,
            githubCandidates: githubResolution.githubCandidates,
            registeredCandidates: githubResolution.registeredCandidates,
            blockingReasons: githubResolution.blockingReasons,
          },
        ],
      });
    }

    await this.ensureNotQualifiedLabel(jiraIssue);
    const reason = isMultiMatch
      ? `Explicit repo ${explicitRepoRef} matched multiple GitHub repositories (${githubResolution.githubCandidates.join(", ")}) but none are registered in code_repositories. Register one or refine the Repo: hint.`
      : githubResolution.blockingReasons.join(" ") ||
        `Explicit repo ${explicitRepoRef} could not be resolved on GitHub.`;
    return this.buildQualificationFailureResult(
      jiraIssue,
      reason,
      isMultiMatch
        ? [reason, ...githubResolution.githubCandidates]
        : githubResolution.blockingReasons,
      retryInstruction,
      startTime,
      assessment,
      metrics,
      "repo_resolution_failed",
      latestRun,
    );
  }

  private buildQualificationFailureResult(
    jiraIssue: QualifierJiraIssue,
    reason: string,
    blockingReasons: string[],
    retryInstruction: string,
    startTime: number,
    assessment: QualificationAssessment,
    metrics: QualifierAssessmentMetrics | undefined,
    reasonCode: QualifierOutcomeReasonCode,
    latestRun: Pick<OneShotRun, "state"> | null,
  ): ProcessResult {
    const outcome = buildQualifierOutcome({
      disposition: "not_qualified",
      reasonCode,
      reason,
      qualifierMode: "fresh",
      labels: jiraIssue.fields.labels ?? [],
      latestRunState: latestRun?.state ?? null,
      acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
      templateMatched: assessment.templateMatched,
      repoSelectionType: assessment.repoSelection.type,
    });
    const reasons = blockingReasons.length > 0 ? blockingReasons : [reason];
    return {
      success: true,
      output: this.buildQualificationFailureOutput(
        jiraIssue.key,
        reasons,
        assessment.nonBlockingWarnings,
        retryInstruction,
      ),
      metrics: buildQualifierMetrics(startTime, outcome, metrics),
    };
  }

  private buildBranchLookupFailureResult(
    input: {
      jiraIssue: QualifierJiraIssue;
      reason: string;
      startTime: number;
      assessment: QualificationAssessment;
      metrics: QualifierAssessmentMetrics | undefined;
      latestRun: Pick<OneShotRun, "state"> | null;
    },
  ): ProcessResult {
    const outcome = buildQualifierOutcome({
      disposition: "not_qualified",
      reasonCode: "branch_lookup_failed",
      reason: input.reason,
      qualifierMode: "fresh",
      labels: input.jiraIssue.fields.labels ?? [],
      latestRunState: input.latestRun?.state ?? null,
      acceptanceCriteriaPresent: input.assessment.acceptanceCriteriaPresent,
      templateMatched: input.assessment.templateMatched,
      repoSelectionType: input.assessment.repoSelection.type,
    });

    return {
      success: false,
      error: input.reason,
      output: wrapOneShotQualifierComment(
        [
          "## OneShot | Qualification Branch Lookup Failed",
          `**Ticket:** \`${input.jiraIssue.key}\``,
          "",
          "QUALIFIER approved this ticket, but GitHub branch lookup failed before OneShot could create the run. The task will be retried by the worker instead of marking the ticket not qualified.",
          "",
          `**Reason:** ${input.reason}`,
        ].join("\n"),
      ),
      metrics: buildQualifierMetrics(
        input.startTime,
        outcome,
        input.metrics,
      ),
    };
  }

  /**
   * Persist a router_decision + router_confirmation row and update the
   * task_management status to waiting_repo_confirmation. The materializer
   * picks these up after a human selects a repo in the dashboard.
   *
   * Caller is responsible for posting the Jira comment via the returned
   * ProcessResult.output. Returns ProcessResult with
   * taskManagementStatus='waiting_repo_confirmation' so AgentWorker does NOT
   * stomp the status to 'completed' on the success path.
   */
  private async parkForRepoConfirmation(input: {
    jiraIssue: QualifierJiraIssue;
    taskManagement: TaskManagement;
    availableRepos: CodeRepository[];
    candidateRepoIds: number[];
    reason: string;
    commentBody: string;
    outcome: QualifierOutcome;
    metrics?: QualifierAssessmentMetrics;
    startTime: number;
    evidence?: unknown[];
  }): Promise<ProcessResult> {
    const {
      jiraIssue,
      taskManagement,
      availableRepos,
      candidateRepoIds,
      reason,
      commentBody,
      outcome,
      metrics,
      startTime,
      evidence,
    } = input;

    const plan = buildQualifierConfirmationPlan({
      ticket: jiraIssue as unknown as {
        key: string;
        fields: { summary?: string; description?: unknown };
      } as any,
      availableRepos,
      selectedRepoIds: candidateRepoIds,
    });

    const candidateById = new Map(
      plan.candidates.map((candidate) => [candidate.repo.id, candidate.repo]),
    );
    const candidates = candidateRepoIds
      .map((id) => {
        const repo =
          candidateById.get(id) ??
          availableRepos.find((candidate) => candidate.id === id);
        return repo
          ? {
              repoId: repo.id,
              repoName: repo.repo_name,
              score: 0,
              evidence: [],
            }
          : null;
      })
      .filter(
        (
          candidate,
        ): candidate is {
          repoId: number;
          repoName: string;
          score: number;
          evidence: never[];
        } => candidate !== null,
      );

    // Atomic write: status update + router_decisions + router_confirmations
    // commit together or roll back together. If anything fails, the task
    // stays in its prior status and AgentWorker hits its failure path
    // (which is hardened to not stomp waiting_repo_confirmation).
    try {
      await this.db.parkQualifierForRepoConfirmation({
        plan,
        candidates,
        evidence: evidence ?? [],
        snapshotHash: plan.snapshotHash,
        taskManagementId: taskManagement.id,
        currentLogicResult: { reason, candidateRepoIds },
        currentLogicDisposition: "needs_confirmation",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          jira: jiraIssue.key,
          taskManagementId: taskManagement.id,
          error: errorMessage,
        },
        "Failed to atomically park QUALIFIER task for repo confirmation; task will be retried",
      );
      return {
        success: false,
        output: wrapOneShotQualifierComment(
          `## OneShot | QUALIFIER Parking Failed\n\n**Ticket:** \`${jiraIssue.key}\`\n\nThe QUALIFIER worker could not park this ticket for human repo confirmation. The task will be retried.\n\n**Reason:** ${errorMessage}`,
        ),
        error: errorMessage,
        metrics: buildQualifierMetrics(startTime, outcome, metrics),
      };
    }

    return {
      success: true,
      output: wrapOneShotQualifierComment(commentBody),
      taskManagementStatus: "waiting_repo_confirmation",
      metrics: buildQualifierMetrics(startTime, outcome, metrics),
    };
  }

  /**
   * Invoke the QUALIFIER LLM with the full ticket text and profiled-repo
   * catalog. Failures surface failureMessage so the dispatcher parks the
   * ticket for human review instead of rejecting it.
   */
  private async runQualifierLlm(
    context: QualifierLlmContext,
    availableRepos: CodeRepository[],
    options: {
      ticketText?: string;
      repoRoutingOverride?: QualifierRepoRoutingOverride;
    } = {},
  ): Promise<QualifierLlmResult> {
    const { jiraIssue, taskDescription, taskManagement, customerBranch } =
      context;

    // Profile-loader path is intentionally separate from the agent call.
    // In production loadRepoProfiles throws on missing YAML — we want a
    // distinct failureKind so operators can tell "fleet config bad" apart
    // from "Bedrock down" or "LLM returned junk".
    let profiledRepoCatalog: string;
    try {
      const summaries = await getProfiledRepoSummariesForLlm(availableRepos);
      profiledRepoCatalog = formatProfiledRepoSummariesForPrompt(summaries);
    } catch (error) {
      const failureMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          jira: jiraIssue.key,
          errorMessage: failureMessage,
        },
        "[QUALIFIER_PROFILE_LOAD_FAILED] Profile catalog unavailable; parking ticket",
      );
      return {
        assessment: emptyQualificationAssessment([], []),
        failureMessage,
        failureKind: "profile",
      };
    }

    const ticketText =
      options.ticketText ?? this.buildQualifierTicketText(context);

    const staleRelatedCodeRepoNames = await this.repoNamesForRelatedCode(
      taskManagement.related_code,
    );

    const customerContext =
      `Customer: ${customerBranch.customer}; customer branch setting: ${customerBranch.branch} ` +
      "(non-authoritative for OneShot branch selection)";

    try {
      const result = await this.getQualifierAgent().assessQualification({
        jiraKey: jiraIssue.key,
        summary: jiraIssue.fields.summary,
        ticketText,
        profiledRepoCatalog,
        staleRelatedCodeRepoNames,
        customerContext,
        repoRoutingOverride: options.repoRoutingOverride,
        taskRoutingPath: context.taskRoutingPath,
      });
      const assessment = result.assessment;

      // Post-validation: even though the schema is satisfied, certain
      // semantic invariants must hold or the dispatcher will produce a
      // useless parking row. Treat violations as schema failures.
      const semanticError = detectQualifierLlmSemanticIssue(assessment);
      if (semanticError) {
        if (
          options.repoRoutingOverride &&
          isFactoryBuilderOverridableSemanticIssue(semanticError)
        ) {
          logger.info(
            {
              jira: jiraIssue.key,
              error: semanticError,
              assessment,
            },
            "[QUALIFIER_FACTORY_BUILDER_SEMANTIC_OVERRIDE] Repo-shape semantic issue deferred to Factory Builder routing normalization",
          );
          return {
            assessment,
            metrics: result.metrics,
          };
        }

        logger.error(
          {
            jira: jiraIssue.key,
            error: semanticError,
            assessment,
          },
          "[QUALIFIER_LLM_SEMANTIC_INVALID] LLM output passed schema but failed semantic check; parking",
        );
        return {
          assessment: emptyQualificationAssessment([], []),
          metrics: result.metrics,
          failureMessage: semanticError,
          failureKind: "schema",
        };
      }

      return {
        assessment,
        metrics: result.metrics,
      };
    } catch (error) {
      const failureMessage =
        error instanceof Error ? error.message : String(error);
      const failureKind = isLikelySchemaError(error) ? "schema" : "infra";
      logger.error(
        {
          jira: jiraIssue.key,
          errorMessage: failureMessage,
          failureKind,
        },
        failureKind === "schema"
          ? "[QUALIFIER_LLM_SCHEMA_INVALID] LLM returned output that failed schema parsing; parking"
          : "[QUALIFIER_LLM_INFRA_FAILED] LLM call failed (likely Bedrock/network); parking",
      );
      return {
        assessment: emptyQualificationAssessment([], []),
        failureMessage,
        failureKind,
      };
    }
  }

  private async repoNamesForRelatedCode(
    relatedCode: string | null | undefined,
  ): Promise<string[]> {
    if (!relatedCode) {
      return [];
    }
    const ids = relatedCode
      .split(",")
      .map((id) => Number.parseInt(id.trim(), 10))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) {
      return [];
    }
    const repos = await Promise.all(
      ids.map((id) => this.db.getRepositoryById(id).catch(() => null)),
    );
    return repos
      .filter((repo): repo is CodeRepository => Boolean(repo))
      .map((repo) => repo.repo_name);
  }

  private buildBranchHintText(
    jiraIssue: QualifierJiraIssue,
    assessment: QualificationAssessment,
  ): string {
    if (assessment.retrofitContext) {
      return [
        `Retrofit: ${assessment.retrofitContext.sourceJiraKey}`,
        `From: ${assessment.retrofitContext.sourceBranch}`,
        `Target: ${assessment.retrofitContext.targetBranch}`,
      ].join("\n");
    }
    return [
      stringifyJiraFieldValue(jiraIssue.fields.description),
      ...flattenJiraFieldValue(jiraIssue.fields.fixVersions).map(
        (entry) => `Fix version: ${entry}`,
      ),
    ]
      .map((line) => line?.trim())
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private buildBranchResolutionMetadata(
    branchResolution: BranchResolutionResult,
  ): Record<string, unknown> {
    return {
      selectedBranch: branchResolution.branchName,
      selectedReason: branchResolution.resolutionSource,
      selectedBranchHint: branchResolution.selectedBranchHint ?? null,
      fallbackBranchHint: branchResolution.fallbackBranchHint ?? null,
      branchCandidates: branchResolution.branchCandidates,
      positiveBranchHints: branchResolution.positiveBranchHints ?? [],
      ignoredNegatedBranchHints:
        branchResolution.ignoredNegatedBranchHints ?? [],
      conflicts: branchResolution.branchConflicts ?? [],
      blockingReasons: branchResolution.blockingReasons,
      nonBlockingWarnings: this.branchResolutionWarnings(branchResolution),
    };
  }

  private branchResolutionWarnings(
    branchResolution: BranchResolutionResult,
  ): string[] {
    return Array.isArray(branchResolution.nonBlockingWarnings)
      ? branchResolution.nonBlockingWarnings
      : [];
  }

  private resolveFactoryBuilderRepo(
    availableRepos: CodeRepository[],
  ): CodeRepository | null {
    return (
      availableRepos.find(
        (candidate) =>
          isOneShotRepoEnabled(candidate) &&
          getOneShotRepoMetadata(candidate)?.githubSlug.toLowerCase() ===
            AI_AGENTS_REPO_SLUG,
      ) ?? null
    );
  }

  private buildFactoryBuilderRepoRoutingOverride(
    repo: CodeRepository,
  ): QualifierRepoRoutingOverride {
    return {
      targetRepoId: repo.id,
      targetRepoName: repo.repo_name,
      targetGithubSlug: AI_AGENTS_REPO_SLUG,
      reason: `${ONESHOT_FACTORY_BUILDER_LABEL} label is present with PFOS.`,
    };
  }

  private buildFactoryBuilderRepoSelection(repo: CodeRepository): RepoSelection {
    return {
      type: "profiled_repo",
      selectedRepoIds: [repo.id],
      candidateSummaries: [],
      repoReasoning:
        "Factory Builder (oneshot-factory-builder) locks repo selection to Ai-agents.",
    };
  }

  private normalizeFactoryBuilderAssessment(
    assessment: QualificationAssessment,
    repo: CodeRepository,
  ): {
    assessment: QualificationAssessment;
    metadata: FactoryBuilderRoutingMetadata;
  } {
    const originalRepoSelection = assessment.repoSelection;
    const factorySelection = this.buildFactoryBuilderRepoSelection(repo);
    const metadata: FactoryBuilderRoutingMetadata = {
      label: ONESHOT_FACTORY_BUILDER_LABEL,
      targetRepoId: repo.id,
      targetRepoName: repo.repo_name,
      targetGithubSlug: AI_AGENTS_REPO_SLUG,
      originalRepoSelection,
    };

    const normalized: QualificationAssessment = {
      ...assessment,
      repoSelection: factorySelection,
      multiRepoPlan: undefined,
      multiBranchRetrofitPlan: undefined,
    };

    if (
      assessment.templateMatched === "retrofit_template" ||
      assessment.retrofitContext ||
      assessment.multiBranchRetrofitPlan
    ) {
      return {
        assessment: {
          ...normalized,
          qualified: false,
          blockingReasons: Array.from(
            new Set([
              ...assessment.blockingReasons,
              "factory_builder_retrofit_not_supported: Factory Builder V1 supports standard PFOS tickets only.",
            ]),
          ),
        },
        metadata,
      };
    }

    const repoOnlyBlockers = assessment.blockingReasons.filter((reason) =>
      this.isFactoryBuilderRepoOnlyBlocker(reason),
    );
    const repoSelectionOnlyRejection =
      !assessment.qualified &&
      assessment.blockingReasons.length === 0 &&
      assessment.acceptanceCriteriaPresent &&
      assessment.requirementsSummary.length > 0 &&
      this.isFactoryBuilderRepoOnlySelection(assessment.repoSelection);
    if (
      (!assessment.qualified &&
        assessment.blockingReasons.length > 0 &&
        repoOnlyBlockers.length === assessment.blockingReasons.length) ||
      repoSelectionOnlyRejection
    ) {
      const demotedReasons =
        repoOnlyBlockers.length > 0
          ? repoOnlyBlockers
          : [
              `repo_selection_only: ${assessment.repoSelection.type} was overridden by Factory Builder routing.`,
            ];
      metadata.demotedBlockingReasons = demotedReasons;
      return {
        assessment: {
          ...normalized,
          qualified: true,
          blockingReasons: [],
          nonBlockingWarnings: Array.from(
            new Set([
              ...assessment.nonBlockingWarnings,
              ...demotedReasons.map(
                (reason) =>
                  `Factory Builder repo routing override demoted repo-only blocker: ${reason}`,
              ),
            ]),
          ),
        },
        metadata,
      };
    }

    return {
      assessment: normalized,
      metadata,
    };
  }

  private isFactoryBuilderRepoOnlySelection(selection: RepoSelection): boolean {
    return (
      selection.type === "no_match" ||
      selection.type === "needs_confirmation" ||
      selection.type === "multi_repo" ||
      selection.type === "explicit_github"
    );
  }

  private isFactoryBuilderRepoOnlyBlocker(reason: string): boolean {
    const normalized = reason.toLowerCase();
    return [
      "repo_no_match",
      "no_match",
      "needs_confirmation",
      "repo_selection",
      "repository_selection",
      "ambiguous_repo",
      "ambiguous_repository",
      "repo_ambiguous",
      "repository_ambiguous",
      "unsupported_repo",
      "repo_unsupported",
      "no profiled repo",
      "no matching profiled repository",
      "repo ambiguity",
      "repository ambiguity",
    ].some((token) => normalized.includes(token));
  }

  private buildRepoSelectionMetadata(
    assessment: QualificationAssessment,
    branchResolution: BranchResolutionResult,
    repo: CodeRepository,
    retrofitSourceEvidence?: RetrofitSourceEvidence | null,
    factoryBuilderMetadata?: FactoryBuilderRoutingMetadata | null,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      decisionSource: factoryBuilderMetadata
        ? "factory_builder_label"
        : "qualifier_llm",
      repoSelection: assessment.repoSelection,
      templateMatched: assessment.templateMatched,
      retrofitContext: assessment.retrofitContext ?? null,
      retrofitSourceEvidence: retrofitSourceEvidence ?? null,
      qualificationReasoning: assessment.qualificationReasoning,
      selectedRepo: {
        id: repo.id,
        name: repo.repo_name,
      },
      branchResolution: this.buildBranchResolutionMetadata(branchResolution),
    };
    if (factoryBuilderMetadata) {
      metadata.factoryBuilder = factoryBuilderMetadata;
    }
    return metadata;
  }

  private async handleRetrofitSourceEvidenceRunGroup(input: {
    context: QualifierLlmContext;
    assessment: QualificationAssessment;
    sourceMatches: RetrofitRepoResolutionMatch[];
    oneShotService: OneShotService;
    latestRun: Pick<
      OneShotRun,
      "state" | "repo_id" | "last_error" | "final_disposition"
    > | null;
    startTime: number;
    metrics: QualifierAssessmentMetrics | undefined;
    retryInstruction: string;
    skippedTargetBranches?: string[];
  }): Promise<ProcessResult> {
    const {
      context,
      assessment,
      sourceMatches,
      oneShotService,
      latestRun,
      startTime,
      metrics,
      retryInstruction,
      skippedTargetBranches = [],
    } = input;
    const { jiraIssue, taskDescription, taskManagement, customerBranch } =
      context;
    const matchesWithEvidence = sourceMatches.filter(
      (match): match is RetrofitRepoResolutionMatch & {
        sourceEvidence: RetrofitSourceEvidence;
      } => Boolean(match.sourceEvidence),
    );

    if (matchesWithEvidence.length < 2) {
      await this.ensureNotQualifiedLabel(jiraIssue);
      const reason =
        "source_commit_not_found: Multi-repo retrofit fan-out requires at least two source-evidence matches.";
      return this.buildQualificationFailureResult(
        jiraIssue,
        reason,
        [reason],
        retryInstruction,
        startTime,
        assessment,
        metrics,
        "repo_resolution_failed",
        latestRun,
      );
    }

    const dedupedMatches = Array.from(
      matchesWithEvidence
        .reduce((byPair, match) => {
          const key = `${match.repo.id}\0${match.sourceEvidence.targetBranch}`;
          if (!byPair.has(key)) {
            byPair.set(key, match);
          }
          return byPair;
        }, new Map<string, RetrofitRepoResolutionMatch & { sourceEvidence: RetrofitSourceEvidence }>())
        .values(),
    );
    const selectedMatches = dedupedMatches.slice(0, 7);
    const skippedPairs = dedupedMatches.slice(7).map((match) => ({
      repoName: match.repo.repo_name,
      targetBranch: match.sourceEvidence.targetBranch,
    }));

    if (selectedMatches.length < 2) {
      await this.ensureNotQualifiedLabel(jiraIssue);
      const reason =
        "source_commit_not_found: Source evidence did not produce enough unique repo/target pairs for grouped execution.";
      return this.buildQualificationFailureResult(
        jiraIssue,
        reason,
        [reason],
        retryInstruction,
        startTime,
        assessment,
        metrics,
        "repo_resolution_failed",
        latestRun,
      );
    }

    const uniqueTargets = Array.from(
      new Set(selectedMatches.map((match) => match.sourceEvidence.targetBranch)),
    );
    const isMultiBranch = uniqueTargets.length > 1;
    const targetOrderByBranch = new Map(
      uniqueTargets.map((targetBranch, index) => [targetBranch, index + 1]),
    );
    const resolvedChildren: Array<{
      match: RetrofitRepoResolutionMatch & {
        sourceEvidence: RetrofitSourceEvidence;
      };
      branchResolution: BranchResolutionResult;
    }> = [];

    for (const match of selectedMatches) {
      const branchResolution = await resolveBranchForQualification(
        this.db,
        match.repo,
        customerBranch,
        [
          `Retrofit: ${match.sourceEvidence.sourceJiraKey}`,
          `From: ${match.sourceEvidence.sourceBranch}`,
          `Target: ${match.sourceEvidence.targetBranch}`,
        ].join("\n"),
      );

      if (!branchResolution.branchName || !branchResolution.baseCommitSha) {
        const reason =
          branchResolution.blockingReasons.join(" ") ||
          `Branch resolution failed for retrofit source evidence repo=${match.repo.repo_name} target=${match.sourceEvidence.targetBranch}.`;
        if (branchResolution.failureKind === "branch_lookup_failed") {
          return this.buildBranchLookupFailureResult({
            jiraIssue,
            reason,
            startTime,
            assessment,
            metrics,
            latestRun,
          });
        }
        await this.ensureNotQualifiedLabel(jiraIssue);
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          branchResolution.blockingReasons,
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "branch_resolution_failed",
          latestRun,
        );
      }

      if (branchResolution.branchName !== match.sourceEvidence.targetBranch) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `retrofit_branch_mismatch: Retrofit target branch ${match.sourceEvidence.targetBranch} ` +
          `resolved to ${branchResolution.branchName} for ${match.repo.repo_name}.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "branch_resolution_failed",
          latestRun,
        );
      }

      resolvedChildren.push({ match, branchResolution });
    }

    const ticketEvidenceRef =
      await this.buildTicketEvidenceRefFromTaskManagement(
        taskManagement,
        jiraIssue.key,
      );
    const sourceJiraKey =
      resolvedChildren[0].match.sourceEvidence.sourceJiraKey;
    const sourceBranch =
      resolvedChildren[0].match.sourceEvidence.sourceBranch;
    const epicKey = extractEpicKey(jiraIssue);
    const runGroupCreation = await oneShotService.createQualifiedRunGroup({
      jiraKey: jiraIssue.key,
      epicKey,
      ticketSummary: jiraIssue.fields.summary,
      taskDescription,
      ticketEvidenceRef,
      jiraIssueType: jiraIssue.fields.issuetype?.name ?? null,
      jiraLabels: jiraIssue.fields.labels ?? [],
      sourceTaskManagementId: taskManagement.id,
      customerId: customerBranch.id,
      groupMode: isMultiBranch ? "multi_branch_retrofit" : "multi_repo",
      groupMetadata: {
        sourceJiraKey,
        sourceBranch,
        modeDetail: "retrofit_source_evidence",
        sourceEvidenceRepos: resolvedChildren.map(({ match }) => ({
          repo_id: match.repo.id,
          repo_name: match.repo.repo_name,
          target_branch: match.sourceEvidence.targetBranch,
          touched_files: match.sourceEvidence.touchedFiles,
          source_commits: match.sourceEvidence.selectedCommits.map(
            (commit) => commit.sha,
          ),
        })),
        targetBranches: uniqueTargets.map((targetBranch) => ({
          targetBranch,
          targetOrder: targetOrderByBranch.get(targetBranch) ?? 1,
        })),
        skippedTargetBranches,
        skippedRepoBranchTargets: skippedPairs,
      },
      runs: resolvedChildren.map(({ match, branchResolution }, index) => {
        const targetBranch = match.sourceEvidence.targetBranch;
        const targetOrder = targetOrderByBranch.get(targetBranch) ?? index + 1;
        const retrofitContext = {
          sourceJiraKey: match.sourceEvidence.sourceJiraKey,
          sourceBranch: match.sourceEvidence.sourceBranch,
          targetBranch,
          ...(match.sourceEvidence.sourcePrUrl
            ? { sourcePrUrl: match.sourceEvidence.sourcePrUrl }
            : {}),
        };
        const multiRepoBrief = {
          repoRef: match.repo.repo_name,
          objective:
            `Retrofit ${match.sourceEvidence.sourceJiraKey} source changes for ` +
            `${match.repo.repo_name} onto ${targetBranch}.`,
          acceptanceCriteria: [
            `Target branch ${targetBranch} contains the source patch for ${match.sourceEvidence.sourceJiraKey} in ${match.repo.repo_name}.`,
          ],
          mergeOrder: index + 1,
        };
        const multiBranchRetrofitBrief = isMultiBranch
          ? {
              sourceJiraKey: match.sourceEvidence.sourceJiraKey,
              repoRef: match.repo.repo_name,
              sourceBranch: match.sourceEvidence.sourceBranch,
              targetBranch,
              targetOrder,
              totalTargets: uniqueTargets.length,
            }
          : undefined;
        return {
          repo: match.repo,
          branchName: targetBranch,
          baseCommitSha: branchResolution.baseCommitSha!,
          qualification: {
            ...assessment,
            repoId: match.repo.id,
            branchName: targetBranch,
            baseCommitSha: branchResolution.baseCommitSha!,
            retrofitContext,
            multiRepoPlan: undefined,
            multiRepoBrief,
            multiBranchRetrofitPlan: undefined,
            ...(multiBranchRetrofitBrief
              ? { multiBranchRetrofitBrief }
              : {}),
            nonBlockingWarnings: Array.from(
              new Set([
                ...assessment.nonBlockingWarnings,
                ...this.branchResolutionWarnings(branchResolution),
              ]),
            ),
          },
          qualificationProvider: "qualifier_llm",
          qualificationModel:
            this.agentModel ||
            process.env.ANTHROPIC_MODEL ||
            FALLBACK_QUALIFIER_MODEL,
          qualificationMetrics: metrics,
          repoSelectionMetadata: {
            multiRepoBrief,
            ...(multiBranchRetrofitBrief
              ? { multiBranchRetrofitBrief }
              : {}),
            retrofitContext,
            retrofitSourceEvidence: match.sourceEvidence,
            branchResolution: this.buildBranchResolutionMetadata(
              branchResolution,
            ),
          },
        };
      }),
    });

    const branchWarnings = Array.from(
      new Set(
        resolvedChildren.flatMap(({ branchResolution }) =>
          this.branchResolutionWarnings(branchResolution),
        ),
      ),
    );
    const selectedTargetsWarning =
      `Selected retrofit source-evidence targets queued: ` +
      resolvedChildren
        .map(
          ({ match }) =>
            `\`${match.repo.repo_name}:${match.sourceEvidence.targetBranch}\``,
        )
        .join(", ");
    const skippedWarning =
      skippedPairs.length > 0 || skippedTargetBranches.length > 0
        ? `Only the first 7 retrofit pipelines were queued. Skipped targets ${[
            ...skippedPairs.map(
              (target) => `${target.repoName}:${target.targetBranch}`,
            ),
            ...skippedTargetBranches,
          ]
            .map((target) => `\`${target}\``)
            .join(", ")} need another ticket.`
        : null;

    const outcome = buildQualifierOutcome({
      disposition: "qualified",
      reasonCode: "llm_qualified",
      reason:
        assessment.qualificationReasoning ||
        "Qualified by deterministic retrofit source evidence.",
      qualifierMode: "fresh",
      labels: jiraIssue.fields.labels ?? [],
      latestRunState: latestRun?.state ?? null,
      acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
      templateMatched: assessment.templateMatched,
      repoSelectionType: assessment.repoSelection.type,
      selectedRepoIds: resolvedChildren.map(({ match }) => match.repo.id),
    });

    return {
      success: true,
      output: wrapOneShotQualifierComment(
        buildQualificationReadyComment({
          assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
          jiraKey: jiraIssue.key,
          repoName: resolvedChildren
            .map(({ match }) => match.repo.repo_name)
            .join(", "),
          branchName: isMultiBranch
            ? `${resolvedChildren.length} retrofit targets`
            : resolvedChildren[0].match.sourceEvidence.targetBranch,
          baseCommitSha: resolvedChildren[0].branchResolution.baseCommitSha!,
          qualification: assessment,
          warnings: [
            selectedTargetsWarning,
            skippedWarning,
            ...branchWarnings,
            ...(runGroupCreation.publishError
              ? [
                  `Planning queue publish failed and operator recovery is required: ${runGroupCreation.publishError}`,
                ]
              : []),
          ].filter((warning): warning is string => Boolean(warning)),
          nextStep: runGroupCreation.publishError
            ? "Planning handoff failed after automatic retries; operator recovery is required."
            : "Planning has been queued for the selected retrofit source-evidence targets.",
        }),
      ),
      metrics: buildQualifierMetrics(startTime, outcome, metrics),
    };
  }

  /**
   * Resolve one repository and create one child run per retrofit target branch.
   * This intentionally uses run groups but does not reuse multiRepoPlan because
   * all children point at the same repository.
   */
  private async handleMultiBranchRetrofitQualification(
    context: QualifierLlmContext,
    assessment: QualificationAssessment,
    availableRepos: CodeRepository[],
    oneShotService: OneShotService,
    latestRun: Pick<
      OneShotRun,
      "state" | "repo_id" | "last_error" | "final_disposition"
    > | null,
    startTime: number,
    metrics: QualifierAssessmentMetrics | undefined,
    retryInstruction: string,
  ): Promise<ProcessResult> {
    const { jiraIssue, taskDescription, taskManagement, customerBranch } =
      context;
    const plan = assessment.multiBranchRetrofitPlan!;
    const selection = assessment.repoSelection;

    let resolvedRepo: CodeRepository | null = null;
    if (selection.type === "explicit_github") {
      const explicitRepoRef = selection.explicitRepoRef?.trim() || plan.repoRef;
      const githubResolution = await resolveExplicitRepoHint(
        this.db,
        explicitRepoRef,
        availableRepos,
      );

      if (!githubResolution.repo) {
        return this.handleExplicitRepoResolutionFailure({
          jiraIssue,
          taskManagement,
          availableRepos,
          explicitRepoRef,
          githubResolution,
          assessment,
          metrics,
          startTime,
          retryInstruction,
          latestRun,
        });
      }
      if (!isOneShotRepoEnabled(githubResolution.repo)) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `Selected repository ${githubResolution.repo.repo_name} is not enabled for OneShot.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "repo_unsupported",
          latestRun,
        );
      }
      resolvedRepo = githubResolution.repo;
    } else {
      const repoId = selection.selectedRepoIds[0];
      const repo = availableRepos.find((candidate) => candidate.id === repoId);
      if (!repo || !isOneShotRepoEnabled(repo)) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason = repo
          ? `Selected repository ${repo.repo_name} is not enabled for OneShot.`
          : `Selected repository id ${repoId} could not be found.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "repo_unsupported",
          latestRun,
        );
      }
      resolvedRepo = repo;
    }

    const resolvedTargets: Array<{
      targetBranch: string;
      targetOrder: number;
      branchResolution: BranchResolutionResult;
      retrofitSourceEvidence: RetrofitSourceEvidence;
    }> = [];
    const sourceEvidenceMatches: RetrofitRepoResolutionMatch[] = [];
    let requiresSourceEvidenceRunGroup = false;
    let sourcePullRequestCandidates: RetrofitSourcePullRequestCandidate[];
    try {
      sourcePullRequestCandidates =
        await this.buildRetrofitSourcePullRequestCandidates({
          sourceJiraKey: plan.sourceJiraKey,
          repo: resolvedRepo,
          oneShotService,
          ticketText: [
            buildRawQualificationText(jiraIssue),
            taskDescription,
          ].join("\n"),
        });
    } catch (error) {
      if (error instanceof RetrofitSourceEvidenceLookupError) {
        logger.warn(
          {
            jira: jiraIssue.key,
            sourceJiraKey: plan.sourceJiraKey,
            repoName: resolvedRepo.repo_name,
            error: error.message,
          },
          "[QUALIFIER_RETROFIT_SOURCE_PR_CANDIDATE_FAILED] Multi-branch retrofit source PR candidate lookup failed",
        );
        return this.buildRetrofitSourceLookupFailureResult({
          jiraIssue,
          reason: error.message,
          causeDescription: error.causeDescription,
          startTime,
          assessment,
          metrics,
          latestRun,
        });
      }
      throw error;
    }
    logger.info(
      {
        jira: jiraIssue.key,
        sourceJiraKey: plan.sourceJiraKey,
        repoName: resolvedRepo.repo_name,
        candidateCount: sourcePullRequestCandidates.length,
        candidateMethods: sourcePullRequestCandidates.map(
          (candidate) => candidate.method,
        ),
      },
      "[QUALIFIER_RETROFIT_SOURCE_PR_CANDIDATES] Built multi-branch source PR candidates",
    );

    const sourcePullRequestSelectionCache = new Map();
    const sourceEvidenceBundleCache = new Map();
    for (const [index, targetBranch] of plan.targetBranches.entries()) {
      let retrofitResolution: Awaited<
        ReturnType<typeof resolveRetrofitRepoMatches>
      > | null = null;
      try {
        retrofitResolution = await resolveRetrofitRepoMatches(
          {
            sourceJiraKey: plan.sourceJiraKey,
            sourceBranch: plan.sourceBranch,
            targetBranch,
            ...(sourcePullRequestCandidates[0]
              ? { sourcePrUrl: sourcePullRequestCandidates[0].prUrl }
              : {}),
          },
          availableRepos,
          {
            sourcePullRequestCandidates,
            sourcePullRequestSelectionCache,
            sourceEvidenceBundleCache,
          },
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            jira: jiraIssue.key,
            sourceJiraKey: plan.sourceJiraKey,
            targetBranch,
            repoName: resolvedRepo.repo_name,
            error: errorMessage,
          },
          "[QUALIFIER_RETROFIT_SOURCE_EVIDENCE_FAILED] Multi-branch retrofit source-evidence resolver threw",
        );
        if (error instanceof RetrofitSourceEvidenceLookupError) {
          return this.buildRetrofitSourceLookupFailureResult({
            jiraIssue,
            reason: error.message,
            causeDescription: error.causeDescription,
            startTime,
            assessment,
            metrics,
            latestRun,
          });
        }
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `retrofit_source_evidence_unavailable: Could not resolve source evidence for ` +
          `${plan.sourceJiraKey} target ${targetBranch}: ${errorMessage}`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }

      if (!retrofitResolution.matches.length) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `source_commit_not_found: Could not find exact source commit evidence ` +
          `for ${plan.sourceJiraKey} on ${plan.sourceBranch} targeting ${targetBranch}.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason, ...retrofitResolution.warnings],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }

      sourceEvidenceMatches.push(...retrofitResolution.matches);

      const sourceEvidenceForResolvedRepo = retrofitResolution.matches.find(
        (match) => match.repo.id === resolvedRepo.id,
      )?.sourceEvidence;
      if (
        retrofitResolution.matches.length !== 1 ||
        !sourceEvidenceForResolvedRepo
      ) {
        requiresSourceEvidenceRunGroup = true;
        continue;
      }

      const branchResolution = await resolveBranchForQualification(
        this.db,
        resolvedRepo,
        customerBranch,
        this.buildRetrofitBranchHintText(plan, targetBranch),
      );

      if (!branchResolution.branchName || !branchResolution.baseCommitSha) {
        const reason =
          branchResolution.blockingReasons.join(" ") ||
          `Branch resolution failed for retrofit target ${targetBranch}.`;
        if (branchResolution.failureKind === "branch_lookup_failed") {
          return this.buildBranchLookupFailureResult({
            jiraIssue,
            reason,
            startTime,
            assessment,
            metrics,
            latestRun,
          });
        }
        await this.ensureNotQualifiedLabel(jiraIssue);
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          branchResolution.blockingReasons,
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "branch_resolution_failed",
          latestRun,
        );
      }

      if (branchResolution.branchName !== targetBranch) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason =
          `retrofit_branch_mismatch: Retrofit target branch ${targetBranch} ` +
          `resolved to ${branchResolution.branchName}.`;
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "branch_resolution_failed",
          latestRun,
        );
      }

      resolvedTargets.push({
        targetBranch,
        targetOrder: index + 1,
        branchResolution,
        retrofitSourceEvidence: sourceEvidenceForResolvedRepo,
      });
    }

    const uniqueSourcePairs = new Set(
      sourceEvidenceMatches.map(
        (match) => `${match.repo.id}\0${match.sourceEvidence?.targetBranch}`,
      ),
    );
    const hasMultipleSourceEvidenceRepos = new Set(
      sourceEvidenceMatches.map((match) => match.repo.id),
    ).size > 1;
    if (
      requiresSourceEvidenceRunGroup ||
      (sourceEvidenceMatches.length > 1 &&
      (hasMultipleSourceEvidenceRepos ||
        uniqueSourcePairs.size > resolvedTargets.length))
    ) {
      return this.handleRetrofitSourceEvidenceRunGroup({
        context,
        assessment,
        sourceMatches: sourceEvidenceMatches,
        oneShotService,
        latestRun,
        startTime,
        metrics,
        retryInstruction,
        skippedTargetBranches: plan.skippedTargetBranches,
      });
    }

    const ticketEvidenceRef =
      await this.buildTicketEvidenceRefFromTaskManagement(
        taskManagement,
        jiraIssue.key,
      );

    const targetBranchMetadata = resolvedTargets.map((target) => ({
      targetBranch: target.targetBranch,
      targetOrder: target.targetOrder,
    }));
    const epicKey = extractEpicKey(jiraIssue);
    const runGroupCreation = await oneShotService.createQualifiedRunGroup({
      jiraKey: jiraIssue.key,
      epicKey,
      ticketSummary: jiraIssue.fields.summary,
      taskDescription,
      ticketEvidenceRef,
      jiraIssueType: jiraIssue.fields.issuetype?.name ?? null,
      jiraLabels: jiraIssue.fields.labels ?? [],
      sourceTaskManagementId: taskManagement.id,
      customerId: customerBranch.id,
      groupMode: "multi_branch_retrofit",
      groupMetadata: {
        sourceJiraKey: plan.sourceJiraKey,
        sourceBranch: plan.sourceBranch,
        repo: {
          repo_id: resolvedRepo.id,
          repo_name: resolvedRepo.repo_name,
        },
        targetBranches: targetBranchMetadata,
        skippedTargetBranches: plan.skippedTargetBranches,
        sourceEvidence: resolvedTargets.map((target) => ({
          targetBranch: target.targetBranch,
          touchedFiles: target.retrofitSourceEvidence.touchedFiles,
          sourceCommits: target.retrofitSourceEvidence.selectedCommits.map(
            (commit) => commit.sha,
          ),
        })),
      },
      runs: resolvedTargets.map((target) => {
        const retrofitContext = {
          sourceJiraKey: plan.sourceJiraKey,
          sourceBranch: plan.sourceBranch,
          targetBranch: target.targetBranch,
        };
        const multiBranchRetrofitBrief = {
          sourceJiraKey: plan.sourceJiraKey,
          repoRef: plan.repoRef,
          sourceBranch: plan.sourceBranch,
          targetBranch: target.targetBranch,
          targetOrder: target.targetOrder,
          totalTargets: resolvedTargets.length,
        };
        const childWarnings = Array.from(
          new Set([
            ...assessment.nonBlockingWarnings,
            ...this.branchResolutionWarnings(target.branchResolution),
          ]),
        );
        return {
          repo: resolvedRepo,
          branchName: target.targetBranch,
          baseCommitSha: target.branchResolution.baseCommitSha!,
          qualification: {
            ...assessment,
            repoId: resolvedRepo.id,
            branchName: target.targetBranch,
            baseCommitSha: target.branchResolution.baseCommitSha!,
            retrofitContext,
            multiBranchRetrofitPlan: undefined,
            multiBranchRetrofitBrief,
            nonBlockingWarnings: childWarnings,
          },
          qualificationProvider: "qualifier_llm",
          qualificationModel:
            this.agentModel ||
            process.env.ANTHROPIC_MODEL ||
            FALLBACK_QUALIFIER_MODEL,
          qualificationMetrics: metrics,
          repoSelectionMetadata: {
            multiBranchRetrofitBrief,
            retrofitContext,
            retrofitSourceEvidence: target.retrofitSourceEvidence,
            branchResolution: this.buildBranchResolutionMetadata(
              target.branchResolution,
            ),
          },
        };
      }),
    });

    const branchWarnings = Array.from(
      new Set(
        resolvedTargets.flatMap((target) =>
          this.branchResolutionWarnings(target.branchResolution),
        ),
      ),
    );
    const selectedTargetWarning =
      `Selected multi-branch retrofit target branches queued: ` +
      plan.targetBranches.map((branch) => `\`${branch}\``).join(", ");
    const skippedTargetWarning =
      plan.skippedTargetBranches.length > 0
        ? `Only the first 7 target branches were queued. Skipped target branches ${plan.skippedTargetBranches
            .map((branch) => `\`${branch}\``)
            .join(", ")} need another ticket.`
        : null;

    const outcome = buildQualifierOutcome({
      disposition: "qualified",
      reasonCode: "llm_qualified",
      reason:
        assessment.qualificationReasoning ||
        "Qualified by QUALIFIER LLM (multi-branch retrofit).",
      qualifierMode: "fresh",
      labels: jiraIssue.fields.labels ?? [],
      latestRunState: latestRun?.state ?? null,
      acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
      templateMatched: assessment.templateMatched,
      repoSelectionType: selection.type,
      selectedRepoIds: [resolvedRepo.id],
    });

    return {
      success: true,
      output: wrapOneShotQualifierComment(
        buildQualificationReadyComment({
          assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
          jiraKey: jiraIssue.key,
          repoName: resolvedRepo.repo_name,
          branchName: `${resolvedTargets.length} retrofit targets`,
          baseCommitSha: resolvedTargets[0].branchResolution.baseCommitSha!,
          qualification: assessment,
          warnings: [
            selectedTargetWarning,
            skippedTargetWarning,
            ...branchWarnings,
            ...(runGroupCreation.publishError
              ? [
                  `Planning queue publish failed and operator recovery is required: ${runGroupCreation.publishError}`,
                ]
              : []),
          ].filter((warning): warning is string => Boolean(warning)),
          nextStep: runGroupCreation.publishError
            ? "Planning handoff failed after automatic retries; operator recovery is required."
            : "Planning has been queued for the selected retrofit target branches.",
        }),
      ),
      metrics: buildQualifierMetrics(startTime, outcome, metrics),
    };
  }

  private buildRetrofitBranchHintText(
    plan: MultiBranchRetrofitPlan,
    targetBranch: string,
  ): string {
    return [
      `Retrofit: ${plan.sourceJiraKey}`,
      `From: ${plan.sourceBranch}`,
      `Target: ${targetBranch}`,
    ].join("\n");
  }

  /**
   * Resolve each repo in the multiRepoPlan and create a run group via
   * createQualifiedRunGroup. If ANY repo or branch resolution fails, no
   * partial group is created and the ticket is rejected.
   */
  private async handleMultiRepoQualification(
    context: QualifierLlmContext,
    assessment: QualificationAssessment,
    availableRepos: CodeRepository[],
    oneShotService: OneShotService,
    latestRun: Pick<
      OneShotRun,
      "state" | "repo_id" | "last_error" | "final_disposition"
    > | null,
    startTime: number,
    metrics: QualifierAssessmentMetrics | undefined,
    retryInstruction: string,
  ): Promise<ProcessResult> {
    const { jiraIssue, taskDescription, taskManagement, customerBranch } =
      context;
    const slices = assessment.multiRepoPlan!;

    // Resolve each repo and branch for all slices before creating anything.
    const resolvedSlices: Array<{
      slice: MultiRepoSlice;
      repo: CodeRepository;
      branchName: string;
      baseCommitSha: string;
      branchResolution: BranchResolutionResult;
    }> = [];

    // Build a branch hint based on the Jira description (same as single-repo path).
    // Multi-repo runs always target each repo's default/customer branch — individual
    // slice objectives are not used as branch hints since branch selection is
    // customer-level, not per-slice.
    const branchHintText = this.buildBranchHintText(jiraIssue, assessment);

    for (const slice of slices) {
      // Resolve repo using exact matching only:
      //   1. Exact repo_name match.
      //   2. Exact owner/repo slug extracted from the registered repo URL.
      // Loose substring matching is intentionally excluded to prevent short or
      // ambiguous repoRefs (e.g. 'cp-batch') from silently resolving to the
      // wrong repo. The 'org/' edge case (empty trailing segment) is also
      // avoided by requiring a non-empty slug.
      const normalizedRepoRef = slice.repoRef.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
      const candidates = availableRepos.filter((r) => {
        if (r.repo_name === normalizedRepoRef) {
          return true;
        }
        // Try normalized owner/repo slug from the registered URL.
        const urlWithoutGit = r.repo_url.replace(/\.git$/i, "").replace(/\/+$/, "");
        const urlSlug = urlWithoutGit.split("/").slice(-2).join("/"); // "owner/repo"
        const repoNameSlug = urlWithoutGit.split("/").pop() ?? "";    // "repo"
        if (repoNameSlug && normalizedRepoRef === repoNameSlug) {
          return true;
        }
        if (urlSlug && normalizedRepoRef === urlSlug) {
          return true;
        }
        return false;
      });

      // Multi-match: park for human confirmation rather than silently picking first.
      if (candidates.length > 1) {
        const enabledCandidates = candidates.filter(isOneShotRepoEnabled);
        const candidateIds = enabledCandidates.map((r) => r.id);
        if (candidateIds.length > 0) {
          const reason = `Multi-repo slice repoRef=${slice.repoRef} matched multiple registered repositories.`;
          const outcome = buildQualifierOutcome({
            disposition: "needs_confirmation",
            reasonCode: "needs_confirmation",
            reason,
            qualifierMode: "fresh",
            labels: jiraIssue.fields.labels ?? [],
            latestRunState: latestRun?.state ?? null,
            templateMatched: assessment.templateMatched,
            repoSelectionType: "multi_repo",
            selectedRepoIds: candidateIds,
          });
          const commentBody = [
            "## OneShot | Repository Confirmation Needed",
            "",
            `**Ticket:** \`${jiraIssue.key}\``,
            "",
            `Multi-repo slice \`${slice.repoRef}\` matched multiple registered repositories. A human must pick the right one.`,
            "",
            "### Candidates",
            ...enabledCandidates.map((r) => `- \`${r.repo_name}\``),
          ].join("\n");
          return this.parkForRepoConfirmation({
            jiraIssue,
            taskManagement,
            availableRepos,
            candidateRepoIds: candidateIds,
            reason,
            commentBody,
            outcome,
            metrics,
            startTime,
            evidence: [
              {
                type: "multi_repo_slice_multi_match",
                repoRef: slice.repoRef,
                candidates: enabledCandidates.map((r) => r.repo_name),
              },
            ],
          });
        }
        // >1 raw matches but 0 enabled — fall through to the not-found/disabled path below.
      }

      const repo = candidates[0] ?? null;

      if (!repo || !isOneShotRepoEnabled(repo)) {
        const reason = repo
          ? `Multi-repo slice for ${slice.repoRef} references a repository not enabled for OneShot.`
          : `Multi-repo slice repoRef=${slice.repoRef} could not be resolved to a registered repository.`;
        logger.error(
          { jira: jiraIssue.key, repoRef: slice.repoRef },
          "[QUALIFIER_MULTI_REPO_RESOLUTION_FAILED] Repo resolution failed for slice",
        );
        const candidateRepoIds = availableRepos
          .filter(isOneShotRepoEnabled)
          .map((candidate) => candidate.id);
        if (candidateRepoIds.length > 0) {
          const outcome = buildQualifierOutcome({
            disposition: "needs_confirmation",
            reasonCode: "needs_confirmation",
            reason,
            qualifierMode: "fresh",
            labels: jiraIssue.fields.labels ?? [],
            latestRunState: latestRun?.state ?? null,
            templateMatched: assessment.templateMatched,
            repoSelectionType: "multi_repo",
            selectedRepoIds: candidateRepoIds,
          });
          const commentBody = [
            "## OneShot | Repository Confirmation Needed",
            "",
            `**Ticket:** \`${jiraIssue.key}\``,
            "",
            `Multi-repo slice \`${slice.repoRef}\` could not be bound to one registered OneShot repo. A human must pick the right repository.`,
            "",
            `**Reason:** ${reason}`,
            "",
            "### Candidates",
            ...candidateRepoIds
              .map(
                (id) =>
                  availableRepos.find((candidate) => candidate.id === id)
                    ?.repo_name,
              )
              .filter((name): name is string => Boolean(name))
              .map((name) => `- \`${name}\``),
          ].join("\n");
          return this.parkForRepoConfirmation({
            jiraIssue,
            taskManagement,
            availableRepos,
            candidateRepoIds,
            reason,
            commentBody,
            outcome,
            metrics,
            startTime,
            evidence: [
              {
                type: "multi_repo_slice_unresolved",
                repoRef: slice.repoRef,
                reason,
              },
            ],
          });
        }

        await this.ensureNotQualifiedLabel(jiraIssue);
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }

      const branchResolution = await resolveBranchForQualification(
        this.db,
        repo,
        customerBranch,
        branchHintText,
      );

      if (!branchResolution.branchName || !branchResolution.baseCommitSha) {
        const reason =
          branchResolution.blockingReasons.join(" ") ||
          `Branch resolution failed for multi-repo slice repoRef=${slice.repoRef}.`;
        logger.error(
          { jira: jiraIssue.key, repoRef: slice.repoRef },
          "[QUALIFIER_MULTI_REPO_BRANCH_FAILED] Branch resolution failed for slice",
        );
        if (branchResolution.failureKind === "branch_lookup_failed") {
          return this.buildBranchLookupFailureResult({
            jiraIssue,
            reason,
            startTime,
            assessment,
            metrics,
            latestRun,
          });
        }
        await this.ensureNotQualifiedLabel(jiraIssue);
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          branchResolution.blockingReasons,
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "branch_resolution_failed",
          latestRun,
        );
      }

      resolvedSlices.push({
        slice,
        repo,
        branchName: branchResolution.branchName,
        baseCommitSha: branchResolution.baseCommitSha,
        branchResolution,
      });
    }

    // Guard: two distinct repoRefs must not resolve to the same registered repo id.
    // The semantic duplicate-repoRef check earlier only catches identical strings;
    // this catches cases where two different repoRef spellings resolve to the same repo.
    const resolvedRepoIds = new Set<number>();
    for (const resolved of resolvedSlices) {
      if (resolvedRepoIds.has(resolved.repo.id)) {
        await this.ensureNotQualifiedLabel(jiraIssue);
        const reason = `Multi-repo slices resolved to the same repository (id=${resolved.repo.id}, name=${resolved.repo.repo_name}). Each slice must target a distinct repository.`;
        logger.error(
          { jira: jiraIssue.key, repoId: resolved.repo.id, repoRef: resolved.slice.repoRef },
          "[QUALIFIER_MULTI_REPO_DUPLICATE_REPO] Two slices resolved to the same repo; rejecting",
        );
        return this.buildQualificationFailureResult(
          jiraIssue,
          reason,
          [reason],
          retryInstruction,
          startTime,
          assessment,
          metrics,
          "repo_resolution_failed",
          latestRun,
        );
      }
      resolvedRepoIds.add(resolved.repo.id);
    }

    // All slices resolved. Build mergeOrder metadata and child runs.
    const mergeOrder: Record<string, number> = {};
    for (const resolved of resolvedSlices) {
      mergeOrder[resolved.slice.repoRef] = resolved.slice.mergeOrder;
    }

    const ticketEvidenceRef =
      await this.buildTicketEvidenceRefFromTaskManagement(
        taskManagement,
        jiraIssue.key,
      );
    const epicKey = extractEpicKey(jiraIssue);

    const runGroupCreation = await oneShotService.createQualifiedRunGroup({
      jiraKey: jiraIssue.key,
      epicKey,
      ticketSummary: jiraIssue.fields.summary,
      taskDescription,
      ticketEvidenceRef,
      jiraIssueType: jiraIssue.fields.issuetype?.name ?? null,
      jiraLabels: jiraIssue.fields.labels ?? [],
      sourceTaskManagementId: taskManagement.id,
      customerId: customerBranch.id,
      groupMetadata: { mergeOrder },
      runs: resolvedSlices.map((resolved) => ({
        repo: resolved.repo,
        branchName: resolved.branchName,
        baseCommitSha: resolved.baseCommitSha,
        qualification: {
          ...assessment,
          nonBlockingWarnings: Array.from(
            new Set([
              ...assessment.nonBlockingWarnings,
              ...this.branchResolutionWarnings(resolved.branchResolution),
            ]),
          ),
        },
        qualificationProvider: "qualifier_llm",
        qualificationModel:
          this.agentModel ||
          process.env.ANTHROPIC_MODEL ||
          FALLBACK_QUALIFIER_MODEL,
        qualificationMetrics: metrics,
        repoSelectionMetadata: {
          multiRepoBrief: {
            repoRef: resolved.slice.repoRef,
            objective: resolved.slice.objective,
            acceptanceCriteria: resolved.slice.acceptanceCriteria,
            mergeOrder: resolved.slice.mergeOrder,
          },
          branchResolution: this.buildBranchResolutionMetadata(
            resolved.branchResolution,
          ),
        },
      })),
    });

    const outcome = buildQualifierOutcome({
      disposition: "qualified",
      reasonCode: "llm_qualified",
      reason:
        assessment.qualificationReasoning ||
        "Qualified by QUALIFIER LLM (multi-repo).",
      qualifierMode: "fresh",
      labels: jiraIssue.fields.labels ?? [],
      latestRunState: latestRun?.state ?? null,
      acceptanceCriteriaPresent: assessment.acceptanceCriteriaPresent,
      templateMatched: assessment.templateMatched,
      repoSelectionType: "multi_repo",
      selectedRepoIds: resolvedSlices.map((r) => r.repo.id),
    });

    const branchWarnings = Array.from(
      new Set(
        resolvedSlices.flatMap(
          (resolved) => this.branchResolutionWarnings(resolved.branchResolution),
        ),
      ),
    );

    return {
      success: true,
      output: wrapOneShotQualifierComment(
        buildQualificationReadyComment({
          assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
          jiraKey: jiraIssue.key,
          repoName: resolvedSlices.map((r) => r.repo.repo_name).join(", "),
          branchName: resolvedSlices[0].branchName,
          baseCommitSha: resolvedSlices[0].baseCommitSha,
          qualification: assessment,
          warnings: [
            ...branchWarnings,
            ...(runGroupCreation.publishError
              ? [
                  `Planning queue publish failed and operator recovery is required: ${runGroupCreation.publishError}`,
                ]
              : []),
          ],
          nextStep: runGroupCreation.publishError
            ? "Planning handoff failed after automatic retries; operator recovery is required."
            : undefined,
        }),
      ),
      metrics: buildQualifierMetrics(startTime, outcome, metrics),
    };
  }

  private getQualifierAgent(): QualifierAgent {
    if (!this.qualifierAgent) {
      this.qualifierAgent = new QualifierAgent({
        region: process.env.AWS_REGION || "us-east-2",
        modelId:
          this.agentModel ||
          process.env.ANTHROPIC_MODEL ||
          FALLBACK_QUALIFIER_MODEL,
        timeoutMs: 10 * 60 * 1000,
      });
    }

    return this.qualifierAgent;
  }

  private async handleForceApprove(
    activeRun: NonNullable<
      Awaited<ReturnType<OneShotService["getActiveRunByJiraKey"]>>
    >,
    oneShotService: OneShotService,
    startTime: number,
  ): Promise<ProcessResult> {
    const repo = await this.db.getRepositoryById(activeRun.repo_id);
    if (!repo) {
      throw new Error(
        `Repository ${activeRun.repo_id} not found for force-approve`,
      );
    }

    const customerBranch = await this.db.getCustomerBranchById(
      activeRun.customer_id,
    );
    if (!customerBranch) {
      throw new Error(
        `Customer branch ${activeRun.customer_id} not found for force-approve`,
      );
    }

    const currentBranchResolution = await resolveBranchForQualification(
      this.db,
      repo,
      customerBranch,
      `branch ${activeRun.branch_name}`,
    );

    if (!currentBranchResolution.baseCommitSha) {
      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          activeRun.jira_key,
          currentBranchResolution.blockingReasons,
          [],
        ),
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    }

    const result = await oneShotService.forceApproveRun(
      activeRun,
      currentBranchResolution.baseCommitSha,
    );

    const isForceApproveSuccess =
      result.state === "queued_for_implementation" ||
      result.state === "queued_for_testing";
    const nextStageLabel =
      result.state === "queued_for_testing" ? "testing" : "implementation";

    const output = isForceApproveSuccess
      ? wrapOneShotQualifierComment(
          buildForceApproveComment({
            assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
            jiraKey: activeRun.jira_key,
            repoId: activeRun.repo_id,
            branchName: activeRun.branch_name,
            baseCommitSha: activeRun.base_commit_sha,
            nextStageLabel,
            publishError: result.publishError ?? undefined,
          }),
        )
      : wrapOneShotQualifierComment(
          buildBranchDriftComment({
            assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
            jiraKey: activeRun.jira_key,
            previousBaseCommitSha: activeRun.base_commit_sha,
            currentHeadSha: currentBranchResolution.baseCommitSha,
          }),
        );

    return {
      success: true,
      output,
      metrics: {
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async handleReplan(
    activeRun: NonNullable<
      Awaited<ReturnType<OneShotService["getActiveRunByJiraKey"]>>
    >,
    oneShotService: OneShotService,
    startTime: number,
  ): Promise<ProcessResult> {
    const repo = await this.db.getRepositoryById(activeRun.repo_id);
    if (!repo) {
      throw new Error(`Repository ${activeRun.repo_id} not found for replan`);
    }

    const customerBranch = await this.db.getCustomerBranchById(
      activeRun.customer_id,
    );
    if (!customerBranch) {
      throw new Error(
        `Customer branch ${activeRun.customer_id} not found for replan`,
      );
    }

    const currentBranchResolution =
      activeRun.state === "queued_for_planning" ||
      activeRun.state === "planning"
        ? {
            branchName: activeRun.branch_name,
            baseCommitSha: activeRun.base_commit_sha,
            blockingReasons: [],
            nonBlockingWarnings: [],
            candidateBranches: [activeRun.branch_name],
            ignoredNegatedBranchHints: [],
            branchConflicts: [],
            retrofitContext: undefined,
          }
        : await resolveBranchForQualification(
            this.db,
            repo,
            customerBranch,
            `branch ${activeRun.branch_name}`,
          );

    if (!currentBranchResolution.baseCommitSha) {
      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          activeRun.jira_key,
          currentBranchResolution.blockingReasons,
          [],
        ),
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    }

    const result = await oneShotService.queueReplanRun(
      activeRun,
      currentBranchResolution.baseCommitSha,
    );

    if (result.skipped) {
      await this.consumeReplanLabelBestEffort(
        {
          key: activeRun.jira_key,
          fields: {
            summary: activeRun.jira_key,
            labels: [PFOS_LABEL, PFOS_REPLAN_LABEL],
          },
        },
        oneShotService,
        activeRun,
        result.noActionReason ?? "replan_noop",
      );
      return {
        success: true,
        output: this.buildQualificationFailureOutput(
          activeRun.jira_key,
          [
            `No OneShot replan was queued because ${result.noActionReason ?? "the replan command was already consumed"}.`,
          ],
          [],
          `${PFOS_REPLAN_LABEL} was consumed without creating a new run.`,
        ),
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    }

    if (!result.publishError) {
      await this.consumeReplanLabelBestEffort(
        {
          key: activeRun.jira_key,
          fields: {
            summary: activeRun.jira_key,
            labels: [PFOS_LABEL, PFOS_REPLAN_LABEL],
          },
        },
        oneShotService,
        activeRun,
        "pfos_replan_queued",
      );
    }

    return {
      success: true,
      output: wrapOneShotQualifierComment(
        buildReplanQueuedComment({
          assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
          jiraKey: activeRun.jira_key,
          repoId: activeRun.repo_id,
          branchName: activeRun.branch_name,
          baseCommitSha: currentBranchResolution.baseCommitSha,
          nextPlanVersion: result.nextPlanVersion,
          publishError: result.publishError ?? undefined,
        }),
      ),
      metrics: {
        durationMs: Date.now() - startTime,
      },
    };
  }

  private async getJiraIssue(issueKey: string): Promise<QualifierJiraIssue> {
    const auth = Buffer.from(
      `${this.agentJiraUsername}:${this.agentJiraToken}`,
    ).toString("base64");

    const jiraBaseUrl = process.env.JIRA_BASE_URL;
    if (!jiraBaseUrl) {
      throw new Error("JIRA_BASE_URL is required for QUALIFIER");
    }

    const params = new URLSearchParams({
      expand: CLIENT_ELIGIBILITY_JIRA_EXPAND,
      fields: "*all",
    });
    const response = await fetch(
      `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params.toString()}`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Jira issue ${issueKey}: ${response.status} ${response.statusText}`,
      );
    }

    return response.json() as Promise<QualifierJiraIssue>;
  }

  private async ensureNotQualifiedLabel(
    jiraIssue: Pick<QualifierJiraIssue, "key" | "fields">,
  ): Promise<void> {
    const notQualifiedLabel = getNotQualifiedLabelForLabels(
      jiraIssue.fields.labels,
    );
    const normalizedLabels = new Set(
      (jiraIssue.fields.labels ?? []).map((label) =>
        label.trim().toUpperCase(),
      ),
    );
    if (normalizedLabels.has(notQualifiedLabel)) {
      return;
    }

    const staleOutcomeLabels =
      notQualifiedLabel === PFOS_NOT_QUALIFIED_LABEL
        ? [PFOS_DONE_LABEL, PFOS_FAILED_LABEL, PFOS_BLOCKED_LABEL]
        : [];

    try {
      await this.addJiraLabel(jiraIssue.key, notQualifiedLabel, staleOutcomeLabels);
      jiraIssue.fields.labels = [
        ...(jiraIssue.fields.labels ?? []),
        notQualifiedLabel,
      ];
      logger.info(
        {
          jiraKey: jiraIssue.key,
          label: notQualifiedLabel,
        },
        "Added not-qualified label after qualification failure",
      );
    } catch (error) {
      logger.warn(
        {
          jiraKey: jiraIssue.key,
          label: notQualifiedLabel,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Failed to add not-qualified label after qualification failure",
      );
    }
  }

  private hasPfosReplanCommand(labels: string[] | undefined): boolean {
    const normalizedLabels = normalizeJiraLabels(labels);
    return (
      normalizedLabels.has(PFOS_LABEL) &&
      normalizedLabels.has(PFOS_REPLAN_LABEL)
    );
  }

  private async consumeReplanLabelBestEffort(
    jiraIssue: Pick<QualifierJiraIssue, "key" | "fields">,
    oneShotService: OneShotService,
    run: OneShotRun | null,
    reason: string,
  ): Promise<void> {
    if (!this.hasPfosReplanCommand(jiraIssue.fields.labels)) {
      return;
    }

    try {
      await this.removeJiraLabel(jiraIssue.key, PFOS_REPLAN_LABEL);
      jiraIssue.fields.labels = (jiraIssue.fields.labels ?? []).filter(
        (label) => label.trim().toUpperCase() !== PFOS_REPLAN_LABEL,
      );
      logger.info(
        {
          jiraKey: jiraIssue.key,
          label: PFOS_REPLAN_LABEL,
          reason,
        },
        "Consumed OneShot replan label",
      );
    } catch (error) {
      logger.warn(
        {
          jiraKey: jiraIssue.key,
          label: PFOS_REPLAN_LABEL,
          reason,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        "Failed to consume OneShot replan label",
      );
      if (run) {
        try {
          await oneShotService.recordReplanLabelCleanupFailed({
            run,
            reason,
            error,
          });
        } catch (eventError) {
          logger.warn(
            {
              jiraKey: jiraIssue.key,
              runId: run.id,
              reason,
              errorMessage:
                eventError instanceof Error
                  ? eventError.message
                  : String(eventError),
            },
            "Failed to record OneShot replan label cleanup failure",
          );
        }
      }
    }
  }

  private async addJiraLabel(
    issueKey: string,
    label: string,
    removeLabels: string[] = [],
  ): Promise<void> {
    await this.updateJiraLabels(issueKey, [
      { add: label },
      ...removeLabels.map((removeLabel) => ({ remove: removeLabel })),
    ]);
  }

  private async removeJiraLabel(
    issueKey: string,
    label: string,
  ): Promise<void> {
    await this.updateJiraLabels(issueKey, [{ remove: label }]);
  }

  private async updateJiraLabels(
    issueKey: string,
    operations: Array<Record<string, string>>,
  ): Promise<void> {
    const auth = Buffer.from(
      `${this.agentJiraUsername}:${this.agentJiraToken}`,
    ).toString("base64");

    const jiraBaseUrl = process.env.JIRA_BASE_URL;
    if (!jiraBaseUrl) {
      throw new Error("JIRA_BASE_URL is required for QUALIFIER");
    }

    const response = await fetch(
      `${jiraBaseUrl}/rest/api/3/issue/${issueKey}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          update: {
            labels: operations,
          },
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      throw new Error(
        `Failed to update Jira labels on ${issueKey}: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  }

  private buildQualificationFailureOutput(
    jiraKey: string,
    blockingReasons: string[],
    nonBlockingWarnings: string[],
    nextStep?: string,
  ): string {
    return wrapOneShotQualifierComment(
      buildQualificationNotReadyComment({
        assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
        jiraKey,
        qualification: emptyQualificationAssessment(
          blockingReasons,
          nonBlockingWarnings,
        ),
        warnings: nonBlockingWarnings,
        nextStep,
      }),
    );
  }

  private buildQualificationSuccessOutput(
    jiraKey: string,
    repoName: string,
    branchName: string,
    baseCommitSha: string,
    runId: number | undefined,
    warnings: string[],
    qualification?: QualificationAssessment,
    nextStep?: string,
  ): string {
    return wrapOneShotQualifierComment(
      buildQualificationReadyComment({
        assetBaseUrl: this.getOneShotCommentAssetBaseUrl(),
        jiraKey,
        repoName,
        branchName,
        baseCommitSha,
        qualification,
        warnings,
        pipelineUrl: runId
          ? this.buildOneShotRunDashboardUrl(runId)
          : undefined,
        nextStep,
      }),
    );
  }

  private getOneShotCommentAssetBaseUrl(): string | undefined {
    const value = process.env.ONESHOT_COMMENT_ASSET_BASE_URL?.trim();
    return value ? value.replace(/\/+$/, "") : undefined;
  }

  private getOneShotDashboardBaseUrl(): string | undefined {
    const value = process.env.ONESHOT_DASHBOARD_BASE_URL?.trim();
    return value ? value.replace(/\/+$/, "") : undefined;
  }

  private buildOneShotRunDashboardUrl(runId: number): string | undefined {
    const baseUrl = this.getOneShotDashboardBaseUrl();
    if (!baseUrl) {
      return undefined;
    }

    return `${baseUrl}/oneshot?view=runs&run=run-${runId}`;
  }
}
