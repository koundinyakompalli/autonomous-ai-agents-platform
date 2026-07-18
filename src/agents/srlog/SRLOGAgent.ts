/**
 * SRLOG - SQL & Resource LOG Analyzer
 *
 * Hybrid agent: deterministic log download + Claude SDK analysis.
 *
 * ## Lifecycle
 * 1. [SRLOG_INIT] - Agent created with options
 * 2. [SRLOG_DOWNLOAD] - Phase 1: Download .log attachments from JIRA
 * 3. [SRLOG_REGISTER] - Phase 1.5: Write logs to workspace, register as repoId
 * 4. [SRLOG_ANALYZE] - Phase 2: Claude SDK analyzes logs for Oracle/PL-SQL errors
 * 5. [SRLOG_COMPLETE] - Return structured findings
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import AdmZip from 'adm-zip';

const gunzip = promisify(zlib.gunzip);
import {
    runAgent,
    getAgentPrompt,
    registerRepo,
    registerRepoFromPath,
    registerCustomerWorkspace,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/index.js';
import type {
    SRLOGAgentOptions,
    SRLOGResult,
    SRLOGStructuredOutput,
    LogDownloadResult,
    LogFileInfo,
} from './types.js';
import type { EventEmitter } from 'events';

const logger = createLogger('srlog-agent');

/** Maximum size per log file (10 MB) to prevent token budget blowout */
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024;

/** Default EFS base path for repositories */
const EFS_BASE_PATH = '/mnt/efs/specter-repo/repositories';

export class SRLOGAgent {
    private options: SRLOGAgentOptions;
    private repoId: string | null = null;
    private repoIds: string[] = [];
    private instanceId: string;
    private jiraBaseUrl: string;
    private jiraAuthHeader: string;

    constructor(options: SRLOGAgentOptions) {
        this.instanceId = `srlog-${Date.now()}`;

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

        logger.debug(logContext, '[SRLOG_INIT] Creating SRLOGAgent instance');

        // Initialize JIRA credentials
        const jiraUsername = options.jiraUsername || process.env.JIRA_USERNAME || '';
        const jiraToken = options.jiraToken || process.env.JIRA_TOKEN || '';
        this.jiraBaseUrl = (process.env.JIRA_BASE_URL || 'https://medhokapps.atlassian.net').replace(/\/$/, '');
        this.jiraAuthHeader = `Basic ${Buffer.from(`${jiraUsername}:${jiraToken}`).toString('base64')}`;

        // Resolve repo if provided (optional — logs are the primary data source)
        if (options.repoId) {
            this.repoId = options.repoId;
            this.repoIds = [options.repoId];

            logger.info({
                ...logContext,
                repoId: this.repoId,
            }, '[SRLOG_REPO_DIRECT] Using provided repoId');
        } else if (options.repositoryPath) {
            if (options.repositoryPath.includes('/tasks/')) {
                const result = registerCustomerWorkspace(options.repositoryPath);
                this.repoId = result.workspaceId;
                this.repoIds = result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

                logger.info({
                    ...logContext,
                    workspaceId: result.workspaceId,
                    repoIds: this.repoIds,
                }, '[SRLOG_WORKSPACE_REGISTERED] Customer workspace registered');
            } else {
                this.repoId = registerRepoFromPath(options.repositoryPath);
                this.repoIds = [this.repoId];

                logger.info({
                    ...logContext,
                    repoId: this.repoId,
                }, '[SRLOG_REPO_REGISTERED] Repository registered');
            }
        } else {
            logger.info(logContext, '[SRLOG_NO_REPO] No repository configured — analysis will use JIRA log files only');
        }
    }

