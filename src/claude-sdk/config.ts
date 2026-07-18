/**
 * Claude Agent SDK Configuration
 *
 * Repo registry, types, and configuration for the Claude Agent SDK
 * replacing the Phoenix execution engine.
 */

import { z } from "zod";
import { RIFT_OUTPUT_SCHEMA } from '../agents/rift/outputSchema.js';

/**
 * Repo registry - maps repo IDs to absolute paths
 * Callers pass repoIds, not raw paths (security)
 */
export const REPO_REGISTRY: Record<string, string> = {
  // Default repos - populated from environment or config
  // Will be dynamically loaded from EFS mount
};

/**
 * Initialize repo registry from EFS mount
 */
export function initRepoRegistry(basePath: string = "/mnt/efs/repos"): void {
  // This will be populated by scanning the EFS mount
  // or from a configuration file
}

/**
 * Add a repo to the registry
 */
export function registerRepo(id: string, path: string): void {
  REPO_REGISTRY[id] = path;
}

/**
 * Remove a repo from the registry.
 *
 * No-op if the ID is not present. Callers (e.g. the OneShot runner)
 * use this to clean up per-run registrations so long-lived processes
 * don't accumulate stale entries.
 */
export function deregisterRepo(id: string): void {
  delete REPO_REGISTRY[id];
}

/**
 * Get repo path by ID
 */
export function getRepoPath(repoId: string): string {
  const path = REPO_REGISTRY[repoId];
  if (!path) {
    throw new Error(
      `Unknown repoId: ${repoId}. Available repos: ${Object.keys(REPO_REGISTRY).join(", ")}`,
    );
  }
  return path;
}

/**
 * Get all registered repo IDs
 */
export function getRegisteredRepos(): string[] {
  return Object.keys(REPO_REGISTRY);
}

/**
 * Tool permission levels
 */
export type ToolPermissionLevel =
  | "read_only"
  | "code_exploration"
  | "analysis"
  | "patch_proposal"
  | "full_autonomy";

/**
 * Claude Agent SDK Built-in Tool Names
 * Reference: @anthropic-ai/claude-agent-sdk TypeScript SDK
 *
 * ## Orchestration
 * - Task           - Spawn a subagent to handle a delegated multi-step task
 *
 * ## User Interaction
 * - AskUserQuestion - Ask clarifying questions mid-run (handled via canUseTool)
 *
 * ## Shell / Command Execution
 * - Bash           - Run a command in a persistent shell (supports background execution)
 * - BashOutput     - Retrieve output from a background bash shell by ID
 * - KillBash       - Terminate a background bash shell by ID
 *
 * ## File Reading/Writing + Search
 * - Read           - Read local files (text, images, PDFs, Jupyter notebooks)
 * - Write          - Write a file (overwrite if exists)
 * - Edit           - Exact string replacement edit in a file (with optional replace_all)
 * - Glob           - File pattern matching
 * - Grep           - ripgrep-backed search across files (regex + flags)
 *
 * ## Notebook Editing
 * - NotebookEdit   - Edit cells in .ipynb notebooks
 *
 * ## Web
 * - WebFetch       - Fetch a URL and run a prompt over the fetched content
 * - WebSearch      - Web search that returns formatted results
 *
 * ## Progress Tracking
 * - TodoWrite      - Maintain/update a structured todo list emitted in the tool stream
 *
 * ## Planning Mode
 * - ExitPlanMode   - Exit planning mode by presenting a plan for user approval
 *
 * ## MCP Resource Helpers
 * - ListMcpResources - List MCP resources from connected servers
 * - ReadMcpResource  - Read a specific MCP resource by server + URI
 *
 * ## Skills
 * - Skill          - Enable Skills (must be in allowedTools to enable)
 *
 * ## Git Operations
 * Git is performed via Bash tool. Claude can run any git command:
 *   git blame <file>           - Find who changed each line
 *   git log --oneline -20      - View commit history
 *   git diff master -- <file>  - Compare changes
 *   git show <commit>          - View commit details
 */

