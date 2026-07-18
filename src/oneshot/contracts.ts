import type { TaskManagement } from "../orchestrator/database.js";
import type { OneShotRun } from "./types.js";
import { z } from "zod";

export const ONESHOT_VERSION = "1.21.66";

export const PFOS_LABEL = "PFOS";
export const PFOS_NOT_QUALIFIED_LABEL = "PFOS-NOT-QUALIFIED";
export const PFOS_FORCE_APPROVE_LABEL = "PFOS-FORCE-APPROVE";
export const PFOS_REPLAN_LABEL = "PFOS-REPLAN";
export const PFOS_DONE_LABEL = "PFOS-DONE";
export const PFOS_FAILED_LABEL = "PFOS-FAILED";
export const PFOS_BLOCKED_LABEL = "PFOS-BLOCKED";
export const ONESHOT_FACTORY_BUILDER_LABEL = "ONESHOT-FACTORY-BUILDER";
export const PFOS_OUTCOME_LABELS = [
  PFOS_DONE_LABEL,
  PFOS_FAILED_LABEL,
  PFOS_BLOCKED_LABEL,
  PFOS_NOT_QUALIFIED_LABEL,
] as const;
export const SONAR_LABEL = "SONAR";
export const SONAR_AUTOFIX_LABEL = "SONAR-AUTOFIX";
export const SONAR_NOT_QUALIFIED_LABEL = "SONAR-NOT-QUALIFIED";
// Wiz Code (SAST) findings ride their own WIZ-CODE-SCAN-* labels so the Wiz
// dependency-CVE poller (which watches WIZ-SCAN-*) never picks them up.
// Prefix is WIZ-CODE (= "wiz-code".toUpperCase()) so jira-writer's
// source.toUpperCase() derivation and the poller agree on the label.
export const WIZCODE_LABEL = "WIZ-CODE";
export const WIZCODE_NOT_QUALIFIED_LABEL = "WIZ-CODE-NOT-QUALIFIED";
export const DOCS_GENERATE_LABEL = "DOCS-GENERATE";
export const DOCS_IN_PROGRESS_LABEL = "DOCS-IN-PROGRESS";
export const DOCS_GENERATED_LABEL = "DOCS-GENERATED";
export const DOCS_NOT_QUALIFIED_LABEL = "DOCS-NOT-QUALIFIED";
export const DOCS_BLOCKED_LABEL = "DOCS-BLOCKED";
export const DOCS_FAILED_LABEL = "DOCS-FAILED";
export const DOCS_REPLAN_LABEL = "DOCS-REPLAN";

export const DOCUMENTATION_DOCUMENT_TYPE_LABELS = [
  "DOC-TYPE-RELEASE-NOTES",
  "DOC-TYPE-FUNCTIONALITY",
  "DOC-TYPE-INTEGRATION",
  "DOC-TYPE-CONFIG",
  "DOC-TYPE-API",
  "DOC-TYPE-DEPLOYMENT-RUNBOOK",
  "DOC-TYPE-TERRAFORM",
  "DOC-TYPE-TROUBLESHOOTING",
  "DOC-TYPE-SUPPORT-RUNBOOK",
] as const;

export type DocumentationDocumentTypeLabel =
  (typeof DOCUMENTATION_DOCUMENT_TYPE_LABELS)[number];

export type DocumentationLabelValidationReason =
  | "qualified"
  | "docs_generate_missing"
  | "terminal_label_present"
  | "document_type_missing"
  | "multiple_document_types"
  | "ambiguous_legacy_document_type";

export interface DocumentationLabelValidationResult {
  qualified: boolean;
  reasonCode: DocumentationLabelValidationReason;
  reason: string;
  labels: string[];
  documentTypeLabel?: DocumentationDocumentTypeLabel;
  terminalLabel?: string;
}

const DOCUMENTATION_DOCUMENT_TYPE_LABEL_SET = new Set<string>(
  DOCUMENTATION_DOCUMENT_TYPE_LABELS,
);

const DOCUMENTATION_TERMINAL_LABELS = [
  DOCS_GENERATED_LABEL,
  DOCS_NOT_QUALIFIED_LABEL,
  DOCS_BLOCKED_LABEL,
  DOCS_FAILED_LABEL,
] as const;

const DOCUMENTATION_DOCUMENT_TYPE_ALIASES: Record<
  string,
  DocumentationDocumentTypeLabel | "ambiguous"
