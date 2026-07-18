import type {
  OneShotDashboardRow,
  OneShotMissingSignalImpact,
  OneShotRowFailureAttribution,
  OneShotStatisticsJiraExample,
  OneShotTicketReadinessTier,
  OneShotWilsonInterval,
  QualifierOutcomeReasonCode,
} from "../types/oneshot.js";

/**
 * Failure attribution taxonomy — kept in sync with `src/oneshot/errors.ts`
 * (`OneShotErrorCategory`). Duplicated here because dashboard tsconfig
 * rootDir is `server/`. If a category is added upstream, the
 * `unknown`/`other` arm below keeps this resilient until the table is
 * extended.
 */
export type FailureErrorCategory =
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

export type FaultAttribution = "oneshot" | "ticket" | "mixed" | "unknown";

export const FAILURE_ATTRIBUTION_VERSION = 3 as const;

interface CategoryRule {
  category: FailureErrorCategory;
  patterns: RegExp[];
}

const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "workspace",
    patterns: [
      /workspace_checkout_timeout/i,
      /Timed out acquiring OneShot workspace lease/i,
      /planning[_.\s]publish[_.\s](?:failed|exhausted)/i,
      /workspace_setup_failed/i,
      /planning_publish_failed/i,
    ],
  },
  {
    category: "git_operation",
    patterns: [
      /worktree/i,
      /git\s+(?:clone|fetch|push|reset)/i,
      /not available locally/i,
      /index\.lock/i,
    ],
  },
  {
    category: "agent_logic",
    patterns: [
      /SDK_IDLE_TIMEOUT/i,
      /SDK timeout after \d+ms/i,
      /Planner target files are not backed by deterministic grounding/i,
      /ticket[_\s-]*explicit[_\s-]*new[_\s-]*source/i,
    ],
  },
  {
    category: "llm_provider",
    patterns: [
      /throttl/i,
      /rate limit/i,
      /\b(?:429|503)\b/,
      /timeout|ETIMEDOUT|ECONNRESET/i,
      /bedrock/i,
      /overloaded/i,
    ],
  },
  {
    category: "llm_output",
    patterns: [
      /structured output failed validation/i,
      /Unexpected token/i,
      /\bJSON\b/i,
      /\bparse\b/i,
      /empty output/i,
      /Corrupted artifact JSON/i,
    ],
  },
  {
    category: "plan_validation",
    patterns: [
      /schema_invalid_after_success/i,
      /retrofit_contract_missing_after_normalization/i,
      /schemaValidationErrors/i,
      /schema_validation_paths/i,
      /plannerDiscoveries\.retrofit(?:Evidence|ExecutionContract)\./i,
    ],
  },
  {
    category: "s3_storage",
    patterns: [
      /PutObject|GetObject/i,
      /\bS3\b/,
      /NoSuchKey/i,
      /Empty artifact body/i,
    ],
  },
  {
    category: "db_operation",
    patterns: [
      /ECONNREFUSED/i,
      /ER_LOCK_DEADLOCK/i,
      /Connection lost|PROTOCOL_CONNECTION_LOST/i,
    ],
  },
  {
    category: "workspace",
    patterns: [/ENOSPC|EACCES|EPERM/i, /disk full/i],
  },
  {
    category: "github_api",
    patterns: [
      /GitHub pull request/i,
      /GitHub branch lookup failed/i,
      /branch_lookup_failed/i,
      /retrofit_source_lookup_failed/i,
      /\bsource_(?:pr|commit|branch)_lookup_failed\b/i,
      /\btarget_branch_lookup_failed\b/i,
      /\b422\b/,
      /status 403/i,
    ],
  },
  {
    category: "ticket_quality",
    patterns: [
      /Gate score/i,
      /not found for oneshot/i,
      /not eligible/i,
      /Missing qualification/i,
      /acceptance[_\s:-]*criteria[_\s:-]*(?:missing|absent|required)/i,
      /(?:missing|absent|required|no)\s+acceptance\s+criteria/i,
      /\bAC\s*[:=-]?\s*(?:missing|absent|required)\b/i,
      /ambiguous[_\s-]*(?:goal|scope|requirements?)/i,
      /(?:goal|scope)[_\s-]*too[_\s-]*broad/i,
      /shared[_\s-]*component[_\s-]*scope[_\s-]*unresolved/i,
      /repo[_\s-]*scope[_\s-]*unresolved/i,
      /repository mismatch/i,
      /target repository is unresolved/i,
      /unresolved[_\s-]*(?:open[_\s-]*)?questions?/i,
      /open question/i,
      /requires product owner confirmation/i,
      /unresolved whether/i,
      /resolution status is contradictory/i,
      /not determinable/i,
      /impossible to determine/i,
      /root cause (?:is )?(?:undetermined|unknown|unresolved|not identified)/i,
      /does not identify .*code[-\s]*level change/i,
      /code[-\s]*level change.*not (?:identified|specified|known)/i,
      /already (?:present|merged|applied)/i,
      /no pending implementation work/i,
      /no new development work/i,
      /validation[-\s]*only/i,
      /manual QA/i,
      /referenced? tickets?.*(?:absent|unavailable|not available)/i,
      /referenced?.*(?:analysis|findings|artifacts?|images?|tickets?).*(?:absent|unavailable|not available)/i,
      /\bsource_(?:pr|commit)_not_found\b/i,
      /\btarget_branch_not_found\b/i,
      /authoritative root cause analysis unavailable/i,
      /cannot be inspected/i,
      /not specified/i,
      /undefined/i,
      /no .* infrastructure/i,
      /without the target queue/i,
      /no .*data model/i,
      /data model .* (?:does not exist|missing|absent)/i,
      /zero .* infrastructure/i,
      /contradict(?:ion|ory|ed)/i,
      /scope ambiguity/i,
      /bundl(?:es|ed|ing).*issues?/i,
      /bounded scoping .* impossible/i,
      /speculative/i,
      /code state that no longer exists/i,
      /does not exist in the codebase/i,
      /absent from .*codebase/i,
      /unreadable artifact/i,
      /missing both .*description.*acceptance criteria/i,
      /missing .*substantive description/i,
      /required vs\.? optional .* unresolved/i,
      /not enough information/i,
      /insufficient detail/i,
      /no_code_changes?_required/i,
      /no .* source code changes required/i,
      /\bconfig[\s_-]*only\b/i,
      /scope_is_configuration_only/i,
      /scope_not_development/i,
      /not suitable for code[_\s-]*generation/i,
      /not implementable code ticket/i,
      /ticket_already_(?:done|closed)/i,
    ],
  },
  {
    category: "budget",
    patterns: [
      /budget(?:_exceeded)?/i,
      /token_budget_exceeded/i,
      /verification_budget_exhausted/i,
      /maximum age of 24 hours/i,
      /exhausted the maximum of/i,
      /stage attempt\(s\)/i,
    ],
  },
  {
    category: "agent_logic",
    patterns: [
      /Candidate SHA integrity check failed/i,
      /completed without producing any file changes/i,
      /implementer disagrees with code review/i,
      /code reviewer blocked the implementation/i,
      /plan[_\s-]*contract[_\s-]*violation/i,
      /Plan-contract auto-replan exhausted/i,
      /retrofit[_\s-]*patch[_\s-]*(?:incomplete|proof[_\s-]*missing)/i,
      /retrofit_patch_incomplete_auto_replan/i,
      /retrofit_patch_proof_missing/i,
      /retrofit_revision_proof_regressed/i,
      /retrofit_contract_(?:missing|missing_source_commit|invalid_status|missing_mapping|missing_file_contract|weak_adaptation_evidence|scope_violation)/i,
      /retrofit[_\s-]*(?:missing[_\s-]*)?adaptation[_\s-]*mapping/i,
      /retrofit[_\s-]*missing[_\s-]*source[_\s-]*proof/i,
      /retrofit[_\s-]*patch[_\s-]*conflict/i,
      /partial[_\s-]*source[_\s-]*commit[_\s-]*selection/i,
      /sourceCommitSelectionComplete\s*[:=]\s*false/i,
    ],
  },
  {
    category: "test_runner_skipped",
    patterns: [
      /Declared runnable test/i,
      /test command\(s\) were skipped/i,
      /\bwere skipped\b/i,
    ],
  },
  {
    category: "ci_failure",
    patterns: [
      /GitHub CI is (?:pending|failing)/i,
      /across commit and pull request checks/i,
      /\d+ check run\(s\)/i,
    ],
  },
];