/**
 * Tool sets for different permission levels
 *
 * DARCI needs Bash for git investigation (blame, log, diff).
 * Other agents (SCRIBE, PRISM, HERMES) only need code exploration tools.
 */
export const TOOL_SETS: Record<ToolPermissionLevel, string[]> = {
  // Level 0: Code exploration only - NO Bash, NO git (for SCRIBE, PRISM, HERMES)
  // These agents just need to read and search code, not execute commands
  code_exploration: [
    "Read", // Read local files
    "Glob", // File pattern matching
    "Grep", // ripgrep search
  ],

  // Level 1: Read-only with Bash for git queries (no file writes)
  read_only: [
    "Read",
    "Glob",
    "Grep",
    "Bash", // For git status, log, diff, show, blame
    "BashOutput", // Retrieve background bash output
  ],

  // Level 2: Git analysis for defect investigation (for DARCI only)
  // DARCI uses Bash to run git commands:
  // - git blame <file> to find introducing commits
  // - git log to track changes
  // - git diff to compare branches
  analysis: [
    "Read",
    "Glob",
    "Grep",
    "Bash", // For git commands and investigation
    "BashOutput", // For long-running git commands
    "Task", // For delegating sub-tasks
    "TodoWrite", // For tracking investigation progress
  ],

  // Level 3: Can propose edits (writes to ephemeral workspace)
  patch_proposal: [
    "Read",
    "Glob",
    "Grep",
    "Edit", // Exact string replacement
    "Write", // Write/overwrite files
    "Bash",
    "BashOutput",
    "Task",
    "TodoWrite",
  ],

  // Level 4: Full autonomy (requires strict hooks)
  full_autonomy: [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "Bash",
    "BashOutput",
    "KillBash", // Can kill background processes
    "Task",
    "TodoWrite",
    "Skill", // Enable Skills
    "WebFetch", // Fetch URLs
    "WebSearch", // Web search
    "NotebookEdit", // Edit Jupyter notebooks
  ],
};

/**
 * Disallowed tools - explicitly blocked for security
 * These are dangerous operations that should never be allowed in our API context
 */
export const DISALLOWED_TOOLS: string[] = [
  // User interaction tools - not applicable in API/headless mode
  "AskUserQuestion", // We handle user interaction via webhooks/callbacks, not interactive prompts
  "ExitPlanMode", // Planning mode is for interactive CLI usage

  // MCP resource tools - we don't expose MCP servers to agents
  "ListMcpResources",
  "ReadMcpResource",
];

/**
 * Output schema for structured agent responses
 */
export const DEFAULT_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: {
      type: "string" as const,
      description: "High-level summary of the analysis or task result",
    },
    findings: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "List of key findings or observations",
    },
    suggested_changes: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          repoId: { type: "string" as const },
          file_path: { type: "string" as const },
          change_type: {
            type: "string" as const,
            enum: ["edit", "create", "delete"],
          },
          rationale: { type: "string" as const },
          before: { type: "string" as const },
          after: { type: "string" as const },
        },
        required: ["repoId", "file_path", "change_type"],
      },
      description: "List of suggested code changes",
    },
    confidence: {
      type: "number" as const,
      minimum: 0,
      maximum: 1,
      description: "Confidence score for the analysis (0-1)",
    },
    metadata: {
      type: "object" as const,
      properties: {
        files_analyzed: { type: "number" as const },
        commits_examined: { type: "number" as const },
        tool_calls: { type: "number" as const },
        duration_ms: { type: "number" as const },
      },
      description: "Metadata about the analysis process",
    },
  },
  required: ["summary"],
};

/**
 * DARCI-specific output schema (defect analysis)
 */