> = {
  "DOC-TYPE-CLIENT-KB": "DOC-TYPE-FUNCTIONALITY",
  "DOC-TYPE-DEPLOYMENT": "DOC-TYPE-DEPLOYMENT-RUNBOOK",
  "DOC-TYPE-SUPPORT-INTERNAL": "ambiguous",
};

export const ONE_SHOT_PLANNING_QUEUE_ENV = "ONESHOT_PLANNING_QUEUE_URL";
export const ONE_SHOT_REVIEW_QUEUE_ENV = "ONESHOT_REVIEW_QUEUE_URL";
export const ONE_SHOT_IMPLEMENTATION_QUEUE_ENV =
  "ONESHOT_IMPLEMENTATION_QUEUE_URL";
export const ONE_SHOT_CODE_REVIEW_QUEUE_ENV = "ONESHOT_CODE_REVIEW_QUEUE_URL";
export const ONE_SHOT_TESTING_QUEUE_ENV = "ONESHOT_TESTING_QUEUE_URL";
export const ONE_SHOT_ARTIFACT_BUCKET_ENV = "ONESHOT_ARTIFACT_BUCKET";
export const ONE_SHOT_ARTIFACT_PREFIX_ENV = "ONESHOT_ARTIFACT_PREFIX";
export const ONE_SHOT_MAX_REVIEW_LOOPS_ENV = "ONESHOT_MAX_REVIEW_LOOPS";
export const ONE_SHOT_MAX_VERIFICATION_LOOPS_ENV =
  "ONESHOT_MAX_VERIFICATION_LOOPS";
export const ONE_SHOT_MAX_TOTAL_TOKENS_ENV = "ONESHOT_MAX_TOTAL_TOKENS";
export const ONE_SHOT_MAX_STAGE_TOKENS_PLANNING_ENV =
  "ONESHOT_MAX_STAGE_TOKENS_PLANNING";
export const ONE_SHOT_MAX_STAGE_TOKENS_REVIEW_ENV =
  "ONESHOT_MAX_STAGE_TOKENS_REVIEW";
export const ONE_SHOT_MAX_STAGE_TOKENS_IMPLEMENTATION_ENV =
  "ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION";
export const ONE_SHOT_MAX_STAGE_TOKENS_CODE_REVIEW_ENV =
  "ONESHOT_MAX_STAGE_TOKENS_CODE_REVIEW";
export const ONE_SHOT_MAX_STAGE_TOKENS_TESTING_ENV =
  "ONESHOT_MAX_STAGE_TOKENS_TESTING";
export const ONE_SHOT_RECONCILE_STALE_MINUTES_ENV =
  "ONESHOT_RECONCILE_STALE_MINUTES";
// Per-stage stale timeout overrides. Default (20 min) applies when unset.
// Set ONESHOT_STALE_MINUTES_IMPLEMENTATION higher (e.g. 90) for monorepo
// mvn clean install runs that exceed the default 20-minute window.
export const ONE_SHOT_STALE_MINUTES_IMPLEMENTATION_ENV =
  "ONESHOT_STALE_MINUTES_IMPLEMENTATION";
export const ONE_SHOT_STALE_MINUTES_PLANNING_ENV =
  "ONESHOT_STALE_MINUTES_PLANNING";
export const ONE_SHOT_STALE_MINUTES_TESTING_ENV =
  "ONESHOT_STALE_MINUTES_TESTING";
export const ONE_SHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS_ENV =
  "ONESHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS";
export const ONE_SHOT_REVIEWER_ENABLED_ENV = "ONESHOT_REVIEWER_ENABLED";
export const ONE_SHOT_CODE_REVIEWER_ENABLED_ENV =
  "ONESHOT_CODE_REVIEWER_ENABLED";
export const ONE_SHOT_TRACE_ENABLED_ENV = "ONESHOT_TRACE_ENABLED";
export const ONE_SHOT_TRACE_POST_TO_JIRA_ENV = "ONESHOT_TRACE_POST_TO_JIRA";
export const ONE_SHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA_ENV =
  "ONESHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA";
export const ONE_SHOT_VERIFY_ENABLED_ENV = "ONESHOT_VERIFY_ENABLED";
export const ONE_SHOT_VERIFY_MODE_ENV = "ONESHOT_VERIFY_MODE";
export const ONE_SHOT_REVIEWER_BYPASS_REASON_ENV =
  "ONESHOT_REVIEWER_BYPASS_REASON";
