/**
 * SRLOG Types
 * SQL & Resource LOG Analyzer
 */

/** Individual Oracle/PL-SQL error found in log */
export interface SRLOGError {
    /** Oracle error code (e.g., ORA-01403, PLS-00201) */
    error_type: string;

    /** Line number in the log file */
    line_number: number;

    /** 2-3 lines of surrounding context */
    context: string;

    /** Error severity classification */
    severity: 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO';

    /** Source log file name */
    log_file: string;

    /** Oracle error code if distinct from error_type */
    oracle_error_code?: string;

    /** PL/SQL unit name (procedure, function, package) if identifiable */
    plsql_unit?: string;
}

/** Recurring error pattern */
export interface SRLOGPattern {
    pattern: string;
    occurrences: number;
    description: string;
}

/** Actionable recommendation */
export interface SRLOGRecommendation {
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    description: string;
    related_errors: string[];
}

/** Structured output from SRLOG analysis */
export interface SRLOGStructuredOutput {
    errors_found: SRLOGError[];
    summary: {
        total_errors: number;
        critical_count: number;
        error_count: number;
        warning_count: number;
        info_count: number;
        files_analyzed: number;
        total_lines_analyzed: number;
    };
    recommendations: SRLOGRecommendation[];
    patterns?: SRLOGPattern[];
}

/** SRLOG agent options */
export interface SRLOGAgentOptions {
    /** JIRA account email for Basic auth */
    jiraUsername?: string;

    /** JIRA API token */
    jiraToken?: string;

    /** Optional repository path for workspace */
    repositoryPath?: string;

    /** Optional repository ID */
    repoId?: string;

    /** Optional event emitter for monitoring */
    eventEmitter?: import('events').EventEmitter;

    /** Optional progress callback */
    onProgress?: (message: string) => void;

    /** Timeout in milliseconds (default: 15 minutes) */
    timeoutMs?: number;

    /** Webhook URL for audit events */
    webhookUrl?: string;
}

/** SRLOG analysis result */
export interface SRLOGResult {
    /** Whether analysis completed successfully */
    success: boolean;

    /** Full analysis report markdown */
    report: string;

    /** Structured output if schema was honored */
    structured?: SRLOGStructuredOutput;

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
        logDownloadMs: number;
        analysisMs: number;
    };

    /** Error if failed */
    error?: string;
}

/** Downloaded log file info */
export interface LogFileInfo {
    filename: string;
    filePath: string;
    sizeBytes: number;
}

/** Result of downloading log attachments */
export interface LogDownloadResult {
    dir: string;
    files: LogFileInfo[];
    totalBytes: number;
    skippedFiles: Array<{ filename: string; reason: string }>;
}
