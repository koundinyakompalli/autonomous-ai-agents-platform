/**
 * RIFT - Regression Investigation & Fix Tracker
 *
 * Analyzes upgrade-related defects by comparing code across two versions:
 * - Identifies missing retrofits (cherry-picks)
 * - Detects breaking enhancements
 * - Finds removed code
 * - Learns from incorrect analyses
 *
 * ## Lifecycle
 * 1. [RIFT_INIT] - Agent created with workspace configuration
 * 2. [RIFT_WORKSPACE_SETUP] - Dual-version workspace prepared
 * 3. [RIFT_ANALYZE_START] - Analysis begins
 * 4. [RIFT_ANALYZE_COMPLETE] - Analysis finishes
 * 5. [RIFT_LEARN] - Learn from feedback (if incorrect analysis)
 */

import {
  runAgent,
  type AgentResult,
  type ProgressUpdate,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/index.js";
import type { EventEmitter } from "events";
import {
  RIFTWorkspaceManager,
  type RIFTWorkspace,
} from "./RIFTWorkspaceManager.js";
import { RIFT_SYSTEM_PROMPT } from "./systemPrompt.js";
import { RIFT_OUTPUT_SCHEMA } from "./outputSchema.js";
import {
  ClientDatabaseService,
  type ClientEnvironment,
  type ClientDbCredentials,
  type QueryResult,
} from "./ClientDatabaseService.js";
import { promises as fs } from "fs";
import * as path from "path";

const logger = createLogger("rift-agent");

export interface RIFTAgentOptions {
  /** Task workspace path created by AgentWorker (branch-aware symlink workspace) */
  repositoryBasePath: string;

  /** Repository type / alias (e.g., 'core-app', 'medhok-monorepo') */
  repositoryType: string;

  /** Old version branch (e.g., 'release/3.13.8') */
  oldBranch: string;

  /** New version branch (e.g., 'release/4.0.2') */
  newBranch: string;

  /** Task ID for workspace isolation */
  taskId: number;

  /** Optional event emitter for monitoring */
  eventEmitter?: EventEmitter;

  /** Optional progress callback */
  onProgress?: (message: string) => void;

  /** Timeout in milliseconds (default: 30 minutes) */
  timeoutMs?: number;

  /** Webhook URL for audit events */
  webhookUrl?: string;

  /** Learn from incorrect analysis (JIRA ticket with feedback) */
  incorrectAnalysisFeedback?: string;

  /** JIRA attachments (screenshots, docs) with authenticated download URLs */
  jiraAttachments?: Array<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    localPath?: string; // If pre-downloaded
    description?: string; // Manual description if download fails
  }>;

  /** JIRA ticket key (e.g., 'CPSUP-41350') for reference in the analysis */
  jiraTicketKey?: string;

  /** Full JIRA ticket description (markdown) */
  jiraDescription?: string;

  /** ALL JIRA comments in chronological order */
  jiraComments?: Array<{
    author: string;
    created: string;
    body: string;
  }>;

  /** Linked JIRA tickets */
  jiraLinkedTickets?: Array<{
    key: string;
    summary: string;
    status: string;
    issueType: string;
    linkType: string; // e.g., "is caused by", "relates to", "blocks"
  }>;

  /** Client database access for validation queries (read-only, non-PROD only) */
  clientDb?: {
    /** Client name matching Secrets Manager path (e.g., 'BCBSNC', 'PerformRx') */
    client: string;
    /** Environment ID (e.g., 'INT', 'UAT', 'CONFIG') — PROD is blocked */
    envId: string;
    /** Division (default: 'CP') */
    division?: string;
    /** Pre-resolved credentials (skips Secrets Manager lookup) */
    credentials?: ClientDbCredentials;
  };

  /** Model to use (e.g., 'claude-opus-4', 'claude-sonnet-4') */
  model?: string;
}

export interface RIFTAnalysisResult {
  /** Whether analysis completed successfully */
  success: boolean;

  /** Full analysis text */
  analysis: string;

