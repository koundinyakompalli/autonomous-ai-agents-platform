/**
 * FORGE Types
 * Failure Operations Root-cause Guidance Engine
 */

import type { EventEmitter } from "events";

/** Error classification categories */
export type FORGEErrorCategory =
  | "YAML_CONFIG"
  | "ORACLE_PLSQL"
  | "AUTOMATION_FRAMEWORK"
  | "WEB_UI"
  | "INFRASTRUCTURE"
  | "UNKNOWN";

/** Team routing targets */
export type FORGETeamRoute =
  | "MP_DEVOPS"
  | "MP_PLSQL_DEV"
  | "MP_WEB_DEV"
  | "MP_AUTOMATION_DEV"
  | "MP_INFRA"
  | "NEEDS_TRIAGE";

/** Individual error found in log */
export interface FORGEError {
  /** Error type or code (e.g., ORA-01403, YAMLException, NullPointerException) */
  error_type: string;

  /** Error severity classification */
  severity: "CRITICAL" | "ERROR" | "WARNING" | "INFO";

  /** 2-3 lines of surrounding context */
  context: string;

  /** Source log file name */
  log_file?: string;

  /** Line number in the log file */
  line_number?: number;

  /** Oracle error code if applicable */
  oracle_error_code?: string;
}

/** Structured output from FORGE analysis */
export interface FORGEStructuredOutput {
  root_cause: {
    /** Human-readable summary of the root cause */
    summary: string;
    /** Error classification */
    error_category: FORGEErrorCategory;
    /** Primary error identifier (e.g., "ORA-01403", "YAML parse error") */
    primary_error?: string;
    /** Detailed error description */
    error_details?: string;
    /** Affected component (e.g., "mp_automation load_beqr", "recursive_archiver") */
    affected_component?: string;
  };

  errors_found: FORGEError[];

  config_analysis?: {
    /** Config file path if relevant */
    config_file?: string;
    /** Description of the config issue */
    config_issue?: string;
    /** Expected value */
    expected_value?: string;
    /** Actual value found */
    actual_value?: string;
  };

  code_references?: Array<{
    /** Repository name */
    repo: string;
    /** File path within the repo */
    file_path: string;
    /** Why this file is relevant */
    relevance: string;
  }>;

  routing: {
    /** Recommended team to handle this issue */
    recommended_team: FORGETeamRoute;
    /** Explanation of why this team was chosen */
    routing_rationale: string;
    /** Confidence score (0-1) */
    confidence: number;
  };

  proposed_fix: {
    /** Description of the proposed fix */
    description: string;
    /** Step-by-step remediation */
    steps?: string[];
    /** Estimated effort level */
    estimated_effort?: "quick_fix" | "moderate" | "significant";
  };

  job_context?: {
    /** Full job name (e.g., "AGRP-MPPROD1-recursive_archiver") */
    job_name?: string;
    /** Job group (e.g., "AGRP") */
    group?: string;
    /** Environment ID (e.g., "MPPROD1") */
    envid?: string;
    /** Client name (e.g., "allymar") */
    client?: string;
    /** Environment (e.g., "PROD") */
    env?: string;
    /** Full command line if available */
    command_line?: string;
  };

  summary: {
    total_errors: number;
    critical_count: number;
    files_analyzed: number;
    repos_searched: string[];
  };
}

/** FORGE agent options */
export interface FORGEAgentOptions {
  /** JIRA account email for Basic auth */
  jiraUsername?: string;

  /** JIRA API token */
  jiraToken?: string;

  /** Optional repository path for workspace */
  repositoryPath?: string;

  /** Optional repository ID */
  repoId?: string;

  /** Optional event emitter for monitoring */
  eventEmitter?: EventEmitter;

  /** Optional progress callback */
  onProgress?: (message: string) => void;

  /** Timeout in milliseconds (default: 15 minutes) */
  timeoutMs?: number;

  /** Webhook URL for audit events */
  webhookUrl?: string;
}

/** FORGE analysis result */
export interface FORGEResult {
  /** Whether analysis completed successfully */
  success: boolean;

  /** Full analysis report markdown */
  report: string;

  /** Structured output if schema was honored */
  structured?: FORGEStructuredOutput;

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

/** Parsed job context from ticket summary/description */
export interface ParsedJobContext {
  /** Full job name from summary (e.g., "AGRP-MPPROD1-recursive_archiver") */
  jobName?: string;
  /** Job group (e.g., "AGRP") */
  group?: string;
  /** Environment ID (e.g., "MPPROD1", "PROD1") */
  envid?: string;
  /** Client name */
  client?: string;
  /** Environment (e.g., "PROD", "UAT") */
  env?: string;
  /** Full command line if found */
  commandLine?: string;
}