export const DARCI_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    resolution_status: {
      type: "string" as const,
      enum: [
        "root_cause_found",
        "insufficient_evidence",
        "fixed_on_default_branch",
        "ambiguous",
      ],
    },
    investigation_summary: { type: "string" as const },
    primary_hypothesis: { type: "string" as const },
    evidence: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          file_path: { type: "string" as const },
          line_numbers: { type: "string" as const },
          finding: { type: "string" as const },
        },
        required: ["finding"],
      },
    },
    root_cause: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const },
        file_path: { type: "string" as const },
        line_numbers: {
          type: "object" as const,
          properties: {
            start: { type: "number" as const },
            end: { type: "number" as const },
          },
        },
        code_snippet: { type: "string" as const },
      },
      required: ["summary"],
    },
    introducing_commit: {
      type: "object" as const,
      properties: {
        hash: { type: "string" as const },
        author: { type: "string" as const },
        date: { type: "string" as const },
        message: { type: "string" as const },
      },
    },
    proposed_fix: {
      type: "object" as const,
      properties: {
        description: { type: "string" as const },
        before: { type: "string" as const },
        after: { type: "string" as const },
        file_path: { type: "string" as const },
      },
      required: ["description"],
    },
    testing_recommendations: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    hypotheses_rejected: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          hypothesis: { type: "string" as const },
          reason: { type: "string" as const },
        },
        required: ["hypothesis", "reason"],
      },
    },
    files_examined: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    searches_performed: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    verification: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    confidence: {
      type: "number" as const,
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["root_cause"],
};


/**
 * SCRIBE-specific output schema (code explanation)
 */
export const SCRIBE_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    summary: { type: "string" as const },
    how_it_works: {
      type: "object" as const,
      properties: {
        overview: { type: "string" as const },
        key_components: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              name: { type: "string" as const },
              file_path: { type: "string" as const },
              purpose: { type: "string" as const },
              how: { type: "string" as const },
            },
          },
        },
        execution_flow: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    code_examples: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          description: { type: "string" as const },
          code: { type: "string" as const },
          language: { type: "string" as const },
        },
      },
    },
    key_concepts: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          concept: { type: "string" as const },
          explanation: { type: "string" as const },
        },
      },
    },
  },
  required: ["summary"],
};

/**
 * PRISM-specific output schema (implementation plan)
 */
export const PRISM_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ticket_summary: {
      type: "object" as const,
      properties: {
        requirements: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        acceptance_criteria: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        assumptions: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    project_identification: {
      type: "object" as const,
      properties: {
        target_projects: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        project_type: { type: "string" as const },
        key_files: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    technical_approach: { type: "string" as const },
    planned_changes: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          file_path: { type: "string" as const },
          change_type: {
            type: "string" as const,
            enum: ["modify", "create", "delete"],
          },
          purpose: { type: "string" as const },
          current_code: { type: "string" as const },
          planned_code: { type: "string" as const },
          change_summary: { type: "string" as const },
        },
        required: ["file_path", "change_type", "purpose"],
      },
    },
    implementation_steps: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          step: { type: "number" as const },
          description: { type: "string" as const },
          files: { type: "array" as const, items: { type: "string" as const } },
          estimated_time: { type: "string" as const },
          complexity: {
            type: "string" as const,
            enum: ["low", "medium", "high"],
          },
        },
      },
    },
    testing_strategy: {
      type: "object" as const,
      properties: {
        unit_tests: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        integration_tests: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        manual_tests: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    risks: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          risk: { type: "string" as const },
          mitigation: { type: "string" as const },
        },
      },
    },
    estimated_effort: {
      type: "object" as const,
      properties: {
        development_hours: { type: "number" as const },
        testing_hours: { type: "number" as const },
        review_hours: { type: "number" as const },
        total_hours: { type: "number" as const },
      },
    },
  },
  required: ["ticket_summary", "planned_changes", "implementation_steps"],
};

/**
 * HERMES-specific output schema (configuration lookup)
 */