export const ONE_SHOT_CODE_REVIEWER_BYPASS_REASON_ENV =
  "ONESHOT_CODE_REVIEWER_BYPASS_REASON";
export const ONE_SHOT_MAX_STAGE_ATTEMPTS_ENV = "ONESHOT_MAX_STAGE_ATTEMPTS";
export const ONE_SHOT_REVIEW_STAGES_BLOCK_ON_EXHAUSTION_ENV =
  "ONESHOT_REVIEW_STAGES_BLOCK_ON_EXHAUSTION";
export const ONE_SHOT_PLANNER_MODEL_ID_ENV = "ONESHOT_PLANNER_MODEL_ID";
export const ONE_SHOT_PLANNER_MAX_OUTPUT_TOKENS_ENV =
  "ONESHOT_PLANNER_MAX_OUTPUT_TOKENS";
export const ONE_SHOT_PLANNER_MAX_THINKING_TOKENS_ENV =
  "ONESHOT_PLANNER_MAX_THINKING_TOKENS";
export const ONE_SHOT_PLANNER_MAX_REPO_TOOL_CALLS_ENV =
  "ONESHOT_PLANNER_MAX_REPO_TOOL_CALLS";
export const ONE_SHOT_PLANNER_MAX_TURNS_ENV = "ONESHOT_PLANNER_MAX_TURNS";
export const ONE_SHOT_PLANNER_CLAUDE_PERMISSION_MODE_ENV =
  "ONESHOT_PLANNER_CLAUDE_PERMISSION_MODE";
export const ONE_SHOT_PLANNER_CLAUDE_TOOL_VISIBILITY_ENV =
  "ONESHOT_PLANNER_CLAUDE_TOOL_VISIBILITY";
export const ONE_SHOT_PLANNER_CLAUDE_TOOL_GUARD_ENV =
  "ONESHOT_PLANNER_CLAUDE_TOOL_GUARD";
export const ONE_SHOT_PLANNER_TOOL_SPRAWL_GUARD_ENV =
  "ONESHOT_PLANNER_TOOL_SPRAWL_GUARD";
export const ONE_SHOT_PLANNER_SKILLS_ENABLED_ENV =
  "ONESHOT_PLANNER_SKILLS_ENABLED";
export const ONE_SHOT_PLANNER_SUBAGENTS_ENABLED_ENV =
  "ONESHOT_PLANNER_SUBAGENTS_ENABLED";
export const ONE_SHOT_PLANNER_SUBAGENT_MAX_TURNS_ENV =
  "ONESHOT_PLANNER_SUBAGENT_MAX_TURNS";
export const ONE_SHOT_PLANNER_PLUGIN_PATH_ENV = "ONESHOT_PLANNER_PLUGIN_PATH";
export const ONE_SHOT_PLANNER_SCOUT_ENABLED_ENV =
  "ONESHOT_PLANNER_SCOUT_ENABLED";
export const ONE_SHOT_PLANNER_SCOUT_MODEL_ID_ENV =
  "ONESHOT_PLANNER_SCOUT_MODEL_ID";
export const ONE_SHOT_SDK_TRACE_MODE_ENV = "ONESHOT_SDK_TRACE_MODE";
export const ONE_SHOT_SDK_STALL_THINKING_PREVIEW_ENV =
  "ONESHOT_SDK_STALL_THINKING_PREVIEW";
export const ONE_SHOT_IMPLEMENTER_MAX_OUTPUT_TOKENS_ENV =
  "ONESHOT_IMPLEMENTER_MAX_OUTPUT_TOKENS";
export const ONE_SHOT_IMPLEMENTER_MODEL_ID_ENV = "ONESHOT_IMPLEMENTER_MODEL_ID";
export const ONE_SHOT_REVIEWER_PROVIDER_ENV = "ONESHOT_REVIEWER_PROVIDER";
export const ONE_SHOT_REVIEWER_MODEL_ID_ENV = "ONESHOT_REVIEWER_MODEL_ID";
export const ONE_SHOT_CODE_REVIEWER_PROVIDER_ENV =
  "ONESHOT_CODE_REVIEWER_PROVIDER";
export const ONE_SHOT_CODE_REVIEWER_MODEL_ID_ENV =
  "ONESHOT_CODE_REVIEWER_MODEL_ID";
