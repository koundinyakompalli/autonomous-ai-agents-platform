/**
 * FORGE - Failure Operations Root-cause Guidance Engine
 *
 * Hybrid agent: deterministic evidence collection + Claude SDK analysis.
 *
 * ## Lifecycle
 * 1. [FORGE_INIT]     - Agent created with options
 * 2. [FORGE_PARSE]    - Phase 0.5: Parse job context from ticket summary/description
 * 3. [FORGE_DOWNLOAD] - Phase 1: Download .log attachments from JIRA
 * 4. [FORGE_REGISTER] - Phase 1.5: Write logs to workspace, register as repoId
 * 5. [FORGE_ANALYZE]  - Phase 2: Claude SDK analyzes logs + cross-references MP repos
 * 6. [FORGE_COMPLETE] - Return structured findings
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";
import AdmZip from "adm-zip";

const gunzip = promisify(zlib.gunzip);
import {
  runAgent,
  getAgentPrompt,
  registerRepo,
  registerRepoFromPath,
  registerCustomerWorkspace,
  type AgentResult,
  type ProgressUpdate,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/index.js";
import type {
  FORGEAgentOptions,
  FORGEResult,
  FORGEStructuredOutput,
  LogDownloadResult,
  LogFileInfo,
  ParsedJobContext,
} from "./types.js";
import type { EventEmitter } from "events";

const logger = createLogger("forge-agent");

/** Maximum size per log file (10 MB) to prevent token budget blowout */
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024;

/** Default EFS base path for repositories */
const EFS_BASE_PATH = "/mnt/efs/specter-repo/repositories";

export class FORGEAgent {
  private options: FORGEAgentOptions;
  private repoId: string | null = null;
  private repoIds: string[] = [];
  private instanceId: string;
  private jiraBaseUrl: string;
  private jiraAuthHeader: string;

  constructor(options: FORGEAgentOptions) {
    this.instanceId = `forge-${Date.now()}`;

    this.options = {
      timeoutMs: 15 * 60 * 1000, // 15 minutes default
      ...options,
    };

    const logContext = {
      instanceId: this.instanceId,
      hasRepoId: !!options.repoId,
      hasRepositoryPath: !!options.repositoryPath,
      timeoutMs: this.options.timeoutMs,
    };

    logger.debug(logContext, "[FORGE_INIT] Creating FORGEAgent instance");

    // Initialize JIRA credentials
    const jiraUsername =
      options.jiraUsername || process.env.JIRA_USERNAME || "";
    const jiraToken = options.jiraToken || process.env.JIRA_TOKEN || "";
    this.jiraBaseUrl = (
      process.env.JIRA_BASE_URL || "https://medhokapps.atlassian.net"
    ).replace(/\/$/, "");
    this.jiraAuthHeader = `Basic ${Buffer.from(`${jiraUsername}:${jiraToken}`).toString("base64")}`;

    // Resolve repo if provided
    if (options.repoId) {
      this.repoId = options.repoId;
      this.repoIds = [options.repoId];

      logger.info(
        {
          ...logContext,
          repoId: this.repoId,
        },
        "[FORGE_REPO_DIRECT] Using provided repoId",
      );
    } else if (options.repositoryPath) {
      if (options.repositoryPath.includes("/tasks/")) {
        const result = registerCustomerWorkspace(options.repositoryPath);
        this.repoId = result.workspaceId;
        this.repoIds =
          result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

        logger.info(
          {
            ...logContext,
            workspaceId: result.workspaceId,
            repoIds: this.repoIds,
          },
          "[FORGE_WORKSPACE_REGISTERED] Customer workspace registered",
        );
      } else {
        this.repoId = registerRepoFromPath(options.repositoryPath);
        this.repoIds = [this.repoId];

        logger.info(
          {
            ...logContext,
            repoId: this.repoId,
          },
          "[FORGE_REPO_REGISTERED] Repository registered",
        );
      }
    } else {
      logger.info(
        logContext,
        "[FORGE_NO_REPO] No repository configured — analysis will use JIRA log files only",
      );
    }
  }

