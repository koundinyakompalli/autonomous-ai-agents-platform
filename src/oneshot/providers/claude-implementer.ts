import {
  parseValidatedJsonFromTextWithRepair,
  registerRepoFromPath,
  runAgent,
  type AgentResult,
} from "../claude-sdk.js";
import { createLogger } from "../../utils/logger.js";
import type { PromptComposer } from "../prompt-composer.js";
import {
  ONE_SHOT_IMPLEMENTATION_OUTPUT_SCHEMA,
  parseOneShotImplementerOutput,
  type OneShotImplementerOutput,
} from "../schema/implementation.js";
import type { OneShotPlan } from "../schema/plan.js";
import type { OneShotTraceArtifact } from "../schema/trace-verify.js";
import type { OneShotCodeReview } from "../schema/code-review.js";
import type { OneShotTestResult } from "../schema/test-result.js";
import type { OneShotModelUsage } from "../model-usage.js";
import type { OneShotProcessingMode } from "../processing-mode.js";
import {
  buildMavenScratchEnv,
  buildOneShotScratchPath,
} from "../maven-env.js";
import type {
  RetrofitAdaptationCoverageEntry,
  RetrofitSourceCommitStatus,
} from "../retrofit-source-evidence.js";
import {
  buildRetrofitWorkflowSection,
  isRetrofitWorkflowRequired,
} from "../retrofit-workflow.js";

const logger = createLogger("oneshot-implementer");
const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-5";

export class ImplementerStallError extends Error {
  constructor(
    message: string,
    public readonly failureKind:
      | "idle_timeout"
      | "wall_timeout"
      | "tool_stall"
      | "post_tool_idle_timeout"
      | "structured_output_retries_exhausted"
      | "turn_limit"
      | "other",
    public readonly metrics?: ImplementerResponse["metrics"],
  ) {
    super(message);
    this.name = "ImplementerStallError";
  }
}

export type ImplementerResumeMode =
  | "fresh"
  | "fork_resume"
  | "fork_resume_fallback_fresh";

export interface ImplementerRevisionContext {
  codeReviewFindings?: OneShotCodeReview;
  testFailures?: OneShotTestResult;
  validationRetryRequested?: boolean;
  previousCompletedSpecIds?: string[];
  previousSessionNotes?: string;
  previousProviderSessionId?: string;
  previousImplementationVersion?: number;
  priorRetrofitSourceCommitStatuses?: RetrofitSourceCommitStatus[];
  priorRetrofitAdaptationCoverage?: RetrofitAdaptationCoverageEntry[];
}

export interface ImplementerRequest {
  jiraKey: string;
  repoName: string;
  branchName: string;
  baseCommitSha: string;
  implementationBranch: string;
  workspacePath: string;
  ticketSummary: string;
  plan: OneShotPlan;
  trace?: OneShotTraceArtifact | null;
  mavenBuildsEnabled?: boolean;
  revisionContext?: ImplementerRevisionContext;
  resumeSessionId?: string;
  forkSessionOnResume?: boolean;
  claudeConfigDir?: string;
  processingMode?: OneShotProcessingMode;
  /**
   * When present, constrains the Claude prompt to adaptation-only behavior:
   * resolving conflicts in the provided source patch without semantically
   * rediscovering or recreating the change from scratch.
   */
  retrofitAdaptationContext?: {
    sourcePatch: string;
    conflictDiagnostics: string;
    allowedFiles: string[];
    sourceShas: string[];
  };
}

export interface ImplementerResponse {
  implementation: OneShotImplementerOutput;
  rawOutput: string;
  sessionId?: string;
  resumedFromSessionId?: string;
  resumeMode?: ImplementerResumeMode;
  resumeAttempted?: boolean;
  resumeSucceeded?: boolean;
  metrics: {
    durationMs: number;
    toolCalls: number;
    tokensUsed?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    costUsd?: number;
    modelUsed?: string;
    modelUsage?: OneShotModelUsage;
  };
}