export const ONE_SHOT_CODE_REVIEWER_MAX_OUTPUT_TOKENS_ENV =
  "ONESHOT_CODE_REVIEWER_MAX_OUTPUT_TOKENS";
export const ONE_SHOT_IMPLEMENTER_MAX_TURNS_ENV =
  "ONESHOT_IMPLEMENTER_MAX_TURNS";
export const ONE_SHOT_MAVEN_BUILDS_ENABLED_ENV = "ONESHOT_MAVEN_BUILDS_ENABLED";

export type OneShotQueueStage =
  | "planning"
  | "review"
  | "implementation"
  | "code_review"
  | "testing";
export type QualifierMode = "fresh" | "force_approve" | "replan";

type QualifierRunSnapshot = Pick<OneShotRun, "state"> &
  Partial<Pick<OneShotRun, "current_pr_url">>;

function hasPfosReplanCommand(labels: Set<string>): boolean {
  return labels.has(PFOS_LABEL) && labels.has(PFOS_REPLAN_LABEL);
}

export function isPfosReplanEligibleRun(
  latestRun: QualifierRunSnapshot | null,
): boolean {
  if (!latestRun) {
    return false;
  }
  if (latestRun.state === "pr_open" || latestRun.state === "completed") {
    return false;
  }
  if (latestRun.current_pr_url?.trim()) {
    return false;
  }
  return true;
}

export interface OneShotQueueMessage {
  run_id: number;
  stage: OneShotQueueStage;
  version: number;
  expected_state: OneShotRun["state"];
  revision: boolean;
  emitted_at: string;
  expected_implementation_commit_sha?: string;
  expected_implementation_version?: number;
  trace_context?: {
    trace_id?: string;
    span_id?: string;
  };
}

export const OneShotQueueMessageSchema = z.object({
  run_id: z.number().int().positive(),
  stage: z.enum([
    "planning",
    "review",
    "implementation",
    "code_review",
    "testing",
  ]),
  version: z.number().int().positive(),
  expected_state: z.string().min(1),
  revision: z.boolean(),
  emitted_at: z.string().min(1),
  expected_implementation_commit_sha: z.string().min(1).optional(),
  expected_implementation_version: z.number().int().positive().optional(),
  trace_context: z
    .object({
      trace_id: z.string().optional(),
      span_id: z.string().optional(),
    })
    .optional(),
});

export function parseOneShotQueueMessage(value: unknown): OneShotQueueMessage {
  return OneShotQueueMessageSchema.parse(value) as OneShotQueueMessage;
}

export function normalizeJiraLabels(labels?: string[]): Set<string> {
  return new Set((labels ?? []).map((label) => label.trim().toUpperCase()));
}

export function normalizeDocumentationDocumentTypeLabel(
  label: string,
): DocumentationDocumentTypeLabel | "ambiguous" | null {
  const normalized = label.trim().toUpperCase();
  if (DOCUMENTATION_DOCUMENT_TYPE_LABEL_SET.has(normalized)) {
    return normalized as DocumentationDocumentTypeLabel;
  }
  return DOCUMENTATION_DOCUMENT_TYPE_ALIASES[normalized] ?? null;
}

export function getDocumentationDocumentTypeLabels(
  labels?: string[],
): DocumentationDocumentTypeLabel[] {
  return collectDocumentationDocumentTypeLabels(normalizeJiraLabels(labels));
}

function collectDocumentationDocumentTypeLabels(
  normalizedLabels: Iterable<string>,
): DocumentationDocumentTypeLabel[] {
  const documentTypes = new Set<DocumentationDocumentTypeLabel>();

  for (const label of normalizedLabels) {
    const canonical = normalizeDocumentationDocumentTypeLabel(label);
    if (canonical && canonical !== "ambiguous") {
      documentTypes.add(canonical);
    }
  }

  return [...documentTypes];
}

export function isDocumentationIntakeTicket(labels?: string[]): boolean {
  return normalizeJiraLabels(labels).has(DOCS_GENERATE_LABEL);
}