  /** Structured analysis data */
  structured?: {
    executive_summary?: {
      issue_description: string;
      repository_name: string;
      root_cause_simple: string;
      impact: string;
      fix_summary: string;
      estimated_fix_time?: string;
    };
    version_comparison?: {
      old_version: string;
      new_version: string;
      repository_type: string;
      configuration_same?: boolean;
    };
    top_root_causes?: Array<{
      rank: number;
      classification: string;
      confidence: number;
      summary: string;
      commit?: {
        hash: string;
        author: string;
        date: string;
        message: string;
        jira_ticket?: string;
      };
      code_diff?: {
        file_path: string;
        old_version_code: string;
        new_version_code: string;
        line_numbers_old?: { start: number; end: number };
        line_numbers_new?: { start: number; end: number };
        diff_summary?: string;
      };
      explanation: {
        how_it_works_in_old: string;
        why_it_fails_in_new: string;
        evidence: string;
        validation_performed?: string;
      };
      fix_recommendation: {
        approach: string;
        commands?: string[];
        patch?: string;
        testing_notes?: string;
      };
    }>;
    additional_missing_retrofits?: Array<{
      file_path: string;
      commit_hash: string;
      commit_message?: string;
      author?: string;
      date?: string;
      jira_ticket?: string;
      risk_level: string;
      description: string;
    }>;
    git_analysis?: {
      commits_in_old_not_in_new?: number;
      commits_in_new_not_in_old?: number;
      files_analyzed?: string[];
      validation_checks_performed?: string[];
    };
    testing_recommendations?: string[];
  };

  /** Analysis metrics */
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
  };

  /** Workspace information */
  workspace?: RIFTWorkspace;

  /** Error if failed */
  error?: string;
}

/**
 * RIFT Agent - Regression Investigation & Fix Tracker
 *
 * Analyzes upgrade defects by comparing code across two versions.
 *
 * @example
 * ```typescript
 * const agent = new RIFTAgent({
 *   repositoryBasePath: '/mnt/efs/specter-repo/repositories/tasks/task-12345',
 *   repositoryType: 'core-app',
 *   oldBranch: 'release/3.13.8',
 *   newBranch: 'release/4.0.2',
 *   taskId: 12345,
 * });
 *
 * const result = await agent.analyzeUpgrade('Claims fail with Invalid provider ID');
 * console.log(result.structured?.top_root_causes?.[0]?.summary);
 * ```
 */
export class RIFTAgent {
  private options: RIFTAgentOptions;
  private instanceId: string;
  private workspaceManager: RIFTWorkspaceManager;
  private workspace?: RIFTWorkspace;
  private learningMemoryPath: string;
  private clientDbService?: ClientDatabaseService;

  constructor(options: RIFTAgentOptions) {
    this.instanceId = `rift-${Date.now()}`;
    this.workspaceManager = new RIFTWorkspaceManager();

    this.options = {
      timeoutMs: 30 * 60 * 1000, // 30 minutes default
      ...options,
    };

    // Learning memory path: stores feedback from incorrect analyses
    this.learningMemoryPath = path.join(
      path.dirname(options.repositoryBasePath),
      "rift-learning-memory",
      "incorrect_analyses.jsonl",
    );

    const logContext = {
      instanceId: this.instanceId,
      taskId: options.taskId,
      repositoryType: options.repositoryType,
      oldBranch: options.oldBranch,
      newBranch: options.newBranch,
      timeoutMs: this.options.timeoutMs,
    };

    if (options.clientDb) {
      this.clientDbService = new ClientDatabaseService();
      logger.info(
        {
          ...logContext,
          clientDbClient: options.clientDb.client,
          clientDbEnv: options.clientDb.envId,
        },
        "[RIFT_INIT] Client database access enabled",
      );
    }

    logger.debug(logContext, "[RIFT_INIT] Creating RIFTAgent instance");
    logger.info(
      logContext,
      "[RIFT_AGENT_CREATED] RIFTAgent instance created successfully",
    );
  }

