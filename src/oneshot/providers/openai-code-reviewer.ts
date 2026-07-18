import { createLogger } from '../../utils/logger.js'
import { parseJsonFromTextWithRepair } from '../../claude-sdk/index.js'
import { runOpenAiAgent } from '../../openai-sdk/index.js'
import type { PromptComposer } from '../prompt-composer.js'
import {
  ONE_SHOT_CODE_REVIEW_OUTPUT_SCHEMA,
  parseOneShotCodeReview,
} from '../schema/code-review.js'
import type {
  CodeReviewerProvider,
  CodeReviewerRequest,
  CodeReviewerResponse,
} from './reviewer-provider.js'
import { resolveOneShotProcessingModeFromIntake } from '../processing-mode.js'
import {
  buildRetrofitWorkflowSection,
  isRetrofitWorkflowRequired,
} from '../retrofit-workflow.js'

const logger = createLogger('oneshot-openai-code-reviewer')

const DEFAULT_OPENAI_MODEL = 'gpt-5.4'
const DEFAULT_REASONING_EFFORT = 'high'

export type OpenAiCodeReviewerRequest = CodeReviewerRequest
export type OpenAiCodeReviewerResponse = CodeReviewerResponse

export class OpenAiCodeReviewerProvider implements CodeReviewerProvider {
  readonly providerName = 'openai' as const
  readonly modelId: string
  private readonly reasoningEffort: string

  constructor(private readonly promptComposer: PromptComposer) {
    this.modelId = process.env.OPENAI_CODE_REVIEWER_MODEL?.trim() || DEFAULT_OPENAI_MODEL
    this.reasoningEffort = process.env.OPENAI_CODE_REVIEWER_REASONING_EFFORT?.trim() || DEFAULT_REASONING_EFFORT
  }

  async reviewCode(request: CodeReviewerRequest): Promise<CodeReviewerResponse> {
    const retrofitWorkflowSection = isRetrofitWorkflowRequired({
      plan: request.plan,
      retrofitContext: request.retrofitContext,
      retrofitSourceEvidence: request.retrofitSourceEvidence,
    })
      ? buildRetrofitWorkflowSection({
          workflowPrompt: await this.promptComposer.loadRetrofitWorkflowPrompt(),
          stage: 'code_reviewer',
          plan: request.plan,
          retrofitContext: request.retrofitContext,
          retrofitSourceEvidence: request.retrofitSourceEvidence,
        })
      : ''

    const basePrompt = await this.promptComposer.composePrompt('code_review', {
      jiraKey: request.jiraKey,
      repoName: request.repoName,
      branchName: request.branchName,
      baseCommitSha: request.baseCommitSha,
      implementationBranch: request.implementationBranch,
      implementationCommitSha: request.implementationCommitSha,
      implementationVersion: String(request.implementationVersion),
      planJson: JSON.stringify(request.plan, null, 2),
      codeReviewContextJson: JSON.stringify(request.codeReviewContext, null, 2),
      priorFindingsLedgerJson: JSON.stringify(request.priorFindingsLedger ?? {
        priorReviewCount: 0,
        requiredChanges: [],
        blockingFindings: [],
        findings: [],
      }, null, 2),
      retrofitWorkflowSection,
    })
    const processingMode =
      request.processingMode ??
      resolveOneShotProcessingModeFromIntake(request.jiraLabels)
    const sonarExtension = processingMode === 'sonar_autofix'
      ? await this.promptComposer.loadSonarCodeReviewExtension()
      : undefined
    const wizCodeExtension = processingMode === 'wiz_code'
      ? await this.promptComposer.loadWizCodeCodeReviewExtension()
      : undefined
    const prompt = [basePrompt, sonarExtension, wizCodeExtension]
      .filter((section): section is string => !!section)
      .join('\n\n---\n\n')

    const ctx = request.codeReviewContext
    const truncationBanner = (ctx.truncated || ctx.diffTruncated)
      ? `\n\n⚠️ CONTEXT TRUNCATION WARNING ⚠️\n` +
        `Your code review context is incomplete:\n` +
        (ctx.diffTruncated ? `  - The unified diff was truncated (>100KB)\n` : '') +
        (ctx.truncated ? `  - ${ctx.truncationNote ?? 'Some changed files were omitted due to size limits.'}\n` : '') +
        `If you cannot verify a security, correctness, or architectural concern in an omitted file, you MUST:\n` +
        `  - Set \`confidence: "low"\`\n` +
        `  - Mark the review decision as NEEDS_CHANGES with a \`requiredChange\` asking for a smaller diff or file-specific audit\n` +
        `  - Do NOT decide APPROVED if you cannot verify a file known to be impacted.\n\n`
      : ''

    const finalPrompt = truncationBanner + prompt

    if (truncationBanner) {
      logger.warn({
        jiraKey: request.jiraKey,
        repoName: request.repoName,
        truncated: ctx.truncated,
        diffTruncated: ctx.diffTruncated ?? undefined,
        truncationNote: ctx.truncationNote,
      }, '[CONTEXT_TRUNCATED] Reviewer prompt includes truncation warning banner')
    }

    // Prompt size guard. The code reviewer prompt includes the unified diff plus changed files,
    // so it runs larger than the plan reviewer. This cap catches runaway context before the
    // OpenAI call turns into a confusing API timeout or silent failure.
    const MAX_PROMPT_BYTES = 600_000
    const promptBytes = Buffer.byteLength(finalPrompt, 'utf8')
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `OneShot code-reviewer prompt exceeds maximum size: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} bytes. ` +
        `This usually indicates runaway context (oversized ticket, large repo scan, ballooned revision context). ` +
        `Reduce input size or increase MAX_PROMPT_BYTES in src/oneshot/providers/openai-code-reviewer.ts.`,
      )
    }
    logger.debug({
      jiraKey: request.jiraKey,
      stage: 'code-reviewer',
      promptBytes,
    }, '[PROMPT_SIZE] Prompt size check passed')

    const result = await runOpenAiAgent({
      taskId: `oneshot-code-reviewer-${request.jiraKey}-${Date.now()}`,
      systemPrompt: 'You are a read-only OneShot code reviewer. Inspect the implementation workspace and compare it against the approved plan before returning structured JSON.',
      userPrompt: finalPrompt,
      workspacePath: request.workspacePath,
      outputSchema: ONE_SHOT_CODE_REVIEW_OUTPUT_SCHEMA,
      schemaName: 'oneshot_code_review',
      model: this.modelId,
      reasoningEffort: this.reasoningEffort,
    })

    if (!result.success) {
      throw new Error(result.error || 'OpenAI code reviewer failed without an explicit error')
    }

    const review = result.structuredOutput
      ? parseOneShotCodeReview(result.structuredOutput)
      : parseOneShotCodeReview(parseJsonFromTextWithRepair(result.output).value)

    logger.info( {
      jiraKey: request.jiraKey,
      repoName: request.repoName,
      decision: review.decision,
      score: review.score,
      findingsCount: review.findings.length,
      toolCalls: result.metrics.toolCalls,
    },'OneShot code reviewer completed')

    return {
      review,
      rawOutput: result.output,
      metrics: {
        durationMs: result.metrics.durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.costUsd,
      },
    }
  }
}
