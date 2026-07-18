import {
  parseJsonFromTextWithRepair,
  registerRepoFromPath,
  runAgent,
  type BedrockConfig,
} from "../claude-sdk.js";
import { createLogger } from "../../utils/logger.js";
import type { PromptComposer } from "../prompt-composer.js";
import {
  ONE_SHOT_REVIEW_OUTPUT_SCHEMA,
  parseOneShotReview,
} from "../schema/review.js";
import type {
  ReviewerProvider,
  ReviewerRequest,
  ReviewerResponse,
} from "./reviewer-provider.js";
import { resolveOneShotProcessingModeFromIntake } from "../processing-mode.js";
import {
  buildRetrofitWorkflowSection,
  isRetrofitWorkflowRequired,
} from "../retrofit-workflow.js";

const logger = createLogger("oneshot-claude-reviewer");

const DEFAULT_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
const MAX_PROMPT_BYTES = 400_000;
// First-run defaults — tune after observing a few Opus 4.6 reviewer runs.
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_BUDGET_USD = 10;

export interface ClaudeReviewerOptions {
  modelId?: string;
}

export class ClaudeReviewerProvider implements ReviewerProvider {
  readonly providerName = "anthropic" as const;
  readonly modelId: string;

  constructor(
    private readonly promptComposer: PromptComposer,
    options: ClaudeReviewerOptions = {},
  ) {
    this.modelId = options.modelId?.trim() || DEFAULT_MODEL_ID;
  }

  async reviewPlan(request: ReviewerRequest): Promise<ReviewerResponse> {
    const retrofitWorkflowSection = isRetrofitWorkflowRequired({
      plan: request.plan,
      retrofitContext: request.retrofitContext,
      retrofitSourceEvidence: request.retrofitSourceEvidence,
    })
      ? buildRetrofitWorkflowSection({
          workflowPrompt: await this.promptComposer.loadRetrofitWorkflowPrompt(),
          stage: "reviewer",
          plan: request.plan,
          retrofitContext: request.retrofitContext,
          retrofitSourceEvidence: request.retrofitSourceEvidence,
        })
      : "";

    const basePrompt = await this.promptComposer.composePrompt("review", {
      jiraKey: request.jiraKey,
      repoName: request.repoName,
      branchName: request.branchName,
      baseCommitSha: request.baseCommitSha,
      planJson: JSON.stringify(request.plan, null, 2),
      traceVerifyContextJson: JSON.stringify(
        {
          trace: request.trace ?? null,
          verify: request.verify ?? null,
        },
        null,
        2,
      ),
      reviewContextJson: JSON.stringify(request.reviewContext, null, 2),
      retrofitWorkflowSection,
    });

    const processingMode =
      request.processingMode ??
      resolveOneShotProcessingModeFromIntake(request.jiraLabels);
    const securityExtension = processingMode === "security_wiz"
      ? await this.promptComposer.loadSecurityReviewExtension()
      : undefined;
    const wizCodeExtension = processingMode === "wiz_code"
      ? await this.promptComposer.loadWizCodeReviewExtension()
      : undefined;
    const sonarExtension = processingMode === "sonar_autofix"
      ? await this.promptComposer.loadSonarReviewExtension()
      : undefined;
    const prompt = [basePrompt, securityExtension, wizCodeExtension, sonarExtension]
      .filter((section): section is string => !!section)
      .join("\n\n---\n\n");

    const ctx = request.reviewContext;
    const truncationBanner = ctx.truncated
      ? `\n\n⚠️ CONTEXT TRUNCATION WARNING ⚠️\n` +
        `The review context you were provided is incomplete.\n` +
        `${ctx.truncationNote ?? "Some impacted files or contents were omitted due to size limits."}\n` +
        `If your review approval depends on files that may have been omitted, reflect this uncertainty by:\n` +
        `  - Setting \`confidence: "low"\` in your response\n` +
        `  - Listing the omitted files in \`nonBlockingSuggestions\` so a human can verify\n` +
        `  - Do NOT decide APPROVED if you cannot verify a critical file was included.\n\n`
      : "";

    const finalPrompt = truncationBanner + prompt;

    if (truncationBanner) {
      logger.warn(
        {
          jiraKey: request.jiraKey,
          repoName: request.repoName,
          truncated: ctx.truncated,
          truncationNote: ctx.truncationNote,
        },
        "[CONTEXT_TRUNCATED] Reviewer prompt includes truncation warning banner",
      );
    }

    const promptBytes = Buffer.byteLength(finalPrompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `OneShot reviewer prompt exceeds maximum size: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} bytes. ` +
          `This usually indicates runaway context (oversized ticket, large repo scan, ballooned revision context). ` +
          `Reduce input size or increase MAX_PROMPT_BYTES in src/oneshot/providers/claude-reviewer.ts.`,
      );
    }
    logger.debug(
      {
        jiraKey: request.jiraKey,
        stage: "reviewer",
        promptBytes,
      },
      "[PROMPT_SIZE] Prompt size check passed",
    );

    const repoId = registerRepoFromPath(
      request.workspacePath,
      `oneshot-run-${request.jiraKey}-reviewer`,
    );

    const bedrockConfig: Partial<BedrockConfig> = { model: this.modelId };

    const result = await runAgent({
      taskId: `oneshot-reviewer-${request.jiraKey}-${Date.now()}`,
      sdkStage: "review",
      taskPrompt: finalPrompt,
      systemAppend:
        "You are a read-only OneShot plan reviewer. Use the available repository tools to inspect the frozen workspace before returning structured JSON.",
      repoIds: [repoId],
      permissionLevel: "read_only",
      allowedTools: ["Read", "Glob", "Grep"],
      outputSchema: ONE_SHOT_REVIEW_OUTPUT_SCHEMA,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxTurns: DEFAULT_MAX_TURNS,
      maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
      bedrockConfig,
      includePartialMessages: true,
    });

    if (!result.success) {
      throw new Error(
        result.error || "Claude reviewer failed without an explicit error",
      );
    }

    const review =
      result.structuredOutput !== undefined
        ? parseOneShotReview(result.structuredOutput)
        : parseOneShotReview(parseJsonFromTextWithRepair(result.output).value);

    logger.info(
      {
        jiraKey: request.jiraKey,
        repoName: request.repoName,
        decision: review.decision,
        score: review.score,
        toolCalls: result.metrics.toolCalls,
        modelUsed: result.metrics.modelUsed,
      },
      "OneShot Claude reviewer completed",
    );

    return {
      review,
      rawOutput: result.output,
      metrics: {
        durationMs: result.metrics.durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.costUsd,
        modelUsage: result.metrics.modelUsage,
      },
    };
  }
}
