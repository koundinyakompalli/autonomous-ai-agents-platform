import {
  buildRetrofitAlreadyAppliedMessage,
  type OneShotRetrofitEvidence,
} from "./schema/plan.js";

export interface PlannerRetrofitContext {
  sourceJiraKey: string;
  sourceBranch: string;
  targetBranch: string;
  sourcePrUrl?: string;
}

export class PlannerRetrofitAlreadyAppliedError extends Error {
  constructor(public readonly evidence: OneShotRetrofitEvidence) {
    super(buildRetrofitAlreadyAppliedMessage(evidence));
    this.name = "PlannerRetrofitAlreadyAppliedError";
  }
}

export function parsePlannerRetrofitContext(
  value: unknown,
): PlannerRetrofitContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const sourceJiraKey = record.sourceJiraKey;
  const sourceBranch = record.sourceBranch;
  const targetBranch = record.targetBranch;
  const sourcePrUrl = record.sourcePrUrl;
  if (
    typeof sourceJiraKey !== "string" ||
    typeof sourceBranch !== "string" ||
    typeof targetBranch !== "string" ||
    !sourceJiraKey.trim() ||
    !sourceBranch.trim() ||
    !targetBranch.trim()
  ) {
    return null;
  }

  return {
    sourceJiraKey: sourceJiraKey.trim(),
    sourceBranch: sourceBranch.trim(),
    targetBranch: targetBranch.trim(),
    ...(typeof sourcePrUrl === "string" && sourcePrUrl.trim()
      ? { sourcePrUrl: sourcePrUrl.trim() }
      : {}),
  };
}

export function normalizePlannerRetrofitContext(
  value: unknown,
): PlannerRetrofitContext | null {
  return parsePlannerRetrofitContext(value);
}

export function buildRetrofitBranchMismatchMessage(
  context: PlannerRetrofitContext,
  runBranch: string,
): string {
  return (
    `retrofit_branch_mismatch: Retrofit target branch ${context.targetBranch} ` +
    `does not match run branch ${runBranch}.`
  );
}