  /**
   * Analyze an upgrade defect
   *
   * @param defectDescription - Description of the defect to analyze
   * @param additionalContext - Optional additional context (stack traces, logs, etc.)
   * @returns Upgrade defect analysis result
   */
  async analyzeUpgrade(
    defectDescription: string,
    additionalContext?: string,
  ): Promise<RIFTAnalysisResult> {
    const taskId = `${this.instanceId}-${Date.now()}`;
    const startTime = Date.now();

    const logContext = {
      instanceId: this.instanceId,
      taskId,
      riftTaskId: this.options.taskId,
      repositoryType: this.options.repositoryType,
      oldBranch: this.options.oldBranch,
      newBranch: this.options.newBranch,
    };

    logger.info(
      {
        ...logContext,
        defectDescriptionLength: defectDescription.length,
        hasAdditionalContext: !!additionalContext,
        additionalContextLength: additionalContext?.length ?? 0,
      },
      "[RIFT_ANALYZE_START] Starting upgrade defect analysis",
    );

    try {
      // Step 1: Setup dual-version workspace
      logger.info(
        logContext,
        "[RIFT_WORKSPACE_SETUP_START] Setting up dual-version workspace",
      );

      this.workspace = await this.workspaceManager.setupWorkspace({
        taskId: this.options.taskId,
        repositoryBasePath: this.options.repositoryBasePath,
        repositoryType: this.options.repositoryType,
        oldBranch: this.options.oldBranch,
        newBranch: this.options.newBranch,
      });

      logger.info(
        {
          ...logContext,
          workspaceRoot: this.workspace.workspaceRoot,
          oldRepoId: this.workspace.oldVersion.repoId,
          newRepoId: this.workspace.newVersion.repoId,
        },
        "[RIFT_WORKSPACE_SETUP_COMPLETE] Dual-version workspace ready",
      );

      // Verify workspace
      const isValid = await this.workspaceManager.verifyWorkspace(
        this.workspace,
      );
      if (!isValid) {
        throw new Error("Workspace verification failed");
      }

      // Step 2: Load learning memory (past incorrect analyses)
      const learningContext = await this.loadLearningMemory();

      // Step 3: Build enhanced system prompt with learning context
      const enhancedSystemPrompt = this.buildSystemPrompt(learningContext);

      // Step 4: Build analysis context
      const analysisContext = this.buildAnalysisContext(
        defectDescription,
        additionalContext,
        this.workspace,
      );

      // Step 5: Run agent analysis
      logger.info(logContext, "[RIFT_ANALYSIS_START] Starting Claude analysis");

      // Build progress handler
      let progressCount = 0;
      const onProgress = (update: ProgressUpdate) => {
        progressCount++;

        if (this.options.onProgress) {
          const message = update.toolName
            ? `Using tool: ${update.toolName}`
            : (update.message ?? `Agent working... (${update.elapsed}ms)`);
          this.options.onProgress(message);
        }

        if (this.options.eventEmitter) {
          this.options.eventEmitter.emit("agent:progress", update);
        }

        if (update.toolName) {
          logger.debug(
            {
              ...logContext,
              toolName: update.toolName,
              progressCount,
              elapsed: update.elapsed,
            },
            "[RIFT_TOOL_USE] Agent using tool",
          );
        }
      };

      // Run agent with a workspace root as cwd, plus explicit old/new worktree
      // directories available to Claude under ./old and ./new.
      const result = await runAgent({
        taskId,
        taskPrompt: analysisContext,
        repoIds: [
          this.workspace.workspaceId,
          this.workspace.oldVersion.repoId,
          this.workspace.newVersion.repoId,
        ],
        agentType: "rift",
        systemAppend: enhancedSystemPrompt,
        additionalContext,
        permissionLevel: "analysis",
        webhookUrl: this.options.webhookUrl,
        timeoutMs: this.options.timeoutMs,
        onProgress,
        outputSchema: RIFT_OUTPUT_SCHEMA,
        bedrockConfig: {
          // Use Opus 4.6 by default for better analysis quality
          // Must use inference profile format: us.anthropic.claude-opus-4-6-v1
          model: this.options.model || "us.anthropic.claude-opus-4-6-v1",
          region: process.env.AWS_REGION || "us-east-1",
        },
      });

      const durationMs = Date.now() - startTime;
      const mappedResult = this.mapResult(result, durationMs);

      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            progressUpdates: progressCount,
            hasStructuredOutput: !!mappedResult.structured,
            analysisLength: mappedResult.analysis.length,
            topRootCausesCount:
              mappedResult.structured?.top_root_causes?.length ?? 0,
            confidence:
              mappedResult.structured?.top_root_causes?.[0]?.confidence,
          },
          "[RIFT_ANALYZE_SUCCESS] Upgrade defect analysis completed successfully",
        );
      } else {
        logger.warn(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[RIFT_ANALYZE_FAILED] Upgrade defect analysis failed",
        );
      }

      return mappedResult;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        {
          ...logContext,
          durationMs,
          errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "[RIFT_ANALYZE_ERROR] Exception during upgrade defect analysis",
      );

      return {
        success: false,
        analysis: "",
        metrics: {
          durationMs,
          toolCalls: 0,
        },
        workspace: this.workspace,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a read-only query against the client's lower environment database.
   * Only available when clientDb is configured. PROD environments are blocked.
   *
   * @param sql - SELECT query to execute
   * @param params - Optional parameterized query values
   * @returns Query result with rows, timing, and error info
   */
  async queryClientDb(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.clientDbService || !this.options.clientDb) {
      return {
        success: false,
        rows: [],
        rowCount: 0,
        truncated: false,
        executionTimeMs: 0,
        error: "Client database access not configured for this RIFT analysis.",
      };
    }

    const env: ClientEnvironment = {
      client: this.options.clientDb.client,
      envId: this.options.clientDb.envId,
      division: this.options.clientDb.division,
    };

    return this.clientDbService.query(
      env,
      sql,
      params,
      this.options.clientDb.credentials,
    );
  }

  /**
   * Learn from incorrect analysis
   * Called when JIRA ticket has label 'incorrect_rift_analysis'
   */
  async learnFromMistake(
    originalDefect: string,
    incorrectAnalysis: string,
    correctRootCause: string,
    feedback: string,
  ): Promise<void> {
    const logContext = {
      instanceId: this.instanceId,
      taskId: this.options.taskId,
    };

    logger.info(logContext, "[RIFT_LEARN] Learning from incorrect analysis");

    const learningEntry = {
      timestamp: new Date().toISOString(),
      taskId: this.options.taskId,
      repositoryType: this.options.repositoryType,
      oldBranch: this.options.oldBranch,
      newBranch: this.options.newBranch,
      originalDefect,
      incorrectAnalysis,
      correctRootCause,
      feedback,
      lesson: this.extractLesson(incorrectAnalysis, correctRootCause, feedback),
    };

    // Ensure learning memory directory exists
    await fs.mkdir(path.dirname(this.learningMemoryPath), { recursive: true });

    // Append to learning memory (JSONL format)
    const learningLine = JSON.stringify(learningEntry) + "\n";
    await fs.appendFile(this.learningMemoryPath, learningLine, "utf-8");

    logger.info(
      {
        ...logContext,
        learningMemoryPath: this.learningMemoryPath,
      },
      "[RIFT_LEARN_COMPLETE] Learning entry added to memory",
    );
  }

  /**
   * Cleanup workspace and database connections after analysis
   */
  async cleanup(): Promise<void> {
    if (this.workspace) {
      const logContext = {
        instanceId: this.instanceId,
        taskId: this.options.taskId,
        workspaceRoot: this.workspace.workspaceRoot,
      };

      logger.info(logContext, "[RIFT_CLEANUP] Cleaning up workspace");

      await this.workspaceManager.cleanupWorkspace(this.workspace);

      logger.info(
        logContext,
        "[RIFT_CLEANUP_COMPLETE] Workspace cleanup complete",
      );
    }

    if (this.clientDbService) {
      await this.clientDbService.close();
      logger.info(
        { instanceId: this.instanceId },
        "[RIFT_CLEANUP] Client DB connections closed",
      );
    }
  }

  /**
   * Load learning memory from past incorrect analyses
   */
  private async loadLearningMemory(): Promise<string> {
    const logContext = {
      instanceId: this.instanceId,
      learningMemoryPath: this.learningMemoryPath,
    };

    try {
      // Check if learning memory file exists
      await fs.access(this.learningMemoryPath);

      const content = await fs.readFile(this.learningMemoryPath, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);

      logger.info(
        {
          ...logContext,
          learningEntriesCount: lines.length,
        },
        "[RIFT_LEARNING_LOADED] Learning memory loaded",
      );

      if (lines.length === 0) {
        return "";
      }

      // Parse and format learning entries for the agent
      const entries = lines.map((line) => JSON.parse(line));
      const formattedLearning = this.formatLearningContext(entries);

      return formattedLearning;
    } catch (error) {
      // Learning memory doesn't exist or is empty
      logger.debug(
        {
          ...logContext,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "[RIFT_LEARNING_EMPTY] No learning memory found",
      );

      return "";
    }
  }

  /**
   * Format learning context for the agent
   */
  private formatLearningContext(entries: any[]): string {
    if (entries.length === 0) {
      return "";
    }

    let context = "\n\n## LEARNING FROM PAST MISTAKES\n\n";
    context +=
      "RIFT has analyzed similar defects before and received feedback. Learn from these past analyses:\n\n";

    entries.forEach((entry, index) => {
      context += `### Past Analysis #${index + 1}\n`;
      context += `**Repository**: ${entry.repositoryType}\n`;
      context += `**Branches**: ${entry.oldBranch} → ${entry.newBranch}\n`;
      context += `**Original Defect**: ${entry.originalDefect.substring(0, 200)}...\n`;
      context += `**Incorrect Analysis**: ${entry.incorrectAnalysis.substring(0, 300)}...\n`;
      context += `**Correct Root Cause**: ${entry.correctRootCause}\n`;
      context += `**Feedback**: ${entry.feedback}\n`;
      context += `**Lesson Learned**: ${entry.lesson}\n\n`;
    });

    context +=
      "**IMPORTANT**: Apply these lessons to avoid repeating the same mistakes.\n\n";

    return context;
  }

  /**
   * Extract lesson from incorrect analysis
   */
  private extractLesson(
    incorrectAnalysis: string,
    correctRootCause: string,
    feedback: string,
  ): string {
    // Simple lesson extraction - can be enhanced with LLM in future
    let lesson = "";

    if (feedback.toLowerCase().includes("same code different commit")) {
      lesson =
        "ALWAYS double-check that code content is actually different, not just commit hashes. Same code with different commits is NOT a root cause.";
    } else if (feedback.toLowerCase().includes("not validated")) {
      lesson =
        "ALWAYS validate that the identified commit actually causes the reported defect. Check that the code difference directly affects the broken functionality.";
    } else if (feedback.toLowerCase().includes("missed the actual")) {
      lesson =
        "ALWAYS search comprehensively for all related files and commits. The root cause might be in a different but related file.";
    } else {
      lesson = `Feedback: ${feedback}. Correct root cause was: ${correctRootCause}`;
    }

    return lesson;
  }

  /**
   * Build enhanced system prompt with learning context
   */
  private buildSystemPrompt(learningContext: string): string {
    return RIFT_SYSTEM_PROMPT + learningContext;
  }

  /**
   * Build analysis context for the agent
   */
  private buildAnalysisContext(
    defectDescription: string,
    additionalContext: string | undefined,
    workspace: RIFTWorkspace,
  ): string {
    let context = `# Upgrade Defect Analysis Request

${this.options.jiraTicketKey ? `## JIRA Ticket: ${this.options.jiraTicketKey}\n` : ""}

## Repository Information
- **Repository Type**: ${workspace.repositoryType}
- **Old Version (Working)**: ${workspace.oldVersion.branch}
- **New Version (Broken)**: ${workspace.newVersion.branch}
- **Configuration**: SAME in both versions

## Workspace Layout
- The current working directory is a scratch workspace for this analysis.
- The **OLD** version is available under \`./old\`
- The **NEW** version is available under \`./new\`
- Use relative filesystem paths like \`old/path/to/File.java\` and \`new/path/to/File.java\`
  when using Read, Glob, and Grep.

## Git Commands
IMPORTANT: All git commands MUST be run from the \`new/\` worktree:
\`\`\`bash
cd new
# Then run your git commands
git diff ${workspace.oldVersion.branch}..${workspace.newVersion.branch} -- path/to/file
git log ${workspace.oldVersion.branch}..${workspace.newVersion.branch} -- path/to/file
\`\`\`

## Defect Description

${defectDescription}

${this.options.jiraDescription ? `\n## JIRA Full Description\n\n${this.options.jiraDescription}\n` : ""}

${this.buildCommentsSection()}

${this.buildLinkedTicketsSection()}

${additionalContext ? `\n## Additional Context\n\n${additionalContext}\n` : ""}

${this.buildAttachmentsSection()}

${this.buildClientDbSection()}

## Your Task

**MANDATORY PRE-FLIGHT — DO NOT SKIP:**

Before touching any code, you MUST complete the following Jira-context review in order. The orchestrator has already fetched every available artifact; if a section above is empty, that is itself a signal and you must note it as an information gap. Do NOT assume hidden Jira context exists beyond what is provided.

1. **Read the full Jira description** above and restate, in one sentence, what the reporter claims is broken.
2. **Read every comment** (all of them — not just the most recent). Extract: reproduction steps, affected clients/members, environment, branches/versions, prior investigation notes, and any commit/PR references.
3. **Inspect every attachment**: for images, use the Read tool on the provided \`localPath\`; for text/log/PDF files, open them with Read; for any video, acknowledge the soft-warning — content is unavailable without transcription.
4. **Traverse linked tickets**: for each row in the Linked Tickets table, note why it is relevant (is it the deploy ticket, the retrofit ticket, a duplicate, a related defect, a fix ticket?).
5. **Synthesize** the above into: (a) the precise symptom, (b) the suspected affected subsystem/files, (c) the expected vs actual behaviour, (d) any explicit hypotheses the reporter/commenters already offered.

Only after the pre-flight is complete may you begin code analysis. Then:

6. Identify the EXACT root cause of why this defect occurs in ${workspace.newVersion.branch} but NOT in ${workspace.oldVersion.branch}.
7. Provide TOP 3 root causes ranked by confidence.
8. For the top root cause, validate with a double-check (same code different commits is NOT a root cause).
9. Search for additional missing retrofits in the impacted files.
10. Provide both a non-technical summary and a detailed technical analysis.

Your final output MUST include a "Jira Context Review" section demonstrating you performed steps 1–5. Analyses that skip the pre-flight will be treated as incorrect and fed back into RIFT's learning memory.
`;

    return context;
  }

  /**
   * Build JIRA attachments section for analysis context
   */
  private buildAttachmentsSection(): string {
    if (
      !this.options.jiraAttachments ||
      this.options.jiraAttachments.length === 0
    ) {
      return "";
    }

    let section = "\n## JIRA Attachments (Screenshots & Documents)\n\n";
    section +=
      "**IMPORTANT**: The following attachments provide visual evidence. Review them BEFORE starting code analysis.\n\n";

    for (const attachment of this.options.jiraAttachments) {
      section += `### ${attachment.filename}\n`;
      section += `- **Type**: ${attachment.mimeType}\n`;
      section += `- **Size**: ${(attachment.size / 1024).toFixed(2)} KB\n`;

      if (attachment.localPath) {
        section += `- **Local Path**: \`${attachment.localPath}\` (use Read tool to view)\n`;
      } else if (attachment.description) {
        section += `- **Description**: ${attachment.description}\n`;
      } else {
        section += `- **Note**: Attachment download failed. Request user to describe screenshot contents.\n`;
      }

      section += "\n";
    }

    return section;
  }

  /**
   * Build JIRA comments section for analysis context
   */
  private buildCommentsSection(): string {
    if (!this.options.jiraComments || this.options.jiraComments.length === 0) {
      return "";
    }

    let section = "\n## JIRA Comments (ALL — Read Every One)\n\n";
    section +=
      "**CRITICAL: Comments contain version numbers, branch names, developer notes, and investigation context. Read ALL of them.**\n\n";

    for (const comment of this.options.jiraComments) {
      section += `### Comment by ${comment.author} (${comment.created})\n\n`;
      section += `${comment.body}\n\n---\n\n`;
    }

    return section;
  }

  /**
   * Build linked tickets section for analysis context
   */
  private buildLinkedTicketsSection(): string {
    if (
      !this.options.jiraLinkedTickets ||
      this.options.jiraLinkedTickets.length === 0
    ) {
      return "";
    }

    let section = "\n## Linked JIRA Tickets\n\n";
    section += "| Ticket | Type | Link Relation | Summary | Status |\n";
    section += "|--------|------|---------------|---------|--------|\n";

    for (const ticket of this.options.jiraLinkedTickets) {
      section += `| ${ticket.key} | ${ticket.issueType} | ${ticket.linkType} | ${ticket.summary} | ${ticket.status} |\n`;
    }

    section +=
      "\n**Action:** Check linked CPDEV tickets for commit hashes, PR links, and fix details.\n\n";

    return section;
  }

  /**
   * Build client database access section for analysis context
   */
  private buildClientDbSection(): string {
    if (!this.options.clientDb) {
      return "";
    }

    const hasResolvedCredentials = !!this.options.clientDb.credentials;

    return `
## Client Database Access (Read-Only)

You have ${hasResolvedCredentials ? "**read-only**" : "**potential**"} access to the client's **${this.options.clientDb.envId}** environment database.

- **Client**: ${this.options.clientDb.client}
- **Environment**: ${this.options.clientDb.envId} (non-production)
- **Database**: medhok

${
  hasResolvedCredentials
    ? "**How to use**: Call the `queryClientDb` function with a SELECT query to validate root cause hypotheses against live data."
    : "**Note**: This run does not include resolved database credentials. Treat DB validation as unavailable unless the caller provides credentials explicitly."
}

**Rules**:
- Only SELECT, SHOW, DESCRIBE, EXPLAIN statements are allowed
- Results are limited to 500 rows
- 30-second query timeout
- Use parameterized queries for user-supplied values

**Example validation queries**:
\`\`\`sql
-- Verify a der_restrictions record exists with specific exclude value
SELECT id, der_request_type_id, company_type_id, exclude FROM der_restrictions WHERE id = 428

-- Check system variable configuration
SELECT * FROM system_variables WHERE name LIKE '%SORT%'

-- Verify epa_config for a company
SELECT * FROM epa_config WHERE company_id = 2

-- Check if a table/column exists
SHOW COLUMNS FROM der_restrictions LIKE 'exclude'

-- Verify Hibernate mapping matches actual schema
DESCRIBE medical_drug_request
\`\`\`

**When to use**: After identifying a suspected root cause in code, query the database to confirm your hypothesis with actual data. This turns speculation into evidence.
`;
  }

  /**
   * Map AgentResult to RIFTAnalysisResult
   */
  private mapResult(
    result: AgentResult,
    durationMs: number,
  ): RIFTAnalysisResult {
    return {
      success: result.success,
      analysis: result.output,
      structured: result.structuredOutput as RIFTAnalysisResult["structured"],
      metrics: {
        durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.costUsd,
      },
      workspace: this.workspace,
      error: result.error,
    };
  }
}

export default RIFTAgent;
