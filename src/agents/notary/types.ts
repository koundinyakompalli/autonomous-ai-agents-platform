/**
 * NOTARY Agent Types
 *
 * NOTARY — Client Notes Review Agent
 * Reviews client notes on MPDEV tickets for a given release source version.
 * Classifies tickets, generates AI drafts in Scott's style, verifies existing
 * notes against the codebase, and labels tickets accordingly.
 */

import type { EventEmitter } from 'events';

// ─── Agent Options ────────────────────────────────────────────────────────────

export interface NOTARYAgentOptions {
    /** JIRA base URL (e.g. https://mhkjira.atlassian.net) */
    jiraBaseUrl: string;

    /** JIRA service account username (email) */
    jiraUsername: string;

    /** JIRA service account API token */
    jiraToken: string;

    /** Absolute path to the mpweb repo worktree checked out at the release tag */
    repositoryPath: string;

    /** The release source version being processed (e.g. "1.10.23") */
    releaseVersion: string;

    /** Optional event emitter for status monitoring */
    eventEmitter?: EventEmitter;

    /** Optional progress callback */
    onProgress?: (message: string) => void;

    /** Timeout in milliseconds (default: 45 minutes) */
    timeoutMs?: number;
}

// ─── Ticket Classification ────────────────────────────────────────────────────

/**
 * Classification categories for MPDEV tickets.
 *
 * A — Already reviewed (has `reviewed_notes` label)
 * B — Has deferral/incomplete language — needs AI draft
 * C — Empty notes, clearly internal/infrastructure — no notes needed
 * D — Empty notes, user-facing — needs AI draft
 * E — Has substantive notes — verify against codebase
 * SKIPPED — Issue type not applicable (Story, Epic, Sub-task, Task)
 */
export type TicketClassification = 'A' | 'B' | 'C' | 'D' | 'E' | 'SKIPPED';

export interface TicketRecord {
    key: string;
    summary: string;
    issueType: string;
    status: string;
    assignee: string;
    labels: string[];
    /** Raw ADF document or null */
    clientNotesAdf: any | null;
    /** Plain text extracted from ADF client notes */
    clientNotesText: string;
    description: string;
    classification: TicketClassification;
    /** Populated during processing */
    processingResult?: TicketProcessingResult;
}

// ─── Per-Ticket Processing Result ────────────────────────────────────────────

export type TicketOutcome =
    | 'pre_reviewed'          // Already had reviewed_notes label
    | 'draft_appended'        // AI draft written to customfield_10044
    | 'draft_failed'          // AI draft generation or write failed
    | 'verified'              // Existing notes verified against codebase
    | 'verification_failed'   // Significant inaccuracy found — flagged
    | 'internal_no_notes'     // Empty + internal ticket — no action needed
    | 'skipped_issue_type';   // Story/Epic/Sub-task/Task

export interface TicketProcessingResult {
    outcome: TicketOutcome;
    /** Generated or verified notes text (for reporting) */
    draftText?: string;
    /** Whether `draft_client_notes` label was added */
    draftLabelAdded?: boolean;
    /** Whether `reviewed_notes` label was added */
    reviewedLabelAdded?: boolean;
    /** Notes on verification discrepancies or errors */
    notes?: string;
}

// ─── Agent Result ─────────────────────────────────────────────────────────────

export interface NOTARYResult {
    success: boolean;

    /** Markdown summary table for Teams/S3 */
    report: string;

    /** All tickets processed with their outcomes */
    tickets: TicketRecord[];

    /** Structured summary counts */
    structured?: NOTARYStructuredSummary;

    metrics: {
        durationMs: number;
        toolCalls: number;
        ticketsProcessed: number;
        draftsGenerated: number;
        notesVerified: number;
        tokensUsed?: { input: number; output: number };
        costUsd?: number;
    };

    error?: string;
}

export interface NOTARYStructuredSummary {
    release_version: string;
    total_tickets: number;
    already_reviewed: number;
    drafts_generated: number;
    drafts_failed: number;
    verified: number;
    verification_failed: number;
    internal_no_notes: number;
    skipped_issue_type: number;
    action_items: string[];
}

// ─── Claude SDK Draft Generation ─────────────────────────────────────────────

/** Per-ticket draft result returned by Claude SDK */
export interface NOTARYDraftOutput {
    ticket_key: string;
    classification: TicketClassification;
    /** 'draft' = generated notes, 'verified' = confirmed accurate, 'inaccurate' = flagged */
    decision: 'draft' | 'verified' | 'inaccurate' | 'no_notes_needed';
    /** The generated or reviewed client notes text in Scott's style */
    notes_text?: string;
    /** Explanation for verification decisions or inaccuracies */
    reasoning?: string;
    /** For 'inaccurate' decisions: suggested corrected notes */
    suggested_notes_text?: string;
}

export const NOTARY_OUTPUT_SCHEMA = {
    type: 'object' as const,
    properties: {
        tickets: {
            type: 'array' as const,
            items: {
                type: 'object' as const,
                properties: {
                    ticket_key:           { type: 'string' as const },
                    classification:       { type: 'string' as const, enum: ['A', 'B', 'C', 'D', 'E', 'SKIPPED'] },
                    decision:             { type: 'string' as const, enum: ['draft', 'verified', 'inaccurate', 'no_notes_needed'] },
                    notes_text:           { type: 'string' as const },
                    reasoning:            { type: 'string' as const },
                    suggested_notes_text: { type: 'string' as const },
                },
                required: ['ticket_key', 'classification', 'decision'],
            },
        },
        summary: {
            type: 'object' as const,
            properties: {
                total_processed:  { type: 'number' as const },
                drafts_generated: { type: 'number' as const },
                verified:         { type: 'number' as const },
                action_items:     { type: 'array' as const, items: { type: 'string' as const } },
            },
            required: ['total_processed'],
        },
    },
    required: ['tickets', 'summary'],
};
