import type {
  OneShotAnalyticsRange,
  OneShotFailureAttributionSummary,
  OneShotFailureErrorCategory,
  OneShotSelfFixCandidate,
  OneShotSelfFixConfig,
} from "../types/oneshot.js";

export const ONESHOT_SELF_FIX_TARGET_EPIC_KEY = "CPDEV-23232";
export const ONESHOT_SELF_FIX_TARGET_REPO =
  "mhk-repos/cp-autonomous-ai-agents-platform";
export const ONESHOT_SELF_FIX_TARGET_BRANCH = "main";
export const DEFAULT_SELF_FIX_MIN_SAMPLE_SIZE = 5;

const ACTIONABLE_SELF_FIX_CATEGORIES = new Set<OneShotFailureErrorCategory>([
  "git_operation",
  "llm_provider",
  "llm_output",
  "s3_storage",
  "db_operation",
  "workspace",
  "github_api",
  "plan_validation",
  "agent_logic",
  "test_runner_skipped",
  "ci_failure",
]);

function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function configuredBoolean(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

export function selfFixMinSampleSize(): number {
  return configuredPositiveInteger(
    "ONESHOT_SELF_FIX_MIN_SAMPLE_SIZE",
    DEFAULT_SELF_FIX_MIN_SAMPLE_SIZE,
  );
}

export function getOneShotSelfFixConfig(): OneShotSelfFixConfig {
  return {
    minSampleSize: selfFixMinSampleSize(),
    autoCreateEnabled: configuredBoolean("ONESHOT_SELF_FIX_AUTO_CREATE"),
    autoRunEnabled: configuredBoolean("ONESHOT_SELF_FIX_AUTO_RUN"),
    targetEpicKey: ONESHOT_SELF_FIX_TARGET_EPIC_KEY,
    targetRepo: ONESHOT_SELF_FIX_TARGET_REPO,
    targetBranch: ONESHOT_SELF_FIX_TARGET_BRANCH,
  };
}

export function selfFixCandidateId(input: {
  category: OneShotFailureErrorCategory;
  attribution: "oneshot";
}): string {
  return `oneshot-self-fix-${input.category}-${input.attribution}`;
}

export function isActionableSelfFixCategory(
  category: OneShotFailureErrorCategory,
): boolean {
  return ACTIONABLE_SELF_FIX_CATEGORIES.has(category);
}

export function buildOneShotSelfFixCandidates(input: {
  range: OneShotAnalyticsRange;
  failureAttribution: OneShotFailureAttributionSummary;
  passRateBaseline: number;
}): OneShotSelfFixCandidate[] {
  const minSampleSize = selfFixMinSampleSize();
  return input.failureAttribution.byCategory
    .filter(
      (row) =>
        row.attribution === "oneshot" &&
        row.significant &&
        row.sampleSize >= minSampleSize &&
        row.examples.length > 0 &&
        isActionableSelfFixCategory(row.errorCategory),
    )
    .map((row) => ({
      id: selfFixCandidateId({
        category: row.errorCategory,
        attribution: "oneshot",
      }),
      category: row.errorCategory,
      attribution: "oneshot" as const,
      sampleSize: row.sampleSize,
      significant: row.significant,
      wilson95: row.wilson95,
      passRateBaseline: input.passRateBaseline,
      range: input.range,
      examples: row.examples,
      status: "eligible" as const,
    }));
}