export const HERMES_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    resolution_status: {
      type: "string" as const,
      enum: ["found", "not_found", "ambiguous", "runtime_value_unverified"],
    },
    evidence: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          source_path: { type: "string" as const },
          finding: { type: "string" as const },
          precedence: { type: "string" as const },
        },
        required: ["finding"],
      },
    },
    configuration: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        type: { type: "string" as const },
        table_name: { type: "string" as const },
      },
      required: ["name"],
    },
    location: {
      type: "object" as const,
      properties: {
        hibernate_mapping: { type: "string" as const },
        java_model: { type: "string" as const },
        service: { type: "string" as const },
      },
    },
    current_value: {
      type: "object" as const,
      properties: {
        code: { type: "string" as const },
        str_value: { type: "string" as const },
        int_value: { type: "number" as const },
        client: { type: "boolean" as const },
        is_locked: { type: "boolean" as const },
      },
    },
    description: { type: "string" as const },
    usage: {
      type: "object" as const,
      properties: {
        service_layer: { type: "string" as const },
        referenced_by: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    impact_analysis: {
      type: "object" as const,
      properties: {
        if_changed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        dependencies: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    related_configurations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          relationship: { type: "string" as const },
        },
      },
    },
    security: {
      type: "object" as const,
      properties: {
        phi_pii: { type: "boolean" as const },
        hipaa_considerations: { type: "string" as const },
        access_control: { type: "string" as const },
      },
    },
  },
  required: ["resolution_status", "configuration", "description"],
};

/**
 * SENTRY-specific output schema (MySQL execution ticket review)
 */
export const SENTRY_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    inputs: {
      type: "object" as const,
      properties: {
        sql_provided: { type: "boolean" as const },
        rollback_sql_provided: { type: "boolean" as const },
        expected_rows_provided: { type: "boolean" as const },
        justification_provided: { type: "boolean" as const },
        verification_queries_provided: { type: "boolean" as const },
      },
    },
    mysql_syntax: {
      type: "object" as const,
      properties: {
        valid_syntax: { type: "boolean" as const },
        version_sensitive_features: { type: "boolean" as const },
        notes: { type: "string" as const },
      },
    },
    code_lookup: {
      type: "object" as const,
      properties: {
        tables_columns_exist: { type: "boolean" as const },
        intent_matches_model: { type: "boolean" as const },
        scope_keys_verified: { type: "boolean" as const },
        join_determinism_verified: { type: "boolean" as const },
        no_conflicting_logic: { type: "boolean" as const },
        model_references: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
    safety_gates: {
      type: "object" as const,
      properties: {
        has_where_clause: { type: "boolean" as const },
        predicate_scoped: { type: "boolean" as const },
        no_dangerous_ddl: { type: "boolean" as const },
        write_deterministic: { type: "boolean" as const },
      },
    },
    row_impact: {
      type: "object" as const,
      properties: {
        where_aligns_expected: { type: "boolean" as const },
        preview_query_exists: { type: "boolean" as const },
      },
    },
    performance: {
      type: "object" as const,
      properties: {
        indexed_filters: { type: "boolean" as const },
        long_transaction_addressed: { type: "boolean" as const },
      },
    },
    rollback: {
      type: "object" as const,
      properties: {
        targets_same_rows: { type: "boolean" as const },
        restores_original_values: { type: "boolean" as const },
        snapshot_plan_exists: { type: "boolean" as const },
      },
    },
    verification: {
      type: "object" as const,
      properties: {
        proves_intended_state: { type: "boolean" as const },
        detects_collateral_impact: { type: "boolean" as const },
      },
    },
    risk_decision: {
      type: "object" as const,
      properties: {
        risk_level: { type: "string" as const, enum: ["LOW", "MED", "HIGH"] },
        risk_rationale: { type: "string" as const },
        decision: {
          type: "string" as const,
          enum: [
            "SAFE TO EXECUTE",
            "EXECUTE WITH CONDITIONS",
            "NOT SAFE",
            "NOT READY",
            "DO NOT EXECUTE",
          ],
        },
        conditions: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["risk_level", "decision"],
    },
    checklist: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const },
          items: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                check: { type: "string" as const },
                status: {
                  type: "string" as const,
                  enum: ["PASS", "FAIL", "WARN", "NA"],
                },
                note: { type: "string" as const },
              },
              required: ["check", "status", "note"],
            },
          },
        },
        required: ["category", "items"],
      },
    },
    corrected_statements: {
      type: "object" as const,
      properties: {
        forward_sql: { type: "string" as const },
        rollback_sql: { type: "string" as const },
        preview_query: { type: "string" as const },
        verification_query: { type: "string" as const },
        changes_made: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
    },
  },
  required: ["risk_decision"],
};