  /**
   * Parse job context from ticket summary and description.
   *
   * Typical summary format: "AGRP-MPPROD1-recursive_archiver - Allymar"
   * Typical description contains command line with args like --client, --envid, --env
   */
  parseJobContext(summary: string, description: string): ParsedJobContext {
    const context: ParsedJobContext = {};

    // Parse job name from summary: {GROUP}-{ENVID}-{job_name} - {Client}
    const jobNameMatch = summary.match(/^([A-Z0-9]+)-([A-Z0-9]+)-(\S+)/i);
    if (jobNameMatch) {
      context.jobName = jobNameMatch[0];
      context.group = jobNameMatch[1];
      context.envid = jobNameMatch[2];
    }

    // Parse client from summary (after " - ")
    const clientFromSummary = summary.match(/\s+-\s+(.+)$/);
    if (clientFromSummary) {
      context.client = clientFromSummary[1].trim();
    }

    // Parse command line args from description
    const clientArg = description.match(/--client\s+(\S+)/i);
    if (clientArg) {
      context.client = clientArg[1];
    }

    const envidArg = description.match(/--envid\s+(\S+)/i);
    if (envidArg) {
      context.envid = envidArg[1];
    }

    const envArg = description.match(/--env\s+(\S+)/i);
    if (envArg) {
      context.env = envArg[1];
    }

    // Extract full command line
    const cmdMatch = description.match(
      /(?:command to call|command[:\s]+)(.+?)(?:\n|$)/i,
    );
    if (cmdMatch) {
      context.commandLine = cmdMatch[1].trim();
    }

    logger.debug(
      {
        instanceId: this.instanceId,
        parsedContext: context,
      },
      "[FORGE_PARSE] Job context parsed from ticket",
    );

    return context;
  }

  /**
   * Resolve the directory path where log files should be written.
   */
  private resolveLogDir(jiraNumber: string): string {
    const basePath = this.options.repositoryPath || EFS_BASE_PATH;

    if (basePath.includes("/tasks/")) {
      return path.join(basePath, "forge-evidence");
    }

    return path.join(
      basePath,
      "forge-evidence",
      jiraNumber.replace(/[^a-zA-Z0-9-]/g, "_"),
    );
  }

