/**
 * VERITAS Evidence Collector
 *
 * Deterministic pre-processing phase: collects all evidence from JIRA
 * before passing it to Claude for RCA generation.
 *
 * Fetches:
 * - SEN ticket with full details and all comments
 * - Linked CPCLIENT-* (and other) tickets with comments
 * - Builds a structured evidence markdown document
 * - Writes evidence files to disk for Claude to explore via tools
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../../utils/logger.js';
import { VERITASJiraService } from './VERITASJiraService.js';
import type { EvidencePackage, EvidenceSource, LinkedTicket, SENTicket, TicketComment } from './types.js';

const logger = createLogger('veritas-evidence-collector');

/** Result of writing evidence files to disk */
export interface EvidenceWriteResult {
    /** Absolute path to the evidence directory */
    evidenceDir: string;
    /** List of files written (relative to evidenceDir) */
    filesWritten: string[];
    /** Total bytes written across all files */
    totalBytesWritten: number;
    /** Per-file sizes in bytes */
    fileSizes: Record<string, number>;
}

export class EvidenceCollector {
    private jira: VERITASJiraService;

    constructor(jira: VERITASJiraService) {
        this.jira = jira;
    }

    /**
     * Collect all evidence for a SEN ticket
     *
     * Phase 1 of the hybrid architecture: deterministic JIRA API calls.
     * No Claude involved — just data fetching and markdown assembly.
     */
    async collectEvidence(jiraNumber: string): Promise<EvidencePackage> {
        const startTime = Date.now();

        logger.info({ jiraNumber }, '[EVIDENCE_COLLECT_START] Starting evidence collection');

        // 1. Fetch SEN ticket with full details + all comments
        const senFetchStart = Date.now();
        let senRaw: Awaited<ReturnType<VERITASJiraService['getIssueWithComments']>>;
        try {
            senRaw = await this.jira.getIssueWithComments(jiraNumber);
        } catch (error) {
            const senFetchMs = Date.now() - senFetchStart;
            logger.error({
                jiraNumber,
                senFetchMs,
                errorMessage: error instanceof Error ? error.message : 'Unknown',
                errorStack: error instanceof Error ? error.stack : undefined,
                errorName: error instanceof Error ? error.name : undefined,
            }, '[EVIDENCE_SEN_FETCH_FAILED] Failed to fetch SEN ticket — this is fatal');
            throw error;
        }
        const senFetchMs = Date.now() - senFetchStart;

        const senTicket: SENTicket = {
            key: senRaw.key,
            summary: senRaw.summary,
            status: senRaw.status,
            priority: senRaw.priority,
            issueType: senRaw.issueType,
            created: senRaw.created,
            resolved: senRaw.resolved || undefined,
            description: senRaw.description,
            labels: senRaw.labels,
            comments: senRaw.comments,
            linkedIssueKeys: senRaw.linkedIssueKeys,
        };

        const senDescriptionBytes = Buffer.byteLength(senTicket.description || '', 'utf8');
        const senCommentBytes = senTicket.comments.reduce(
            (sum, c) => sum + Buffer.byteLength(c.body, 'utf8'), 0,
        );

        logger.info({
            jiraNumber,
            senFetchMs,
            commentCount: senTicket.comments.length,
            linkedCount: senTicket.linkedIssueKeys.length,
            labelCount: senTicket.labels.length,
            labels: senTicket.labels,
            descriptionBytes: senDescriptionBytes,
            descriptionEmpty: !senTicket.description || senTicket.description.trim().length === 0,
            totalCommentBytes: senCommentBytes,
            largestCommentBytes: senTicket.comments.length > 0
                ? Math.max(...senTicket.comments.map(c => Buffer.byteLength(c.body, 'utf8')))
                : 0,
        }, '[EVIDENCE_SEN_FETCHED] SEN ticket fetched with details');

        // 2. Fetch each linked ticket with comments
        const linkedTickets: LinkedTicket[] = [];
        const linkedFetchErrors: Array<{ key: string; error: string }> = [];

        for (const linkedKey of senTicket.linkedIssueKeys) {
            const linkedFetchStart = Date.now();
            try {
                const linkedRaw = await this.jira.getIssueWithComments(linkedKey);
                const linkedFetchMs = Date.now() - linkedFetchStart;

                const linkedDescBytes = Buffer.byteLength(linkedRaw.description || '', 'utf8');
                const linkedCommentBytes = linkedRaw.comments.reduce(
                    (sum: number, c: TicketComment) => sum + Buffer.byteLength(c.body, 'utf8'), 0,
                );

                linkedTickets.push({
                    key: linkedRaw.key,
                    summary: linkedRaw.summary,
                    status: linkedRaw.status,
                    priority: linkedRaw.priority,
                    issueType: linkedRaw.issueType,
                    created: linkedRaw.created,
                    resolved: linkedRaw.resolved || undefined,
                    description: linkedRaw.description,
                    comments: linkedRaw.comments,
                });

                logger.info({
                    jiraNumber,
                    linkedKey,
                    linkedFetchMs,
                    commentCount: linkedRaw.comments.length,
                    descriptionBytes: linkedDescBytes,
                    descriptionEmpty: !linkedRaw.description || linkedRaw.description.trim().length === 0,
                    totalCommentBytes: linkedCommentBytes,
                    largestCommentBytes: linkedRaw.comments.length > 0
                        ? Math.max(...linkedRaw.comments.map((c: TicketComment) => Buffer.byteLength(c.body, 'utf8')))
                        : 0,
                    status: linkedRaw.status,
                    priority: linkedRaw.priority,
                }, '[EVIDENCE_LINKED_FETCHED] Linked ticket fetched with details');
            } catch (error) {
                const linkedFetchMs = Date.now() - linkedFetchStart;
                const errorMessage = error instanceof Error ? error.message : 'Unknown';

                linkedFetchErrors.push({ key: linkedKey, error: errorMessage });

                logger.warn({
                    jiraNumber,
                    linkedKey,
                    linkedFetchMs,
                    errorMessage,
                    errorName: error instanceof Error ? error.name : undefined,
                    errorStack: error instanceof Error ? error.stack : undefined,
                    attemptedUrl: `${linkedKey}`,
                }, '[EVIDENCE_LINKED_FETCH_FAILED] Failed to fetch linked ticket — skipping (evidence gap)');
            }
        }

        // Log summary of linked ticket fetch results
        if (linkedFetchErrors.length > 0) {
            logger.warn({
                jiraNumber,
                totalLinked: senTicket.linkedIssueKeys.length,
                fetchedCount: linkedTickets.length,
                failedCount: linkedFetchErrors.length,
                failedKeys: linkedFetchErrors.map(e => e.key),
                errors: linkedFetchErrors,
            }, '[EVIDENCE_LINKED_SUMMARY] Some linked tickets could not be fetched — evidence may be incomplete');
        }

        // 3. Build evidence sources list
        const sources: EvidenceSource[] = [
            {
                type: 'sen_ticket',
                key: senTicket.key,
                title: senTicket.summary,
                fetchedAt: new Date().toISOString(),
                commentCount: senTicket.comments.length,
            },
            ...linkedTickets.map(lt => ({
                type: 'linked_ticket' as const,
                key: lt.key,
                title: lt.summary,
                fetchedAt: new Date().toISOString(),
                commentCount: lt.comments.length,
            })),
        ];

        // 4. Build evidence markdown
        const evidenceMarkdown = this.buildEvidenceMarkdown(senTicket, linkedTickets);

        // 5. Extract repo hints from all evidence
        const repoHints = this.extractRepoHints({ senTicket, linkedTickets, evidenceMarkdown, sources, repoHints: [] });

        // Compute comprehensive size metrics
        const totalComments = senTicket.comments.length + linkedTickets.reduce((sum, lt) => sum + lt.comments.length, 0);
        const totalDescriptionBytes = senDescriptionBytes + linkedTickets.reduce(
            (sum, lt) => sum + Buffer.byteLength(lt.description || '', 'utf8'), 0,
        );
        const totalCommentBytes = senCommentBytes + linkedTickets.reduce(
            (sum, lt) => sum + lt.comments.reduce((s, c) => s + Buffer.byteLength(c.body, 'utf8'), 0), 0,
        );
        const markdownBytes = Buffer.byteLength(evidenceMarkdown, 'utf8');
        const estimatedTokens = Math.ceil(markdownBytes / 4); // ~4 bytes per token rough estimate

        const durationMs = Date.now() - startTime;
        logger.info({
            jiraNumber,
            durationMs,
            sourceCount: sources.length,
            linkedTicketsFetched: linkedTickets.length,
            linkedTicketsFailed: linkedFetchErrors.length,
            totalComments,
            totalDescriptionBytes,
            totalCommentBytes,
            markdownBytes,
            estimatedTokens,
            repoHints,
            repoHintCount: repoHints.length,
        }, '[EVIDENCE_COLLECT_COMPLETE] Evidence collection complete — full metrics');

        if (estimatedTokens > 30000) {
            logger.warn({
                jiraNumber,
                markdownBytes,
                estimatedTokens,
                totalComments,
                linkedTicketCount: linkedTickets.length,
            }, '[EVIDENCE_SIZE_WARN] Evidence package is large — consider file-based delivery to Claude');
        }

        return {
            senTicket,
            linkedTickets,
            evidenceMarkdown,
            sources,
            repoHints,
        };
    }