/**
 * BEACON Output Schema
 * Backend Execution Agent for Case Orchestrated Normalization
 * Validates MOANA-generated SQL against HBM models
 */
export const BEACON_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    sql_validation: {
      type: "object" as const,
      properties: {
        decision: {
          type: "string" as const,
          enum: [
            "SAFE TO EXECUTE",
            "EXECUTE WITH CAUTION",
            "NEEDS REVIEW",
            "NOT SAFE",
          ],
        },
        risk_level: {
          type: "string" as const,
          enum: ["LOW", "MEDIUM", "HIGH"],
        },
        risk_rationale: { type: "string" as const },
        recommendations: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["decision", "risk_level"],
    },
    moana_context: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" as const },
        query_id: { type: "string" as const },
        generated_sql: { type: "string" as const },
        explanation: { type: "string" as const },
      },
      required: ["generated_sql"],
    },
    file_info: {
      type: "object" as const,
      properties: {
        file_name: { type: "string" as const },
        row_count: { type: "number" as const },
        headers: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["file_name"],
    },
    validated_against: {
      type: "object" as const,
      properties: {
        repository: { type: "string" as const },
        models_checked: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        tables_referenced: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        columns_validated: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["repository"],
    },
    validation_checklist: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const },
          items: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                check: { type: "string" as const },
                status: {
                  type: "string" as const,
                  enum: ["PASS", "FAIL", "WARN", "NA"],
                },
                note: { type: "string" as const },
              },
              required: ["check", "status"],
            },
          },
        },
        required: ["category", "items"],
      },
    },
    issues_found: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          severity: {
            type: "string" as const,
            enum: ["ERROR", "WARNING", "INFO"],
          },
          type: { type: "string" as const },
          description: { type: "string" as const },
          affected_element: { type: "string" as const },
          suggestion: { type: "string" as const },
        },
        required: ["severity", "type", "description"],
      },
    },
  },
  required: [
    "sql_validation",
    "moana_context",
    "validated_against",
    "validation_checklist",
  ],
};

/**
 * ANVIL-specific output schema (automation config generation)
 */
export const ANVIL_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    ticket_type: {
      type: "string" as const,
      enum: ["epic", "story"],
      description: "Whether the labeled ticket was an epic or single story",
    },
    stories_processed: {
      type: "number" as const,
      description:
        "Number of stories processed (1 for single story, N for epic)",
    },
    configs_created: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string" as const,
            description: "Path to the created config file",
          },
          product_type: {
            type: "string" as const,
            description:
              "mp_automation, file_copier, task_runner, alerter, sql_runner, mpweb",
          },
          job_type: {
            type: "string" as const,
            description: "Specific job type (e.g., load_beqr, create_beq)",
          },
          environment: {
            type: "string" as const,
            description: "Environment (uat, prod, etc.)",
          },
          envid: {
            type: "string" as const,
            description: "Environment ID (uat1, prod1, etc.)",
          },
          story_key: {
            type: "string" as const,
            description: "Jira story key this config was created for",
          },
        },
        required: ["file_path", "product_type"],
      },
      description: "List of config files created",
    },
    requirement_gaps: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          field: {
            type: "string" as const,
            description: "The field or requirement that was missing or unclear",
          },
          description: {
            type: "string" as const,
            description: "What was expected vs what was found",
          },
          assumed_value: {
            type: "string" as const,
            description: "Value assumed by the agent (if any)",
          },
          story_key: {
            type: "string" as const,
            description: "Jira story key where gap was found",
          },
        },
        required: ["field", "description"],
      },
      description: "Requirement gaps found during config generation",
    },
    git_info: {
      type: "object" as const,
      properties: {
        branch: {
          type: "string" as const,
          description: "Git branch created",
        },
        commits: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Commit hashes",
        },
        pr_url: {
          type: "string" as const,
          description: "Pull request URL",
        },
      },
      description: "Git workflow information",
    },
    jira_comments_posted: {
      type: "boolean" as const,
      description: "Whether results were posted as Jira comments",
    },
    summary: {
      type: "string" as const,
      description: "Human-readable summary of what was done",
    },
  },
  required: ["configs_created", "summary", "ticket_type", "stories_processed"],
};