export function classifyErrorCategory(message: string): FailureErrorCategory {
  if (!message) return "unknown";
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      return rule.category;
    }
  }
  return "unknown";
}

/** Reason codes that indicate gating, not a real run failure — excluded from the denominator. */
const GATING_REASON_CODES: ReadonlySet<QualifierOutcomeReasonCode> = new Set([
  "pfos_label_missing_at_processing",
  "pfos_not_qualified_label_present",
  "existing_run_not_actionable",
  "missing_qualifying_run",
  "repo_unsupported",
  "repo_resolution_failed",
  "branch_resolution_failed",
  // Parked-for-confirmation outcomes are gating, not failures: a human
  // selects a repo and the task resumes. Counting them as failures would
  // misclassify QUALIFIER infra outages and ambiguity as platform faults.
  "needs_confirmation",
  "llm_error_parked",
  "llm_schema_invalid",
]);

const TICKET_FAULT_CATEGORIES: ReadonlySet<FailureErrorCategory> = new Set([
  "ticket_quality",
]);

const ONESHOT_FAULT_CATEGORIES: ReadonlySet<FailureErrorCategory> = new Set([
  "git_operation",
  "llm_provider",
  "llm_output",
  "s3_storage",
  "db_operation",
  "workspace",
  "github_api",
  "plan_validation",
  "agent_logic",
  "budget",
  "test_runner_skipped",
  "ci_failure",
]);