    /**
     * Write evidence files to disk so Claude can explore them via Read/Glob/Grep tools.
     *
     * File structure:
     *   {outputDir}/
     *     ├── _INDEX.md               (manifest of all evidence files with metadata)
     *     ├── SEN-123.md              (SEN ticket: metadata + description + comments)
     *     ├── CPCLIENT-456.md         (linked ticket: metadata + description + comments)
     *     ├── CPCLIENT-789.md         (linked ticket: metadata + description + comments)
     *     └── ...
     *
     * Each ticket file is self-contained markdown that Claude can read independently.
     */
    writeEvidenceFiles(evidence: EvidencePackage, outputDir: string): EvidenceWriteResult {
        const writeStart = Date.now();
        const filesWritten: string[] = [];
        const fileSizes: Record<string, number> = {};
        let totalBytesWritten = 0;

        logger.info({
            outputDir,
            senKey: evidence.senTicket.key,
            linkedTicketCount: evidence.linkedTickets.length,
            sourceCount: evidence.sources.length,
        }, '[EVIDENCE_WRITE_START] Writing evidence files to disk');

        // Create the output directory
        try {
            fs.mkdirSync(outputDir, { recursive: true });
            logger.debug({ outputDir }, '[EVIDENCE_WRITE_DIR] Evidence directory created');
        } catch (error) {
            logger.error({
                outputDir,
                errorMessage: error instanceof Error ? error.message : 'Unknown',
                errorStack: error instanceof Error ? error.stack : undefined,
            }, '[EVIDENCE_WRITE_DIR_FAILED] Failed to create evidence directory');
            throw error;
        }

        // Helper to write a file and track sizes
        const writeFile = (filename: string, content: string): void => {
            const filePath = path.join(outputDir, filename);
            const bytes = Buffer.byteLength(content, 'utf8');
            try {
                fs.writeFileSync(filePath, content, 'utf8');
                filesWritten.push(filename);
                fileSizes[filename] = bytes;
                totalBytesWritten += bytes;
                logger.debug({
                    filename,
                    bytes,
                    filePath,
                }, '[EVIDENCE_WRITE_FILE] Evidence file written');
            } catch (error) {
                logger.error({
                    filename,
                    filePath,
                    bytes,
                    errorMessage: error instanceof Error ? error.message : 'Unknown',
                    errorStack: error instanceof Error ? error.stack : undefined,
                }, '[EVIDENCE_WRITE_FILE_FAILED] Failed to write evidence file');
                throw error;
            }
        };

        // Write SEN ticket file
        const senContent = this.buildTicketFileContent(evidence.senTicket);
        writeFile(`${evidence.senTicket.key}.md`, senContent);

        // Write each linked ticket file
        for (const lt of evidence.linkedTickets) {
            const ltContent = this.buildLinkedTicketFileContent(lt);
            writeFile(`${lt.key}.md`, ltContent);
        }

        // Write the index file — this is what Claude reads first
        const indexContent = this.buildIndexFileContent(evidence, filesWritten, fileSizes);
        writeFile('_INDEX.md', indexContent);

        const writeMs = Date.now() - writeStart;

        logger.info({
            outputDir,
            writeMs,
            filesWritten,
            fileCount: filesWritten.length,
            totalBytesWritten,
            fileSizes,
        }, '[EVIDENCE_WRITE_COMPLETE] All evidence files written to disk');

        return {
            evidenceDir: outputDir,
            filesWritten,
            totalBytesWritten,
            fileSizes,
        };
    }

