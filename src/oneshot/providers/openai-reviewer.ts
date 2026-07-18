import { createLogger } from "../../utils/logger.js";
import { parseJsonFromTextWithRepair } from "../../claude-sdk/index.js";
import { runOpenAiAgent } from "../../openai-sdk/index.js";
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

const logger = createLogger("oneshot-openai-reviewer");

const DEFAULT_OPENAI_MODEL = "gpt-5.4";
const DEFAULT_REASONING_EFFORT = "high";

export type OpenAiReviewerRequest = ReviewerRequest;
export type OpenAiReviewerResponse = ReviewerResponse;

export class OpenAiReviewerProvider implements ReviewerProvider {
  readonly providerName = "openai" as const;
  readonly modelId: string;
  private readonly reasoningEffort: string;

  constructor(private readonly promptComposer: PromptComposer) {
    this.modelId =
      process.env.OPENAI_REVIEWER_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
    this.reasoningEffort =
      process.env.OPENAI_REVIEWER_REASONING_EFFORT?.trim() ||
      DEFAULT_REASONING_EFFORT;
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

    // Prompt size guard. OpenAI reasoning models have their own context limits; we stay
    // conservative. Checking the final prompt (banner + composed prompt) catches runaway
    // context before the LLM call turns into a confusing API timeout or silent failure.
    const MAX_PROMPT_BYTES = 400_000;
    const promptBytes = Buffer.byteLength(finalPrompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `OneShot reviewer prompt exceeds maximum size: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} bytes. ` +
          `This usually indicates runaway context (oversized ticket, large repo scan, ballooned revision context). ` +
          `Reduce input size or increase MAX_PROMPT_BYTES in src/oneshot/providers/openai-reviewer.ts.`,
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

    const result = await runOpenAiAgent({
      taskId: `oneshot-reviewer-${request.jiraKey}-${Date.now()}`,
      systemPrompt:
        "You are a read-only OneShot plan reviewer. Use the available repository tools to inspect the frozen workspace before returning structured JSON.",
      userPrompt: finalPrompt,
      workspacePath: request.workspacePath,
      outputSchema: ONE_SHOT_REVIEW_OUTPUT_SCHEMA,
      schemaName: "oneshot_review",
      model: this.modelId,
      reasoningEffort: this.reasoningEffort,
    });

    if (!result.success) {
      throw new Error(
        result.error || "OpenAI reviewer failed without an explicit error",
      );
    }

    const review = result.structuredOutput
      ? parseOneShotReview(result.structuredOutput)
      : parseOneShotReview(parseJsonFromTextWithRepair(result.output).value);

    logger.info(
      {
        jiraKey: request.jiraKey,
        repoName: request.repoName,
        decision: review.decision,
        score: review.score,
        toolCalls: result.metrics.toolCalls,
      },
      "OneShot reviewer completed",
    );

    return {
      review,
      rawOutput: result.output,
      metrics: {
        durationMs: result.metrics.durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.costUsd,
      },
    };
  }
}