export interface ClaudeImplementerOptions {
  modelId?: string;
  maxOutputTokens?: number;
  maxTurns?: number;
  mavenBuildsEnabled?: boolean;
}

function buildRetrofitAdaptationInstruction(
  ctx: NonNullable<ImplementerRequest['retrofitAdaptationContext']>,
): string {
  const allowedFilesSection =
    ctx.allowedFiles.length > 0
      ? `\nAllowed files for adaptation:\n${ctx.allowedFiles.map((f) => `- \`${f}\``).join('\n')}`
      : ''

  const sourceShasSection =
    ctx.sourceShas.length > 0
      ? `\nSource commit SHA(s): ${ctx.sourceShas.join(', ')}`
      : ''

  return `\n## RETROFIT ADAPTATION MODE

This is a retrofit adaptation task. A source commit patch could not be applied cleanly to the target branch. Adapt the provided source patch using the conflict diagnostics below.
${allowedFilesSection}
${sourceShasSection}

**Conflict diagnostics (why the patch did not apply cleanly):**
\`\`\`
${ctx.conflictDiagnostics}
\`\`\`

**Source patch to adapt:**
\`\`\`diff
${ctx.sourcePatch}
\`\`\`
`
}

function buildMavenBuildsInstruction(mavenBuildsEnabled: boolean): string {
  if (mavenBuildsEnabled) {
    return "";
  }

  return `\n## Maven/Artifactory availability\n\n` +
    `Maven builds and Maven test commands are disabled for this OneShot run because Artifactory is unavailable. ` +
    `Do not run \`mvn\`, \`mvnw\`, or \`./mvnw\` commands. Do not declare Maven-only commands in \`testCommands\`. ` +
    `Use non-Maven validation when available and put any Maven-dependent verification in \`manualVerificationSteps\` or residual risk notes.\n`;
}

function isClaudeResumeUnavailableError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalized = message.toLowerCase();
  if (!normalized.includes("session") && !normalized.includes("resume")) {
    return false;
  }

  return [
    "not found",
    "missing",
    "expired",
    "invalid",
    "could not resume",
    "cannot resume",
    "unable to resume",
    "failed to resume",
    "no such session",
    "load session",
    "load the session",
    "materialize",
    "materialise",
  ].some((marker) => normalized.includes(marker));
}

function classifyResumeFreshRetry(
  result: AgentResult,
): "resume_unavailable" | "pre_execution_failure" | null {
  if (result.success) {
    return null;
  }

  const output = result.output?.trim() ?? "";
  const toolCalls = result.metrics?.toolCalls ?? 0;
  const beforeClaudeDidWork =
    !result.sessionId &&
    toolCalls === 0 &&
    output.length === 0 &&
    (!result.failureKind || result.failureKind === "other");

  if (!beforeClaudeDidWork) {
    return null;
  }

  return isClaudeResumeUnavailableError(result.error)
    ? "resume_unavailable"
    : "pre_execution_failure";
}