    /**
     * Build markdown file content for the SEN ticket
     */
    private buildTicketFileContent(senTicket: SENTicket): string {
        const parts: string[] = [];

        parts.push(`# ${senTicket.key}: ${senTicket.summary}\n`);
        parts.push(`| Field | Value |`);
        parts.push(`|-------|-------|`);
        parts.push(`| **Key** | ${senTicket.key} |`);
        parts.push(`| **Status** | ${senTicket.status} |`);
        parts.push(`| **Priority** | ${senTicket.priority || 'Not set'} |`);
        parts.push(`| **Issue Type** | ${senTicket.issueType || 'Not set'} |`);
        parts.push(`| **Created** | ${senTicket.created || 'Unknown'} |`);
        if (senTicket.resolved) {
            parts.push(`| **Resolved** | ${senTicket.resolved} |`);
        }
        parts.push(`| **Labels** | ${senTicket.labels.join(', ') || 'None'} |`);
        parts.push(`| **Linked Issues** | ${senTicket.linkedIssueKeys.join(', ') || 'None'} |`);
        parts.push('');

        if (senTicket.description) {
            parts.push('## Description\n');
            parts.push(senTicket.description);
            parts.push('');
        } else {
            parts.push('## Description\n');
            parts.push('_No description provided._');
            parts.push('');
        }

        parts.push(`## Comments (${senTicket.comments.length})\n`);
        if (senTicket.comments.length === 0) {
            parts.push('_No comments._');
        } else {
            for (const comment of senTicket.comments) {
                parts.push(`### ${comment.author} — ${comment.created}\n`);
                parts.push(comment.body);
                parts.push('');
            }
        }

        return parts.join('\n');
    }