const WEAK_TIERS: ReadonlySet<OneShotTicketReadinessTier> = new Set([
  "weak",
  "missing_description",
]);

export interface FailureClassification {
  attribution: FaultAttribution;
  errorCategory: FailureErrorCategory;
  qualifierReasonCode: QualifierOutcomeReasonCode | null;
  readinessTier: OneShotTicketReadinessTier;
  rationale: string;
  excludedFromDenominator: boolean;
}

export interface FailureClassificationInput {
  row: OneShotDashboardRow;
  readinessTier: OneShotTicketReadinessTier;
}

export function buildFailureClassificationMessage(
  row: OneShotDashboardRow,
): string {
  return [
    row.lastErrorSummary,
    row.lastError,
    row.qualificationSummary,
    row.qualifierOutcome?.reason,
    row.qualifierOutcome?.reasonCode,
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n");
}

function isFailedRow(row: OneShotDashboardRow): boolean {
  return (
    row.displayState === "failed" ||
    row.displayState === "qualification_failed"
  );
}

function labelForAttribution(
  row: OneShotDashboardRow,
  attribution: FaultAttribution,
): OneShotRowFailureAttribution["label"] {
  switch (attribution) {
    case "ticket":
      return "Ticket Not Ready";
    case "oneshot":
      if (
        row.displayState === "qualification_failed" ||
        row.progressStage === "qualification"
      ) {
        return "Qualifier Error";
      }
      switch (row.progressStage) {
        case "planning":
          return "Planning Error";
        case "review":
          return "Review Error";
        case "implementation":
          return "Implementation Error";
        case "code_review":
          return "Code Review Error";
        case "testing":
          return "Testing Error";
        case "pr_complete":
          return "Run Failed";
      }
      return "Run Failed";
    case "mixed":
      return "Mixed Issue";
    case "unknown":
      return "Needs Triage";
  }
}

function failureErrorCategory(
  errorCategory: FailureErrorCategory,
  qualifierReasonCode: QualifierOutcomeReasonCode | null,
): FailureErrorCategory {
  if (errorCategory !== "unknown") return errorCategory;
  if (qualifierReasonCode === "gate_hard_fail") return "ticket_quality";
  if (qualifierReasonCode === "llm_schema_invalid") return "llm_output";
  if (qualifierReasonCode === "llm_error_parked") return "llm_provider";
  if (qualifierReasonCode === "branch_lookup_failed") return "github_api";
  return errorCategory;
}

export function classifyFailure(
  input: FailureClassificationInput,
): FailureClassification {
  const { row, readinessTier } = input;
  const message = buildFailureClassificationMessage(row);
  const qualifierReasonCode = row.qualifierOutcome?.reasonCode ?? null;
  const errorCategory = failureErrorCategory(
    classifyErrorCategory(message),
    qualifierReasonCode,
  );

  if (qualifierReasonCode === "branch_lookup_failed") {
    return {
      attribution: "oneshot",
      errorCategory,
      qualifierReasonCode,
      readinessTier,
      rationale:
        "Qualifier GitHub branch lookup failed; platform-side infrastructure issue.",
      excludedFromDenominator: true,
    };
  }

  if (qualifierReasonCode && GATING_REASON_CODES.has(qualifierReasonCode)) {
    return {
      attribution: "unknown",
      errorCategory,
      qualifierReasonCode,
      readinessTier,
      rationale: `Gating outcome (${qualifierReasonCode}) — excluded from failure denominator.`,
      excludedFromDenominator: true,
    };
  }

  if (qualifierReasonCode === "gate_hard_fail") {
    return {
      attribution: "ticket",
      errorCategory,
      qualifierReasonCode,
      readinessTier,
      rationale:
        "Qualifier rejected the ticket at the hard-fail gate; ticket-side issue.",
      excludedFromDenominator: false,
    };
  }

  if (TICKET_FAULT_CATEGORIES.has(errorCategory)) {
    return {
      attribution: "ticket",
      errorCategory,
      qualifierReasonCode,
      readinessTier,
      rationale:
        "Error category indicates ticket-quality issue (e.g. unmet qualification criteria).",
      excludedFromDenominator: false,
    };
  }

  if (
    qualifierReasonCode === "llm_rejected" &&
    !WEAK_TIERS.has(readinessTier)
  ) {
    return {
      attribution: "oneshot",
      errorCategory,
      qualifierReasonCode,
      readinessTier,
      rationale:
        "Qualifier LLM rejected a well-formed ticket; OneShot-side issue.",
      excludedFromDenominator: false,
    };
  }

  if (ONESHOT_FAULT_CATEGORIES.has(errorCategory)) {
    if (WEAK_TIERS.has(readinessTier)) {
      return {
        attribution: "mixed",
        errorCategory,
        qualifierReasonCode,
        readinessTier,
        rationale: `Infra/agent failure (${errorCategory}) on a weak ticket — both sides plausible.`,
        excludedFromDenominator: false,
      };
    }
    return {
      attribution: "oneshot",
      errorCategory,
      qualifierReasonCode,
      readinessTier,
      rationale: `Infra/agent failure (${errorCategory}) on a well-formed ticket — OneShot-side issue.`,
      excludedFromDenominator: false,
    };
  }

  return {
    attribution: "unknown",
    errorCategory,
    qualifierReasonCode,
    readinessTier,
    rationale: "Unrecognized failure pattern; needs human triage.",
    excludedFromDenominator: false,
  };
}

export function classifyFailureForRow(
  row: OneShotDashboardRow,
): OneShotRowFailureAttribution | null {
  if (!isFailedRow(row)) return null;

  const message = buildFailureClassificationMessage(row);
  const qualifierReasonCode = row.qualifierOutcome?.reasonCode ?? null;
  const errorCategory = failureErrorCategory(
    classifyErrorCategory(message),
    qualifierReasonCode,
  );

  let attribution: FaultAttribution = "unknown";
  let rationale = "Unrecognized failure pattern; needs human triage.";
  let excludedFromDenominator = false;

  if (
    qualifierReasonCode === "llm_error_parked" ||
    qualifierReasonCode === "llm_schema_invalid" ||
    qualifierReasonCode === "branch_lookup_failed"
  ) {
    attribution = "oneshot";
    rationale = `Qualifier runtime/output failure (${qualifierReasonCode}) — visually treated as OneShot-side while preserved as denominator-excluded.`;
    excludedFromDenominator = true;
  } else if (qualifierReasonCode && GATING_REASON_CODES.has(qualifierReasonCode)) {
    rationale = `Gating outcome (${qualifierReasonCode}) — excluded from failure denominator.`;
    excludedFromDenominator = true;
  } else if (qualifierReasonCode === "gate_hard_fail") {
    attribution = "ticket";
    rationale =
      "Qualifier rejected the ticket at the hard-fail gate; ticket-side issue.";
  } else if (TICKET_FAULT_CATEGORIES.has(errorCategory)) {
    attribution = "ticket";
    rationale =
      "Error category indicates ticket-quality issue (e.g. unmet qualification criteria).";
  } else if (ONESHOT_FAULT_CATEGORIES.has(errorCategory)) {
    attribution = "oneshot";
    rationale = `Infra/agent failure (${errorCategory}) — OneShot-side issue.`;
  } else if (qualifierReasonCode === "llm_rejected") {
    rationale =
      "Qualifier LLM rejected the ticket, but the rejection text did not match a known ticket-quality pattern.";
  }

  return {
    attribution,
    errorCategory,
    qualifierReasonCode,
    label: labelForAttribution(row, attribution),
    rationale,
    excludedFromDenominator,
  };
}

export interface FailureAttributionByCategoryRow {
  errorCategory: FailureErrorCategory;
  attribution: FaultAttribution;
  sampleSize: number;
  passRateInCohort: number;
  wilson95: OneShotWilsonInterval | null;
  examples: OneShotStatisticsJiraExample[];
  /** True when this cohort's Wilson upper bound sits below the overall pass-rate baseline. */
  significant: boolean;
}

export interface FailureAttributionSummary {
  totalFailures: number;
  excludedFromDenominator: number;
  countsByAttribution: {
    oneshot: number;
    ticket: number;
    mixed: number;
    unknown: number;
  };
  byCategory: FailureAttributionByCategoryRow[];
  attributionVersion: number;
}

export interface FailureAttributionAggregateInput {
  classifications: ReadonlyArray<{
    classification: FailureClassification;
    row: OneShotDashboardRow;
    example: OneShotStatisticsJiraExample;
  }>;
  overallPassRate: number;
  /** Minimum cohort size before a per-category significance claim is allowed. */
  minSignificantSize: number;
  /** Wilson interval helper provided by the caller (already implemented in oneshotStatistics.ts). */
  wilsonInterval: (
    successes: number,
    total: number,
  ) => OneShotWilsonInterval | null;
}

export function summarizeFailureAttribution(
  input: FailureAttributionAggregateInput,
): FailureAttributionSummary {
  const counts = { oneshot: 0, ticket: 0, mixed: 0, unknown: 0 };
  let excluded = 0;
  let totalFailures = 0;
  const byCategoryMap = new Map<
    string,
    {
      errorCategory: FailureErrorCategory;
      attribution: FaultAttribution;
      sampleSize: number;
      examples: OneShotStatisticsJiraExample[];
    }
  >();

  for (const entry of input.classifications) {
    if (entry.classification.excludedFromDenominator) {
      excluded += 1;
      continue;
    }
    totalFailures += 1;
    counts[entry.classification.attribution] += 1;
    const key = `${entry.classification.errorCategory}|${entry.classification.attribution}`;
    const existing = byCategoryMap.get(key);
    if (existing) {
      existing.sampleSize += 1;
      if (existing.examples.length < 5) existing.examples.push(entry.example);
    } else {
      byCategoryMap.set(key, {
        errorCategory: entry.classification.errorCategory,
        attribution: entry.classification.attribution,
        sampleSize: 1,
        examples: [entry.example],
      });
    }
  }

  const byCategory: FailureAttributionByCategoryRow[] = Array.from(
    byCategoryMap.values(),
  )
    .map((row) => {
      const wilson = input.wilsonInterval(0, row.sampleSize);
      const significant =
        row.sampleSize >= input.minSignificantSize &&
        wilson !== null &&
        wilson.high < input.overallPassRate;
      return {
        errorCategory: row.errorCategory,
        attribution: row.attribution,
        sampleSize: row.sampleSize,
        passRateInCohort: 0,
        wilson95: wilson,
        examples: row.examples,
        significant,
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize);

  return {
    totalFailures,
    excludedFromDenominator: excluded,
    countsByAttribution: counts,
    byCategory,
    attributionVersion: FAILURE_ATTRIBUTION_VERSION,
  };
}

// Re-export to satisfy unused-import lint when only the types are consumed.
export type { OneShotMissingSignalImpact };
