/**
 * RIFTWorker - Polls for upgrade defect analysis tasks
 *
 * Monitors database for RIFT tasks, executes analysis, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up task context
 * 3. process() (this file) creates RIFTAgent and runs analysis
 * 4. Agent uses Claude CLI with Bedrock for LLM inference
 * 5. Results uploaded to S3, status updated in database
 * 6. If task has 'incorrect_rift_analysis' label, agent learns from feedback
 */

import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import { RIFTAgent, type RIFTAnalysisResult } from "../../agents/rift/index.js";
import {
  adfToMarkdown,
  type JiraAttachment,
  type JiraComment,
  type JiraIssue,
} from "../JiraClient.js";
import { createLogger } from "../../utils/logger.js";
import { promises as fs } from "fs";
import * as path from "path";
import type { EventEmitter } from "events";

const logger = createLogger("rift-worker");

const JIRA_BASE_URL =
  process.env.JIRA_BASE_URL ?? "https://mhkjira.atlassian.net";
const RIFT_CONFIG_REGEX = /RIFT_CONFIG:\s*([\s\S]*?)(?:\n\s*\n|\n---|$)/;

// Attachments up to this size are saved to disk and exposed to the agent
// via localPath. Larger files get a metadata-only description entry.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const VIDEO_MIME_PREFIX = "video/";
const IMAGE_MIME_PREFIX = "image/";

type JiraAttachmentInput = NonNullable<
  ConstructorParameters<typeof RIFTAgent>[0]["jiraAttachments"]
>[number];

type JiraCommentInput = NonNullable<
  ConstructorParameters<typeof RIFTAgent>[0]["jiraComments"]
>[number];

type JiraLinkedTicketInput = NonNullable<
  ConstructorParameters<typeof RIFTAgent>[0]["jiraLinkedTickets"]
>[number];

interface JiraContextBundle {
  ticketKey: string;
  summary?: string;
  descriptionMarkdown: string;
  comments: JiraCommentInput[];
  attachments: JiraAttachmentInput[];
  linkedTickets: JiraLinkedTicketInput[];
  videoWarnings: string[];
}

/**
 * RIFT Worker - Regression Investigation & Fix Tracker
 */
