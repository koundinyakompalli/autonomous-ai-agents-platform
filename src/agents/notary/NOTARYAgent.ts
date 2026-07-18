/**
 * NOTARY Agent — Client Notes Review
 *
 * Reviews client notes (customfield_10044) on all MPDEV tickets for a given
 * release source version. Classifies tickets, generates AI drafts in Scott's
 * writing style, verifies existing notes against the codebase at the release
 * git tag, and labels tickets accordingly.
 *
 * ## Lifecycle
 * 1. [NOTARY_INIT]         — Agent created with Jira credentials + repo path
 * 2. [NOTARY_FETCH]        — All tickets for the release fetched from Jira
 * 3. [NOTARY_CLASSIFY]     — Each ticket classified (A/B/C/D/E/SKIPPED)
 * 4. [NOTARY_DRAFT]        — Claude SDK generates drafts for B+D tickets
 * 5. [NOTARY_WRITE_BACK]   — Drafts appended + labels set in Jira
 * 6. [NOTARY_SUMMARY]      — Summary table produced
 */

import {
    runAgent,
    getAgentPrompt,
    registerRepoFromPath,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/logger.js';
import {
    NOTARYJiraService,
    LABEL_REVIEWED_NOTES,
    LABEL_DRAFT_NOTES,
} from './NOTARYJiraService.js';
import type {
    NOTARYAgentOptions,
    NOTARYResult,
    NOTARYStructuredSummary,
    TicketRecord,
    TicketClassification,
    TicketProcessingResult,
    NOTARYDraftOutput,
} from './types.js';
import { NOTARY_OUTPUT_SCHEMA } from './types.js';
import type { EventEmitter } from 'events';

const logger = createLogger('notary-agent');

/** Deferral patterns that classify a ticket as category B */
const DEFERRAL_PATTERNS = [
    /need to speak with/i,
    /need to tag/i,
    /need to ask/i,
    /NOTE TO SELF/i,
    /\bTODO\b/,
    /\bTBD\b/,
    /\bpending\b/i,
    /will use info from/i,
    /will create/i,
    /will update/i,
    /waiting on/i,
    /waiting for/i,
    /SCOTT NOTE TO DEVEL/i,
    /SCOTT NOTE TO SELF/i,
    /s\/w /i,           // Scott's shorthand for "speak with"
    /skipping for now/i,
];

/** Patterns that suggest a ticket is internal/infrastructure (category C) */
const INTERNAL_PATTERNS = [
    /\bscript\b/i,
    /\bprocedure\b/i,
    /\bdeployment\b/i,
    /\brefactor\b/i,
    /\binternal\b/i,
    /\bmigration\b/i,
    /\bdb script\b/i,
    /\bsql script\b/i,
    /PER SCOTT.*no release notes/i,
    /Per Scott.*No Release Notes/i,
    /no release notes/i,
];

export class NOTARYAgent {
    private options: NOTARYAgentOptions;
    private jira: NOTARYJiraService;
    private repoId: string;
    private instanceId: string;

    constructor(options: NOTARYAgentOptions) {
        this.instanceId = `notary-${Date.now()}`;
        this.options = {
            timeoutMs: 45 * 60 * 1000, // 45 minutes default
            ...options,
        };

        this.jira = new NOTARYJiraService(
            options.jiraBaseUrl,
            options.jiraUsername,
            options.jiraToken,
        );

        // Register the tag-checked-out repo with the Claude SDK repo registry
        this.repoId = registerRepoFromPath(options.repositoryPath);

        logger.info({
            instanceId: this.instanceId,
            releaseVersion: options.releaseVersion,
            repositoryPath: options.repositoryPath,
            repoId: this.repoId,
        }, '[NOTARY_INIT] NOTARYAgent initialized');
    }

    // ─── Main Entry Point ─────────────────────────────────────────────────────

    async analyze(): Promise<NOTARYResult> {
        const startTime = Date.now();
        const logCtx = { instanceId: this.instanceId, release: this.options.releaseVersion };

        logger.info(logCtx, '[NOTARY_ANALYZE_START] Starting client notes review');

        try {
            // Phase 1: Fetch all tickets for this release
            logger.info(logCtx, '[NOTARY_FETCH] Fetching release tickets from Jira');
            const tickets = await this.jira.fetchReleaseTickets(this.options.releaseVersion);
            this.options.onProgress?.(`Fetched ${tickets.length} tickets for release ${this.options.releaseVersion}`);

            // Phase 2: Classify each ticket
            logger.info({ ...logCtx, count: tickets.length }, '[NOTARY_CLASSIFY] Classifying tickets');
            for (const ticket of tickets) {
                ticket.classification = this.classify(ticket);
            }

            const byClass = this.groupByClassification(tickets);
            logger.info({ ...logCtx, counts: byClass }, '[NOTARY_CLASSIFY_DONE] Classification complete');
            this.options.onProgress?.(
                `Classified: ${byClass.A} pre-reviewed, ${byClass.B} deferral, ` +
                `${byClass.C} internal-empty, ${byClass.D} needs-draft, ` +
                `${byClass.E} verify, ${byClass.SKIPPED} skipped`,
            );

            // Phase 3: AI draft generation + codebase verification (B, D, E tickets)
            const draftTargets = tickets.filter(t => t.classification === 'B' || t.classification === 'D');
            const verifyTargets = tickets.filter(t => t.classification === 'E');

            let claudeResult: AgentResult | null = null;
            let totalToolCalls = 0;
            let totalTokens: { input: number; output: number } | undefined;
            let totalCost: number | undefined;

            if (draftTargets.length > 0 || verifyTargets.length > 0) {
                logger.info({
                    ...logCtx,
                    drafts: draftTargets.length,
                    verifications: verifyTargets.length,
                }, '[NOTARY_DRAFT] Invoking Claude SDK for drafts + verification');

                const taskPrompt = this.buildClaudePrompt(draftTargets, verifyTargets, tickets);

                claudeResult = await this.runClaudeAgent(taskPrompt);
                totalToolCalls = claudeResult.metrics.toolCalls;
                totalTokens = claudeResult.metrics.tokensUsed;
                totalCost = claudeResult.metrics.costUsd;
            }

            // Phase 4: Apply Claude's decisions — write drafts back to Jira, set labels
            logger.info(logCtx, '[NOTARY_WRITE_BACK] Writing drafts and labels to Jira');
            await this.applyResults(tickets, claudeResult);

            // Phase 5: Handle pre-classified tickets (A, C, SKIPPED) — no Jira writes needed
            for (const ticket of tickets) {
                if (ticket.classification === 'A' && !ticket.processingResult) {
                    ticket.processingResult = { outcome: 'pre_reviewed' };
                } else if (ticket.classification === 'C' && !ticket.processingResult) {
                    ticket.processingResult = { outcome: 'internal_no_notes' };
                } else if (ticket.classification === 'SKIPPED' && !ticket.processingResult) {
                    ticket.processingResult = { outcome: 'skipped_issue_type' };
                }
            }

            const durationMs = Date.now() - startTime;
            const report = this.buildSummaryReport(tickets);
            const structured = this.buildStructuredSummary(tickets);

            const draftsGenerated = tickets.filter(t => t.processingResult?.outcome === 'draft_appended').length;
            const notesVerified = tickets.filter(t => t.processingResult?.outcome === 'verified').length;

            logger.info({
                ...logCtx,
                durationMs,
                totalTickets: tickets.length,
                draftsGenerated,
                notesVerified,
                totalToolCalls,
            }, '[NOTARY_ANALYZE_COMPLETE] Client notes review complete');

            return {
                success: true,
                report,
                tickets,
                structured,
                metrics: {
                    durationMs,
                    toolCalls: totalToolCalls,
                    ticketsProcessed: tickets.length,
                    draftsGenerated,
                    notesVerified,
                    tokensUsed: totalTokens,
                    costUsd: totalCost,
                },
            };
        } catch (error: any) {
            const durationMs = Date.now() - startTime;
            logger.error({ ...logCtx, durationMs, error: error.message, stack: error.stack },
                '[NOTARY_ANALYZE_ERROR] Unhandled error in NOTARY analysis');
            return {
                success: false,
                report: '',
                tickets: [],
                metrics: { durationMs, toolCalls: 0, ticketsProcessed: 0, draftsGenerated: 0, notesVerified: 0 },
                error: error.message,
            };
        }
    }

    // ─── Classification ───────────────────────────────────────────────────────

    private classify(ticket: TicketRecord): TicketClassification {
        // Skip non-applicable issue types
        if (NOTARYJiraService.isSkippedIssueType(ticket.issueType)) return 'SKIPPED';

        // A: Already reviewed
        if (ticket.labels.includes(LABEL_REVIEWED_NOTES)) return 'A';

        const text = ticket.clientNotesText.trim();

        // Empty notes
        if (!text) {
            // C: Internal/infrastructure
            if (this.isInternalTicket(ticket)) return 'C';
            // D: User-facing, needs draft
            return 'D';
        }

        // B: Has content but contains deferral language
        if (DEFERRAL_PATTERNS.some(p => p.test(text))) return 'B';

        // E: Has substantive notes — needs codebase verification
        return 'E';
    }

    private isInternalTicket(ticket: TicketRecord): boolean {
        const haystack = `${ticket.summary} ${ticket.description}`;
        return INTERNAL_PATTERNS.some(p => p.test(haystack));
    }

    private groupByClassification(tickets: TicketRecord[]): Record<TicketClassification, number> {
        const counts: Record<TicketClassification, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, SKIPPED: 0 };
        for (const t of tickets) counts[t.classification]++;
        return counts;
    }

    // ─── Claude SDK Invocation ────────────────────────────────────────────────

    private buildClaudePrompt(
        draftTargets: TicketRecord[],
        verifyTargets: TicketRecord[],
        allTickets: TicketRecord[],
    ): string {
        const lines: string[] = [
            `# NOTARY Task — Release ${this.options.releaseVersion}`,
            '',
            'You are reviewing client notes for an MP software release.',
            `The codebase is checked out at tag ${this.options.releaseVersion} in your working directory.`,
            '',
        ];

        if (draftTargets.length > 0) {
            lines.push('## Tickets Needing AI Draft (Categories B and D)');
            lines.push('');
            lines.push('For each ticket below, generate client notes in Scott\'s style.');
            lines.push('Research the codebase to understand the fix/enhancement before writing.');
            lines.push('');

            for (const t of draftTargets) {
                lines.push(`### ${t.key} — ${t.summary} [${t.issueType}] [Category ${t.classification}]`);
                lines.push(`**Description:** ${t.description || '(none)'}`);
                if (t.clientNotesText) {
                    lines.push(`**Existing (incomplete) notes:** ${t.clientNotesText}`);
                }
                lines.push('');
            }
        }

        if (verifyTargets.length > 0) {
            lines.push('## Tickets Needing Verification (Category E)');
            lines.push('');
            lines.push('For each ticket below, verify the existing client notes against the codebase.');
            lines.push('If the notes are significantly inaccurate, provide suggested_notes_text with corrected notes in Scott\'s style.');
            lines.push('');

            for (const t of verifyTargets) {
                lines.push(`### ${t.key} — ${t.summary} [${t.issueType}]`);
                lines.push(`**Existing notes:** ${t.clientNotesText}`);
                lines.push('');
            }
        }

        lines.push('## Output');
        lines.push('Return structured output with one entry per ticket processed.');

        return lines.join('\n');
    }

    private async runClaudeAgent(taskPrompt: string): Promise<AgentResult> {
        const taskId = `${this.instanceId}-${Date.now()}`;
        let progressCount = 0;

        const onProgress = (update: ProgressUpdate) => {
            progressCount++;
            if (update.toolName) {
                this.options.onProgress?.(`[${progressCount}] ${update.toolName}`);
                if (this.options.eventEmitter) {
                    this.options.eventEmitter.emit('agent:progress', update);
                }
            }
        };

        return runAgent({
            taskId,
            taskPrompt,
            repoIds: [this.repoId],
            agentType: 'notary',
            systemAppend: getAgentPrompt('notary'),
            permissionLevel: 'read_only', // Read codebase + git only — no writes
            timeoutMs: this.options.timeoutMs,
            onProgress,
            outputSchema: NOTARY_OUTPUT_SCHEMA,
        });
    }

    // ─── Apply Results ────────────────────────────────────────────────────────

    /**
     * Apply Claude's structured output back to Jira:
     * - Append drafts to customfield_10044
     * - Add draft_client_notes label
     * - Add reviewed_notes label to verified tickets
     */
    private async applyResults(tickets: TicketRecord[], claudeResult: AgentResult | null): Promise<void> {
        const structured = claudeResult?.structuredOutput as any;
        const claudeOutputs: NOTARYDraftOutput[] = structured?.tickets ?? [];
        const outputByKey = new Map<string, NOTARYDraftOutput>(
            claudeOutputs.map((o: NOTARYDraftOutput) => [o.ticket_key, o]),
        );

        for (const ticket of tickets) {
            if (ticket.classification === 'A' || ticket.classification === 'C' || ticket.classification === 'SKIPPED') {
                continue; // No Jira writes for these
            }

            const output = outputByKey.get(ticket.key);

            if (!output) {
                // Claude didn't return output for this ticket
                ticket.processingResult = {
                    outcome: 'draft_failed',
                    notes: 'No output returned by Claude SDK',
                };
                continue;
            }

            try {
                if ((ticket.classification === 'B' || ticket.classification === 'D') && output.notes_text) {
                    // Append AI draft
                    await this.jira.appendAiDraft(ticket.key, output.notes_text);
                    await this.jira.addLabel(ticket.key, LABEL_DRAFT_NOTES);

                    ticket.processingResult = {
                        outcome: 'draft_appended',
                        draftText: output.notes_text,
                        draftLabelAdded: true,
                    };

                    logger.info({ key: ticket.key }, '[NOTARY_DRAFT_WRITTEN] Draft appended to Jira');

                } else if (ticket.classification === 'E') {
                    if (output.decision === 'verified') {
                        await this.jira.addLabel(ticket.key, LABEL_REVIEWED_NOTES);
                        ticket.processingResult = {
                            outcome: 'verified',
                            reviewedLabelAdded: true,
                            notes: output.reasoning,
                        };
                        logger.info({ key: ticket.key }, '[NOTARY_VERIFIED] Ticket marked as reviewed');

                    } else if (output.decision === 'inaccurate') {
                        // Append suggested corrected notes if provided
                        if (output.suggested_notes_text) {
                            await this.jira.appendSuggestedNotes(ticket.key, output.suggested_notes_text);
                            ticket.processingResult = {
                                outcome: 'verification_failed',
                                notes: output.reasoning ?? 'Inaccuracy detected — suggested notes appended',
                                draftText: output.suggested_notes_text,
                            };
                            logger.warn({ key: ticket.key, reason: output.reasoning },
                                '[NOTARY_INACCURATE] Ticket flagged with suggested corrections appended');
                        } else {
                            ticket.processingResult = {
                                outcome: 'verification_failed',
                                notes: output.reasoning ?? 'Inaccuracy detected — needs human review',
                            };
                            logger.warn({ key: ticket.key, reason: output.reasoning },
                                '[NOTARY_INACCURATE] Ticket flagged for human review');
                        }
                    } else {
                        ticket.processingResult = {
                            outcome: 'verified',
                            notes: output.reasoning,
                        };
                    }

                } else if (output.decision === 'no_notes_needed') {
                    ticket.processingResult = { outcome: 'internal_no_notes' };
                } else {
                    ticket.processingResult = {
                        outcome: 'draft_failed',
                        notes: `Unexpected output decision: ${output.decision}`,
                    };
                }
            } catch (err: any) {
                logger.error({ key: ticket.key, error: err.message }, '[NOTARY_WRITE_ERROR] Failed to write to Jira');
                ticket.processingResult = {
                    outcome: 'draft_failed',
                    notes: `Jira write error: ${err.message}`,
                };
            }
        }
    }

    // ─── Reporting ────────────────────────────────────────────────────────────

    private buildSummaryReport(tickets: TicketRecord[]): string {
        const lines: string[] = [
            `## Client Notes Review — Release ${this.options.releaseVersion}`,
            '',
            '| Ticket | Type | Summary | Reviewed | AI Draft | Notes |',
            '|--------|------|---------|:--------:|:--------:|-------|',
        ];

        for (const t of tickets) {
            const r = t.processingResult;
            const reviewed = r?.reviewedLabelAdded ? '✅' : (t.classification === 'A' ? '✅' : '—');
            const draft = r?.draftLabelAdded ? 'Yes' : '—';
            const note = this.outcomeNote(t);

            lines.push(`| ${t.key} | ${t.issueType} | ${t.summary.substring(0, 60)} | ${reviewed} | ${draft} | ${note} |`);
        }

        const drafted = tickets.filter(t => t.processingResult?.outcome === 'draft_appended').length;
        const reviewed = tickets.filter(t =>
            t.processingResult?.outcome === 'verified' ||
            t.processingResult?.reviewedLabelAdded ||
            t.classification === 'A',
        ).length;
        const failed = tickets.filter(t =>
            t.processingResult?.outcome === 'draft_failed' ||
            t.processingResult?.outcome === 'verification_failed',
        ).length;

        lines.push('');
        lines.push(`**Totals**: ${reviewed}/${tickets.length} reviewed, ${drafted} AI drafts generated`);

        const actionItems = tickets
            .filter(t =>
                t.processingResult?.outcome === 'draft_appended' ||
                t.processingResult?.outcome === 'verification_failed' ||
                t.processingResult?.outcome === 'draft_failed',
            )
            .map(t => `- ${t.key}: ${this.outcomeNote(t)}`);

        if (actionItems.length > 0) {
            lines.push('');
            lines.push('**Action Items:**');
            lines.push(...actionItems);
        }

        if (failed > 0) {
            lines.push('');
            lines.push(`⚠️ ${failed} ticket(s) encountered errors — check logs.`);
        }

        return lines.join('\n');
    }

    private outcomeNote(ticket: TicketRecord): string {
        const r = ticket.processingResult;
        if (!r) return '—';

        switch (r.outcome) {
            case 'pre_reviewed':       return 'Pre-existing reviewed_notes';
            case 'draft_appended':     return 'AI draft appended — pending review';
            case 'draft_failed':       return `Draft failed: ${r.notes ?? 'unknown error'}`;
            case 'verified':           return 'Verified against codebase';
            case 'verification_failed': return `Flagged: ${r.notes ?? 'inaccuracy detected'}`;
            case 'internal_no_notes':  return 'Empty — internal ticket';
            case 'skipped_issue_type': return `Skipped (${ticket.issueType})`;
            default:                   return '—';
        }
    }

    private buildStructuredSummary(tickets: TicketRecord[]): NOTARYStructuredSummary {
        const actionItems: string[] = tickets
            .filter(t =>
                t.processingResult?.outcome === 'draft_appended' ||
                t.processingResult?.outcome === 'verification_failed',
            )
            .map(t => `${t.key}: ${this.outcomeNote(t)}`);

        return {
            release_version: this.options.releaseVersion,
            total_tickets: tickets.length,
            already_reviewed: tickets.filter(t => t.classification === 'A').length,
            drafts_generated: tickets.filter(t => t.processingResult?.outcome === 'draft_appended').length,
            drafts_failed: tickets.filter(t => t.processingResult?.outcome === 'draft_failed').length,
            verified: tickets.filter(t => t.processingResult?.outcome === 'verified').length,
            verification_failed: tickets.filter(t => t.processingResult?.outcome === 'verification_failed').length,
            internal_no_notes: tickets.filter(t => t.processingResult?.outcome === 'internal_no_notes').length,
            skipped_issue_type: tickets.filter(t => t.classification === 'SKIPPED').length,
            action_items: actionItems,
        };
    }
}

export default NOTARYAgent;