    /**
     * Build markdown file content for a linked ticket
     */
    private buildLinkedTicketFileContent(lt: LinkedTicket): string {
        const parts: string[] = [];

        parts.push(`# ${lt.key}: ${lt.summary}\n`);
        parts.push(`| Field | Value |`);
        parts.push(`|-------|-------|`);
        parts.push(`| **Key** | ${lt.key} |`);
        parts.push(`| **Status** | ${lt.status} |`);
        parts.push(`| **Priority** | ${lt.priority || 'Not set'} |`);
        parts.push(`| **Issue Type** | ${lt.issueType || 'Not set'} |`);
        parts.push(`| **Created** | ${lt.created || 'Unknown'} |`);
        if (lt.resolved) {
            parts.push(`| **Resolved** | ${lt.resolved} |`);
        }
        if (lt.linkType) {
            parts.push(`| **Relationship** | ${lt.linkType} |`);
        }
        parts.push('');

        if (lt.description) {
            parts.push('## Description\n');
            parts.push(lt.description);
            parts.push('');
        } else {
            parts.push('## Description\n');
            parts.push('_No description provided._');
            parts.push('');
        }

        parts.push(`## Comments (${lt.comments.length})\n`);
        if (lt.comments.length === 0) {
            parts.push('_No comments._');
        } else {
            for (const comment of lt.comments) {
                parts.push(`### ${comment.author} — ${comment.created}\n`);
                parts.push(comment.body);
                parts.push('');
            }
        }

        return parts.join('\n');
    }

