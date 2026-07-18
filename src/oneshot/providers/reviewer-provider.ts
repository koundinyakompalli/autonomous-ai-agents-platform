import type { OneShotPlan } from "../schema/plan.js";
import type { OneShotReview } from "../schema/review.js";
import type { OneShotCodeReview } from "../schema/code-review.js";
import type {
  OneShotTraceArtifact,
  OneShotVerifyReport,
} from "../schema/trace-verify.js";
import type { ReviewContext } from "../review-context.js";
import type { CodeReviewContext } from "../code-review-context.js";
import type { OneShotModelUsage } from "../model-usage.js";
import type { OneShotProcessingMode } from "../processing-mode.js";
import type { PlannerRetrofitContext } from "../retrofit-context.js";
import type { RetrofitSourceEvidence } from "../retrofit-source-evidence.js";

export type ReviewerProviderName = "openai" | "anthropic";

export interface ReviewerProviderMetrics {
  durationMs: number;
  toolCalls: number;
  tokensUsed?: {
    input: number;
    output: number;
    cachedInput?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  costUsd?: number;
  modelUsage?: OneShotModelUsage;
}

export interface ReviewerRequest {
  jiraKey: string;
  repoName: string;
  branchName: string;
  baseCommitSha: string;
  workspacePath: string;
  plan: OneShotPlan;
  trace?: OneShotTraceArtifact | null;
  verify?: OneShotVerifyReport | null;
  reviewContext: ReviewContext;
  /** Qualification-level retrofit context, used even when a draft plan omits retrofitEvidence. */
  retrofitContext?: PlannerRetrofitContext | null;
  /** Qualification-level source commit evidence, used to validate retrofit plan coverage. */
  retrofitSourceEvidence?: RetrofitSourceEvidence | null;
  /** Resolved OneShot lane for prompt selection (security, Sonar, or standard). */
  processingMode?: OneShotProcessingMode;
  /** Raw Jira labels kept for artifact/reporting context and compatibility fallbacks. */
  jiraLabels?: string[];
}

export interface ReviewerResponse {
  review: OneShotReview;
  rawOutput: string;
  metrics: ReviewerProviderMetrics;
}

export interface ReviewerProvider {
  readonly providerName: ReviewerProviderName;
  readonly modelId: string;
  reviewPlan(request: ReviewerRequest): Promise<ReviewerResponse>;
}

export interface CodeReviewerRequest {
  jiraKey: string;
  repoName: string;
  branchName: string;
  baseCommitSha: string;
  workspacePath: string;
  implementationBranch: string;
  implementationCommitSha: string;
  implementationVersion: number;
  plan: OneShotPlan;
  codeReviewContext: CodeReviewContext;
  priorFindingsLedger?: unknown;
  /** Qualification-level retrofit context, used when plan evidence is incomplete. */
  retrofitContext?: PlannerRetrofitContext | null;
  /** Qualification-level source commit evidence, used to review retrofit proof. */
  retrofitSourceEvidence?: RetrofitSourceEvidence | null;
  /** Resolved OneShot lane for prompt selection (security, Sonar, or standard). */
  processingMode?: OneShotProcessingMode;
  /** Raw Jira labels kept for compatibility fallbacks and audit context. */
  jiraLabels?: string[];
}

export interface CodeReviewerResponse {
  review: OneShotCodeReview;
  rawOutput: string;
  metrics: ReviewerProviderMetrics;
}

export interface CodeReviewerProvider {
  readonly providerName: ReviewerProviderName;
  readonly modelId: string;
  reviewCode(request: CodeReviewerRequest): Promise<CodeReviewerResponse>;
}
