/**
 * VERITAS Types
 * Verified Evidence-based Root-cause Investigation Truth & Analysis System
 */

/** Evidence source type identifier */
export type EvidenceSourceType = 'sen_ticket' | 'linked_ticket' | 'comment' | 'code_reference';

/** A single evidence source with metadata */
export interface EvidenceSource {
    type: EvidenceSourceType;
    key: string;           // e.g., SEN-123, CPCLIENT-456
    title?: string;
    fetchedAt: string;     // ISO timestamp
    commentCount?: number;
}

/** A linked ticket with its details and comments */
export interface LinkedTicket {
    key: string;
    summary: string;
    status: string;
    priority?: string;
    issueType?: string;
    created?: string;
    resolved?: string;
    description?: string;
    comments: TicketComment[];
    linkType?: string;     // e.g., "is caused by", "relates to"
}

/** A single JIRA comment */
export interface TicketComment {
    id: string;
    author: string;
    created: string;
    body: string;
}

/** SEN ticket with full details */
export interface SENTicket {
    key: string;
    summary: string;
    status: string;
    priority?: string;
    issueType?: string;
    created?: string;
    resolved?: string;
    description?: string;
    labels: string[];
    comments: TicketComment[];
    linkedIssueKeys: string[];
}

/** Collected evidence package for Claude */
export interface EvidencePackage {
    senTicket: SENTicket;
    linkedTickets: LinkedTicket[];
    evidenceMarkdown: string;
    sources: EvidenceSource[];
    /** Repo hints extracted from evidence (populated by Phase 1.5) */
    repoHints: string[];
}

/** VERITAS agent options */
export interface VERITASAgentOptions {
    /** Jira account email for Basic auth */
    jiraUsername?: string;

    /** JIRA API token for the agent */
    jiraToken?: string;

    /** Optional repository path for code exploration */
    repositoryPath?: string;

    /** Optional repository ID */
    repoId?: string;

    /** Optional event emitter for monitoring */
    eventEmitter?: import('events').EventEmitter;

    /** Optional progress callback */
    onProgress?: (message: string) => void;

    /** Timeout in milliseconds (default: 20 minutes) */
    timeoutMs?: number;

    /** Webhook URL for audit events */
    webhookUrl?: string;
}

/** VERITAS analysis result */
export interface VERITASResult {
    /** Whether analysis completed successfully */
    success: boolean;

    /** Full RCA report markdown */
    rcaReport: string;

    /** Evidence sources used */
    sources: EvidenceSource[];

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
        evidenceCollectionMs: number;
        rcaGenerationMs: number;
    };

    /** Error if failed */
    error?: string;
}