function buildPriorRetrofitProofSection(
  revisionContext: ImplementerRevisionContext,
): string {
  const statuses = revisionContext.priorRetrofitSourceCommitStatuses ?? [];
  if (statuses.length === 0) {
    return "";
  }

  const MAX_ENTRIES = 12;
  const MAX_LIST_ITEMS = 8;
  const MAX_PROOF_SNIPPETS = 4;
  const shownStatuses = statuses.slice(0, MAX_ENTRIES);
  const lines = shownStatuses.map((status) => {
    const sourceFiles = (status.sourceFiles ?? [])
      .slice(0, MAX_LIST_ITEMS)
      .join(", ");
    const targetFiles = (status.targetFiles ?? [])
      .slice(0, MAX_LIST_ITEMS)
      .join(", ");
    const adaptationFiles = (status.adaptationFiles ?? [])
      .slice(0, MAX_LIST_ITEMS)
      .join(", ");
    const proof = [
      ...(status.proofSnippets ?? []),
      ...(status.validationEvidence ?? []),
    ]
      .slice(0, MAX_PROOF_SNIPPETS)
      .join(" | ");
    return [
      `- ${status.sourceSha} status=${status.status}`,
      sourceFiles ? `sourceFiles=${sourceFiles}` : "",
      targetFiles ? `targetFiles=${targetFiles}` : "",
      adaptationFiles ? `adaptationFiles=${adaptationFiles}` : "",
      proof ? `proof=${proof}` : "",
      status.rationale ? `rationale=${status.rationale}` : "",
    ]
      .filter(Boolean)
      .join("; ");
  });
  const omitted = statuses.length - shownStatuses.length;
  const coverage = revisionContext.priorRetrofitAdaptationCoverage ?? [];
  const coverageLines = coverage.slice(0, MAX_ENTRIES).map((entry) => {
    const files = entry.filesCovered.slice(0, MAX_LIST_ITEMS).join(", ");
    const evidence = entry.hunkEvidence
      .slice(0, MAX_PROOF_SNIPPETS)
      .join(" | ");
    return `- ${entry.sourceSha}: files=${files || "none"}${evidence ? `; evidence=${evidence}` : ""}`;
  });

  return `## Prior Retrofit Source Proof

Implementation v${revisionContext.previousImplementationVersion ?? "previous"} already accounted for these selected retrofit source commits. This revision is not a fresh retrofit patch application.

Prior source commit statuses:
${lines.join("\n")}
${omitted > 0 ? `\n(+ ${omitted} additional source commit status entries not shown)` : ""}

Prior adaptation coverage:
${coverageLines.join("\n") || "- None"}`;
}

