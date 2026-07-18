/**
 * LEDGER - Level-of-Effort Data Guidance Estimation Reporter
 * Type definitions
 */

export type LedgerTaskCategory =
  | 'data_load'       // INSERT/UPDATE data scripts, client onboarding — cp-medhok-data-import-monorepo
  | 'data_extract'    // SELECT-based extracts, outbound feeds — cp-medhok-data-extract-monorepo
  | 'queue_update'    // queue_authorization, incoming_image_config — cp-medhok-monorepo + cp-batch-monorepo
  | 'schema_change'   // ALTER TABLE, new columns, flyway migrations — cp-medhok-monorepo
  | 'config_change'   // product_group, sla_master, sla_bundle_crosswalk, system_variables — cp-medhok-monorepo
  | 'bi_datamart'     // BI/datamart pipelines — cp-medhok-bi-datamart-monorepo
  | 'unknown';

export interface LedgerAgentOptions {
    /** Repository ID for core monorepo (registered in repo registry) — preferred */
    repoId?: string;

    /**
     * Repository path — will auto-register.
     * Can be a customer workspace with symlinks or a direct git repo path.
     */
    repositoryPath?: string;

    /** JIRA credentials */
    jiraUsername?: string;
    jiraToken?: string;

    /** Optional event emitter for monitoring */
    eventEmitter?: import('events').EventEmitter;

    /** Optional progress callback */
    onProgress?: (message: string) => void;

    /** Timeout in milliseconds (default: 15 minutes) */
    timeoutMs?: number;

    /** Webhook URL for audit events */
    webhookUrl?: string;
}

export interface LedgerMetrics {
    durationMs: number;
    toolCalls?: number;
    tokensUsed?: { input: number; output: number };
    costUsd?: number;
    evidenceCollectionMs?: number;
    analysisMs?: number;
}

export interface LedgerResult {
    success: boolean;

    /** Full LOE analysis markdown including SQL statements */
    loeReport: string;

    /** Detected task categories (may span multiple) */
    taskCategories: LedgerTaskCategory[];

    /** Repos that were actually consulted during analysis */
    reposConsulted: string[];

    metrics: LedgerMetrics;

    error?: string;
}