    /**
     * Resolve the directory path where log files should be written.
     * Uses the workspace/repository path if available, otherwise EFS base.
     */
    private resolveLogDir(jiraNumber: string): string {
        const basePath = this.options.repositoryPath || EFS_BASE_PATH;

        if (basePath.includes('/tasks/')) {
            return path.join(basePath, 'srlog-evidence');
        }

        return path.join(basePath, 'srlog-evidence', jiraNumber.replace(/[^a-zA-Z0-9-]/g, '_'));
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
    private async downloadLogAttachments(jiraNumber: string, logDir: string): Promise<LogDownloadResult> {
        const logContext = {
            instanceId: this.instanceId,
            jiraNumber,
            logDir,
        };

        logger.info(logContext, '[SRLOG_DOWNLOAD_START] Fetching JIRA attachments');

        // Fetch issue metadata
        const issueUrl = `${this.jiraBaseUrl}/rest/api/3/issue/${jiraNumber}?fields=attachment`;
        const response = await fetch(issueUrl, {
            headers: {
                'Authorization': this.jiraAuthHeader,
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`JIRA API error fetching attachments for ${jiraNumber}: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as any;
        const allAttachments: any[] = data.fields?.attachment || [];

        logger.debug({
            ...logContext,
            totalAttachments: allAttachments.length,
        }, '[SRLOG_ATTACHMENTS_FETCHED] Got attachment list from JIRA');

        // Filter for .log, .gz, and .zip files
        const logAttachments = allAttachments.filter((att: any) => {
            const filename = (att.filename || '').toLowerCase();
            return filename.endsWith('.log') || filename.endsWith('.gz') || filename.endsWith('.zip');
        });

        if (logAttachments.length === 0) {
            logger.warn(logContext, '[SRLOG_NO_LOGS] No .log/.gz/.zip attachments found on JIRA ticket');
            return { dir: logDir, files: [], totalBytes: 0, skippedFiles: [] };
        }

        logger.info({
            ...logContext,
            logAttachmentCount: logAttachments.length,
        }, '[SRLOG_LOG_ATTACHMENTS_FOUND] Found .log attachments');

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

            // Skip oversized files (applies to direct .log and archives)
            if (sizeBytes > MAX_LOG_FILE_SIZE) {
                const reason = `File size ${this.formatBytes(sizeBytes)} exceeds limit ${this.formatBytes(MAX_LOG_FILE_SIZE)}`;
                logger.warn({ ...logContext, filename: originalFilename, sizeBytes }, `[SRLOG_SKIP_LARGE] ${reason}`);
                skippedFiles.push({ filename: originalFilename, reason });
                continue;
            }

            logger.info({
                ...logContext,
                originalFilename,
                sizeBytes,
            }, '[SRLOG_DOWNLOADING] Downloading attachment');

            const fileResponse = await fetch(attachment.content, {
                headers: { 'Authorization': this.jiraAuthHeader },
            });

            if (!fileResponse.ok) {
                const reason = `Download failed: ${fileResponse.status} ${fileResponse.statusText}`;
                logger.error({ ...logContext, filename: originalFilename }, `[SRLOG_DOWNLOAD_FAILED] ${reason}`);
                skippedFiles.push({ filename: originalFilename, reason });
                continue;
            }

            const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());

            // --- Handle .zip archives ---
            if (lowerFilename.endsWith('.zip')) {
                logger.info({ ...logContext, originalFilename }, '[SRLOG_ZIP] Extracting .zip archive');
                const extracted = this.extractZip(fileBuffer, originalFilename, logDir, usedFilenames, logContext);
                for (const f of extracted) {
                    downloadedFiles.push(f);
                    totalBytes += f.sizeBytes;
                }
                if (extracted.length === 0) {
                    skippedFiles.push({ filename: originalFilename, reason: 'No .log files found inside archive' });
                }
                continue;
            }

            // --- Handle .gz archives ---
            if (lowerFilename.endsWith('.gz')) {
                logger.info({ ...logContext, originalFilename }, '[SRLOG_GZ] Extracting .gz archive');
                const extracted = await this.extractGz(fileBuffer, originalFilename, logDir, usedFilenames, logContext);
                if (extracted) {
                    downloadedFiles.push(extracted);
                    totalBytes += extracted.sizeBytes;
                } else {
                    skippedFiles.push({ filename: originalFilename, reason: 'Decompressed file is not a .log or extraction failed' });
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

            logger.info({
                ...logContext,
                filename,
                filePath,
                sizeBytes: actualSize,
            }, '[SRLOG_DOWNLOADED] Log file saved');
        }

        return { dir: logDir, files: downloadedFiles, totalBytes, skippedFiles };
    }

    /**
     * Extract a .gz file: decompress and save as the base filename (without .gz).
     * Returns LogFileInfo if the decompressed file is a .log, otherwise null.
     */
    private async extractGz(
        gzBuffer: Buffer,
        originalFilename: string,
        logDir: string,
        usedFilenames: Set<string>,
        logContext: Record<string, any>,
    ): Promise<LogFileInfo | null> {
        // Remove .gz extension to get the inner filename
        const innerName = originalFilename.endsWith('.gz')
            ? originalFilename.slice(0, -3)
            : `${originalFilename}.decompressed`;

        if (!innerName.toLowerCase().endsWith('.log')) {
            logger.debug({ ...logContext, innerName }, '[SRLOG_GZ_SKIP] Decompressed file is not a .log — skipping');
            return null;
        }

        let decompressed: Buffer;
        try {
            decompressed = await gunzip(gzBuffer);
        } catch (err) {
            logger.error({ ...logContext, originalFilename, error: err instanceof Error ? err.message : 'Unknown' }, '[SRLOG_GZ_ERROR] Failed to decompress .gz file');
            return null;
        }

        // Resolve unique filename
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

        logger.info({ ...logContext, originalFilename, filename, sizeBytes: decompressed.length }, '[SRLOG_GZ_EXTRACTED] Extracted .gz to .log');
        return { filename, filePath, sizeBytes: decompressed.length };
    }

    /**
     * Extract .log files from a .zip archive.
     * Returns all LogFileInfo entries for .log files found inside.
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
            logger.error({ ...logContext, originalFilename, error: err instanceof Error ? err.message : 'Unknown' }, '[SRLOG_ZIP_ERROR] Failed to open .zip file');
            return [];
        }

        const entries = zip.getEntries();
        const extracted: LogFileInfo[] = [];

        for (const entry of entries) {
            if (entry.isDirectory) continue;

            const entryName = path.basename(entry.entryName);
            if (!entryName.toLowerCase().endsWith('.log')) continue;

            const entryData = entry.getData();
            if (entryData.length > MAX_LOG_FILE_SIZE) {
                logger.warn({ ...logContext, entryName, sizeBytes: entryData.length }, '[SRLOG_ZIP_SKIP_LARGE] Entry exceeds size limit');
                continue;
            }

            // Resolve unique filename
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

            logger.info({ ...logContext, originalFilename, entryName, filename, sizeBytes: entryData.length }, '[SRLOG_ZIP_EXTRACTED] Extracted .log from .zip');
            extracted.push({ filename, filePath, sizeBytes: entryData.length });
        }

        if (extracted.length === 0) {
            logger.warn({ ...logContext, originalFilename }, '[SRLOG_ZIP_NO_LOGS] No .log files found inside .zip archive');
        }

        return extracted;
    }

    private writeIndexFile(logDir: string, jiraNumber: string, downloadResult: LogDownloadResult): void {
        const lines = [
            `# SRLOG Evidence Index`,
            ``,
            `**Ticket:** ${jiraNumber}`,
            `**Generated:** ${new Date().toISOString()}`,
            ``,
            `## Downloaded Log Files`,
            ``,
        ];

        for (const file of downloadResult.files) {
            lines.push(`- \`${file.filename}\` (${this.formatBytes(file.sizeBytes)})`);
        }

        if (downloadResult.skippedFiles.length > 0) {
            lines.push(``, `## Skipped Files`, ``);
            for (const skipped of downloadResult.skippedFiles) {
                lines.push(`- \`${skipped.filename}\` — ${skipped.reason}`);
            }
        }

        lines.push(``, `## Summary`, ``, `- Total files: ${downloadResult.files.length}`, `- Total size: ${this.formatBytes(downloadResult.totalBytes)}`);

        fs.writeFileSync(path.join(logDir, '_INDEX.md'), lines.join('\n'));
    }

    /**
     * Run the full SRLOG analysis pipeline:
     * 1. Download .log attachments from JIRA (deterministic)
     * 1.5. Write files to workspace, register as repoId
     * 2. Claude SDK analyzes logs for Oracle/PL-SQL errors
     *
     * @param jiraNumber - JIRA ticket key (e.g., SEN-123, CPSUP-456)
     * @param additionalContext - Optional additional context from task description
     */
    async analyze(
        jiraNumber: string,
        additionalContext?: string,
    ): Promise<SRLOGResult> {
        const taskId = `${this.instanceId}-${Date.now()}`;
        const startTime = Date.now();

        const logContext = {
            instanceId: this.instanceId,
            taskId,
            jiraNumber,
            repoId: this.repoId,
            repoIds: this.repoIds,
        };

        logger.info({
            ...logContext,
            hasAdditionalContext: !!additionalContext,
        }, '[SRLOG_ANALYZE_START] Starting SRLOG log analysis');

        try {
            // ================================================================
            // Phase 1: Download log attachments from JIRA
            // ================================================================
            logger.info(logContext, '[SRLOG_DOWNLOAD_PHASE] Phase 1: Downloading .log attachments');
            const downloadStartTime = Date.now();

            const logDir = this.resolveLogDir(jiraNumber);
            const downloadResult = await this.downloadLogAttachments(jiraNumber, logDir);
            const logDownloadMs = Date.now() - downloadStartTime;

            if (downloadResult.files.length === 0) {
                logger.error({
                    ...logContext,
                    logDownloadMs,
                    skippedFiles: downloadResult.skippedFiles,
                }, '[SRLOG_NO_LOGS_ERROR] No .log files downloaded — cannot analyze');

                return {
                    success: false,
                    report: '',
                    metrics: {
                        durationMs: Date.now() - startTime,
                        toolCalls: 0,
                        logDownloadMs,
                        analysisMs: 0,
                    },
                    error: `No .log attachments found on JIRA ticket ${jiraNumber}. Please attach Oracle/SQL log files with a .log extension.`,
                };
            }

            logger.info({
                ...logContext,
                logDownloadMs,
                filesDownloaded: downloadResult.files.length,
                totalBytes: downloadResult.totalBytes,
                skippedCount: downloadResult.skippedFiles.length,
            }, '[SRLOG_DOWNLOAD_COMPLETE] Phase 1 complete: Log files downloaded');

            // ================================================================
            // Phase 1.5: Write index file and register directory as repoId
            // ================================================================
            this.writeIndexFile(logDir, jiraNumber, downloadResult);

            const logRepoId = `srlog_logs_${jiraNumber.replace(/[^a-zA-Z0-9]/g, '_')}`;
            registerRepo(logRepoId, logDir);

            // Place log dir first — it's the primary working directory for Claude
            const allRepoIds = [logRepoId, ...this.repoIds];

            logger.info({
                ...logContext,
                logDir,
                logRepoId,
                allRepoIds,
            }, '[SRLOG_REGISTER] Log directory registered for Claude SDK access');

            // ================================================================
            // Phase 2: Claude SDK Analysis
            // ================================================================
            logger.info(logContext, '[SRLOG_ANALYZE_PHASE] Phase 2: Analyzing logs via Claude SDK');
            const analysisStartTime = Date.now();

            // Build progress handler
            const onProgress = (update: ProgressUpdate) => {
                if (this.options.onProgress) {
                    const message = update.toolName
                        ? `Analyzing: ${update.toolName}`
                        : update.message ?? `Analyzing logs... (${update.elapsed}ms)`;
                    this.options.onProgress(message);
                }
                if (this.options.eventEmitter) {
                    this.options.eventEmitter.emit('agent:progress', update);
                }
            };

            // Build task prompt directing Claude to the downloaded log files
            const fileList = downloadResult.files
                .map(f => `- \`${f.filename}\` (${this.formatBytes(f.sizeBytes)})`)
                .join('\n');

            const skippedSection = downloadResult.skippedFiles.length > 0
                ? `\n\n**Skipped files (too large or download failed):**\n${downloadResult.skippedFiles.map(s => `- \`${s.filename}\` — ${s.reason}`).join('\n')}`
                : '';

            const taskPrompt = [
                `Analyze the Oracle/PL-SQL log files from JIRA ticket ${jiraNumber} for errors and issues.`,
                ``,
                `## Log Files Location`,
                ``,
                `Pre-downloaded .log files are available in your working directory.`,
                ``,
                `**Start by reading \`_INDEX.md\`** — it lists all available log files.`,
                `Then use Grep to search for Oracle error patterns (ORA-, PLS-, SP2-, TNS-) across all files.`,
                ``,
                `### Available Log Files`,
                fileList,
                skippedSection,
                ``,
                `### Total Size`,
                `${this.formatBytes(downloadResult.totalBytes)} across ${downloadResult.files.length} file(s)`,
                additionalContext ? `\n---\n## Additional Context\n${additionalContext}` : '',
            ].filter(Boolean).join('\n');

            logger.info({
                ...logContext,
                taskPromptLength: taskPrompt.length,
                filesInPrompt: downloadResult.files.length,
            }, '[SRLOG_PROMPT_BUILT] Task prompt built for Claude');

            const result = await runAgent({
                taskId,
                taskPrompt,
                repoIds: allRepoIds,
                agentType: 'srlog' as const,
                systemAppend: getAgentPrompt('srlog'),
                permissionLevel: 'read_only' as const,
                webhookUrl: this.options.webhookUrl,
                timeoutMs: this.options.timeoutMs,
                onProgress,
            });

            const analysisMs = Date.now() - analysisStartTime;

            logger.info({
                ...logContext,
                analysisMs,
                toolCalls: result.metrics.toolCalls,
                outputLength: result.output.length,
                success: result.success,
            }, '[SRLOG_ANALYZE_COMPLETE] Phase 2 complete: Analysis generated');

            if (!result.success) {
                logger.error({
                    ...logContext,
                    error: result.error,
                }, '[SRLOG_ANALYZE_FAILED] Claude SDK returned failure');

                return {
                    success: false,
                    report: '',
                    metrics: {
                        durationMs: Date.now() - startTime,
                        toolCalls: result.metrics.toolCalls,
                        tokensUsed: result.metrics.tokensUsed,
                        costUsd: result.metrics.costUsd,
                        logDownloadMs,
                        analysisMs,
                    },
                    error: result.error || 'Log analysis failed',
                };
            }

            // Parse structured output if present
            let structured: SRLOGStructuredOutput | undefined;
            try {
                if (result.structuredOutput) {
                    structured = result.structuredOutput as SRLOGStructuredOutput;
                }
            } catch {
                // Non-fatal — structured output is best-effort
            }

            const durationMs = Date.now() - startTime;

            logger.info({
                ...logContext,
                durationMs,
                toolCalls: result.metrics.toolCalls,
                costUsd: result.metrics.costUsd,
                errorsFound: structured?.summary?.total_errors ?? 'unknown',
            }, '[SRLOG_ANALYZE_SUCCESS] SRLOG analysis completed successfully');

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
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logger.error({
                ...logContext,
                durationMs,
                errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined,
            }, '[SRLOG_ANALYZE_ERROR] Exception during SRLOG analysis');

            return {
                success: false,
                report: '',
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
}

export default SRLOGAgent;