export class RIFTWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "RIFT",
      repositoryPath,
      pollingIntervalMs: 10000, // 10 seconds
      batchSize: 1,
      enableStatusServer,
    });

    logger.info(
      {
        repositoryPath,
        enableStatusServer,
        pollingIntervalMs: 10000,
      },
      "[RIFT_WORKER_INIT] RIFTWorker initialized",
    );
  }

  /**
   * Process upgrade defect analysis task
   *
   * Called by AgentWorker.processTask() after task is retrieved from database.
   * This is the agent-specific implementation that creates and runs RIFT.
   */
  protected async process(
    jiraNumber: string,
    taskId: number,
    taskDescription: string,
    additionalContext: string,
    repositoryPath: string,
    eventEmitter?: EventEmitter,
  ): Promise<ProcessResult> {
    const startTime = Date.now();

    // Parse task metadata from additional_context or, if absent, from the
    // Jira comments on the ticket. The LLM-generated task description can
    // paraphrase the block away, so we pull it verbatim from Jira as a
    // fallback. Expected format:
    //   RIFT_CONFIG:
    //   old_branch: release/3.13.8
    //   new_branch: release/4.0.2
    //   repository_type: core-app
    //   analysis_mode: code_upgrade
    let taskConfig = this.parseTaskConfig(additionalContext);

    if (!taskConfig) {
      logger.info(
        { jira: jiraNumber, taskId },
        "[RIFT_CONFIG_JIRA_FETCH] RIFT_CONFIG missing from context; fetching from Jira comments",
      );
      const configBlock =
        await this.fetchRiftConfigFromJiraComments(jiraNumber);
      if (configBlock) {
        taskConfig = this.parseTaskConfig(configBlock);
      }
    }

    if (!taskConfig) {
      logger.error(
        {
          jira: jiraNumber,
          taskId,
        },
        "[RIFT_PROCESS_ERROR] Failed to parse task configuration",
      );

      return {
        success: false,
        output: "",
        error:
          "Invalid task configuration. Expected RIFT_CONFIG with old_branch, new_branch, and repository_type. Add a Jira comment starting with 'RIFT_CONFIG:' on the ticket.",
        metrics: {
          durationMs: Date.now() - startTime,
        },
      };
    }

    const logContext = {
      jira: jiraNumber,
      taskId,
      repositoryType: taskConfig.repositoryType,
      oldBranch: taskConfig.oldBranch,
      newBranch: taskConfig.newBranch,
      analysisMode: taskConfig.analysisMode,
      correlationId: `rift-${taskId}-${jiraNumber}`,
    };

    logger.info(
      logContext,
      "[RIFT_PROCESS_START] Starting upgrade defect analysis",
    );
    logger.debug(
      {
        ...logContext,
        taskDescriptionLength: taskDescription.length,
        additionalContextLength: additionalContext.length,
        hasEventEmitter: !!eventEmitter,
      },
      "[RIFT_PROCESS_CONTEXT] Task context details",
    );

    // MANDATORY: fetch the full Jira context (description, comments,
    // attachments, linked tickets) before we touch any code. Learning tasks
    // are exempt because they operate on feedback text, not a live ticket.
    let jiraContext: JiraContextBundle | null = null;
    if (!taskConfig.isLearningTask) {
      try {
        jiraContext = await this.fetchJiraContext(
          jiraNumber,
          repositoryPath,
          taskId,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          { ...logContext, error: errorMessage },
          "[RIFT_JIRA_CONTEXT_FAILED] Unable to fetch mandatory Jira context; aborting analysis",
        );
        return {
          success: false,
          output: "",
          error: `RIFT requires full Jira context before analysis. Failed to fetch ticket data: ${errorMessage}`,
          metrics: { durationMs: Date.now() - startTime },
        };
      }

      logger.info(
        {
          ...logContext,
          descriptionLength: jiraContext.descriptionMarkdown.length,
          commentCount: jiraContext.comments.length,
          attachmentCount: jiraContext.attachments.length,
          linkedTicketCount: jiraContext.linkedTickets.length,
          videoWarnings: jiraContext.videoWarnings.length,
        },
        "[RIFT_JIRA_CONTEXT_READY] Full Jira context loaded",
      );
    }

    let agent: RIFTAgent | undefined;

    try {
      // Stage 1: Create RIFT agent with dual-version workspace
      logger.info(
        logContext,
        "[RIFT_AGENT_CREATE] Creating RIFTAgent instance",
      );

      agent = new RIFTAgent({
        repositoryBasePath: repositoryPath,
        repositoryType: taskConfig.repositoryType,
        oldBranch: taskConfig.oldBranch,
        newBranch: taskConfig.newBranch,
        taskId,
        jiraTicketKey: jiraNumber,
        jiraDescription: jiraContext?.descriptionMarkdown,
        jiraComments: jiraContext?.comments,
        jiraAttachments: jiraContext?.attachments,
        jiraLinkedTickets: jiraContext?.linkedTickets,
        onProgress: (msg) => {
          logger.debug(
            {
              ...logContext,
              progressMessage: msg,
            },
            "[RIFT_PROGRESS] Agent progress update",
          );
        },
        eventEmitter,
      });

      logger.info(
        logContext,
        "[RIFT_AGENT_CREATED] RIFTAgent instance created successfully",
      );

      // Stage 2: Check if this is a learning task (incorrect analysis feedback)
      if (taskConfig.isLearningTask) {
        logger.info(logContext, "[RIFT_LEARNING] Processing learning task");

        await agent.learnFromMistake(
          taskDescription,
          taskConfig.incorrectAnalysis || "",
          taskConfig.correctRootCause || "",
          taskConfig.feedback || "",
        );

        return {
          success: true,
          output: "RIFT learned from the incorrect analysis feedback.",
          metrics: {
            durationMs: Date.now() - startTime,
          },
        };
      }

      // Stage 3: Run analysis
      logger.info(logContext, "[RIFT_ANALYSIS_START] Starting Claude analysis");
      const result = await agent.analyzeUpgrade(
        taskDescription,
        this.cleanAdditionalContext(additionalContext),
      );

      const durationMs = Date.now() - startTime;

      // Stage 4: Cleanup workspace
      logger.info(logContext, "[RIFT_CLEANUP_START] Cleaning up workspace");
      await agent.cleanup();
      logger.info(
        logContext,
        "[RIFT_CLEANUP_COMPLETE] Workspace cleanup complete",
      );

      // Stage 5: Process results
      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            tokensUsed: result.metrics.tokensUsed,
            costUsd: result.metrics.costUsd,
            hasStructuredOutput: !!result.structured,
            topRootCausesCount: result.structured?.top_root_causes?.length ?? 0,
            topConfidence: result.structured?.top_root_causes?.[0]?.confidence,
          },
          "[RIFT_ANALYSIS_SUCCESS] Analysis completed successfully",
        );

        const output = this.formatOutput(jiraNumber, result, taskConfig);

        // Use actual cost from SDK if available, otherwise estimate
        const actualCost =
          result.metrics.costUsd ??
          this.estimateCost(result.metrics.tokensUsed);

        return {
          success: true,
          output,
          metrics: {
            totalTokens: result.metrics.tokensUsed,
            iterations: result.metrics.toolCalls,
            cost: actualCost,
            durationMs,
          },
        };
      } else {
        logger.error(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[RIFT_ANALYSIS_FAILED] Analysis failed",
        );

        return {
          success: false,
          output: "",
          error: result.error || "Unknown error",
          metrics: {
            durationMs,
          },
        };
      }
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      logger.error(
        {
          ...logContext,
          durationMs,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
        },
        "[RIFT_PROCESS_ERROR] Unhandled error in RIFT analysis",
      );

      // Attempt cleanup even on error
      if (agent) {
        try {
          await agent.cleanup();
        } catch (cleanupError) {
          logger.error(
            {
              ...logContext,
              cleanupError:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : "Unknown",
            },
            "[RIFT_CLEANUP_ERROR] Failed to cleanup workspace after error",
          );
        }
      }

      return {
        success: false,
        output: "",
        error: error.message,
        metrics: {
          durationMs,
        },
      };
    }
  }

  /**
   * Parse task configuration from additionalContext
   */
  private parseTaskConfig(additionalContext: string): {
    oldBranch: string;
    newBranch: string;
    repositoryType: string;
    analysisMode: string;
    isLearningTask?: boolean;
    incorrectAnalysis?: string;
    correctRootCause?: string;
    feedback?: string;
  } | null {
    const logContext = { method: "parseTaskConfig" };

    try {
      // Look for RIFT_CONFIG block
      const configMatch = additionalContext.match(RIFT_CONFIG_REGEX);

      if (!configMatch) {
        logger.error(
          logContext,
          "[RIFT_CONFIG_PARSE_ERROR] RIFT_CONFIG block not found",
        );
        return null;
      }

      const configBlock = configMatch[1];
      const config: any = {};

      // Parse key-value pairs
      const lines = configBlock.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const colonIndex = trimmed.indexOf(":");
        if (colonIndex === -1) continue;

        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        config[key] = value;
      }

      // Validate required fields for code upgrade analysis
      if (!config.old_branch || !config.new_branch || !config.repository_type) {
        logger.error(
          {
            ...logContext,
            config,
          },
          "[RIFT_CONFIG_PARSE_ERROR] Missing required fields",
        );
        return null;
      }

      // Check if this is a learning task
      const isLearningTask =
        config.analysis_mode === "learning" || config.learning === "true";

      logger.info(
        {
          ...logContext,
          oldBranch: config.old_branch,
          newBranch: config.new_branch,
          repositoryType: config.repository_type,
          analysisMode: config.analysis_mode || "code_upgrade",
          isLearningTask,
        },
        "[RIFT_CONFIG_PARSED] Task configuration parsed successfully",
      );

      return {
        oldBranch: config.old_branch,
        newBranch: config.new_branch,
        repositoryType: config.repository_type,
        analysisMode: config.analysis_mode || "code_upgrade",
        isLearningTask,
        incorrectAnalysis: config.incorrect_analysis,
        correctRootCause: config.correct_root_cause,
        feedback: config.feedback,
      };
    } catch (error) {
      logger.error(
        {
          ...logContext,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "[RIFT_CONFIG_PARSE_ERROR] Failed to parse task configuration",
      );
      return null;
    }
  }

  /**
   * Clean additional context (remove RIFT_CONFIG block)
   */
  private cleanAdditionalContext(additionalContext: string): string {
    return additionalContext.replace(RIFT_CONFIG_REGEX, "").trim();
  }

  /**
   * Fetch the RIFT_CONFIG block verbatim from Jira comments.
   *
   * Reporters post the config as a comment on the ticket; the orchestrator's
   * TaskDescriptionGenerator summarises comments through an LLM and can drop
   * or paraphrase the block, so we read the raw REST v3 comment bodies here.
   * Returns the whole "RIFT_CONFIG:\n..." substring (including the label) so
   * the caller can feed it through parseTaskConfig unchanged. Uses the most
   * recent matching comment so a reposted config can override an earlier one.
   */
  private async fetchRiftConfigFromJiraComments(
    jiraNumber: string,
  ): Promise<string | null> {
    const token = this.agentJiraToken;
    const username = this.agentJiraUsername;
    if (!token || !username) {
      logger.error(
        { jira: jiraNumber },
        "[RIFT_CONFIG_JIRA_FETCH_ERROR] Missing Jira credentials on RIFT agent",
      );
      return null;
    }

    const auth = Buffer.from(`${username}:${token}`).toString("base64");
    const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(jiraNumber)}/comment?orderBy=-created&maxResults=100`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => "Unable to read error response");
        logger.error(
          {
            jira: jiraNumber,
            status: response.status,
            statusText: response.statusText,
            errorBody: errorText.substring(0, 500),
          },
          "[RIFT_CONFIG_JIRA_FETCH_ERROR] Failed to fetch Jira comments",
        );
        return null;
      }

      const payload = (await response.json()) as { comments?: JiraComment[] };
      const comments = payload.comments ?? [];

      // Jira's orderBy=-created is advisory; sort locally to be safe.
      const sorted = [...comments].sort((a, b) =>
        (b.created ?? "").localeCompare(a.created ?? ""),
      );

      for (const comment of sorted) {
        const body = adfToMarkdown(comment.body);
        if (!body) continue;
        const match = body.match(RIFT_CONFIG_REGEX);
        if (match) {
          logger.info(
            {
              jira: jiraNumber,
              commentId: comment.id,
              commentCreated: comment.created,
              commentAuthor: comment.author?.displayName,
            },
            "[RIFT_CONFIG_JIRA_FETCHED] Found RIFT_CONFIG block in Jira comment",
          );
          return match[0];
        }
      }

      logger.warn(
        { jira: jiraNumber, commentCount: comments.length },
        "[RIFT_CONFIG_JIRA_FETCH_MISS] No RIFT_CONFIG block found in any Jira comment",
      );
      return null;
    } catch (error) {
      logger.error(
        {
          jira: jiraNumber,
          error: error instanceof Error ? error.message : String(error),
        },
        "[RIFT_CONFIG_JIRA_FETCH_ERROR] Exception while fetching Jira comments",
      );
      return null;
    }
  }

  /**
   * Fetch the full Jira context for a ticket.
   *
   * RIFT requires description, comments, attachments, and linked tickets to
   * do its job — without them the analysis is speculation. Any failure here
   * is fatal for the task (the caller aborts and marks it failed).
   *
   * Videos are soft-warned: we still record their filename and flag that
   * content cannot be extracted without transcription.
   */
  private async fetchJiraContext(
    jiraNumber: string,
    repositoryPath: string,
    taskId: number,
  ): Promise<JiraContextBundle> {
    this.assertJiraCredentials(jiraNumber);

    const issue = await this.fetchJiraIssue(jiraNumber);
    const rawComments = await this.fetchJiraCommentsRaw(jiraNumber);

    const descriptionMarkdown = adfToMarkdown(issue.fields.description);
    const summary = issue.fields.summary;

    const comments: JiraCommentInput[] = rawComments.map((comment) => ({
      author: comment.author?.displayName ?? "Unknown",
      created: comment.created ?? "",
      body: adfToMarkdown(comment.body),
    }));

    const attachmentsDir = path.join(
      repositoryPath,
      "jira",
      `task-${taskId}`,
      "attachments",
    );
    const { attachments, videoWarnings } = await this.downloadAttachments(
      jiraNumber,
      issue.fields.attachment ?? [],
      attachmentsDir,
    );

    const linkedTickets = await this.resolveLinkedTickets(
      jiraNumber,
      issue.fields.issuelinks ?? [],
    );

    return {
      ticketKey: jiraNumber,
      summary,
      descriptionMarkdown,
      comments,
      attachments,
      linkedTickets,
      videoWarnings,
    };
  }

  private assertJiraCredentials(jiraNumber: string): void {
    if (!this.agentJiraToken || !this.agentJiraUsername) {
      logger.error(
        { jira: jiraNumber },
        "[RIFT_JIRA_CONTEXT_ERROR] Missing Jira credentials on RIFT agent",
      );
      throw new Error("RIFT agent is missing Jira credentials");
    }
  }

  private jiraAuthHeader(): string {
    const auth = Buffer.from(
      `${this.agentJiraUsername}:${this.agentJiraToken}`,
    ).toString("base64");
    return `Basic ${auth}`;
  }

  private async fetchJiraIssue(jiraNumber: string): Promise<JiraIssue> {
    const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(jiraNumber)}?fields=*all`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.jiraAuthHeader(),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      throw new Error(
        `Jira issue fetch failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 300)}`,
      );
    }

    return (await response.json()) as JiraIssue;
  }

  private async fetchJiraCommentsRaw(
    jiraNumber: string,
  ): Promise<JiraComment[]> {
    const pageSize = 100;
    let startAt = 0;
    const comments: JiraComment[] = [];

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(pageSize),
        orderBy: "created",
      });
      const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(jiraNumber)}/comment?${params.toString()}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.jiraAuthHeader(),
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => "Unable to read error response");
        throw new Error(
          `Jira comments fetch failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 300)}`,
        );
      }

      const payload = (await response.json()) as {
        comments?: JiraComment[];
        startAt?: number;
        maxResults?: number;
        total?: number;
      };

      const page = payload.comments ?? [];
      comments.push(...page);

      const currentStart = payload.startAt ?? startAt;
      const currentMax = payload.maxResults ?? pageSize;
      const total = payload.total ?? comments.length;
      startAt = currentStart + currentMax;
      if (startAt >= total || currentMax <= 0 || page.length === 0) {
        break;
      }
    }

    return comments;
  }

  /**
   * Download every attachment on the ticket. Files within the size budget are
   * saved locally and exposed to the agent via localPath; larger files fall
   * back to a metadata-only description so the agent can still reason about
   * their existence. Videos are recorded as soft-warnings because content
   * cannot be extracted without a transcription step.
   */
  private async downloadAttachments(
    jiraNumber: string,
    attachments: JiraAttachment[],
    targetDir: string,
  ): Promise<{
    attachments: JiraAttachmentInput[];
    videoWarnings: string[];
  }> {
    if (attachments.length === 0) {
      return { attachments: [], videoWarnings: [] };
    }

    await fs.mkdir(targetDir, { recursive: true });

    const result: JiraAttachmentInput[] = [];
    const videoWarnings: string[] = [];

    for (const attachment of attachments) {
      const baseEntry: JiraAttachmentInput = {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType ?? "application/octet-stream",
        size: attachment.size ?? 0,
      };

      const mime = (attachment.mimeType ?? "").toLowerCase();
      const isVideo = mime.startsWith(VIDEO_MIME_PREFIX);
      const isImage = mime.startsWith(IMAGE_MIME_PREFIX);
      const tooLarge = (attachment.size ?? 0) > MAX_ATTACHMENT_BYTES;

      if (isVideo) {
        const warning = `Video attachment '${attachment.filename}' cannot be analyzed without a transcription step.`;
        videoWarnings.push(warning);
        baseEntry.description = warning;
      }

      if (!attachment.content) {
        baseEntry.description =
          baseEntry.description ??
          "No download URL present on this attachment.";
        result.push(baseEntry);
        continue;
      }

      if (tooLarge) {
        baseEntry.description =
          baseEntry.description ??
          `Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit (size=${attachment.size}); not downloaded.`;
        result.push(baseEntry);
        continue;
      }

      try {
        const safeName = attachment.filename.replace(/[^A-Za-z0-9._-]+/g, "_");
        const localFile = path.join(targetDir, `${attachment.id}-${safeName}`);

        const response = await fetch(attachment.content, {
          method: "GET",
          headers: {
            Authorization: this.jiraAuthHeader(),
            Accept: "*/*",
          },
          redirect: "follow",
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(localFile, buffer);
        baseEntry.localPath = localFile;

        if (isVideo) {
          // Keep the transcription warning; just note the local file too.
          baseEntry.description = `${baseEntry.description} Saved to ${localFile}.`;
        } else if (!isImage && mime && !this.isAgentReadableMime(mime)) {
          baseEntry.description =
            `Binary attachment (${mime}); saved locally at ${localFile}. ` +
            "The Read tool may not parse it; request a text extraction if needed.";
        }

        result.push(baseEntry);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            jira: jiraNumber,
            attachmentId: attachment.id,
            filename: attachment.filename,
            reason,
          },
          "[RIFT_ATTACHMENT_DOWNLOAD_FAILED] Falling back to metadata-only entry",
        );
        baseEntry.description =
          baseEntry.description ??
          `Attachment download failed: ${reason}. Agent should request content from reporter.`;
        result.push(baseEntry);
      }
    }

    return { attachments: result, videoWarnings };
  }

  /**
   * MIME types Claude can read directly through the Read tool.
   * Images are handled separately (by localPath + multimodal input).
   */
  private isAgentReadableMime(mime: string): boolean {
    if (mime.startsWith("text/")) return true;
    if (mime === "application/json") return true;
    if (mime === "application/xml") return true;
    if (mime === "application/x-sql") return true;
    if (mime === "application/pdf") return true;
    if (mime === "application/x-yaml" || mime === "text/yaml") return true;
    return false;
  }

  private async resolveLinkedTickets(
    jiraNumber: string,
    issuelinks: JiraIssue["fields"]["issuelinks"],
  ): Promise<JiraLinkedTicketInput[]> {
    if (!issuelinks || issuelinks.length === 0) {
      return [];
    }

    const resolved: JiraLinkedTicketInput[] = [];
    for (const link of issuelinks) {
      const outward = link.outwardIssue;
      const inward = link.inwardIssue;
      const linked = outward ?? inward;
      if (!linked?.key) continue;

      const relation =
        (outward ? link.type?.outward : link.type?.inward) ??
        link.type?.name ??
        "related to";

      try {
        const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(linked.key)}?fields=summary,status,issuetype`;
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.jiraAuthHeader(),
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const payload = (await response.json()) as JiraIssue;
        resolved.push({
          key: linked.key,
          summary: payload.fields.summary ?? linked.fields?.summary ?? "",
          status:
            payload.fields.status?.name ??
            linked.fields?.status?.name ??
            "Unknown",
          issueType: payload.fields.issuetype?.name ?? "Unknown",
          linkType: relation,
        });
      } catch (error) {
        logger.warn(
          {
            jira: jiraNumber,
            linkedKey: linked.key,
            reason: error instanceof Error ? error.message : String(error),
          },
          "[RIFT_LINK_RESOLVE_FAILED] Using shallow link metadata",
        );
        resolved.push({
          key: linked.key,
          summary: linked.fields?.summary ?? "",
          status: linked.fields?.status?.name ?? "Unknown",
          issueType: "Unknown",
          linkType: relation,
        });
      }
    }

    return resolved;
  }

  /**
   * Estimate cost based on token usage
   */
  private estimateCost(tokensUsed?: { input: number; output: number }): number {
    if (!tokensUsed) return 0;

    // Claude Sonnet 4 pricing via Bedrock
    const inputCost = (tokensUsed.input / 1000) * 0.003;
    const outputCost = (tokensUsed.output / 1000) * 0.015;
    return inputCost + outputCost;
  }

  /**
   * Format analysis result as markdown
   */
  private formatOutput(
    jiraNumber: string,
    result: RIFTAnalysisResult,
    config: { oldBranch: string; newBranch: string; repositoryType: string },
  ): string {
    const structured = result.structured;
    const executiveSummary = structured?.executive_summary;
    const topRootCauses = structured?.top_root_causes || [];
    const additionalRetrofits = structured?.additional_missing_retrofits || [];
    const gitAnalysis = structured?.git_analysis;
    const testingRecommendations = structured?.testing_recommendations || [];

    return `# RIFT Analysis for ${jiraNumber}

## Upgrade Defect Analysis & Root Cause Identification

---

## Executive Summary

${
  executiveSummary
    ? `
**Issue**: ${executiveSummary.issue_description}

**Repository**: **${executiveSummary.repository_name}**

**Root Cause**: ${executiveSummary.root_cause_simple}

**Impact**: ${executiveSummary.impact}

**Fix Summary**: ${executiveSummary.fix_summary}

${executiveSummary.estimated_fix_time ? `**Estimated Fix Time**: ${executiveSummary.estimated_fix_time}` : ""}
`
    : result.analysis.substring(0, 500) + "..."
}

---

## Version Information

- **Old Version (Working)**: \`${config.oldBranch}\`
- **New Version (Broken)**: \`${config.newBranch}\`
- **Repository**: **${config.repositoryType}**
- **Configuration**: Same in both versions

${
  gitAnalysis
    ? `
### Git Analysis Summary
- **Commits in OLD not in NEW**: ${gitAnalysis.commits_in_old_not_in_new ?? "N/A"}
- **Commits in NEW not in OLD**: ${gitAnalysis.commits_in_new_not_in_old ?? "N/A"}
- **Files Analyzed**: ${gitAnalysis.files_analyzed?.length ?? 0}
${gitAnalysis.validation_checks_performed ? `- **Validation Checks**: ${gitAnalysis.validation_checks_performed.join(", ")}` : ""}
`
    : ""
}

---

## Top ${topRootCauses.length} Root Cause${topRootCauses.length > 1 ? "s" : ""} (Ranked by Confidence)

${topRootCauses
  .map(
    (cause, index) => `
### #${cause.rank}: ${cause.summary}

**Classification**: ${this.formatClassification(cause.classification)}
**Confidence**: **${cause.confidence}%**

${
  cause.commit
    ? `
#### Commit Details
- **Hash**: \`${cause.commit.hash}\`
- **Author**: ${cause.commit.author}
- **Date**: ${cause.commit.date}
- **Message**: ${cause.commit.message}
${cause.commit.jira_ticket ? `- **JIRA Ticket**: ${cause.commit.jira_ticket}` : ""}
`
    : ""
}

${
  cause.code_diff
    ? `
#### Code Difference

**File**: \`${cause.code_diff.file_path}\`

${cause.code_diff.diff_summary ? `**Summary**: ${cause.code_diff.diff_summary}\n` : ""}

**In OLD Version (${config.oldBranch})** ${cause.code_diff.line_numbers_old ? `- Lines ${cause.code_diff.line_numbers_old.start}-${cause.code_diff.line_numbers_old.end}` : ""}:
\`\`\`
${cause.code_diff.old_version_code || "N/A"}
\`\`\`

**In NEW Version (${config.newBranch})** ${cause.code_diff.line_numbers_new ? `- Lines ${cause.code_diff.line_numbers_new.start}-${cause.code_diff.line_numbers_new.end}` : ""}:
\`\`\`
${cause.code_diff.new_version_code || "N/A"}
\`\`\`
`
    : ""
}

#### Explanation

**How it works in OLD version (${config.oldBranch})**:
${cause.explanation.how_it_works_in_old}

**Why it fails in NEW version (${config.newBranch})**:
${cause.explanation.why_it_fails_in_new}

**Evidence**:
${cause.explanation.evidence}

${
  cause.explanation.validation_performed
    ? `**Validation Performed**:
${cause.explanation.validation_performed}`
    : ""
}

#### Fix Recommendation

**Approach**: ${this.formatApproach(cause.fix_recommendation.approach)}

${
  cause.fix_recommendation.commands &&
  cause.fix_recommendation.commands.length > 0
    ? `
**Commands**:
\`\`\`bash
${cause.fix_recommendation.commands.join("\n")}
\`\`\`
`
    : ""
}

${
  cause.fix_recommendation.patch
    ? `
**Patch**:
\`\`\`diff
${cause.fix_recommendation.patch}
\`\`\`
`
    : ""
}

${
  cause.fix_recommendation.testing_notes
    ? `
**Testing Notes**:
${cause.fix_recommendation.testing_notes}
`
    : ""
}

---
`,
  )
  .join("\n")}

${
  additionalRetrofits.length > 0
    ? `
---

## Additional Missing Retrofits Found

While investigating this defect, RIFT identified **${additionalRetrofits.length}** other commit${additionalRetrofits.length > 1 ? "s" : ""} in OLD version (\`${config.oldBranch}\`) that ${additionalRetrofits.length > 1 ? "are" : "is"} missing in NEW version (\`${config.newBranch}\`) for the same impacted files. These may cause future issues:

${additionalRetrofits
  .map(
    (retrofit, index) => `
### ${index + 1}. File: \`${retrofit.file_path}\`

**Risk Level**: ${this.formatRiskLevel(retrofit.risk_level)}
**Commit**: \`${retrofit.commit_hash}\`
${retrofit.jira_ticket ? `**JIRA**: ${retrofit.jira_ticket}  ` : ""}
${retrofit.author ? `**Author**: ${retrofit.author}  ` : ""}
${retrofit.date ? `**Date**: ${retrofit.date}  ` : ""}
${retrofit.commit_message ? `**Message**: ${retrofit.commit_message}  ` : ""}

**Description**: ${retrofit.description}
`,
  )
  .join("\n")}

**Recommendation**: Review these commits and cherry-pick if applicable to prevent future defects.

---
`
    : ""
}

${
  testingRecommendations.length > 0
    ? `
## Testing Recommendations

${testingRecommendations.map((rec, index) => `${index + 1}. ${rec}`).join("\n")}

---
`
    : ""
}

## Full Technical Analysis

${result.analysis}

---

## Metrics

- **Duration**: ${(result.metrics.durationMs / 1000).toFixed(2)}s
- **Tool Calls**: ${result.metrics.toolCalls}
${result.metrics.tokensUsed ? `- **Tokens Used**: Input: ${result.metrics.tokensUsed.input.toLocaleString()}, Output: ${result.metrics.tokensUsed.output.toLocaleString()}` : ""}
${result.metrics.costUsd ? `- **Estimated Cost**: $${result.metrics.costUsd.toFixed(4)}` : ""}

---

## How to Provide Feedback

If this analysis is **incorrect**, please add the label \`incorrect_rift_analysis\` to this JIRA ticket and add a comment with:
1. The correct root cause
2. Why RIFT's analysis was wrong
3. Any additional context

RIFT will learn from this feedback and improve future analyses.

---

*Generated by **RIFT** (Regression Investigation & Fix Tracker) at ${new Date().toISOString()}*
`;
  }

  /**
   * Format classification for display
   */
  private formatClassification(classification: string): string {
    const map: Record<string, string> = {
      missing_retrofit: "🔴 Missing Retrofit (Cherry-pick)",
      breaking_enhancement: "🟡 Breaking Enhancement",
      removed_code: "🟠 Removed Code",
      other: "⚪ Other",
    };
    return map[classification] || classification;
  }

  /**
   * Format approach for display
   */
  private formatApproach(approach: string): string {
    const map: Record<string, string> = {
      cherry_pick: "🍒 Cherry-pick commit",
      code_patch: "🔧 Apply code patch",
      revert: "↩️ Revert commit",
      manual_fix: "✍️ Manual fix required",
    };
    return map[approach] || approach;
  }

  /**
   * Format risk level for display
   */
  private formatRiskLevel(risk: string): string {
    const map: Record<string, string> = {
      high: "🔴 **HIGH**",
      medium: "🟡 **MEDIUM**",
      low: "🟢 **LOW**",
    };
    return map[risk] || risk.toUpperCase();
  }
}