    /**
     * Build the _INDEX.md file — Claude reads this first to understand what evidence is available
     */
    private buildIndexFileContent(
        evidence: EvidencePackage,
        filesWritten: string[],
        fileSizes: Record<string, number>,
    ): string {
        const parts: string[] = [];

        parts.push(`# Evidence Index for ${evidence.senTicket.key}\n`);
        parts.push(`> This directory contains pre-collected JIRA evidence for RCA analysis.`);
        parts.push(`> Read individual ticket files for full details including all comments.\n`);

        parts.push(`## SEN Ticket\n`);
        parts.push(`| File | Key | Summary | Comments | Size |`);
        parts.push(`|------|-----|---------|----------|------|`);
        const senFile = `${evidence.senTicket.key}.md`;
        parts.push(`| [${senFile}](${senFile}) | ${evidence.senTicket.key} | ${evidence.senTicket.summary} | ${evidence.senTicket.comments.length} | ${this.formatBytes(fileSizes[senFile] || 0)} |`);
        parts.push('');

        if (evidence.linkedTickets.length > 0) {
            parts.push(`## Linked Tickets (${evidence.linkedTickets.length})\n`);
            parts.push(`| File | Key | Summary | Status | Comments | Size |`);
            parts.push(`|------|-----|---------|--------|----------|------|`);
            for (const lt of evidence.linkedTickets) {
                const ltFile = `${lt.key}.md`;
                parts.push(`| [${ltFile}](${ltFile}) | ${lt.key} | ${lt.summary} | ${lt.status} | ${lt.comments.length} | ${this.formatBytes(fileSizes[ltFile] || 0)} |`);
            }
            parts.push('');
        } else {
            parts.push(`## Linked Tickets\n`);
            parts.push(`_No linked tickets found._\n`);
        }

        parts.push(`## Evidence Statistics\n`);
        const totalComments = evidence.senTicket.comments.length +
            evidence.linkedTickets.reduce((sum, lt) => sum + lt.comments.length, 0);
        const totalBytes = Object.values(fileSizes).reduce((sum, b) => sum + b, 0);
        parts.push(`- **Total files**: ${filesWritten.length}`);
        parts.push(`- **Total tickets**: ${1 + evidence.linkedTickets.length}`);
        parts.push(`- **Total comments**: ${totalComments}`);
        parts.push(`- **Total evidence size**: ${this.formatBytes(totalBytes)}`);
        parts.push(`- **Collected at**: ${new Date().toISOString()}`);
        parts.push('');

        if (evidence.repoHints.length > 0) {
            parts.push(`## Detected Repo Hints\n`);
            parts.push(`The following repository hints were detected from the evidence:\n`);
            for (const hint of evidence.repoHints) {
                parts.push(`- \`${hint}\``);
            }
            parts.push('');
        }

        parts.push(`## How to Use This Evidence\n`);
        parts.push(`1. Start by reading this index to understand what evidence is available.`);
        parts.push(`2. Read individual ticket files (e.g., \`Read ${evidence.senTicket.key}.md\`) for full details.`);
        parts.push(`3. Use \`Grep\` to search across all evidence files for specific terms, error messages, or stack traces.`);
        parts.push(`4. Cross-reference findings with code repositories if available.`);
        parts.push('');

        return parts.join('\n');
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
     * Extract repo hints from collected evidence.
     *
     * Scans SEN + linked ticket descriptions, comments, labels, and keys
     * for patterns that indicate which code repositories are relevant:
     * - JIRA project keys (CPCLIENT → client-services, core-app)
     * - Java package patterns (com.medhok.batch → batch-jobs)
     * - Component/module names (fax-intake → batch-jobs)
     * - Explicit repo mentions (core-app, batch-jobs)
     */
    extractRepoHints(evidence: EvidencePackage): string[] {
        const hints = new Set<string>();

        // Patterns to search for in text
        const HINT_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
            // Java package patterns
            { pattern: /com\.medhok\.batch/i, hint: 'com.medhok.batch' },
            { pattern: /com\.medhok/i, hint: 'com.medhok' },
            { pattern: /MedicalMgmt/i, hint: 'MedicalMgmt' },

            // Explicit repo names
            { pattern: /\bcore-app\b/i, hint: 'core-app' },
            { pattern: /\bbatch-jobs\b/i, hint: 'batch-jobs' },
            { pattern: /\bclient-services\b/i, hint: 'client-services' },
            { pattern: /\bprovider-portal\b/i, hint: 'provider-portal' },
            { pattern: /\bReact-based-new-ui\b/i, hint: 'react' },
            { pattern: /\bDocument-ai\b/i, hint: 'document-ai' },

            // Component / module names
            { pattern: /\bweb-services\b/i, hint: 'web-services' },
            { pattern: /\bmm-web-services\b/i, hint: 'mm-web-services' },
            { pattern: /\bshared-services\b/i, hint: 'shared-services' },
            { pattern: /\bmm-shared-services\b/i, hint: 'mm-shared-services' },
            { pattern: /\bbusiness-layer\b/i, hint: 'business-layer' },
            { pattern: /\bfax-intake\b/i, hint: 'fax-intake' },
            { pattern: /\bqueue-monitor\b/i, hint: 'queue-monitor' },
            { pattern: /\bauto-tasking\b/i, hint: 'auto-tasking' },
            { pattern: /\bcorrespondence\b/i, hint: 'correspondence' },
            { pattern: /\bassessments\b/i, hint: 'assessments' },
            { pattern: /\bworkflow\b/i, hint: 'workflow' },
            { pattern: /\bocr\b/i, hint: 'ocr' },
            { pattern: /\bmd-review\b/i, hint: 'md-review' },
        ];

        // Collect all text to scan
        const textsToScan: string[] = [];

        // SEN ticket
        if (evidence.senTicket.description) textsToScan.push(evidence.senTicket.description);
        textsToScan.push(evidence.senTicket.summary);
        for (const label of evidence.senTicket.labels) textsToScan.push(label);
        for (const comment of evidence.senTicket.comments) textsToScan.push(comment.body);

        // Linked tickets
        for (const lt of evidence.linkedTickets) {
            if (lt.description) textsToScan.push(lt.description);
            textsToScan.push(lt.summary);
            for (const comment of lt.comments) textsToScan.push(comment.body);

            // Extract JIRA project key from ticket key (e.g., CPCLIENT-456 → CPCLIENT)
            const projectKey = lt.key.split('-')[0];
            if (projectKey) hints.add(projectKey);
        }

        // SEN project key
        const senProjectKey = evidence.senTicket.key.split('-')[0];
        if (senProjectKey) hints.add(senProjectKey);

        // Scan all text for patterns
        const allText = textsToScan.join('\n');
        for (const { pattern, hint } of HINT_PATTERNS) {
            if (pattern.test(allText)) {
                hints.add(hint);
            }
        }

        return Array.from(hints);
    }