/**
 * SRLOG output schema — SQL & Resource LOG Analyzer
 */
export const SRLOG_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    errors_found: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          error_type: { type: "string" as const },
          line_number: { type: "number" as const },
          context: { type: "string" as const },
          severity: {
            type: "string" as const,
            enum: ["CRITICAL", "ERROR", "WARNING", "INFO"],
          },
          log_file: { type: "string" as const },
          oracle_error_code: { type: "string" as const },
          plsql_unit: { type: "string" as const },
        },
        required: ["error_type", "line_number", "severity", "log_file"],
      },
    },
    summary: {
      type: "object" as const,
      properties: {
        total_errors: { type: "number" as const },
        critical_count: { type: "number" as const },
        error_count: { type: "number" as const },
        warning_count: { type: "number" as const },
        info_count: { type: "number" as const },
        files_analyzed: { type: "number" as const },
        total_lines_analyzed: { type: "number" as const },
      },
      required: ["total_errors", "files_analyzed"],
    },
    recommendations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          priority: {
            type: "string" as const,
            enum: ["HIGH", "MEDIUM", "LOW"],
          },
          description: { type: "string" as const },
          related_errors: {
            type: "array" as const,
            items: { type: "string" as const },
          },
        },
        required: ["priority", "description"],
      },
    },
    patterns: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          pattern: { type: "string" as const },
          occurrences: { type: "number" as const },
          description: { type: "string" as const },
        },
      },
    },
  },
  required: ["errors_found", "summary", "recommendations"],
};

/**
 * FORGE output schema - Failure Operations Root-cause Guidance Engine
 */
const FORGE_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    root_cause: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const },
        error_category: {
          type: "string" as const,
          enum: [
            "YAML_CONFIG",
            "ORACLE_PLSQL",
            "AUTOMATION_FRAMEWORK",
            "WEB_UI",
            "INFRASTRUCTURE",
            "UNKNOWN",
          ],
        },
        primary_error: { type: "string" as const },
        error_details: { type: "string" as const },
        affected_component: { type: "string" as const },
      },
      required: ["summary", "error_category"],
    },
    errors_found: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          error_type: { type: "string" as const },
          severity: {
            type: "string" as const,
            enum: ["CRITICAL", "ERROR", "WARNING", "INFO"],
          },
          context: { type: "string" as const },
          log_file: { type: "string" as const },
          line_number: { type: "number" as const },
          oracle_error_code: { type: "string" as const },
        },
        required: ["error_type", "severity", "context"],
      },
    },
    config_analysis: {
      type: "object" as const,
      properties: {
        config_file: { type: "string" as const },
        config_issue: { type: "string" as const },
        expected_value: { type: "string" as const },
        actual_value: { type: "string" as const },
      },
    },
    code_references: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          repo: { type: "string" as const },
          file_path: { type: "string" as const },
          relevance: { type: "string" as const },
        },
        required: ["repo", "file_path", "relevance"],
      },
    },
    routing: {
      type: "object" as const,
      properties: {
        recommended_team: {
          type: "string" as const,
          enum: [
            "MP_DEVOPS",
            "MP_PLSQL_DEV",
            "MP_WEB_DEV",
            "MP_AUTOMATION_DEV",
            "MP_INFRA",
            "NEEDS_TRIAGE",
          ],
        },
        routing_rationale: { type: "string" as const },
        confidence: { type: "number" as const },
      },
      required: ["recommended_team", "routing_rationale", "confidence"],
    },
    proposed_fix: {
      type: "object" as const,
      properties: {
        description: { type: "string" as const },
        steps: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        estimated_effort: {
          type: "string" as const,
          enum: ["quick_fix", "moderate", "significant"],
        },
      },
      required: ["description"],
    },
    job_context: {
      type: "object" as const,
      properties: {
        job_name: { type: "string" as const },
        group: { type: "string" as const },
        envid: { type: "string" as const },
        client: { type: "string" as const },
        env: { type: "string" as const },
        command_line: { type: "string" as const },
      },
    },
    summary: {
      type: "object" as const,
      properties: {
        total_errors: { type: "number" as const },
        critical_count: { type: "number" as const },
        files_analyzed: { type: "number" as const },
        repos_searched: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["total_errors", "critical_count", "files_analyzed"],
    },
  },
  required: ["root_cause", "routing", "summary"],
};

