/**
 * ANVIL Worker
 * Processes JIRA tickets labeled with "ANVIL"
 *
 * Workflow:
 * 1. Poll for ANVIL labeled tickets (MPPROJECT epics or stories)
 * 2. Download ASD (.docx) attachment from JIRA
 * 3. Create ANVILAgent to generate YAML configs
 * 4. Agent determines epic vs story, generates configs, creates PR
 * 5. Post results to JIRA
 */

import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import { ANVILAgent, type ANVILResult } from "../../agents/anvil/index.js";
import { createLogger } from "../../utils/logger.js";
import type { EventEmitter } from "events";

const logger = createLogger("anvil-worker");
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * ANVIL Worker - MP Automation Config Generator
 */
export class ANVILWorker extends AgentWorker {
  private jiraBaseUrl: string;

  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "ANVIL",
      repositoryPath,
      pollingIntervalMs: 10000, // 10 seconds
      batchSize: 1,
      enableStatusServer,
    });

    this.jiraBaseUrl = process.env.JIRA_BASE_URL || "";

    logger.info(
      {
        repositoryPath,
        enableStatusServer,
        pollingIntervalMs: 10000,
        jiraBaseUrl: this.jiraBaseUrl,
      },
      "[ANVIL_WORKER_INIT] ANVILWorker initialized",
    );
  }

  /**
   * Process ANVIL task - download ASD and generate configs
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

    const logContext = {
      jira: jiraNumber,
      taskId,
      repositoryPath,
    };

    logger.info(logContext, "[ANVIL_PROCESS_START] Processing ticket");

    let asdFilePath: string | null = null;

    try {
      // Step 1: Download ASD (.docx) attachment from JIRA
      logger.info(
        logContext,
        "[ANVIL_ASD_DOWNLOAD] Downloading ASD attachment",
      );
      asdFilePath = await this.downloadAsdAttachment(jiraNumber, logContext);

      // Step 2: Build additional context with ASD path and Jira credentials
      const contextParts: string[] = [];

      if (additionalContext) {
        contextParts.push(additionalContext);
      }

      if (asdFilePath) {
        contextParts.push(
          `\n## ASD Document\nASD file downloaded to: ${asdFilePath}`,
        );
      } else {
        contextParts.push(
          "\n## ASD Document\nNo ASD (.docx) attachment found on this ticket. " +
            "If this is an Epic, child stories may have their own ASD attachments.",
        );
      }

      // Pass Jira credentials for the agent to fetch child stories and post comments
      if (this.agentJiraUsername && this.agentJiraToken) {
        contextParts.push(
          `\n## Jira API Credentials\n` +
            `Use these credentials for Jira API calls (fetching child stories, downloading attachments, posting comments):\n` +
            `- Base URL: ${this.jiraBaseUrl}\n` +
            `- Email: ${this.agentJiraUsername}\n` +
            `- API Token: ${this.agentJiraToken}\n` +
            `- Auth header: Basic ${Buffer.from(`${this.agentJiraUsername}:${this.agentJiraToken}`).toString("base64")}`,
        );
      }

      const enrichedContext = contextParts.join("\n");

      // Step 3: Create agent and generate configs
      logger.info(
        logContext,
        "[ANVIL_AGENT_START] Creating agent and starting config generation",
      );

      const configRepoPath = path.join(
        repositoryPath,
        "mp-product-client-configs",
      );

      if (!fs.existsSync(configRepoPath)) {
        throw new Error(
          `Expected ANVIL config repository at ${configRepoPath}. Ensure code_repositories contains mp-product-client-configs and the task resolves that repo.`,
        );
      }

      const agent = new ANVILAgent({
        repositoryPath: configRepoPath,
        eventEmitter,
      });

      const result: ANVILResult = await agent.generateConfigs(
        taskDescription,
        enrichedContext,
      );

      const durationMs = Date.now() - startTime;

      if (result.success) {
        const configCount = result.structured?.configs_created?.length ?? 0;
        const gapCount = result.structured?.requirement_gaps?.length ?? 0;
        const prUrl = result.structured?.git_info?.pr_url ?? "N/A";

        logger.info(
          {
            ...logContext,
            durationMs,
            configCount,
            gapCount,
            prUrl,
            ticketType: result.structured?.ticket_type,
            storiesProcessed: result.structured?.stories_processed,
          },
          "[ANVIL_PROCESS_SUCCESS] Config generation completed",
        );

        // Format output for posting to Jira
        const output = this.formatOutput(result);

        return {
          success: true,
          output,
          metrics: {
            durationMs,
            totalTokens: result.metrics.tokensUsed || { input: 0, output: 0 },
            iterations: result.metrics.toolCalls,
            cost: result.metrics.costUsd,
          },
        };
      } else {
        logger.warn(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[ANVIL_PROCESS_FAILED] Config generation failed",
        );

        return {
          success: false,
          output: result.output || result.error || "Config generation failed",
          metrics: {
            durationMs,
            iterations: result.metrics.toolCalls,
          },
        };
      }
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      logger.error(
        {
          ...logContext,
          durationMs,
          error: error.message,
          stack: error.stack,
        },
        "[ANVIL_PROCESS_ERROR] Exception during processing",
      );

      return {
        success: false,
        output: `Error: ${error.message}`,
        metrics: {
          durationMs,
        },
      };
    } finally {
      // Cleanup temp file
      if (asdFilePath) {
        try {
          fs.unlinkSync(asdFilePath);
          logger.debug(
            logContext,
            "[ANVIL_CLEANUP] Temporary ASD file deleted",
          );
        } catch (cleanupError) {
          logger.warn(
            {
              ...logContext,
              error: cleanupError,
            },
            "[ANVIL_CLEANUP_WARN] Failed to delete temporary file",
          );
        }
      }
    }
  }

  /**
   * Download ASD (.docx) attachment from JIRA ticket
   */
  private async downloadAsdAttachment(
    jiraNumber: string,
    logContext: Record<string, any>,
  ): Promise<string | null> {
    try {
      // Fetch issue to get attachments
      const issueUrl = `${this.jiraBaseUrl}/rest/api/3/issue/${jiraNumber}?fields=attachment`;

      const basicAuth = `Basic ${Buffer.from(`${this.agentJiraUsername}:${this.agentJiraToken}`).toString("base64")}`;
      const response = await fetch(issueUrl, {
        headers: {
          Authorization: basicAuth,
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `JIRA API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as any;
      const attachments = data.fields?.attachment || [];

      logger.debug(
        {
          ...logContext,
          attachmentCount: attachments.length,
        },
        "[ANVIL_ATTACHMENTS] Found attachments",
      );

      // Find .docx file (ASD - Automation Specification Document)
      const docxAttachment = attachments.find((att: any) => {
        const filename = (att.filename || "").toLowerCase();
        return filename.endsWith(".docx");
      });

      if (!docxAttachment) {
        logger.warn(
          logContext,
          "[ANVIL_NO_ASD] No .docx (ASD) attachment found",
        );
        return null;
      }

      logger.info(
        {
          ...logContext,
          filename: docxAttachment.filename,
          size: docxAttachment.size,
        },
        "[ANVIL_DOWNLOAD_START] Downloading ASD file",
      );

      // Download file to temp directory
      const tempDir = os.tmpdir();
      const tempFilePath = path.join(
        tempDir,
        `anvil-${jiraNumber}-${Date.now()}.docx`,
      );

      const fileResponse = await fetch(docxAttachment.content, {
        headers: {
          Authorization: basicAuth,
        },
      });

      if (!fileResponse.ok) {
        throw new Error(
          `File download failed: ${fileResponse.status} ${fileResponse.statusText}`,
        );
      }

      const arrayBuffer = await fileResponse.arrayBuffer();
      fs.writeFileSync(tempFilePath, Buffer.from(arrayBuffer));

      logger.info(
        {
          ...logContext,
          tempFilePath,
          fileSize: fs.statSync(tempFilePath).size,
        },
        "[ANVIL_DOWNLOAD_COMPLETE] ASD file saved to temp",
      );

      return tempFilePath;
    } catch (error: any) {
      logger.error(
        {
          ...logContext,
          error: error.message,
        },
        "[ANVIL_DOWNLOAD_ERROR] Failed to download ASD",
      );
      // Don't throw - ASD might be on child stories for epics
      return null;
    }
  }

  /**
   * Format ANVIL result as markdown for Jira posting
   */
  private formatOutput(result: ANVILResult): string {
    const parts: string[] = [];

    parts.push("# ANVIL - Automation Config Generation Results\n");

    if (result.structured?.ticket_type) {
      parts.push(`**Ticket Type:** ${result.structured.ticket_type}`);
      parts.push(
        `**Stories Processed:** ${result.structured.stories_processed ?? 0}`,
      );
    }

    // Configs created
    const configs = result.structured?.configs_created ?? [];
    if (configs.length > 0) {
      parts.push(`\n## Configs Created (${configs.length})\n`);
      parts.push("| File | Product | Job Type | Environment |");
      parts.push("|------|---------|----------|-------------|");
      for (const config of configs) {
        parts.push(
          `| ${config.file_path} | ${config.product_type} | ${config.job_type ?? "-"} | ${config.environment ?? "-"} |`,
        );
      }
    }

    // Requirement gaps
    const gaps = result.structured?.requirement_gaps ?? [];
    if (gaps.length > 0) {
      parts.push(`\n## Requirement Gaps (${gaps.length})\n`);
      for (const gap of gaps) {
        parts.push(
          `- **${gap.field}**: ${gap.description}${gap.assumed_value ? ` (assumed: ${gap.assumed_value})` : ""}`,
        );
      }
    }

    // Git info
    if (result.structured?.git_info) {
      parts.push("\n## Git Info\n");
      if (result.structured.git_info.branch) {
        parts.push(`- **Branch:** ${result.structured.git_info.branch}`);
      }
      if (result.structured.git_info.pr_url) {
        parts.push(`- **PR:** ${result.structured.git_info.pr_url}`);
      }
    }

    // Summary
    if (result.structured?.summary) {
      parts.push(`\n## Summary\n${result.structured.summary}`);
    }

    // Metrics
    parts.push("\n## Metrics\n");
    parts.push(`- Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
    parts.push(`- Tool calls: ${result.metrics.toolCalls}`);
    if (result.metrics.costUsd) {
      parts.push(`- Cost: $${result.metrics.costUsd.toFixed(4)}`);
    }

    return parts.join("\n");
  }
}