  /**
   * Format bytes for human-readable display
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Phase 1: Download .log attachments from JIRA ticket.
   * Filters for .log extension, enforces MAX_LOG_FILE_SIZE, handles duplicate filenames.
   */
  private async downloadLogAttachments(
    jiraNumber: string,
    logDir: string,
  ): Promise<LogDownloadResult> {
    const logContext = {
      instanceId: this.instanceId,
      jiraNumber,
      logDir,
    };

    logger.info(logContext, "[FORGE_DOWNLOAD_START] Fetching JIRA attachments");

    // Fetch issue metadata
    const issueUrl = `${this.jiraBaseUrl}/rest/api/3/issue/${jiraNumber}?fields=attachment`;
    const response = await fetch(issueUrl, {
      headers: {
        Authorization: this.jiraAuthHeader,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `JIRA API error fetching attachments for ${jiraNumber}: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as any;
    const allAttachments: any[] = data.fields?.attachment || [];

    logger.debug(
      {
        ...logContext,
        totalAttachments: allAttachments.length,
      },
      "[FORGE_ATTACHMENTS_FETCHED] Got attachment list from JIRA",
    );

    // Filter for .log, .gz, and .zip files
    const logAttachments = allAttachments.filter((att: any) => {
      const filename = (att.filename || "").toLowerCase();
      return (
        filename.endsWith(".log") ||
        filename.endsWith(".gz") ||
        filename.endsWith(".zip")
      );
    });

    if (logAttachments.length === 0) {
      logger.warn(
        logContext,
        "[FORGE_NO_LOGS] No .log/.gz/.zip attachments found on JIRA ticket",
      );
      return { dir: logDir, files: [], totalBytes: 0, skippedFiles: [] };
    }

    logger.info(
      {
        ...logContext,
        logAttachmentCount: logAttachments.length,
      },
      "[FORGE_LOG_ATTACHMENTS_FOUND] Found log attachments",
    );

    // Create evidence directory
    fs.mkdirSync(logDir, { recursive: true });

    const downloadedFiles: LogFileInfo[] = [];
    const skippedFiles: Array<{ filename: string; reason: string }> = [];
    let totalBytes = 0;

    // Track filenames to handle duplicates
    const usedFilenames = new Set<string>();

    for (const attachment of logAttachments) {
      const originalFilename = attachment.filename as string;
      const sizeBytes = attachment.size as number;
      const lowerFilename = originalFilename.toLowerCase();

      // Skip oversized files
      if (sizeBytes > MAX_LOG_FILE_SIZE) {
        const reason = `File size ${this.formatBytes(sizeBytes)} exceeds limit ${this.formatBytes(MAX_LOG_FILE_SIZE)}`;
        logger.warn(
          { ...logContext, filename: originalFilename, sizeBytes },
          `[FORGE_SKIP_LARGE] ${reason}`,
        );
        skippedFiles.push({ filename: originalFilename, reason });
        continue;
      }

      logger.info(
        {
          ...logContext,
          originalFilename,
          sizeBytes,
        },
        "[FORGE_DOWNLOADING] Downloading attachment",
      );

      const fileResponse = await fetch(attachment.content, {
        headers: { Authorization: this.jiraAuthHeader },
      });

      if (!fileResponse.ok) {
        const reason = `Download failed: ${fileResponse.status} ${fileResponse.statusText}`;
        logger.error(
          { ...logContext, filename: originalFilename },
          `[FORGE_DOWNLOAD_FAILED] ${reason}`,
        );
        skippedFiles.push({ filename: originalFilename, reason });
        continue;
      }

      const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());

      // --- Handle .zip archives ---
      if (lowerFilename.endsWith(".zip")) {
        logger.info(
          { ...logContext, originalFilename },
          "[FORGE_ZIP] Extracting .zip archive",
        );
        const extracted = this.extractZip(
          fileBuffer,
          originalFilename,
          logDir,
          usedFilenames,
          logContext,
        );
        for (const f of extracted) {
          downloadedFiles.push(f);
          totalBytes += f.sizeBytes;
        }
        if (extracted.length === 0) {
          skippedFiles.push({
            filename: originalFilename,
            reason: "No .log files found inside archive",
          });
        }
        continue;
      }

      // --- Handle .gz archives ---
      if (lowerFilename.endsWith(".gz")) {
        logger.info(
          { ...logContext, originalFilename },
          "[FORGE_GZ] Extracting .gz archive",
        );
        const extracted = await this.extractGz(
          fileBuffer,
          originalFilename,
          logDir,
          usedFilenames,
          logContext,
        );
        if (extracted) {
          downloadedFiles.push(extracted);
          totalBytes += extracted.sizeBytes;
        } else {
          skippedFiles.push({
            filename: originalFilename,
            reason: "Decompressed file is not a .log or extraction failed",
          });
        }
        continue;
      }

      // --- Direct .log file ---
      let filename = originalFilename;
      if (usedFilenames.has(filename)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        let counter = 2;
        while (usedFilenames.has(filename)) {
          filename = `${base}_${counter}${ext}`;
          counter++;
        }
      }
      usedFilenames.add(filename);

      const filePath = path.join(logDir, filename);
      fs.writeFileSync(filePath, fileBuffer);

      const actualSize = fs.statSync(filePath).size;
      downloadedFiles.push({ filename, filePath, sizeBytes: actualSize });
      totalBytes += actualSize;

      logger.info(
        {
          ...logContext,
          filename,
          filePath,
          sizeBytes: actualSize,
        },
        "[FORGE_DOWNLOADED] Log file saved",
      );
    }

    return { dir: logDir, files: downloadedFiles, totalBytes, skippedFiles };
  }

  /**
   * Extract a .gz file: decompress and save as the base filename (without .gz).
   */
  private async extractGz(
    gzBuffer: Buffer,
    originalFilename: string,
    logDir: string,
    usedFilenames: Set<string>,
    logContext: Record<string, any>,
  ): Promise<LogFileInfo | null> {
    const innerName = originalFilename.endsWith(".gz")
      ? originalFilename.slice(0, -3)
      : `${originalFilename}.decompressed`;

    if (!innerName.toLowerCase().endsWith(".log")) {
      logger.debug(
        { ...logContext, innerName },
        "[FORGE_GZ_SKIP] Decompressed file is not a .log — skipping",
      );
      return null;
    }

    let decompressed: Buffer;
    try {
      decompressed = await gunzip(gzBuffer);
    } catch (err) {
      logger.error(
        {
          ...logContext,
          originalFilename,
          error: err instanceof Error ? err.message : "Unknown",
        },
        "[FORGE_GZ_ERROR] Failed to decompress .gz file",
      );
      return null;
    }

    let filename = innerName;
    if (usedFilenames.has(filename)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 2;
      while (usedFilenames.has(filename)) {
        filename = `${base}_${counter}${ext}`;
        counter++;
      }
    }
    usedFilenames.add(filename);

    const filePath = path.join(logDir, filename);
    fs.writeFileSync(filePath, decompressed);

    logger.info(
      {
        ...logContext,
        originalFilename,
        filename,
        sizeBytes: decompressed.length,
      },
      "[FORGE_GZ_EXTRACTED] Extracted .gz to .log",
    );
    return { filename, filePath, sizeBytes: decompressed.length };
  }

  /**
   * Extract .log files from a .zip archive.
   */
  private extractZip(
    zipBuffer: Buffer,
    originalFilename: string,
    logDir: string,
    usedFilenames: Set<string>,
    logContext: Record<string, any>,
  ): LogFileInfo[] {
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      logger.error(
        {
          ...logContext,
          originalFilename,
          error: err instanceof Error ? err.message : "Unknown",
        },
        "[FORGE_ZIP_ERROR] Failed to open .zip file",
      );
      return [];
    }

    const entries = zip.getEntries();
    const extracted: LogFileInfo[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      const entryName = path.basename(entry.entryName);
      if (!entryName.toLowerCase().endsWith(".log")) continue;

      const entryData = entry.getData();
      if (entryData.length > MAX_LOG_FILE_SIZE) {
        logger.warn(
          { ...logContext, entryName, sizeBytes: entryData.length },
          "[FORGE_ZIP_SKIP_LARGE] Entry exceeds size limit",
        );
        continue;
      }

      let filename = entryName;
      if (usedFilenames.has(filename)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        let counter = 2;
        while (usedFilenames.has(filename)) {
          filename = `${base}_${counter}${ext}`;
          counter++;
        }
      }
      usedFilenames.add(filename);

      const filePath = path.join(logDir, filename);
      fs.writeFileSync(filePath, entryData);

      logger.info(
        {
          ...logContext,
          originalFilename,
          entryName,
          filename,
          sizeBytes: entryData.length,
        },
        "[FORGE_ZIP_EXTRACTED] Extracted .log from .zip",
      );
      extracted.push({ filename, filePath, sizeBytes: entryData.length });
    }

    if (extracted.length === 0) {
      logger.warn(
        { ...logContext, originalFilename },
        "[FORGE_ZIP_NO_LOGS] No .log files found inside .zip archive",
      );
    }

    return extracted;
  }

  private writeIndexFile(
    logDir: string,
    jiraNumber: string,
    downloadResult: LogDownloadResult,
  ): void {
    const lines = [
      `# FORGE Evidence Index`,
      ``,
      `**Ticket:** ${jiraNumber}`,
      `**Generated:** ${new Date().toISOString()}`,
      ``,
      `## Downloaded Log Files`,
      ``,
    ];

    for (const file of downloadResult.files) {
      lines.push(
        `- \`${file.filename}\` (${this.formatBytes(file.sizeBytes)})`,
      );
    }

    if (downloadResult.skippedFiles.length > 0) {
      lines.push(``, `## Skipped Files`, ``);
      for (const skipped of downloadResult.skippedFiles) {
        lines.push(`- \`${skipped.filename}\` — ${skipped.reason}`);
      }
    }

    lines.push(
      ``,
      `## Summary`,
      ``,
      `- Total files: ${downloadResult.files.length}`,
      `- Total size: ${this.formatBytes(downloadResult.totalBytes)}`,
    );

    fs.writeFileSync(path.join(logDir, "_INDEX.md"), lines.join("\n"));
  }

  /**
   * Run the full FORGE analysis pipeline.
   *
   * @param jiraNumber - JIRA ticket key (e.g., MPSUP-4228)
   * @param additionalContext - Additional context from task description (includes ticket summary, description, custom fields)
   */
  async analyze(
    jiraNumber: string,
    additionalContext?: string,
  ): Promise<FORGEResult> {
    const taskId = `${this.instanceId}-${Date.now()}`;
    const startTime = Date.now();

    const logContext = {
      instanceId: this.instanceId,
      taskId,
      jiraNumber,
      repoId: this.repoId,
      repoIds: this.repoIds,
    };

    logger.info(
      {
        ...logContext,
        hasAdditionalContext: !!additionalContext,
      },
      "[FORGE_ANALYZE_START] Starting FORGE failure analysis",
    );

    try {
      // ================================================================
      // Phase 0.5: Parse job context from ticket content
      // ================================================================
      const summary = this.extractField(additionalContext, "Summary") || "";
      const description =
        this.extractField(additionalContext, "Description") ||
        additionalContext ||
        "";
      const jobContext = this.parseJobContext(summary, description);

      logger.info(
        {
          ...logContext,
          jobContext,
        },
        "[FORGE_PARSE_COMPLETE] Job context parsed",
      );

      // ================================================================
      // Phase 1: Download log attachments from JIRA
      // ================================================================
      logger.info(
        logContext,
        "[FORGE_DOWNLOAD_PHASE] Phase 1: Downloading .log attachments",
      );
      const downloadStartTime = Date.now();

      const logDir = this.resolveLogDir(jiraNumber);
      const downloadResult = await this.downloadLogAttachments(
        jiraNumber,
        logDir,
      );
      const logDownloadMs = Date.now() - downloadStartTime;

      if (downloadResult.files.length === 0) {
        logger.warn(
          {
            ...logContext,
            logDownloadMs,
            skippedFiles: downloadResult.skippedFiles,
          },
          "[FORGE_NO_LOGS_WARN] No .log files downloaded — analysis will rely on ticket description only",
        );
      } else {
        logger.info(
          {
            ...logContext,
            logDownloadMs,
            filesDownloaded: downloadResult.files.length,
            totalBytes: downloadResult.totalBytes,
            skippedCount: downloadResult.skippedFiles.length,
          },
          "[FORGE_DOWNLOAD_COMPLETE] Phase 1 complete: Log files downloaded",
        );
      }

      // ================================================================
      // Phase 1.5: Write index file and register directory as repoId
      // ================================================================
      const allRepoIds = [...this.repoIds];

      if (downloadResult.files.length > 0) {
        this.writeIndexFile(logDir, jiraNumber, downloadResult);

        const logRepoId = `forge_logs_${jiraNumber.replace(/[^a-zA-Z0-9]/g, "_")}`;
        registerRepo(logRepoId, logDir);

        // Place log dir first — primary working directory for Claude
        allRepoIds.unshift(logRepoId);

        logger.info(
          {
            ...logContext,
            logDir,
            logRepoId,
            allRepoIds,
          },
          "[FORGE_REGISTER] Log directory registered for Claude SDK access",
        );
      }

      // ================================================================
      // Phase 2: Claude SDK Analysis
      // ================================================================
      logger.info(
        logContext,
        "[FORGE_ANALYZE_PHASE] Phase 2: Analyzing via Claude SDK",
      );
      const analysisStartTime = Date.now();

      // Build progress handler
      const onProgress = (update: ProgressUpdate) => {
        if (this.options.onProgress) {
          const message = update.toolName
            ? `Analyzing: ${update.toolName}`
            : (update.message ?? `Analyzing failure... (${update.elapsed}ms)`);
          this.options.onProgress(message);
        }
        if (this.options.eventEmitter) {
          this.options.eventEmitter.emit("agent:progress", update);
        }
      };

      // Build task prompt
      const taskPrompt = this.buildTaskPrompt(
        jiraNumber,
        jobContext,
        downloadResult,
        additionalContext,
      );

      logger.info(
        {
          ...logContext,
          taskPromptLength: taskPrompt.length,
          filesInPrompt: downloadResult.files.length,
          repoCount: allRepoIds.length,
        },
        "[FORGE_PROMPT_BUILT] Task prompt built for Claude",
      );

      const result = await runAgent({
        taskId,
        taskPrompt,
        repoIds: allRepoIds.length > 0 ? allRepoIds : ["__no_repo__"],
        agentType: "forge" as const,
        systemAppend: getAgentPrompt("forge"),
        permissionLevel: "read_only" as const,
        webhookUrl: this.options.webhookUrl,
        timeoutMs: this.options.timeoutMs,
        onProgress,
      });

      const analysisMs = Date.now() - analysisStartTime;

      logger.info(
        {
          ...logContext,
          analysisMs,
          toolCalls: result.metrics.toolCalls,
          outputLength: result.output.length,
          success: result.success,
        },
        "[FORGE_ANALYZE_COMPLETE] Phase 2 complete: Analysis generated",
      );

      if (!result.success) {
        logger.error(
          {
            ...logContext,
            error: result.error,
          },
          "[FORGE_ANALYZE_FAILED] Claude SDK returned failure",
        );

        return {
          success: false,
          report: "",
          metrics: {
            durationMs: Date.now() - startTime,
            toolCalls: result.metrics.toolCalls,
            tokensUsed: result.metrics.tokensUsed,
            costUsd: result.metrics.costUsd,
            logDownloadMs,
            analysisMs,
          },
          error: result.error || "Failure analysis failed",
        };
      }

      // Parse structured output if present
      let structured: FORGEStructuredOutput | undefined;
      try {
        if (result.structuredOutput) {
          structured = result.structuredOutput as FORGEStructuredOutput;
        }
      } catch {
        // Non-fatal — structured output is best-effort
      }

      const durationMs = Date.now() - startTime;

      logger.info(
        {
          ...logContext,
          durationMs,
          toolCalls: result.metrics.toolCalls,
          costUsd: result.metrics.costUsd,
          errorCategory: structured?.root_cause?.error_category ?? "unknown",
          recommendedTeam: structured?.routing?.recommended_team ?? "unknown",
        },
        "[FORGE_ANALYZE_SUCCESS] FORGE analysis completed successfully",
      );

      return {
        success: true,
        report: result.output,
        structured,
        metrics: {
          durationMs,
          toolCalls: result.metrics.toolCalls,
          tokensUsed: result.metrics.tokensUsed,
          costUsd: result.metrics.costUsd,
          logDownloadMs,
          analysisMs,
        },
      };
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
        "[FORGE_ANALYZE_ERROR] Exception during FORGE analysis",
      );

      return {
        success: false,
        report: "",
        metrics: {
          durationMs,
          toolCalls: 0,
          logDownloadMs: 0,
          analysisMs: 0,
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Build the task prompt for Claude SDK analysis.
   */
  private buildTaskPrompt(
    jiraNumber: string,
    jobContext: ParsedJobContext,
    downloadResult: LogDownloadResult,
    additionalContext?: string,
  ): string {
    const sections: string[] = [];

    sections.push(
      `Analyze the MP product job failure reported in JIRA ticket ${jiraNumber}.`,
    );
    sections.push(
      `Identify the root cause, classify the error, propose a fix, and recommend which team should own resolution.`,
    );

    // Job context section
    if (jobContext.jobName || jobContext.client) {
      sections.push("");
      sections.push("## Job Context (Parsed from Ticket)");
      sections.push("");
      if (jobContext.jobName)
        sections.push(`- **Job Name:** ${jobContext.jobName}`);
      if (jobContext.group) sections.push(`- **Group:** ${jobContext.group}`);
      if (jobContext.envid)
        sections.push(`- **Environment ID:** ${jobContext.envid}`);
      if (jobContext.client)
        sections.push(`- **Client:** ${jobContext.client}`);
      if (jobContext.env) sections.push(`- **Environment:** ${jobContext.env}`);
      if (jobContext.commandLine)
        sections.push(`- **Command Line:** \`${jobContext.commandLine}\``);
    }

    // Log files section
    if (downloadResult.files.length > 0) {
      sections.push("");
      sections.push("## Log Files Location");
      sections.push("");
      sections.push(
        "Pre-downloaded .log files are available in your working directory.",
      );
      sections.push("");
      sections.push(
        "**Start by reading `_INDEX.md`** — it lists all available log files.",
      );
      sections.push(
        "Then use Grep to search for error patterns across all files.",
      );
      sections.push("");
      sections.push("### Available Log Files");
      for (const f of downloadResult.files) {
        sections.push(`- \`${f.filename}\` (${this.formatBytes(f.sizeBytes)})`);
      }

      if (downloadResult.skippedFiles.length > 0) {
        sections.push("");
        sections.push("**Skipped files (too large or download failed):**");
        for (const s of downloadResult.skippedFiles) {
          sections.push(`- \`${s.filename}\` — ${s.reason}`);
        }
      }

      sections.push("");
      sections.push(`### Total Size`);
      sections.push(
        `${this.formatBytes(downloadResult.totalBytes)} across ${downloadResult.files.length} file(s)`,
      );
    } else {
      sections.push("");
      sections.push("## No Log Files Available");
      sections.push("");
      sections.push(
        "No .log attachments were found on the JIRA ticket. Analyze the ticket description and any available repository code to determine the likely cause.",
      );
    }

    // MP repos section
    if (this.repoIds.length > 0) {
      sections.push("");
      sections.push("## MP Repositories Available");
      sections.push("");
      sections.push(
        "You have access to MP product repositories for cross-referencing:",
      );
      for (const repoId of this.repoIds) {
        sections.push(`- \`${repoId}\``);
      }
      sections.push("");
      if (jobContext.client) {
        sections.push(
          `**Hint:** Look for config files related to client "${jobContext.client}" in mp-product-client-configs.`,
        );
      }
    }

    // Additional context (ticket description, comments, custom fields)
    if (additionalContext) {
      sections.push("");
      sections.push("---");
      sections.push("## Ticket Details");
      sections.push(additionalContext);
    }

    return sections.join("\n");
  }

  /**
   * Extract a named field from the additional context string.
   * Looks for patterns like "Summary: value" or "## Summary\nvalue"
   */
  private extractField(
    context: string | undefined,
    fieldName: string,
  ): string | undefined {
    if (!context) return undefined;

    // Try "Field: value" pattern
    const lineMatch = context.match(
      new RegExp(`^${fieldName}:\\s*(.+)$`, "mi"),
    );
    if (lineMatch) return lineMatch[1].trim();

    // Try "## Field\nvalue" pattern
    const sectionMatch = context.match(
      new RegExp(`## ${fieldName}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, "i"),
    );
    if (sectionMatch) return sectionMatch[1].trim();

    return undefined;
  }
}

export default FORGEAgent;