function buildRevisionSection(
  revisionContext: ImplementerRevisionContext,
): string {
  const sections: string[] = [];

  if (
    revisionContext.previousCompletedSpecIds &&
    revisionContext.previousCompletedSpecIds.length > 0
  ) {
    sections.push(`## Already Completed Specs (DO NOT re-implement these)

The following spec IDs were successfully completed and code-review-accepted in a prior pass.
Only implement the remaining specs and fix the issues identified in code review.

Completed: ${revisionContext.previousCompletedSpecIds.join(", ")}`);
  }

  if (revisionContext.previousSessionNotes) {
    const MAX_SESSION_NOTES = 4000;
    const notes = revisionContext.previousSessionNotes;
    const truncated = notes.length > MAX_SESSION_NOTES;
    const shown = truncated ? notes.slice(0, MAX_SESSION_NOTES) : notes;

    sections.push(`## Prior Session Notes

The previous implementer session captured these observations about the codebase.
Use them to skip re-discovery and focus on the required fixes.

${shown}${truncated ? `\n\n[...${notes.length - MAX_SESSION_NOTES} character(s) truncated]` : ""}`);
  }

  const priorRetrofitProofSection =
    buildPriorRetrofitProofSection(revisionContext);
  if (priorRetrofitProofSection) {
    sections.push(priorRetrofitProofSection);
  }

  if (revisionContext.codeReviewFindings) {
    const cr = revisionContext.codeReviewFindings;

    // Group findings by file; keep worst severity per file; cap total files shown.
    const severityRank: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };
    const byFile = new Map<string, typeof cr.findings>();
    for (const f of cr.findings) {
      const list = byFile.get(f.file) ?? [];
      list.push(f);
      byFile.set(f.file, list);
    }
    const MAX_FILES = 15;
    const MAX_FINDINGS_PER_FILE = 3;

    const dedupedFindings = Array.from(byFile.entries())
      .slice(0, MAX_FILES)
      .map(([file, list]) => {
        const sorted = [...list].sort(
          (a, b) =>
            (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0),
        );
        const shown = sorted.slice(0, MAX_FINDINGS_PER_FILE);
        const extra = list.length - shown.length;
        return { file, shown, extra };
      });

    const omittedFiles = Math.max(byFile.size - MAX_FILES, 0);

    sections.push(`## Code Review Findings (score: ${cr.score}/100, decision: ${cr.decision})

Required changes:
${cr.requiredChanges.map((c) => `- ${c}`).join("\n") || "- None"}

Blocking findings:
${cr.blockingFindings.map((f) => `- ${f}`).join("\n") || "- None"}

Detailed findings (grouped by file, top ${MAX_FINDINGS_PER_FILE} per file, worst-severity first):
${
  dedupedFindings
    .map(
      ({ file, shown, extra }) =>
        shown
          .map(
            (f) =>
              `- [${f.severity}] ${file}${f.line != null ? `:${f.line}` : ""} — ${f.description}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ""}`,
          )
          .join("\n") +
        (extra > 0
          ? `\n  ...and ${extra} more finding(s) in ${file} of equal or lower severity`
          : ""),
    )
    .join("\n") || "- None"
}
${omittedFiles > 0 ? `\n(+ ${omittedFiles} additional file(s) with findings not shown)` : ""}

If you believe a required change from code review is technically incorrect, cannot be done within the
codebase constraints, or conflicts with an existing acceptance criterion, set implementerDisagrees=true
and explain in implementerDisagreementReason. DO NOT set this for stylistic disagreements — only
for changes that would break correctness or are factually impossible in this codebase.

Revision output must either produce actual file edits or set implementerDisagrees=true with a
non-empty implementerDisagreementReason. Do not return a no-op revision silently.`);
  }

  if (revisionContext.testFailures) {
    const tr = revisionContext.testFailures;
    const MAX_FAILED_TESTS = 20;
    const shownTests = tr.failedTests.slice(0, MAX_FAILED_TESTS);
    const omittedTests = Math.max(tr.failedTests.length - MAX_FAILED_TESTS, 0);

    sections.push(`## Test Failures (${tr.failCount} failed, ${tr.passCount} passed, ${tr.skipCount} skipped)

Command: ${tr.resolvedCommand}
Exit code: ${tr.exitCode}

Failed tests${omittedTests > 0 ? ` (showing first ${MAX_FAILED_TESTS} of ${tr.failedTests.length})` : ""}:
${shownTests.map((t) => `- ${t.testName}${t.className ? ` (${t.className})` : ""}: ${t.message}`).join("\n") || "- None"}
${omittedTests > 0 ? `\n(+ ${omittedTests} additional failing test(s) not shown — fix the shown ones first and re-run)` : ""}

${tr.truncatedOutput ? `Truncated output:\n\`\`\`\n${tr.truncatedOutput.slice(0, 4000)}\n\`\`\`` : ""}`);
  }

  return sections.join("\n\n");
}

export class ClaudeImplementerProvider {
  constructor(
    private readonly promptComposer: PromptComposer,
    private readonly options: ClaudeImplementerOptions = {},
  ) {}

  async implementPlan(
    request: ImplementerRequest,
  ): Promise<ImplementerResponse> {
    const isRevision = !!request.revisionContext;
    const mavenBuildsEnabled =
      request.mavenBuildsEnabled ?? this.options.mavenBuildsEnabled ?? true;

    const revisionSection = isRevision
      ? `## REVISION MODE\n\n` +
        `This is a revision pass. Your previous implementation received feedback that must be addressed.\n` +
        `Focus ONLY on fixing the issues identified below. Do not refactor unrelated code.\n\n` +
        `${buildRevisionSection(request.revisionContext!)}\n\n` +
        `Address every required change and blocking finding. Run tests after fixing to verify.\n` +
        `You must either edit files or set implementerDisagrees=true with a non-empty ` +
        `implementerDisagreementReason explaining why the requested change is technically invalid.`
      : "";

    const retrofitAdaptationSection = request.retrofitAdaptationContext
      ? buildRetrofitAdaptationInstruction(request.retrofitAdaptationContext)
      : '';
    const retrofitWorkflowRequired = isRetrofitWorkflowRequired({
      plan: request.plan,
      selectedShas: request.retrofitAdaptationContext?.sourceShas,
      allowedFiles: request.retrofitAdaptationContext?.allowedFiles,
      priorStatuses: request.revisionContext?.priorRetrofitSourceCommitStatuses,
    });
    const retrofitWorkflowSection = retrofitWorkflowRequired
      ? buildRetrofitWorkflowSection({
          workflowPrompt: await this.promptComposer.loadRetrofitWorkflowPrompt(),
          stage: "implementer",
          plan: request.plan,
          selectedShas: request.retrofitAdaptationContext?.sourceShas,
          allowedFiles: request.retrofitAdaptationContext?.allowedFiles,
          priorStatuses:
            request.revisionContext?.priorRetrofitSourceCommitStatuses,
        })
      : "";

    const basePrompt = await this.promptComposer.composePrompt("implementation", {
      jiraKey: request.jiraKey,
      repoName: request.repoName,
      branchName: request.branchName,
      baseCommitSha: request.baseCommitSha,
      implementationBranch: request.implementationBranch,
      workspacePath: request.workspacePath,
      ticketSummary: request.ticketSummary,
      planJson: JSON.stringify(request.plan, null, 2),
      traceSectionCJson: JSON.stringify(
        {
          sectionCUnitTestSpecs:
            request.trace?.testCases.filter(
              (testCase) => testCase.section === "C",
            ) ?? [],
          acceptanceCriteriaCoverage:
            request.trace?.acceptanceCriteriaCoverage ?? null,
        },
        null,
        2,
      ),
      mavenBuildsInstruction: buildMavenBuildsInstruction(mavenBuildsEnabled),
      revisionSection,
      retrofitWorkflowSection,
      retrofitAdaptationSection,
      modeDescription: isRevision ? "fix issues in" : "implement",
      modeInstruction: isRevision
        ? "Fix the identified issues now."
        : "Implement the plan now in the writable workspace.",
    });
    const sonarExtension = request.processingMode === "sonar_autofix"
      ? await this.promptComposer.loadSonarImplementationExtension()
      : undefined;
    const finalPrompt = [basePrompt, sonarExtension]
      .filter((section): section is string => !!section)
      .join("\n\n---\n\n");

    // Prompt size guard. The implementer prompt embeds the full plan JSON plus any revision
    // context (code review findings, test failures, prior session notes), so it naturally runs
    // larger than other stages. This cap catches runaway context before the Claude call turns
    // into a confusing API timeout or silent failure.
    const MAX_PROMPT_BYTES = 800_000;
    const promptBytes = Buffer.byteLength(finalPrompt, "utf8");
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new Error(
        `OneShot implementer prompt exceeds maximum size: ${promptBytes} bytes > ${MAX_PROMPT_BYTES} bytes. ` +
          `This usually indicates runaway context (oversized ticket, large repo scan, ballooned revision context). ` +
          `Reduce input size or increase MAX_PROMPT_BYTES in src/oneshot/providers/claude-implementer.ts.`,
      );
    }
    logger.debug(
      {
        jiraKey: request.jiraKey,
        stage: "implementer",
        promptBytes,
      },
      "[PROMPT_SIZE] Prompt size check passed",
    );

    const repoId = registerRepoFromPath(
      request.workspacePath,
      `oneshot-run-${request.jiraKey}-implementer`,
    );
    const resumeAttempted = !!request.resumeSessionId;
    const taskStartMs = Date.now();
    const implementerScratchPath = buildOneShotScratchPath(
      request.workspacePath,
      "implementer",
    );
    const implementerEnv = buildMavenScratchEnv(
      process.env,
      implementerScratchPath,
    );
    implementerEnv.ONESHOT_MAVEN_BUILDS_ENABLED = String(mavenBuildsEnabled);
    const buildAgentOptions = (useResume: boolean) => ({
      taskId: `oneshot-implementer-${request.jiraKey}-${taskStartMs}${useResume ? "-resume" : "-fresh"}`,
      sdkStage: "implementation",
      taskPrompt: finalPrompt,
      repoIds: [repoId],
      permissionLevel: "analysis" as const,
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Write",
        "Bash",
        "BashOutput",
      ],
      outputSchema: ONE_SHOT_IMPLEMENTATION_OUTPUT_SCHEMA,
      maxTurns: this.options.maxTurns ?? 180,
      maxBudgetUsd: 50,
      allowWrite: true,
      timeoutMs: 80 * 60 * 1000,
      // Implementer tool calls can legitimately run longer than planner
      // exploration, so use a looser idle watchdog while keeping the same
      // partial-stream visibility across Claude-backed stages.
      includePartialMessages: true,
      idleTimeoutMs: 5 * 60 * 1000,
      toolIdleTimeoutMs: 30 * 60 * 1000,
      compactionGraceMs: 120_000,
      resumeSessionId: useResume ? request.resumeSessionId : undefined,
      forkSessionOnResume: useResume ? request.forkSessionOnResume : undefined,
      claudeConfigDir: request.claudeConfigDir,
      env: implementerEnv,
      bedrockConfig: {
        model: this.options.modelId?.trim() || DEFAULT_MODEL_ID,
        ...(this.options.maxOutputTokens
          ? { maxOutputTokens: this.options.maxOutputTokens }
          : {}),
      },
    });

    let result: AgentResult = await runAgent(
      buildAgentOptions(resumeAttempted),
    );
    let resumeMode: ImplementerResumeMode = resumeAttempted
      ? "fork_resume"
      : "fresh";
    let resumeSucceeded = resumeAttempted && result.success;
    const resumeRetryReason = resumeAttempted
      ? classifyResumeFreshRetry(result)
      : null;

    if (resumeAttempted && !result.success && resumeRetryReason) {
      logger.warn(
        {
          jiraKey: request.jiraKey,
          repoName: request.repoName,
          resumedFromSessionId: request.resumeSessionId,
          retryReason: resumeRetryReason,
          failureKind: result.failureKind,
          toolCalls: result.metrics?.toolCalls ?? 0,
          hadSessionId: !!result.sessionId,
          error: result.error,
        },
        "Claude implementer resume unavailable; retrying once as a fresh session",
      );

      result = await runAgent(buildAgentOptions(false));
      resumeMode = "fork_resume_fallback_fresh";
      resumeSucceeded = false;
    }

    if (!result.success) {
      const failureKind = result.error?.startsWith("Turn limit exceeded")
        ? "turn_limit"
        : (result.failureKind ?? "other");
      throw new ImplementerStallError(
        result.error || "OneShot implementer failed",
        failureKind,
        result.metrics,
      );
    }

    const structuredImplementation = this.resolveImplementation(
      result.output,
      result.structuredOutput,
      request.jiraKey,
    );

    logger.info(
      {
        jiraKey: request.jiraKey,
        repoName: request.repoName,
        changedFiles: structuredImplementation.changedFiles.length,
        toolCalls: result.metrics.toolCalls,
        isRevision: !!request.revisionContext,
        sessionId: result.sessionId,
        resumedFromSessionId: request.resumeSessionId,
        resumeMode,
        resumeAttempted,
        resumeSucceeded,
      },
      "OneShot implementer completed",
    );

    return {
      implementation: structuredImplementation,
      rawOutput: result.output,
      sessionId: result.sessionId,
      resumedFromSessionId: request.resumeSessionId,
      resumeMode,
      resumeAttempted,
      resumeSucceeded,
      metrics: result.metrics,
    };
  }

  private resolveImplementation(
    output: string,
    structuredOutput: unknown,
    jiraKey: string,
  ): OneShotImplementerOutput {
    if (structuredOutput) {
      try {
        return parseOneShotImplementerOutput(structuredOutput);
      } catch (error) {
        logger.warn(
          {
            jiraKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "Implementer structured output failed validation; falling back to raw output scan",
        );
      }
    }

    return this.parseImplementationFromOutput(output);
  }

  private parseImplementationFromOutput(
    output: string,
  ): OneShotImplementerOutput {
    const { value } = parseValidatedJsonFromTextWithRepair(
      output,
      parseOneShotImplementerOutput,
    );
    return value;
  }
}