    /**
     * Build a structured evidence markdown document.
     * Kept for backward compatibility / logging — primary delivery is now via files.
     */
    private buildEvidenceMarkdown(senTicket: SENTicket, linkedTickets: LinkedTicket[]): string {
        const parts: string[] = [];

        parts.push(`# Evidence Package for ${senTicket.key}\n`);

        // SEN Ticket section
        parts.push(`## SEN Ticket: ${senTicket.key}`);
        parts.push(`- **Summary**: ${senTicket.summary}`);
        parts.push(`- **Status**: ${senTicket.status}`);
        parts.push(`- **Priority**: ${senTicket.priority || 'Not set'}`);
        parts.push(`- **Issue Type**: ${senTicket.issueType || 'Not set'}`);
        parts.push(`- **Created**: ${senTicket.created || 'Unknown'}`);
        if (senTicket.resolved) {
            parts.push(`- **Resolved**: ${senTicket.resolved}`);
        }
        parts.push(`- **Labels**: ${senTicket.labels.join(', ') || 'None'}`);
        parts.push('');

        // Description
        if (senTicket.description) {
            parts.push('### Description');
            parts.push(senTicket.description);
            parts.push('');
        }

        // Comments
        if (senTicket.comments.length > 0) {
            parts.push(`### Comments (${senTicket.comments.length})`);
            for (const comment of senTicket.comments) {
                parts.push(`**${comment.author}** (${comment.created}):`);
                parts.push(comment.body);
                parts.push('');
            }
        }

        // Linked Tickets
        for (const lt of linkedTickets) {
            parts.push('---');
            parts.push(`## Linked Ticket: ${lt.key}`);
            parts.push(`- **Summary**: ${lt.summary}`);
            parts.push(`- **Status**: ${lt.status}`);
            parts.push(`- **Priority**: ${lt.priority || 'Not set'}`);
            parts.push(`- **Issue Type**: ${lt.issueType || 'Not set'}`);
            parts.push(`- **Created**: ${lt.created || 'Unknown'}`);
            if (lt.resolved) {
                parts.push(`- **Resolved**: ${lt.resolved}`);
            }
            if (lt.linkType) {
                parts.push(`- **Relationship**: ${lt.linkType}`);
            }
            parts.push('');

            if (lt.description) {
                parts.push('### Description');
                parts.push(lt.description);
                parts.push('');
            }

            if (lt.comments.length > 0) {
                parts.push(`### Comments (${lt.comments.length})`);
                for (const comment of lt.comments) {
                    parts.push(`**${comment.author}** (${comment.created}):`);
                    parts.push(comment.body);
                    parts.push('');
                }
            }
        }

        // Evidence Sources Summary
        parts.push('---');
        parts.push('## Evidence Sources Available');
        parts.push(`- [x] SEN Ticket (${senTicket.key}) — fetched with ${senTicket.comments.length} comments`);
        for (const lt of linkedTickets) {
            parts.push(`- [x] Linked Ticket (${lt.key}) — fetched with ${lt.comments.length} comments`);
        }
        parts.push('- [ ] Code Repository — available via tools if needed');
        parts.push('');

        return parts.join('\n');
    }
}