/**
 * Agent types for configuration
 */
export type AgentType =
  | "darci"
  | "rift"
  | "scribe"
  | "prism"
  | "hermes"
  | "sentry"
  | "beacon"
  | "veritas"
  | "anvil"
  | "srlog"
  | "notary"
  | "forge"
  | "ledger"
  | "custom";

/**
 * Get output schema for agent type
 */
export function getOutputSchema(agentType: AgentType): Record<string, unknown> {
  switch (agentType) {
    case "darci":
      return DARCI_OUTPUT_SCHEMA;
    case "rift":
      return RIFT_OUTPUT_SCHEMA;
    case "scribe":
      return SCRIBE_OUTPUT_SCHEMA;
    case "prism":
      return PRISM_OUTPUT_SCHEMA;
    case "hermes":
      return HERMES_OUTPUT_SCHEMA;
    case "sentry":
      return SENTRY_OUTPUT_SCHEMA;
    case "beacon":
      return BEACON_OUTPUT_SCHEMA;
    case "veritas":
      // VERITAS uses plain markdown — no structured output schema.
      // The 6-section RCA format is enforced via the system prompt.
      return DEFAULT_OUTPUT_SCHEMA;
    case "anvil":
      return ANVIL_OUTPUT_SCHEMA;
    case "srlog":
      return SRLOG_OUTPUT_SCHEMA;
    case "forge":
      return FORGE_OUTPUT_SCHEMA;
    case "notary":
      // NOTARY output schema is defined in agents/notary/types.ts
      // and passed explicitly via NOTARYAgent — use default here as fallback
      return DEFAULT_OUTPUT_SCHEMA;
    case "ledger":
      // LEDGER returns plain markdown LOE report — format enforced via system prompt
      return DEFAULT_OUTPUT_SCHEMA;
    default:
      return DEFAULT_OUTPUT_SCHEMA;
  }
}

/**
 * Get tool set for agent type
 *
 * IMPORTANT:
 * - DARCI gets 'analysis' (includes Bash for git investigation)
 * - HERMES gets 'read_only' (includes Bash for filesystem exploration like `ls`, `find`)
 * - SCRIBE, PRISM get 'code_exploration' (NO Bash) - they only read/search code
 *
 * Note: HERMES needs Bash to explore config directories. Without it, the agent
 * stalls trying to list files and times out. The Bash commands are restricted
 * to safe read-only operations by the isGitOnlyCommand or isReadOnlyCommand checks.
 */