export function validateDocumentationIntakeLabels(
  labels?: string[],
): DocumentationLabelValidationResult {
  const normalizedLabels = [...normalizeJiraLabels(labels)];

  if (!normalizedLabels.includes(DOCS_GENERATE_LABEL)) {
    return {
      qualified: false,
      reasonCode: "docs_generate_missing",
      reason: `No documentation action was taken because ${DOCS_GENERATE_LABEL} is missing.`,
      labels: normalizedLabels,
    };
  }

  const terminalLabel = DOCUMENTATION_TERMINAL_LABELS.find((label) =>
    normalizedLabels.includes(label),
  );
  if (terminalLabel) {
    return {
      qualified: false,
      reasonCode: "terminal_label_present",
      reason: `No documentation action was taken because terminal label ${terminalLabel} is already present.`,
      labels: normalizedLabels,
      terminalLabel,
    };
  }

  const ambiguousLabel = normalizedLabels.find(
    (label) => normalizeDocumentationDocumentTypeLabel(label) === "ambiguous",
  );
  if (ambiguousLabel) {
    return {
      qualified: false,
      reasonCode: "ambiguous_legacy_document_type",
      reason:
        `${ambiguousLabel} is ambiguous. Choose ` +
        "`DOC-TYPE-INTEGRATION`, `DOC-TYPE-TROUBLESHOOTING`, or `DOC-TYPE-SUPPORT-RUNBOOK`.",
      labels: normalizedLabels,
    };
  }

  const documentTypes =
    collectDocumentationDocumentTypeLabels(normalizedLabels);
  if (documentTypes.length === 0) {
    return {
      qualified: false,
      reasonCode: "document_type_missing",
      reason: "Documentation run requires exactly one DOC-TYPE-* label.",
      labels: normalizedLabels,
    };
  }

  if (documentTypes.length > 1) {
    return {
      qualified: false,
      reasonCode: "multiple_document_types",
      reason: `Documentation run requires exactly one DOC-TYPE-* label; found ${documentTypes.join(", ")}.`,
      labels: normalizedLabels,
    };
  }

  return {
    qualified: true,
    reasonCode: "qualified",
    reason: "Documentation labels are qualified for artifact generation.",
    labels: normalizedLabels,
    documentTypeLabel: documentTypes[0],
  };
}

export function isPfosTicket(labels?: string[]): boolean {
  return normalizeJiraLabels(labels).has(PFOS_LABEL);
}

export function isFactoryBuilderTicket(labels?: string[]): boolean {
  const normalized = normalizeJiraLabels(labels);
  return (
    normalized.has(PFOS_LABEL) &&
    normalized.has(ONESHOT_FACTORY_BUILDER_LABEL) &&
    !normalized.has(SONAR_AUTOFIX_LABEL)
  );
}

export function isOneShotIntakeTicket(labels?: string[]): boolean {
  const normalizedLabels = normalizeJiraLabels(labels);
  return (
    normalizedLabels.has(PFOS_LABEL) ||
    normalizedLabels.has(SONAR_AUTOFIX_LABEL)
  );
}

export function getQualifierMode(
  labels: string[] | undefined,
  latestRun: QualifierRunSnapshot | null,
): QualifierMode | null {
  const normalizedLabels = normalizeJiraLabels(labels);
  if (!isOneShotIntakeTicket(labels)) {
    return null;
  }
  const replanRequested = hasPfosReplanCommand(normalizedLabels);

  if (!latestRun) {
    if (replanRequested) {
      return null;
    }
    if (
      normalizedLabels.has(PFOS_NOT_QUALIFIED_LABEL) ||
      normalizedLabels.has(SONAR_NOT_QUALIFIED_LABEL)
    ) {
      return null;
    }
    return "fresh";
  }

  if (
    latestRun.state === "escalated" &&
    normalizedLabels.has(PFOS_FORCE_APPROVE_LABEL)
  ) {
    return "force_approve";
  }

  if (replanRequested && isPfosReplanEligibleRun(latestRun)) {
    return "replan";
  }

  return null;
}

export function shouldSkipAgentForPfos(
  agentName: string,
  labels?: string[],
): boolean {
  const oneShotIntakeTicket = isOneShotIntakeTicket(labels);
  const qualifierAgent = agentName.trim().toUpperCase() === "QUALIFIER";

  if (oneShotIntakeTicket) {
    return !qualifierAgent;
  }

  return qualifierAgent;
}

export function canReuseTaskManagementRow(
  taskManagement: Pick<TaskManagement, "status">,
): boolean {
  return (
    taskManagement.status === "posted_to_jira" ||
    taskManagement.status === "failed"
  );
}