export function getToolSet(agentType: AgentType): string[] {
  switch (agentType) {
    case "darci":
      // DARCI needs git tools for:
      // - Finding who introduced defective code (git blame, git log)
      // - Checking if defect is fixed in master (git diff)
      return TOOL_SETS.analysis;
    case "hermes":
      // HERMES needs Bash for filesystem exploration:
      // - Listing config directories (ls, find)
      // - Viewing file contents (cat)
      // This is required to navigate multi-repo workspaces effectively
      return TOOL_SETS.read_only;
    case "scribe":
      // SCRIBE only explains existing code - no git/bash needed
      return TOOL_SETS.code_exploration;
    case "prism":
      // PRISM only plans implementation - no git/bash needed
      return TOOL_SETS.code_exploration;
    case "sentry":
      // SENTRY reviews MySQL execution tickets against HBM models
      // Only needs to read and search code - no git/bash needed
      return TOOL_SETS.code_exploration;
    case "beacon":
      // BEACON validates MOANA-generated SQL against HBM models
      // Only needs to read and search code - no git/bash needed
      return TOOL_SETS.code_exploration;
    case "veritas":
      // VERITAS generates RCA from JIRA evidence + optional code exploration
      // Needs Bash for git commands if repos are available
      return TOOL_SETS.analysis;
    case "anvil":
      // ANVIL generates config files, creates branches, commits, pushes, creates PRs
      // Needs Edit, Write, Bash (with expanded permissions), Task for epic sub-agents
      return TOOL_SETS.patch_proposal;
    case "srlog":
      // SRLOG reads log files via Read/Glob/Grep + Bash for ls, wc, tail on large files
      return TOOL_SETS.read_only;
    case "notary":
      // NOTARY reads the codebase at a release tag to verify/generate client notes
      // Needs Bash for git log (find ticket-related commits by MPDEV number)
      return TOOL_SETS.read_only;
    case "forge":
      // FORGE reads log files + searches MP repos + uses Bash for git/filesystem
      return TOOL_SETS.read_only;
    case "ledger":
      // LEDGER reads HBM models, flyway migrations, loader/extract/BI repos
      // Needs Read/Glob/Grep across multiple repos — no write, no git needed
      return TOOL_SETS.code_exploration;
    default:
      return TOOL_SETS.code_exploration;
  }
}

/**
 * Resolve the effective tool set for a run.
 *
 * Precedence (highest to lowest):
 *   1. explicit allowedTools override supplied by the caller
 *   2. permissionLevel (any of the 5 profiles in TOOL_SETS)
 *   3. agentType default (via getToolSet)
 *   4. fallback: code_exploration
 *
 * This replaces the inline resolution in index.ts that had
 * agentType shadowing permissionLevel.
 */
export function resolveToolSet(args: {
  allowedTools?: string[];
  permissionLevel?: ToolPermissionLevel;
  agentType?: AgentType;
}): string[] {
  if (args.allowedTools && args.allowedTools.length > 0) {
    return [...args.allowedTools];
  }
  if (args.permissionLevel) {
    return [...TOOL_SETS[args.permissionLevel]];
  }
  if (args.agentType) {
    return [...getToolSet(args.agentType)];
  }
  return [...TOOL_SETS.code_exploration];
}

/**
 * Environment configuration for Bedrock
 */
export interface BedrockConfig {
  region: string;
  model?: string;
  smallFastModel?: string;
  maxOutputTokens?: number;
  maxThinkingTokens?: number;
}

/**
 * Get Bedrock environment variables
 */
export function getBedrockEnv(
  config: Partial<BedrockConfig> = {},
): Record<string, string> {
  return {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: config.region || process.env.AWS_REGION || "us-east-1",
    ...(config.model && { ANTHROPIC_MODEL: config.model }),
    ...(config.smallFastModel && {
      ANTHROPIC_SMALL_FAST_MODEL: config.smallFastModel,
    }),
    ...(config.maxOutputTokens && {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(config.maxOutputTokens),
    }),
    ...(config.maxThinkingTokens && {
      MAX_THINKING_TOKENS: String(config.maxThinkingTokens),
    }),
  };
}

/**
 * Validation schemas using Zod
 */
export const AgentRequestSchema = z.object({
  taskId: z.string(),
  taskPrompt: z.string(),
  repoIds: z.array(z.string()).min(1),
  agentType: z
    .enum([
      "darci",
      "scribe",
      "prism",
      "hermes",
      "sentry",
      "beacon",
      "veritas",
      "anvil",
      "srlog",
      "notary",
      "forge",
      "ledger",
      "custom",
    ])
    .default("custom"),
  systemAppend: z.string().optional(),
  additionalContext: z.string().optional(),
  webhookUrl: z.string().url().optional(),
  permissionLevel: z
    .enum([
      "read_only",
      "code_exploration",
      "analysis",
      "patch_proposal",
      "full_autonomy",
    ])
    .default("read_only"),
  timeoutMs: z.number().positive().default(1800000), // 30 minutes default
});

export type AgentRequest = z.infer<typeof AgentRequestSchema>;
