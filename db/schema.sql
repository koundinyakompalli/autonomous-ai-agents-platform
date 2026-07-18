-- Specter Database Schema
-- Database: Specter

-- ============================================================================
-- DATABASE CREATION
-- ============================================================================
CREATE DATABASE IF NOT EXISTS Specter
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE Specter;

-- ============================================================================
-- AGENTS TABLE
-- ============================================================================
-- Stores agent configurations and their JIRA polling criteria

CREATE TABLE IF NOT EXISTS agents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(100) COMMENT 'Short description of agent purpose',
  additional_context TEXT COMMENT 'Extra context to append to every task for this agent',
  model VARCHAR(100) NOT NULL DEFAULT 'us.anthropic.claude-sonnet-4-6',
  task_type VARCHAR(50) COMMENT 'Type of task this agent handles',
  jql TEXT NOT NULL,
  jira_token VARCHAR(250) COMMENT 'Agent-specific JIRA API token for polling and posting',
  jira_username VARCHAR(255) COMMENT 'Jira account email used for Basic auth (username:token)',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_name (name),
  INDEX idx_active (is_active),
  INDEX idx_task_type (task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Specter Agents
INSERT INTO agents (name, description, task_type, model, jql, is_active) VALUES
-- DARCI: Defect Analysis & Root Cause Identification
('DARCI', 'Defect Analysis & Root Cause Identification', 'defect_analysis', 'us.anthropic.claude-sonnet-4-6',
 'labels in (DARCI) AND labels not in (DARCI_DONE, DARCI_FAILED) ORDER BY updated DESC', TRUE),

-- SCRIBE: Simple Clear Rundown of Implementations, Behavior, and Endpoints
('SCRIBE', 'Simple Clear Rundown of Implementations, Behavior, and Endpoints', 'code_explanation', 'us.anthropic.claude-sonnet-4-6',
 'labels in (SCRIBE) AND labels not in (SCRIBE_DONE, SCRIBE_FAILED) ORDER BY updated DESC', TRUE),

-- PRISM: Planning & Refinement with Intelligent Systems at MedHok
('PRISM', 'Planning & Refinement with Intelligent Systems at MedHok', 'implementation_planning', 'us.anthropic.claude-sonnet-4-6',
 'labels in (PRISM) AND labels not in (PRISM_DONE, PRISM_FAILED) ORDER BY updated DESC', TRUE),

-- QUALIFIER: PFOS/Sonar ticket qualification and OneShot entry
-- Keep inactive until the OneShot queue infrastructure is deployed.
('QUALIFIER', 'PFOS Qualification & OneShot Control-Plane Entry', 'qualification', 'us.anthropic.claude-sonnet-4-6',
 'labels in (PFOS, SONAR-AUTOFIX) ORDER BY updated DESC', FALSE),

-- PLANNER: OneShot planning queue consumer
('PLANNER', 'OneShot planner queue consumer', 'oneshot_planning', 'us.anthropic.claude-sonnet-4-6',
 '', FALSE),

-- REVIEWER: OneShot review queue consumer
('REVIEWER', 'OneShot reviewer queue consumer', 'oneshot_review', 'gpt-5.4',
 '', FALSE),

-- IMPLEMENTER: OneShot implementation queue consumer
('IMPLEMENTER', 'OneShot implementer queue consumer', 'oneshot_implementation', 'us.anthropic.claude-sonnet-4-6',
 '', FALSE),

-- HERMES: Heuristic Engine for Rules, Modes, and Environment Settings
('HERMES', 'Heuristic Engine for Rules, Modes, and Environment Settings', 'config_lookup', 'us.anthropic.claude-sonnet-4-6',
 'labels in (HERMES) AND labels not in (HERMES_DONE, HERMES_FAILED) ORDER BY updated DESC', TRUE),

-- MERIDIAN: deterministic SQL generation with Haiku fallback for unstructured input
('MERIDIAN', 'Deterministic data SQL generation with Claude Haiku fallback for unstructured input', 'sql_generation', 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
 'labels in (MERIDIAN) ORDER BY updated DESC', FALSE),

-- ANVIL: Automated Normalization of YAML from Implementation Layouts
('ANVIL', 'Automated Normalization of YAML from Implementation Layouts', 'config_generation', 'us.anthropic.claude-sonnet-4-6',
 'labels in (ANVIL) AND labels not in (ANVIL_DONE, ANVIL_FAILED) ORDER BY updated DESC', TRUE),

-- FORGE: Failure Operations Root-cause Guidance Engine
('FORGE', 'Failure Operations Root-cause Guidance Engine', 'mp_failure_analysis', 'us.anthropic.claude-sonnet-4-6',
 'labels in (FORGE) AND labels not in (FORGE_DONE, FORGE_FAILED) ORDER BY priority DESC, created ASC', TRUE),

-- SRLOG: SQL & Resource LOG Analyzer
('SRLOG', 'SQL & Resource LOG Analyzer', 'log_analysis', 'us.anthropic.claude-sonnet-4-6',
 'labels in (SRLOG) AND labels not in (SRLOG_DONE, SRLOG_FAILED) ORDER BY updated DESC', TRUE),

-- NOTARY: Client Notes Review Agent
-- jql is unused — NOTARY tasks are triggered via Harvey with a release version, not JIRA labels
('NOTARY', 'Client Notes Review Agent — reviews and generates client release notes for a given release version', 'client_notes_review', 'us.anthropic.claude-sonnet-4-6',
 '', FALSE)

ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  updated_at = CURRENT_TIMESTAMP;

-- ============================================================================
-- TASKS TABLE
-- ============================================================================
-- Stores individual task executions

CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_type VARCHAR(50) NOT NULL,
  status ENUM('pending', 'in_progress', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  task_description TEXT NOT NULL,
  result_s3_bucket VARCHAR(255),
  result_s3_key VARCHAR(512),
  error_message TEXT,
  metrics_json JSON,
  tokens_consumed VARCHAR(50) COMMENT 'Token usage in format: input:X,output:Y',
  cost VARCHAR(50) COMMENT 'Task cost in USD (e.g., 0.0234)',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,

  INDEX idx_status (status),
  INDEX idx_task_type (task_type),
  INDEX idx_created_at (created_at),
  INDEX idx_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- CUSTOMER_BRANCHES TABLE
-- ============================================================================
-- Maps customers to their code branches

CREATE TABLE IF NOT EXISTS customer_branches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer VARCHAR(50) NOT NULL UNIQUE COMMENT 'Customer name from JIRA',
  branch VARCHAR(100) NOT NULL COMMENT 'Branch version (e.g., 3.18, master)',
  `default` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Is this the default customer for unknown tickets',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_customer (customer),
  INDEX idx_default (`default`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert customer branches
INSERT INTO customer_branches (customer, branch, `default`) VALUES
('Aetna CP', '3.16', 0),
('Allymar CP', '3.12', 0),
('BCBSMA CP', '3.18', 0),
('BCBSNC CP', '3.13', 0),
('BCBSRI CP', '3.13', 0),
('Cambia CP', '3.15', 0),
('CareSource CP', '3.18', 0),
('Centene (WellCare) CP', '3.19', 0),
('Cigna CP', '3.17', 0),
('CSH CP', '3.17', 0),
('CVS CP', '3.18', 0),
('Evolent CP', '3.8', 0),
('HFHP CP', '3.13', 0),
('Highmark CP', '3.17', 0),
('HNE CP', '3.19', 0),
('HP CP', '3.12', 0),
('Humana CP', '3.18', 0),
('JHP CP', '3.14', 0),
('P32H CP (Tufts)', '3.13', 0),
('PerformRx CP', '3.13', 0),
('Prime CP (Magellan)', '3.13', 0),
('Rightway CP', '3.11', 0),
('SCAN CP', '3.15', 0),
('UPMC CP', '3.12', 0),
('MHK', 'master', 1)  -- Default customer
ON DUPLICATE KEY UPDATE
  branch = VALUES(branch),
  `default` = VALUES(`default`),
  updated_at = CURRENT_TIMESTAMP;

-- ============================================================================
-- CODE_REPOSITORIES TABLE
-- ============================================================================
-- Stores repository metadata only. Runtime clone auth comes from Secrets Manager.

CREATE TABLE IF NOT EXISTS code_repositories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repo_name VARCHAR(255) NOT NULL UNIQUE COMMENT 'Short name for the repository',
  repo_url VARCHAR(500) NOT NULL UNIQUE COMMENT 'Git clone URL',
  description TEXT COMMENT 'Description of repository contents',
  default_branch VARCHAR(255) NOT NULL DEFAULT 'main' COMMENT 'Default branch to use when a task targets the repo base branch',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_repo_name (repo_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert code repositories
INSERT INTO code_repositories (repo_name, repo_url, description, default_branch) VALUES
('core-app', 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
 'Core application: primary UI, Business Layer, Web-Services. Contains mm-web-services (all API endpoints) and mm-shared-services (primary business logic)',
 'master'),

('client-services', 'https://github.com/mhk-repos/cp-client-services-monorepo.git',
 'Client-specific implementations and integrations. Projects named mm-service-{customer}. External integrations like PBM',
 'master'),

('batch-jobs', 'https://github.com/mhk-repos/cp-batch-monorepo.git',
 'Batch jobs: fax-intake, queue-monitor, auto-tasking, epa, workflow, correspondence, assessments',
 'master'),

('provider-portal', 'https://github.com/mhk-repos/cp-provider-portal.git',
 'Secondary application for providers to login and create cases. Calls core-app web-services',
 'master'),

('React-based-new-ui', 'https://github.com/mhk-repos/cp-mhk-smart-prominence.git',
 'React-based new UI for core application. Contains OCR project and MD Review Project',
 'main'),

('interop', 'https://github.com/mhk-repos/cp-interoperability-monorepo.git',
 'CP interoperability monorepo for interoperability, FHIR, CDS Hooks, and external integration work',
 'main'),

('data-visor', 'https://github.com/mhk-repos/cp-datalake-pipeline.git',
 'Data Visor / data lake pipeline tooling for reference table validation and reporting query support',
 'main'),

('cp-medhok-bi-datamart-monorepo', 'https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git',
 'MedHOK BI Data Mart monorepo for member data mart reporting, report metadata, and warehouse/reporting extracts',
 'master'),

('Ai-agents', 'https://github.com/mhk-repos/enterprise-ai-agent-platform.git',
 'Enterprise AI Agent Platform repository for controller agents, processing agents, MCP servers, shared SDKs, and platform Terraform',
 'master'),

('cp-autonomous-ai-agents-platform', 'https://github.com/mhk-repos/cp-autonomous-ai-agents-platform.git',
 'Autonomous AI agents platform repository: OneShot runtime, dashboard, agents, and MCP services',
 'main'),

('Document-ai', 'https://github.com/mhk-repos/document-ai.git',
 'Document AI: OCR, Document Understanding, Data Extraction, LLM-based intake service',
 'main'),

('mp-product-client-configs', 'https://github.com/mhk-repos/mp-product-client-configs.git',
 'MP platform client-specific YAML/SQL configs for batch automation and web deployments. Used by ANVIL agent.',
 'main'),


('mp-web', 'https://github.com/mhk-repos/mp-web.git',
 'MP Web — Angular/TypeScript front-end for MarketProminence. Used by NOTARY to verify client notes against release tags.',
 'master')

ON DUPLICATE KEY UPDATE
  repo_url = VALUES(repo_url),
  description = VALUES(description),
  default_branch = VALUES(default_branch);

-- ============================================================================
-- CHAT_SESSIONS TABLE (Harvey conversational intake)
-- ============================================================================

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  session_id            VARCHAR(64) NOT NULL UNIQUE,
  user_id               VARCHAR(128) NOT NULL,
  user_name             VARCHAR(128) NOT NULL,
  channel               ENUM('teams', 'web') NOT NULL DEFAULT 'teams',
  status                ENUM('active', 'routing', 'task_created', 'delivering', 'completed', 'delivered', 'abandoned')
                          NOT NULL DEFAULT 'active',
  resolved_agent_id     INT NULL,
  resolved_customer_id  INT NULL,
  resolved_repo_ids     TEXT NULL,
  task_management_id    INT NULL,
  jira_number           VARCHAR(32) NULL,
  conversation_reference JSON NULL,
  messages_json         JSON NOT NULL DEFAULT ('[]'),
  summary               TEXT NULL COMMENT 'Compact summary of what was accomplished, injected into next session',
  feedback              ENUM('positive', 'negative') NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_cs_agent    FOREIGN KEY (resolved_agent_id)    REFERENCES agents(id),
  CONSTRAINT fk_cs_customer FOREIGN KEY (resolved_customer_id) REFERENCES customer_branches(id),

  INDEX idx_cs_user_active (user_id, status, updated_at),
  INDEX idx_cs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- NOTE: chat_sessions.task_management_id FK is added after task_management table is created (below)

-- ============================================================================
-- TASK_MANAGEMENT TABLE
-- ============================================================================
-- Maps JIRA tickets to agents, customers, repositories, and tasks

CREATE TABLE IF NOT EXISTS task_management (
  id INT AUTO_INCREMENT PRIMARY KEY,
  jira_number VARCHAR(50) NOT NULL,
  customer_id INT NOT NULL COMMENT 'FK to customer_branches.id',
  agent_id INT NOT NULL,
  related_code VARCHAR(100) COMMENT 'CSV of repository IDs to analyze (e.g., "1,2,3")',
  task_type VARCHAR(50) COMMENT 'Type of task from agent',
  task_id INT NULL,
  task_s3_bucket VARCHAR(255) NULL COMMENT 'S3 bucket containing task description MD',
  task_s3_key VARCHAR(512) NULL COMMENT 'S3 key for task description MD',
  chat_session_id INT NULL COMMENT 'FK to chat_sessions.id (Harvey-originated tasks)',
  status ENUM('assigned', 'in_progress', 'waiting_repo_confirmation', 'completed', 'failed', 'failed_retries_exhausted', 'posting_to_jira', 'posted_to_jira') NOT NULL DEFAULT 'assigned',
  source ENUM('jira', 'harvey', 'api') NOT NULL DEFAULT 'jira' COMMENT 'Task origin — prevents Orchestrator from posting Harvey tasks to JIRA',
  jira_posted_at TIMESTAMP NULL,
  error_message TEXT,
  cancelled_by          VARCHAR(128) NULL COMMENT 'Teams user ID who cancelled this task',
  cancelled_at          TIMESTAMP NULL,
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (customer_id) REFERENCES customer_branches(id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,

  -- Composite unique: same ticket can be processed by multiple agents
  UNIQUE KEY uk_jira_agent (jira_number, agent_id),

  INDEX idx_jira_number (jira_number),
  INDEX idx_customer_id (customer_id),
  INDEX idx_agent_id (agent_id),
  INDEX idx_task_id (task_id),
  INDEX idx_task_type (task_type),
  INDEX idx_status (status),
  INDEX idx_status_agent (status, agent_id),
  INDEX idx_source (source),
  INDEX idx_retry (retry_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ONESHOT TABLES
-- ============================================================================
-- Durable state for PFOS / OneShot planning, review, implementation, and notification flow

CREATE TABLE IF NOT EXISTS oneshot_run_groups (
  id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
  jira_key                  VARCHAR(50) NOT NULL,
  source_task_management_id INT         NOT NULL,
  status                    VARCHAR(50) NOT NULL DEFAULT 'active',
  metadata_json             JSON        NULL,
  created_at                TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_oneshot_run_groups_task_management
    FOREIGN KEY (source_task_management_id) REFERENCES task_management(id),

  INDEX idx_oneshot_run_groups_jira_key (jira_key),
  INDEX idx_oneshot_run_groups_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_runs (
  id                             BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_group_id                   BIGINT       NULL,
  workspace_mode                 ENUM('v2') NOT NULL DEFAULT 'v2',
  jira_key                       VARCHAR(50)  NOT NULL,
  epic_key                       VARCHAR(50)  NULL,
  jira_issue_type                VARCHAR(100) NULL,
  ticket_type                    VARCHAR(50)  NOT NULL DEFAULT 'unknown',
  ticket_type_source             VARCHAR(50)  NOT NULL DEFAULT 'unknown',
  ticket_type_updated_by         VARCHAR(255) NULL,
  ticket_type_updated_at         TIMESTAMP(6) NULL,
  source_task_management_id      INT          NOT NULL,
  customer_id                    INT          NOT NULL,
  repo_id                        INT          NOT NULL,
  branch_name                    VARCHAR(255) NOT NULL,
  base_commit_sha                VARCHAR(40)  NOT NULL,
  run_branch_name                VARCHAR(255) NULL,
  run_branch_base_sha            VARCHAR(40)  NULL,
  run_branch_created_at          TIMESTAMP(6) NULL,
  state                          VARCHAR(50)  NOT NULL DEFAULT 'queued_for_planning',
  active_jira_repo_key           VARCHAR(360)
    GENERATED ALWAYS AS (
      CASE
        WHEN state IN ('completed', 'blocked', 'failed') THEN NULL
        ELSE CONCAT(jira_key, '#', repo_id, '#', branch_name)
      END
    ) STORED,
  max_review_loops               INT          NOT NULL DEFAULT 3,
  review_loop_count              INT          NOT NULL DEFAULT 0,
  current_plan_version           INT          NULL,
  current_review_version         INT          NULL,
  current_implementation_version INT          NULL,
  current_implementation_branch  VARCHAR(255) NULL,
  current_implementation_commit_sha VARCHAR(40) NULL,
  current_code_review_version    INT          NULL,
  current_test_version           INT          NULL,
  verification_loop_count        INT          NOT NULL DEFAULT 0,
  max_verification_loops         INT          NOT NULL DEFAULT 3,
  planning_attempt_count         INT          NOT NULL DEFAULT 0,
  implementation_attempt_count   INT          NOT NULL DEFAULT 0,
  code_review_attempt_count      INT          NOT NULL DEFAULT 0,
  current_pr_url                 VARCHAR(1024) NULL,
  final_disposition              VARCHAR(50)  NULL,
  last_error                     TEXT         NULL,
  max_total_tokens               INT          NOT NULL DEFAULT 10000000,
  total_tokens_used              INT          NOT NULL DEFAULT 0,
  created_at                     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_active_jira_repo (active_jira_repo_key),
  CONSTRAINT fk_oneshot_runs_group
    FOREIGN KEY (run_group_id) REFERENCES oneshot_run_groups(id),
  CONSTRAINT fk_oneshot_runs_task_management
    FOREIGN KEY (source_task_management_id) REFERENCES task_management(id),
  CONSTRAINT fk_oneshot_runs_customer
    FOREIGN KEY (customer_id) REFERENCES customer_branches(id),
  CONSTRAINT fk_oneshot_runs_repo
    FOREIGN KEY (repo_id) REFERENCES code_repositories(id),

  INDEX idx_oneshot_state (state),
  INDEX idx_oneshot_jira_key (jira_key),
  INDEX idx_oneshot_epic_key (epic_key),
  INDEX idx_oneshot_run_group (run_group_id),
  INDEX idx_oneshot_ticket_type (ticket_type),
  INDEX idx_oneshot_state_updated (state, updated_at),
  INDEX idx_oneshot_runs_updated_id (updated_at, id),
  INDEX idx_oneshot_run_branch_name (run_branch_name),
  INDEX idx_oneshot_current_impl_branch (current_implementation_branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_artifacts (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id BIGINT       NOT NULL,
  stage          ENUM('qualification', 'plan', 'trace', 'verify', 'review', 'implementation', 'code_review', 'test_result') NOT NULL,
  version        INT          NOT NULL,
  status         VARCHAR(50)  NOT NULL,
  s3_bucket      VARCHAR(255) NOT NULL,
  s3_key         VARCHAR(1024) NOT NULL,
  provider       VARCHAR(50)  NULL,
  model          VARCHAR(100) NULL,
  metadata_json  JSON         NULL,
  started_at     TIMESTAMP    NULL,
  completed_at   TIMESTAMP    NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_oneshot_artifact_stage (oneshot_run_id, stage, version),
  CONSTRAINT fk_oneshot_artifacts_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),

  INDEX idx_oneshot_artifacts_run (oneshot_run_id),
  INDEX idx_oneshot_artifacts_stage (stage),
  INDEX idx_oneshot_artifacts_run_created_version_id (oneshot_run_id, created_at, version, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_notifications (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id    BIGINT       NOT NULL,
  jira_key          VARCHAR(50)  NOT NULL,
  notification_type VARCHAR(50)  NOT NULL,
  body_markdown     TEXT         NOT NULL,
  status            ENUM('pending', 'posting', 'posted', 'failed') NOT NULL DEFAULT 'pending',
  error             TEXT         NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at         TIMESTAMP    NULL,

  CONSTRAINT fk_oneshot_notifications_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),

  INDEX idx_oneshot_notifications_status (status),
  INDEX idx_oneshot_notifications_run (oneshot_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_statistics_snapshots (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  range_key             ENUM('24h', '7d', '30d', 'all') NOT NULL,
  data_fingerprint      CHAR(40)                         NOT NULL,
  status                ENUM('ready', 'invalid', 'failed') NOT NULL,
  snapshot_json         JSON                             NULL,
  provider              VARCHAR(50)                      NULL,
  model                 VARCHAR(160)                     NULL,
  generated_at          TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at            TIMESTAMP(3)                     NULL,
  error_message         TEXT                             NULL,
  invalid_output_sample TEXT                             NULL,
  created_at            TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_oneshot_statistics_range_generated (range_key, generated_at, id),
  INDEX idx_oneshot_statistics_range_status_generated (range_key, status, generated_at, id),
  INDEX idx_oneshot_statistics_fingerprint (data_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_statistics_refresh_state (
  range_key                ENUM('24h', '7d', '30d', 'all') PRIMARY KEY,
  latest_snapshot_id       BIGINT       NULL,
  refresh_started_at       TIMESTAMP(3) NULL,
  refresh_lease_expires_at TIMESTAMP(3) NULL,
  next_retry_at            TIMESTAMP(3) NULL,
  attempt_count            INT          NOT NULL DEFAULT 0,
  last_attempt_at          TIMESTAMP(3) NULL,
  last_error               TEXT         NULL,
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_oneshot_statistics_latest_snapshot
    FOREIGN KEY (latest_snapshot_id) REFERENCES oneshot_statistics_snapshots(id),

  INDEX idx_oneshot_statistics_refresh_lease (refresh_lease_expires_at),
  INDEX idx_oneshot_statistics_next_retry (next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_ticket_readiness_scores (
  id                            BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_management_id            INT                              NOT NULL,
  rubric_version                VARCHAR(24)                      NOT NULL,
  detection_patterns_version    VARCHAR(24)                      NOT NULL,
  source_text_sha               CHAR(40)                         NOT NULL,
  score_source                  ENUM('intake', 'backfill')       NOT NULL,
  score_json                    JSON                             NOT NULL,
  scored_at                     TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_oneshot_ticket_readiness_scores_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id),

  UNIQUE KEY uq_oneshot_ticket_readiness_task_text_source (
    task_management_id,
    rubric_version,
    detection_patterns_version,
    source_text_sha,
    score_source
  ),
  INDEX idx_oneshot_ticket_readiness_task (
    task_management_id,
    rubric_version,
    detection_patterns_version,
    source_text_sha
  ),
  INDEX idx_oneshot_ticket_readiness_scored_at (scored_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_run_events (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id BIGINT       NOT NULL,
  event_type     VARCHAR(64)  NOT NULL,
  from_state     VARCHAR(64)  NULL,
  to_state       VARCHAR(64)  NULL,
  stage          VARCHAR(64)  NULL,
  metadata_json  JSON         NULL,
  occurred_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_oneshot_run_events_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE CASCADE,

  INDEX idx_oneshot_run_events_run (oneshot_run_id),
  INDEX idx_oneshot_run_events_occurred (occurred_at),
  INDEX idx_oneshot_run_events_run_occurred_id (oneshot_run_id, occurred_at, id),
  INDEX idx_oneshot_run_events_budget_stage (oneshot_run_id, event_type, stage, occurred_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_workspace_leases (
  scope           VARCHAR(191) PRIMARY KEY,
  fencing_token   BIGINT       NOT NULL DEFAULT 0,
  owner_task_arn  VARCHAR(512) NULL,
  owner_stage     VARCHAR(64)  NULL,
  heartbeat_at    TIMESTAMP(6) NULL,
  expires_at      TIMESTAMP(6) NULL,
  metadata_json   JSON         NULL,
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  INDEX idx_oneshot_workspace_leases_expiry (expires_at),
  INDEX idx_oneshot_workspace_leases_owner (owner_task_arn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_workspace_state (
  oneshot_run_id              BIGINT PRIMARY KEY,
  workspace_mode              ENUM('v2') NOT NULL DEFAULT 'v2',
  workspace_path              VARCHAR(1024) NULL,
  state_path                  VARCHAR(1024) NULL,
  workspace_phase             VARCHAR(64)   NULL,
  workspace_head_sha          VARCHAR(40)   NULL,
  base_commit_sha             VARCHAR(40)   NULL,
  current_candidate_version   INT           NULL,
  current_candidate_sha       VARCHAR(40)   NULL,
  last_repo_fetch_at          TIMESTAMP(6)  NULL,
  last_remote_head_sha        VARCHAR(40)   NULL,
  metadata_json               JSON          NULL,
  created_at                  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at                  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  CONSTRAINT fk_oneshot_workspace_state_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE CASCADE,

  INDEX idx_oneshot_workspace_state_phase (workspace_phase),
  INDEX idx_oneshot_workspace_state_candidate (current_candidate_sha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_candidate_versions (
  id                                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id                      BIGINT      NOT NULL,
  candidate_version                   INT         NOT NULL,
  candidate_commit_sha                VARCHAR(40) NOT NULL,
  previous_candidate_commit_sha       VARCHAR(40) NULL,
  status                              VARCHAR(50) NOT NULL DEFAULT 'current',
  superseded_by_candidate_version     INT         NULL,
  target_files_json                   JSON        NULL,
  metadata_json                       JSON        NULL,
  created_at                          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finalized_at                        TIMESTAMP(6) NULL,

  CONSTRAINT fk_oneshot_candidate_versions_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE CASCADE,

  UNIQUE KEY uk_oneshot_candidate_versions_run_version (oneshot_run_id, candidate_version),
  INDEX idx_oneshot_candidate_versions_run_sha (oneshot_run_id, candidate_commit_sha),
  INDEX idx_oneshot_candidate_versions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_github_commands (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id           BIGINT        NULL,
  delivery_id              VARCHAR(128)  NOT NULL,
  repository_full_name     VARCHAR(255)  NOT NULL,
  pull_number              INT           NOT NULL,
  comment_id               VARCHAR(64)   NOT NULL,
  comment_url              VARCHAR(1024) NULL,
  requester_login          VARCHAR(255)  NOT NULL,
  author_association       VARCHAR(64)   NULL,
  command_text             TEXT          NOT NULL,
  requested_plan_version   INT           NULL,
  status                   VARCHAR(50)   NOT NULL,
  response_comment_url     VARCHAR(1024) NULL,
  rejection_reason         VARCHAR(255)  NULL,
  created_at               TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at               TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  CONSTRAINT fk_oneshot_github_commands_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE SET NULL,

  UNIQUE KEY uk_oneshot_github_commands_delivery (delivery_id),
  INDEX idx_oneshot_github_commands_run_plan (oneshot_run_id, requested_plan_version, status),
  INDEX idx_oneshot_github_commands_pr (repository_full_name, pull_number, created_at),
  INDEX idx_oneshot_github_commands_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_deployments (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id      BIGINT       NOT NULL,
  slot_name           VARCHAR(100) NOT NULL DEFAULT 'core-app-preview',
  repo_id             INT          NOT NULL,
  branch_name         VARCHAR(255) NOT NULL,
  commit_sha          VARCHAR(40)  NOT NULL,
  pr_url              VARCHAR(1024) NULL,
  requested_by        VARCHAR(255) NULL,
  requested_by_display VARCHAR(255) NULL,
  status              VARCHAR(50)  NOT NULL,
  workflow_run_id     BIGINT       NULL,
  workflow_url        VARCHAR(1024) NULL,
  image_uri           VARCHAR(1024) NULL,
  task_definition_arn VARCHAR(1024) NULL,
  ecs_cluster_name    VARCHAR(255) NOT NULL,
  ecs_service_name    VARCHAR(255) NOT NULL,
  preview_url         VARCHAR(1024) NULL,
  error               TEXT         NULL,
  superseded_by       BIGINT       NULL,
  active_slot         VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN status = 'active' THEN slot_name
        ELSE NULL
      END
    ) STORED,
  inflight_slot       VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('requested', 'awaiting_approval', 'building', 'pushing', 'deploying')
        THEN slot_name
        ELSE NULL
      END
    ) STORED,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at        TIMESTAMP    NULL,

  UNIQUE KEY uk_oneshot_active_slot (active_slot),
  UNIQUE KEY uk_oneshot_inflight_slot (inflight_slot),
  CONSTRAINT fk_oneshot_deployments_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),
  CONSTRAINT fk_oneshot_deployments_repo
    FOREIGN KEY (repo_id) REFERENCES code_repositories(id),
  CONSTRAINT fk_oneshot_deployments_superseded_by
    FOREIGN KEY (superseded_by) REFERENCES oneshot_deployments(id),

  INDEX idx_oneshot_deployments_run (oneshot_run_id),
  INDEX idx_oneshot_deployments_status (status),
  INDEX idx_oneshot_deployments_slot (slot_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_dashboard_run_requests (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  jira_key              VARCHAR(50)  NOT NULL,
  requested_by          VARCHAR(255) NOT NULL,
  requested_by_display  VARCHAR(255) NOT NULL,
  status                ENUM('queued', 'processing', 'task_created', 'failed')
                          NOT NULL DEFAULT 'queued',
  error_message         TEXT         NULL,
  task_management_id    INT          NULL,
  active_jira_key       VARCHAR(50)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('queued', 'processing') THEN jira_key
        ELSE NULL
      END
    ) STORED,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
  started_at            TIMESTAMP    NULL,
  finished_at           TIMESTAMP    NULL,

  UNIQUE KEY uk_oneshot_dashboard_run_requests_active_jira (active_jira_key),
  INDEX idx_oneshot_dashboard_run_requests_status_created (status, created_at),
  INDEX idx_oneshot_dashboard_run_requests_jira_key (jira_key),
  INDEX idx_oneshot_dashboard_run_requests_task_management (task_management_id),

  CONSTRAINT fk_oneshot_dashboard_run_requests_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_blocked_clients (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_key          VARCHAR(255) NOT NULL,
  display_name        VARCHAR(255) NOT NULL,
  reason              TEXT         NULL,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_by          VARCHAR(255) NOT NULL,
  created_by_display  VARCHAR(255) NOT NULL,
  updated_by          VARCHAR(255) NOT NULL,
  updated_by_display  VARCHAR(255) NOT NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_oneshot_blocked_clients_key (client_key),
  INDEX idx_oneshot_blocked_clients_active (is_active, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_blocked_client_audit_events (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_key          VARCHAR(255) NOT NULL,
  display_name        VARCHAR(255) NOT NULL,
  action              ENUM('created', 'updated', 'deactivated', 'reactivated') NOT NULL,
  reason              TEXT         NULL,
  operator_id         VARCHAR(255) NOT NULL,
  operator_display    VARCHAR(255) NOT NULL,
  old_snapshot_json   JSON         NULL,
  new_snapshot_json   JSON         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_oneshot_blocked_client_audit_key (client_key, created_at, id),
  INDEX idx_oneshot_blocked_client_audit_operator (operator_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_artifact_runs (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_key               VARCHAR(50)  NOT NULL,
  source_parent_key        VARCHAR(50)  NULL,
  mode                     ENUM('wiz', 'sonar', 'wiz_sast', 'documentation') NOT NULL,
  status                   VARCHAR(50)  NOT NULL,
  title                    VARCHAR(255) NOT NULL,
  generated_count          INT          NOT NULL DEFAULT 0,
  generated_tickets_json   JSON         NULL,
  human_review_required    TINYINT(1)   NOT NULL DEFAULT 0,
  human_review_count       INT          NOT NULL DEFAULT 0,
  review_items_json        JSON         NULL,
  evidence_json            JSON         NULL,
  artifact_refs_json       JSON         NULL,
  jira_summary             TEXT         NULL,
  completed_at             TIMESTAMP(3) NULL,
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_oneshot_artifact_source_mode (source_key, mode),
  INDEX idx_oneshot_artifact_mode_updated (mode, updated_at, id),
  INDEX idx_oneshot_artifact_status_updated (status, updated_at, id),
  INDEX idx_oneshot_artifact_parent (source_parent_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_sources (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_jira_key     VARCHAR(50)  NOT NULL,
  source_summary      VARCHAR(255) NOT NULL,
  source_status       VARCHAR(100) NULL,
  source_labels_json  JSON         NULL,
  loe_hours           DECIMAL(8,2) NULL,
  state               ENUM('candidate','drafting','draft_ready','approved','oneshot_submitted','needs_attention','not_qualified','archived') NOT NULL DEFAULT 'candidate',
  origin              ENUM('louise','compose') NOT NULL DEFAULT 'louise',
  approved_epic_key   VARCHAR(50)  NULL,
  qualification_reasons_json JSON NULL,
  last_seen_at        TIMESTAMP(3) NULL,
  submitted_at        TIMESTAMP(3) NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_spec_factory_source_key (source_jira_key),
  INDEX idx_spec_factory_sources_state_updated (state, updated_at, id),
  INDEX idx_spec_factory_sources_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_drafts (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id              BIGINT      NOT NULL,
  workflow_id            BIGINT      NULL,
  version                INT         NOT NULL,
  evidence_snapshot_id   BIGINT      NULL,
  status                 ENUM('generating','ready','approved','superseded','failed') NOT NULL DEFAULT 'generating',
  draft_json             JSON        NULL,
  rendered_markdown      MEDIUMTEXT  NULL,
  evidence_manifest_json JSON        NULL,
  model_metadata_json    JSON        NULL,
  approved_by            VARCHAR(255) NULL,
  approved_at            TIMESTAMP(3) NULL,
  error_message          TEXT        NULL,
  created_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_drafts_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_spec_factory_draft_version (source_id, version),
  INDEX idx_spec_factory_drafts_id_source (id, source_id),
  INDEX idx_spec_factory_drafts_evidence_snapshot (evidence_snapshot_id),
  INDEX idx_spec_factory_drafts_source_status (source_id, status, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_child_tickets (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id           BIGINT       NOT NULL,
  draft_id            BIGINT       NOT NULL,
  repo_id             INT          NULL,
  repo_name           VARCHAR(255) NOT NULL,
  summary             VARCHAR(255) NOT NULL,
  description         MEDIUMTEXT   NOT NULL,
  loe_hours           DECIMAL(8,2) NULL,
  jira_key            VARCHAR(50)  NULL,
  state               ENUM('draft','created','pfos_labeled','oneshot_requested','oneshot_running','oneshot_terminal','failed') NOT NULL DEFAULT 'draft',
  oneshot_request_id  BIGINT       NULL,
  oneshot_run_id      BIGINT       NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_child_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_spec_factory_child_draft_source
    FOREIGN KEY (draft_id) REFERENCES spec_factory_drafts(id),
  INDEX idx_spec_factory_child_draft_repo (draft_id, repo_name),
  UNIQUE KEY uk_spec_factory_child_jira (jira_key),
  INDEX idx_spec_factory_child_source_state (source_id, state),
  INDEX idx_spec_factory_child_oneshot_request (oneshot_request_id),
  INDEX idx_spec_factory_child_oneshot_run (oneshot_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_events (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id      BIGINT       NOT NULL,
  event_type     VARCHAR(80)  NOT NULL,
  actor          VARCHAR(255) NULL,
  request_id     VARCHAR(128) NULL,
  metadata_json  JSON         NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_events_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_events_source_time (source_id, created_at, id),
  INDEX idx_spec_factory_events_type_time (event_type, created_at, id),
  INDEX idx_spec_factory_events_request (request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_attachments (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id           BIGINT       NOT NULL,
  jira_attachment_id  VARCHAR(80)  NOT NULL,
  filename            VARCHAR(512) NOT NULL,
  mime_type           VARCHAR(255) NULL,
  size_bytes          BIGINT       NULL,
  artifact_kind       VARCHAR(50)  NOT NULL DEFAULT 'other',
  is_priority         BOOLEAN      NOT NULL DEFAULT FALSE,
  s3_bucket           VARCHAR(255) NULL,
  s3_key              VARCHAR(1024) NULL,
  sha256              CHAR(64)     NULL,
  extracted_text      MEDIUMTEXT   NULL,
  extraction_status   ENUM('stored','extracted','unsupported','failed','skipped') NOT NULL DEFAULT 'stored',
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_attachments_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_spec_factory_attachment_source_jira (source_id, jira_attachment_id),
  INDEX idx_spec_factory_attachments_source_kind (source_id, artifact_kind, id),
  INDEX idx_spec_factory_attachments_status (extraction_status, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_evidence_snapshots (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id                BIGINT       NOT NULL,
  source_jira_key          VARCHAR(50)  NOT NULL,
  source_summary           VARCHAR(255) NOT NULL,
  source_status            VARCHAR(100) NULL,
  source_labels_json       JSON         NULL,
  description_markdown     MEDIUMTEXT   NULL,
  comments_json            JSON         NULL,
  loe_hours                DECIMAL(8,2) NULL,
  loe_source               VARCHAR(600) NULL,
  artifacts_json           JSON         NULL,
  repo_references_json     JSON         NULL,
  warnings_json            JSON         NULL,
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_evidence_snapshots_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_evidence_source_created (source_id, created_at, id),
  INDEX idx_spec_factory_evidence_jira_key (source_jira_key, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_processing_jobs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id       BIGINT       NOT NULL,
  job_type        VARCHAR(50)  NOT NULL,
  status          ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  requested_by    VARCHAR(255) NULL,
  request_id      VARCHAR(128) NULL,
  worker_id       VARCHAR(255) NULL,
  error_message   TEXT         NULL,
  started_at      TIMESTAMP(3) NULL,
  finished_at     TIMESTAMP(3) NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_processing_jobs_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_jobs_status_created (status, job_type, created_at, id),
  INDEX idx_spec_factory_jobs_source_status (source_id, status, id),
  INDEX idx_spec_factory_jobs_request (request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_intake_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  intake_source   VARCHAR(50) NOT NULL,
  status          ENUM('succeeded','failed') NOT NULL,
  scanned         INT NOT NULL DEFAULT 0,
  inserted_count  INT NOT NULL DEFAULT 0,
  matched         INT NOT NULL DEFAULT 0,
  claimed         INT NOT NULL DEFAULT 0,
  claim_failures  INT NOT NULL DEFAULT 0,
  auto_queued     INT NOT NULL DEFAULT 0,
  error_message   TEXT NULL,
  started_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_intake_source_status_finished (intake_source, status, finished_at, id),
  INDEX idx_spec_factory_intake_finished (finished_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_self_fix_tickets (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  candidate_key         VARCHAR(160) NOT NULL,
  range_key             ENUM('24h', '7d', '30d', 'all') NOT NULL,
  snapshot_fingerprint  CHAR(40)     NOT NULL,
  jira_key              VARCHAR(50)  NOT NULL,
  jira_url              VARCHAR(512) NULL,
  run_request_id        BIGINT       NULL,
  status                ENUM('ticket_created', 'duplicate', 'run_requested', 'failed')
                          NOT NULL DEFAULT 'ticket_created',
  candidate_metadata    JSON         NOT NULL,
  last_error            TEXT         NULL,
  active_candidate_key  VARCHAR(160)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('ticket_created', 'duplicate', 'run_requested') THEN candidate_key
        ELSE NULL
      END
    ) STORED,
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                          ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_oneshot_self_fix_active_candidate (active_candidate_key),
  INDEX idx_oneshot_self_fix_candidate (candidate_key),
  INDEX idx_oneshot_self_fix_jira_key (jira_key),
  INDEX idx_oneshot_self_fix_run_request (run_request_id),

  CONSTRAINT fk_oneshot_self_fix_run_request
    FOREIGN KEY (run_request_id) REFERENCES oneshot_dashboard_run_requests(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS router_decisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  task_management_id INT NULL,
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outcome VARCHAR(50) NOT NULL,
  decision_source VARCHAR(50) NOT NULL,
  signals_json JSON NULL,
  scores_json JSON NULL,
  top1_repo_id INT NULL,
  top1_score DECIMAL(10, 3) NULL,
  top2_repo_id INT NULL,
  top2_score DECIMAL(10, 3) NULL,
  chosen_repo_id INT NULL,
  selected_repo_ids_json JSON NULL,
  unsupported_repo_ids_json JSON NULL,
  blocking_reasons_json JSON NULL,
  llm_input_json JSON NULL,
  llm_output_json JSON NULL,
  llm_cost_usd DECIMAL(12, 6) NULL,
  current_logic_result JSON NULL,
  current_logic_disposition VARCHAR(50) NULL,
  profile_versions_json JSON NULL,
  weights_version VARCHAR(50) NULL,
  extractor_schema_version VARCHAR(100) NULL,
  snapshot_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_router_decisions_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id),
  CONSTRAINT fk_router_decisions_top1_repo
    FOREIGN KEY (top1_repo_id) REFERENCES code_repositories(id),
  CONSTRAINT fk_router_decisions_top2_repo
    FOREIGN KEY (top2_repo_id) REFERENCES code_repositories(id),
  CONSTRAINT fk_router_decisions_chosen_repo
    FOREIGN KEY (chosen_repo_id) REFERENCES code_repositories(id),

  INDEX idx_router_decisions_ticket_ts (ticket_id, ts),
  INDEX idx_router_decisions_outcome (outcome),
  INDEX idx_router_decisions_task_management (task_management_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS router_confirmations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  task_management_id INT NULL,
  router_decision_id BIGINT NULL,
  candidates_json JSON NOT NULL,
  evidence_json JSON NULL,
  jira_comment_id VARCHAR(100) NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  resolved_by VARCHAR(255) NULL,
  resolved_repo_id INT NULL,
  resolution_source ENUM('jira_reply', 'dashboard', 'auto_timeout', 'target_repo_field_set') NULL,
  timeout_state ENUM('pending', 'escalated', 'timed_out') NOT NULL DEFAULT 'pending',
  snapshot_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_router_confirmations_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id),
  CONSTRAINT fk_router_confirmations_decision
    FOREIGN KEY (router_decision_id) REFERENCES router_decisions(id),
  CONSTRAINT fk_router_confirmations_repo
    FOREIGN KEY (resolved_repo_id) REFERENCES code_repositories(id),

  INDEX idx_router_confirmations_ticket_pending (ticket_id, resolved_at, timeout_state),
  INDEX idx_router_confirmations_task_management (task_management_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS historical_ticket_index (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  text MEDIUMTEXT NOT NULL,
  routed_repo_id INT NOT NULL,
  disposition VARCHAR(50) NULL,
  component VARCHAR(255) NULL,
  epic_id VARCHAR(100) NULL,
  ticket_created_at TIMESTAMP NULL,
  pr_files_touched_json JSON NULL,
  included_reason ENUM('merged_pr', 'explicit_confirmation', 'backfill_seed') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_historical_ticket_index_repo
    FOREIGN KEY (routed_repo_id) REFERENCES code_repositories(id),

  UNIQUE KEY uk_historical_ticket_reason (ticket_id, routed_repo_id, included_reason),
  INDEX idx_historical_ticket_repo (routed_repo_id),
  INDEX idx_historical_ticket_created (ticket_created_at),
  FULLTEXT KEY ftx_historical_ticket_text (text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS router_truth_set (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  correct_repo_id INT NOT NULL,
  label_source ENUM('auto', 'human') NOT NULL,
  labeled_by VARCHAR(255) NULL,
  labeled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  held_out_flag BOOLEAN NOT NULL DEFAULT FALSE,
  truth_set_version VARCHAR(50) NOT NULL DEFAULT '1',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_router_truth_set_repo
    FOREIGN KEY (correct_repo_id) REFERENCES code_repositories(id),

  UNIQUE KEY uk_router_truth_set_ticket_version (ticket_id, truth_set_version),
  INDEX idx_router_truth_set_held_out (held_out_flag, truth_set_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- INVESTIGATION COCKPIT TARGET THROTTLE
-- ============================================================================
-- Bounded target leases for Cockpit/MERIDIAN worker concurrency.
-- Contains operational metadata only; no Jira body, PHI, SQL, or client data.

CREATE TABLE IF NOT EXISTS investigation_target_slots (
  target_key        VARCHAR(240) NOT NULL,
  slot_no           INT          NOT NULL,
  run_id            VARCHAR(80)  NULL,
  lease_expires_at  DATETIME(3)  NULL,
  heartbeat_at      DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (target_key, slot_no),
  INDEX idx_investigation_target_slots_run (run_id),
  INDEX idx_investigation_target_slots_lease (lease_expires_at),
  INDEX idx_investigation_target_slots_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW v_oneshot_stuck_runs AS
SELECT id, jira_key, state, updated_at
FROM oneshot_runs
WHERE state LIKE 'queued_for_%'
  AND updated_at < NOW() - INTERVAL 10 MINUTE;

-- Deferred FK: chat_sessions -> task_management (created after both tables exist)
ALTER TABLE chat_sessions
  ADD CONSTRAINT fk_cs_task_mgmt FOREIGN KEY (task_management_id) REFERENCES task_management(id),
  ADD INDEX idx_cs_task_mgmt (task_management_id);

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View: Active tasks with agent info
CREATE OR REPLACE VIEW v_active_tasks AS
SELECT
  tm.id as task_management_id,
  tm.jira_number,
  tm.status as tm_status,
  a.name as agent_name,
  a.model as agent_model,
  t.id as task_id,
  t.task_type,
  t.status as task_status,
  t.task_description,
  t.result_s3_bucket,
  t.result_s3_key,
  tm.created_at as assigned_at,
  t.started_at,
  t.completed_at
FROM task_management tm
JOIN agents a ON tm.agent_id = a.id
LEFT JOIN tasks t ON tm.task_id = t.id
WHERE tm.status IN ('assigned', 'in_progress', 'completed', 'posting_to_jira')
ORDER BY tm.created_at DESC;

-- View: Agent workload
CREATE OR REPLACE VIEW v_agent_workload AS
SELECT
  a.id as agent_id,
  a.name as agent_name,
  COUNT(CASE WHEN tm.status = 'assigned' THEN 1 END) as assigned_count,
  COUNT(CASE WHEN tm.status = 'in_progress' THEN 1 END) as in_progress_count,
  COUNT(CASE WHEN tm.status = 'completed' THEN 1 END) as completed_count,
  COUNT(CASE WHEN tm.status = 'failed' THEN 1 END) as failed_count,
  COUNT(CASE WHEN tm.status = 'failed_retries_exhausted' THEN 1 END) as failed_retries_exhausted_count,
  COUNT(*) as total_tasks
FROM agents a
LEFT JOIN task_management tm ON a.id = tm.agent_id
WHERE a.is_active = TRUE
GROUP BY a.id, a.name;

-- View: Tasks pending JIRA posting (includes agent's jira_token for posting)
CREATE OR REPLACE VIEW v_pending_jira_posts AS
SELECT
  tm.id,
  tm.jira_number,
  tm.agent_id,
  tm.customer_id,
  a.name as agent_name,
  a.model as agent_model,
  a.jira_token,
  a.jira_username,
  cb.customer as customer_name,
  cb.branch as code_branch,
  t.result_s3_bucket,
  t.result_s3_key,
  t.tokens_consumed,
  t.cost,
  t.started_at,
  t.completed_at,
  TIMESTAMPDIFF(SECOND, t.started_at, t.completed_at) as duration_seconds,
  tm.retry_count
FROM task_management tm
JOIN agents a ON tm.agent_id = a.id
JOIN tasks t ON tm.task_id = t.id
JOIN customer_branches cb ON tm.customer_id = cb.id
WHERE tm.status = 'completed'
  AND tm.source = 'jira'
  AND t.status = 'completed'
  AND t.result_s3_key IS NOT NULL
  AND tm.retry_count < 3
ORDER BY t.completed_at ASC;

-- ============================================================================
-- COMPOSE SESSIONS TABLES (Spec Factory Phase 1)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compose_sessions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(200) NOT NULL,
  created_by          VARCHAR(120) NULL,
  created_by_display  VARCHAR(200) NULL,
  agent_persona_key   VARCHAR(80)  NULL,
  agent_persona_name  VARCHAR(120) NULL,
  status              ENUM('draft','ready','handed_off','archived') NOT NULL DEFAULT 'draft',
  archived_at         TIMESTAMP(3) NULL,
  claude_session_id   VARCHAR(120) NULL,
  source_id           BIGINT       NULL,
  readiness_json      JSON         NULL,
  last_active_at      TIMESTAMP(3) NULL,
  last_action         VARCHAR(80)  NULL,
  last_actor          VARCHAR(120) NULL,
  active_turn_started_at TIMESTAMP(3) NULL,
  latest_context_version BIGINT    NULL,
  context_status      VARCHAR(32)  NOT NULL DEFAULT 'dirty',
  conversation_summary_uri TEXT    NULL,
  password_hash       VARCHAR(255) NULL,
  s3_prefix           VARCHAR(300) NOT NULL,
  workspace_path      VARCHAR(400) NOT NULL,
  workspace_cleaned_at TIMESTAMP(3) NULL,
  workspace_cleanup_error TEXT     NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_sessions_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_compose_sessions_source_id (source_id),
  INDEX idx_compose_sessions_status_updated (status, updated_at, id),
  INDEX idx_compose_sessions_cleanup (status, archived_at, workspace_cleaned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_session_sources (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id         BIGINT       NOT NULL,
  request_id         VARCHAR(128) NULL,
  kind               ENUM('file','youtube','chat','note','jira','confluence','generated_research') NOT NULL,
  original_filename  VARCHAR(400) NULL,
  mime_type          VARCHAR(160) NULL,
  size_bytes         BIGINT       NULL,
  source_url         VARCHAR(2000) NULL,
  s3_key_raw         VARCHAR(500) NULL,
  converter          ENUM('markitdown','voxtral','none') NOT NULL DEFAULT 'none',
  markdown_path      VARCHAR(500) NULL,
  markdown_content   MEDIUMTEXT   NULL,
  source_summary     TEXT         NULL,
  source_entities_json JSON       NULL,
  source_usefulness  VARCHAR(40)  NULL,
  source_contribution TEXT        NULL,
  source_origin      VARCHAR(32)  NOT NULL DEFAULT 'user',
  generated_by_task_id BIGINT     NULL,
  parent_source_ids_json JSON     NULL,
  context_version_used BIGINT     NULL,
  evidence_json      JSON         NULL,
  confidence         VARCHAR(32)  NULL,
  artifact_uri       TEXT         NULL,
  artifact_sha256    CHAR(64)     NULL,
  artifact_bytes     BIGINT       NULL,
  current_revision_id BIGINT      NULL,
  content_sha256     CHAR(64)     NULL,
  deleted_at         TIMESTAMP(3) NULL,
  deleted_by         VARCHAR(128) NULL,
  deletion_id        BIGINT       NULL,
  purged_at           TIMESTAMP(3) NULL,
  conversion_status  ENUM('awaiting_upload','pending','converting','converted','unsupported','failed') NOT NULL DEFAULT 'pending',
  conversion_started_at TIMESTAMP(3) NULL,
  conversion_attempts INT NOT NULL DEFAULT 0,
  conversion_lease_expires_at TIMESTAMP(3) NULL,
  error_message      TEXT         NULL,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_sources_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_session_sources_session (session_id, id),
  INDEX idx_compose_session_sources_request (request_id, id),
  UNIQUE KEY uk_compose_session_sources_generated_task (generated_by_task_id),
  INDEX idx_compose_session_sources_deletion (deletion_id, deleted_at, id),
  INDEX idx_compose_sources_status_id (conversion_status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_source_deletions (
  id                          BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                  BIGINT       NOT NULL,
  source_id                   BIGINT       NOT NULL,
  source_title                VARCHAR(400) NOT NULL,
  deleted_by                  VARCHAR(128) NULL,
  status                      ENUM(
    'undoable','restored','purging','purged','failed'
  ) NOT NULL DEFAULT 'undoable',
  undo_until                  TIMESTAMP(3) NOT NULL,
  invalidated_source_ids_json JSON         NOT NULL,
  invalidated_handoff_ids_json JSON        NOT NULL,
  restored_by                 VARCHAR(128) NULL,
  restored_at                 TIMESTAMP(3) NULL,
  purge_started_at            TIMESTAMP(3) NULL,
  purged_at                   TIMESTAMP(3) NULL,
  purge_error                 TEXT         NULL,
  deleted_file_count          BIGINT       NOT NULL DEFAULT 0,
  deleted_object_count        BIGINT       NOT NULL DEFAULT 0,
  created_at                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                             ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_source_deletions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_source_deletions_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  INDEX idx_compose_source_deletions_session (session_id, created_at, id),
  INDEX idx_compose_source_deletions_purge (status, undo_until, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_session_messages (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id           BIGINT       NOT NULL,
  role                 ENUM('user','assistant','system') NOT NULL,
  content              MEDIUMTEXT   NOT NULL,
  turn_job_id          BIGINT       NULL,
  context_version_used BIGINT       NULL,
  agent_task_id        BIGINT       NULL,
  message_kind         VARCHAR(32)  NULL,
  clarification_idempotency_key VARCHAR(128) NULL,
  created_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_messages_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  UNIQUE KEY uniq_compose_messages_clarification_idem
    (session_id, clarification_idempotency_key),
  INDEX idx_compose_session_messages_session (session_id, id),
  INDEX idx_compose_session_messages_turn_job (turn_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_turn_jobs (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                 BIGINT       NOT NULL,
  turn_kind                  ENUM('chat','analyze') NOT NULL DEFAULT 'chat',
  user_message_id            BIGINT       NULL,
  status                     ENUM('queued','running','waiting_on_research','awaiting_user_input','synthesizing','completed','failed','cancelled','abandoned') NOT NULL DEFAULT 'queued',
  requested_context_version  BIGINT       NULL,
  context_version_used       BIGINT       NULL,
  coordinator_run_id         VARCHAR(128) NULL,
  active_worker_id           VARCHAR(128) NULL,
  lease_generation           BIGINT       NOT NULL DEFAULT 0,
  lease_until                TIMESTAMP(3) NULL,
  idempotency_key            VARCHAR(128) NOT NULL,
  request_hash               CHAR(64)     NOT NULL,
  request_id                 VARCHAR(128) NULL,
  attempt_count              INT          NOT NULL DEFAULT 0,
  max_attempts               INT          NOT NULL DEFAULT 3,
  research_round_count       INT          NOT NULL DEFAULT 0,
  max_research_rounds        INT          NOT NULL DEFAULT 3,
  cancellation_requested_at  TIMESTAMP(3) NULL,
  clarification_expires_at   TIMESTAMP(3) NULL,
  clarification_answer_message_id BIGINT  NULL,
  clarification_answer_idempotency_key VARCHAR(128) NULL,
  error_code                 VARCHAR(64)  NULL,
  error_message              TEXT         NULL,
  created_at                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at                 TIMESTAMP(3) NULL,
  completed_at               TIMESTAMP(3) NULL,

  CONSTRAINT fk_compose_turn_jobs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_turn_jobs_user_message
    FOREIGN KEY (user_message_id) REFERENCES compose_session_messages(id),
  CONSTRAINT fk_compose_turn_jobs_clarification_answer_message
    FOREIGN KEY (clarification_answer_message_id) REFERENCES compose_session_messages(id),
  UNIQUE KEY uniq_turn_idempotency (session_id, idempotency_key),
  UNIQUE KEY uniq_turn_clarification_answer_idempotency (session_id, clarification_answer_idempotency_key),
  INDEX idx_compose_turn_jobs_claim (status, lease_until, created_at),
  INDEX idx_compose_turn_jobs_session_status (session_id, status, created_at),
  INDEX idx_compose_turn_jobs_worker (active_worker_id),
  INDEX idx_compose_turn_jobs_user_message (user_message_id),
  INDEX idx_compose_turn_jobs_clarification_answer_message (clarification_answer_message_id),
  INDEX idx_compose_turn_jobs_request (request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_turn_outputs (
  turn_job_id          BIGINT PRIMARY KEY,
  session_id           BIGINT NOT NULL,
  assistant_message_id BIGINT NOT NULL,
  context_version_used BIGINT NULL,
  final_payload_json   JSON   NULL,
  created_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_turn_outputs_turn
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id),
  CONSTRAINT fk_compose_turn_outputs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_turn_outputs_assistant_message
    FOREIGN KEY (assistant_message_id) REFERENCES compose_session_messages(id),
  UNIQUE KEY uniq_compose_turn_outputs_assistant_message (assistant_message_id),
  INDEX idx_compose_turn_outputs_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_agent_tasks (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                 BIGINT       NOT NULL,
  turn_job_id                BIGINT       NULL,
  capability                 VARCHAR(64)  NOT NULL,
  executor_type              VARCHAR(64)  NULL,
  request_id                 VARCHAR(128) NULL,
  status                     ENUM('queued','running','completed','failed','cancelled','abandoned') NOT NULL DEFAULT 'queued',
  priority                   INT          NOT NULL DEFAULT 100,
  input_json                 JSON         NOT NULL,
  output_json                JSON         NULL,
  context_version_used       BIGINT       NULL,
  output_source_id           BIGINT       NULL,
  active_worker_id           VARCHAR(128) NULL,
  lease_generation           BIGINT       NOT NULL DEFAULT 0,
  lease_until                TIMESTAMP(3) NULL,
  attempt_count              INT          NOT NULL DEFAULT 0,
  max_attempts               INT          NOT NULL DEFAULT 3,
  cancellation_requested_at  TIMESTAMP(3) NULL,
  error_code                 VARCHAR(64)  NULL,
  error_message              TEXT         NULL,
  created_at                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at                 TIMESTAMP(3) NULL,
  completed_at               TIMESTAMP(3) NULL,

  CONSTRAINT fk_compose_agent_tasks_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_agent_tasks_turn
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id),
  CONSTRAINT fk_compose_agent_tasks_output_source
    FOREIGN KEY (output_source_id) REFERENCES compose_session_sources(id),
  INDEX idx_compose_agent_tasks_claim (capability, status, lease_until, priority, created_at),
  INDEX idx_compose_agent_tasks_session_created (session_id, created_at),
  INDEX idx_compose_agent_tasks_turn_job (turn_job_id),
  INDEX idx_compose_agent_tasks_worker (active_worker_id),
  INDEX idx_compose_agent_tasks_output_source (output_source_id),
  INDEX idx_compose_agent_tasks_request (request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_agent_runtime_runs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id          BIGINT       NOT NULL,
  agent_task_id       BIGINT       NOT NULL,
  executor_type       VARCHAR(64)  NOT NULL,
  provider            VARCHAR(64)  NULL,
  model               VARCHAR(128) NULL,
  workspace_uri       TEXT         NULL,
  trace_uri           TEXT         NULL,
  output_artifact_uri TEXT         NULL,
  status              VARCHAR(32)  NOT NULL,
  started_at          TIMESTAMP(3) NULL,
  completed_at        TIMESTAMP(3) NULL,
  input_tokens        BIGINT       NULL,
  output_tokens       BIGINT       NULL,
  estimated_cost_usd  DECIMAL(12,6) NULL,
  error_code          VARCHAR(128) NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_agent_runtime_runs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_agent_runtime_runs_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id),
  INDEX idx_compose_agent_runtime_runs_task (agent_task_id),
  INDEX idx_compose_agent_runtime_runs_session (session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_source_revisions (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT        NOT NULL,
  source_id       BIGINT        NOT NULL,
  revision_number BIGINT        NOT NULL,
  content_sha256  CHAR(64)      NOT NULL,
  artifact_uri    TEXT          NOT NULL,
  artifact_sha256 CHAR(64)      NOT NULL,
  artifact_bytes  BIGINT        NOT NULL,
  content_type    VARCHAR(128)  NULL,
  status          ENUM('ready','superseded','deleted') NOT NULL DEFAULT 'ready',
  created_by      VARCHAR(128)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_source_revisions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_source_revisions_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  UNIQUE KEY uniq_compose_source_revision_number (source_id, revision_number),
  UNIQUE KEY uniq_compose_source_revision_content (source_id, content_sha256),
  INDEX idx_compose_source_revisions_session (session_id, created_at),
  INDEX idx_compose_source_revisions_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_source_chunks (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id         BIGINT       NOT NULL,
  source_id          BIGINT       NOT NULL,
  source_revision_id BIGINT       NOT NULL,
  chunk_index        INT          NOT NULL,
  start_offset       BIGINT       NOT NULL,
  end_offset         BIGINT       NOT NULL,
  token_estimate     INT          NOT NULL,
  content_text       MEDIUMTEXT   NOT NULL,
  content_sha256     CHAR(64)     NOT NULL,
  artifact_uri       TEXT         NOT NULL,
  artifact_sha256    CHAR(64)     NOT NULL,
  artifact_bytes     BIGINT       NOT NULL,
  status             ENUM('ready','superseded','deleted') NOT NULL DEFAULT 'ready',
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_source_chunks_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_source_chunks_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  CONSTRAINT fk_compose_source_chunks_revision
    FOREIGN KEY (source_revision_id) REFERENCES compose_source_revisions(id),
  UNIQUE KEY uniq_compose_source_chunk_index (source_revision_id, chunk_index),
  UNIQUE KEY uniq_compose_source_chunk_content (source_revision_id, content_sha256),
  INDEX idx_compose_source_chunks_source (source_id, source_revision_id),
  INDEX idx_compose_source_chunks_session (session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_context_patches (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id           BIGINT       NOT NULL,
  source_id            BIGINT       NULL,
  source_revision_id   BIGINT       NULL,
  agent_task_id        BIGINT       NULL,
  turn_job_id          BIGINT       NULL,
  base_context_version BIGINT       NULL,
  schema_version       INT          NOT NULL DEFAULT 4,
  patch_kind           VARCHAR(32)  NOT NULL DEFAULT 'source_distillation',
  idempotency_key      VARCHAR(191) NULL,
  message_ids_json     JSON         NULL,
  status               ENUM('building','ready','failed','superseded') NOT NULL DEFAULT 'building',
  patch_uri            TEXT         NULL,
  artifact_sha256      CHAR(64)     NULL,
  artifact_bytes       BIGINT       NULL,
  patch_json           JSON         NULL,
  error_message        TEXT         NULL,
  created_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_context_patches_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_context_patches_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  CONSTRAINT fk_compose_context_patches_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id),
  CONSTRAINT fk_compose_context_patches_turn
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id),
  CONSTRAINT fk_compose_context_patches_revision
    FOREIGN KEY (source_revision_id) REFERENCES compose_source_revisions(id),
  UNIQUE KEY uniq_compose_context_patch_idempotency (session_id, idempotency_key),
  INDEX idx_compose_context_patches_session_status (session_id, status, created_at),
  INDEX idx_compose_context_patches_source (source_id),
  INDEX idx_compose_context_patches_task (agent_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_context_versions (
  id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id              BIGINT       NOT NULL,
  version                 BIGINT       NOT NULL,
  schema_version          INT          NOT NULL DEFAULT 3,
  status                  ENUM('building','committed','failed','superseded') NOT NULL DEFAULT 'building',
  parent_version          BIGINT       NULL,
  artifact_uri            TEXT         NULL,
  structured_artifact_uri TEXT         NULL,
  summary_json            JSON         NULL,
  facts_json              JSON         NULL,
  implementation_findings_json JSON    NULL,
  requirements_json       JSON         NULL,
  constraints_json        JSON         NULL,
  open_questions_json     JSON         NULL,
  conflicts_json          JSON         NULL,
  decisions_json          JSON         NULL,
  risks_json              JSON         NULL,
  source_ids_json         JSON         NULL,
  patch_ids_json          JSON         NULL,
  created_by_task_id      BIGINT       NULL,
  artifact_sha256         CHAR(64)     NULL,
  artifact_bytes          BIGINT       NULL,
  error_message           TEXT         NULL,
  created_at              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at            TIMESTAMP(3) NULL,

  CONSTRAINT fk_compose_context_versions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_context_versions_task
    FOREIGN KEY (created_by_task_id) REFERENCES compose_agent_tasks(id),
  UNIQUE KEY uniq_compose_context_versions_session_version (session_id, version),
  INDEX idx_compose_context_versions_latest (session_id, status, version),
  INDEX idx_compose_context_versions_task (created_by_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_workspace_manifests (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT        NOT NULL,
  workspace_path  VARCHAR(1024) NOT NULL,
  manifest_json   JSON          NOT NULL,
  manifest_bytes  BIGINT        NOT NULL,
  manifest_sha256 CHAR(64)      NOT NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_workspace_manifests_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  UNIQUE KEY uniq_compose_workspace_manifests_session (session_id),
  INDEX idx_compose_workspace_manifests_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_outbox (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  aggregate_type   VARCHAR(64)  NOT NULL,
  aggregate_id     VARCHAR(128) NOT NULL,
  event_type       VARCHAR(128) NOT NULL,
  schema_version   INT          NOT NULL DEFAULT 1,
  dedupe_key       VARCHAR(191) NOT NULL,
  payload_json     JSON         NOT NULL,
  status           ENUM('pending','publishing','published','failed','dead') NOT NULL DEFAULT 'pending',
  publish_attempts INT          NOT NULL DEFAULT 0,
  available_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_owner      VARCHAR(128) NULL,
  lease_until      TIMESTAMP(3) NULL,
  published_at     TIMESTAMP(3) NULL,
  last_error       TEXT         NULL,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uniq_spec_factory_outbox_dedupe (dedupe_key),
  INDEX idx_spec_factory_outbox_claim (status, available_at, lease_until, id),
  INDEX idx_spec_factory_outbox_aggregate (aggregate_type, aggregate_id, id),
  INDEX idx_spec_factory_outbox_published (published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


DROP TRIGGER IF EXISTS trg_compose_source_conversion_insert_outbox;
CREATE TRIGGER trg_compose_source_conversion_insert_outbox
AFTER INSERT ON compose_session_sources
FOR EACH ROW
INSERT INTO spec_factory_outbox
  (aggregate_type, aggregate_id, event_type, schema_version, dedupe_key,
   payload_json, status, available_at)
SELECT
  'source_conversion',
  CAST(NEW.id AS CHAR),
  'source.conversion.queued',
  1,
  CONCAT('source-conversion:', NEW.id, ':g', NEW.conversion_attempts + 1),
  JSON_OBJECT(
    'sessionId', NEW.session_id,
    'sourceId', NEW.id,
    'sourceKind', NEW.kind,
    'queueGeneration', NEW.conversion_attempts + 1
  ),
  'pending',
  COALESCE(NEW.conversion_lease_expires_at, CURRENT_TIMESTAMP(3))
WHERE NEW.conversion_status = 'pending'
ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id);

DROP TRIGGER IF EXISTS trg_compose_source_conversion_update_outbox;
CREATE TRIGGER trg_compose_source_conversion_update_outbox
AFTER UPDATE ON compose_session_sources
FOR EACH ROW
INSERT INTO spec_factory_outbox
  (aggregate_type, aggregate_id, event_type, schema_version, dedupe_key,
   payload_json, status, available_at)
SELECT
  'source_conversion',
  CAST(NEW.id AS CHAR),
  'source.conversion.queued',
  1,
  CONCAT('source-conversion:', NEW.id, ':g', NEW.conversion_attempts + 1),
  JSON_OBJECT(
    'sessionId', NEW.session_id,
    'sourceId', NEW.id,
    'sourceKind', NEW.kind,
    'queueGeneration', NEW.conversion_attempts + 1
  ),
  'pending',
  COALESCE(NEW.conversion_lease_expires_at, CURRENT_TIMESTAMP(3))
WHERE NEW.conversion_status = 'pending'
  AND OLD.conversion_status <> 'pending'
ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id);


CREATE TABLE IF NOT EXISTS spec_factory_queue_receipts (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  consumer_name    VARCHAR(128) NOT NULL,
  message_id       VARCHAR(191) NOT NULL,
  outbox_id        BIGINT       NULL,
  queue_generation BIGINT       NOT NULL DEFAULT 1,
  status           ENUM('processing','completed','failed') NOT NULL DEFAULT 'processing',
  lease_token      CHAR(36)     NULL,
  lease_until      TIMESTAMP(3) NULL,
  result_json      JSON         NULL,
  error_message    TEXT         NULL,
  started_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at     TIMESTAMP(3) NULL,
  updated_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_queue_receipts_outbox
    FOREIGN KEY (outbox_id) REFERENCES spec_factory_outbox(id),
  UNIQUE KEY uniq_spec_factory_queue_receipt (consumer_name, message_id),
  INDEX idx_spec_factory_queue_receipts_status (status, lease_until, updated_at),
  INDEX idx_spec_factory_queue_receipts_outbox (outbox_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_handoffs (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                 BIGINT        NOT NULL,
  source_id                  BIGINT        NULL,
  idempotency_key            VARCHAR(191)  NOT NULL,
  requested_by               VARCHAR(128)  NULL,
  status                     ENUM(
    'requested','snapshot_building','snapshot_ready','draft_queued','drafting',
    'draft_ready','approved','publishing','published','failed','cancelled'
  ) NOT NULL DEFAULT 'requested',
  requested_context_version  BIGINT        NULL,
  context_version_used       BIGINT        NULL,
  message_high_watermark_id  BIGINT        NULL,
  source_revision_set_hash   CHAR(64)      NULL,
  repository_manifest_hash   CHAR(64)      NULL,
  build_agent_task_id        BIGINT        NULL,
  snapshot_id                BIGINT        NULL,
  draft_workflow_id          BIGINT        NULL,
  error_code                 VARCHAR(128)  NULL,
  error_message              TEXT          NULL,
  created_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                           ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at               TIMESTAMP(3)  NULL,

  CONSTRAINT fk_compose_handoffs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_handoffs_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_compose_handoffs_build_task
    FOREIGN KEY (build_agent_task_id) REFERENCES compose_agent_tasks(id),
  UNIQUE KEY uniq_compose_handoff_idempotency (session_id, idempotency_key),
  INDEX idx_compose_handoffs_session_status (session_id, status, created_at),
  INDEX idx_compose_handoffs_source (source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_handoff_snapshots (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  handoff_id                 BIGINT        NOT NULL,
  session_id                 BIGINT        NOT NULL,
  source_id                  BIGINT        NOT NULL,
  schema_version             INT           NOT NULL DEFAULT 2,
  context_version            BIGINT        NULL,
  message_high_watermark_id  BIGINT        NULL,
  source_revision_set_hash   CHAR(64)      NOT NULL,
  repository_manifest_hash   CHAR(64)      NOT NULL,
  snapshot_json              JSON          NOT NULL,
  artifact_uri               TEXT          NOT NULL,
  artifact_sha256            CHAR(64)      NOT NULL,
  artifact_bytes             BIGINT        NOT NULL,
  markdown_artifact_uri      TEXT          NULL,
  markdown_artifact_sha256   CHAR(64)      NULL,
  markdown_artifact_bytes    BIGINT        NULL,
  status                     ENUM('building','ready','failed','superseded')
                               NOT NULL DEFAULT 'building',
  created_by                 VARCHAR(128)  NULL,
  created_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at               TIMESTAMP(3)  NULL,

  CONSTRAINT fk_compose_handoff_snapshots_handoff
    FOREIGN KEY (handoff_id) REFERENCES compose_handoffs(id),
  CONSTRAINT fk_compose_handoff_snapshots_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_handoff_snapshots_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uniq_compose_handoff_snapshot_handoff (handoff_id),
  INDEX idx_compose_handoff_snapshots_session (session_id, created_at),
  INDEX idx_compose_handoff_snapshots_source (source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE compose_handoffs
  ADD CONSTRAINT fk_compose_handoffs_snapshot
  FOREIGN KEY (snapshot_id) REFERENCES compose_handoff_snapshots(id);

CREATE TABLE IF NOT EXISTS spec_factory_draft_workflows (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id             BIGINT        NOT NULL,
  handoff_snapshot_id   BIGINT        NULL,
  idempotency_key       VARCHAR(191)  NOT NULL,
  input_sha256          CHAR(64)      NOT NULL,
  requested_by          VARCHAR(255)  NULL,
  status                ENUM(
    'queued','running','approval_wait','approved','publishing','published',
    'failed','cancelled'
  ) NOT NULL DEFAULT 'queued',
  current_stage         VARCHAR(64)   NOT NULL DEFAULT 'evidence_snapshot',
  evidence_snapshot_id  BIGINT        NULL,
  draft_id              BIGINT        NULL,
  error_code            VARCHAR(128)  NULL,
  error_message         TEXT          NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,

  CONSTRAINT fk_spec_factory_draft_workflows_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_spec_factory_draft_workflows_handoff_snapshot
    FOREIGN KEY (handoff_snapshot_id) REFERENCES compose_handoff_snapshots(id),
  CONSTRAINT fk_spec_factory_draft_workflows_evidence_snapshot
    FOREIGN KEY (evidence_snapshot_id) REFERENCES spec_factory_evidence_snapshots(id),
  CONSTRAINT fk_spec_factory_draft_workflows_draft
    FOREIGN KEY (draft_id) REFERENCES spec_factory_drafts(id),
  UNIQUE KEY uniq_spec_factory_draft_workflow_idem (source_id, idempotency_key),
  INDEX idx_spec_factory_draft_workflows_status (status, updated_at, id),
  INDEX idx_spec_factory_draft_workflows_handoff (handoff_snapshot_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_draft_stage_runs (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  workflow_id           BIGINT        NOT NULL,
  source_id             BIGINT        NOT NULL,
  stage_name            VARCHAR(64)   NOT NULL,
  stage_order           INT           NOT NULL,
  status                ENUM('blocked','queued','running','completed','failed','skipped','waiting')
                                      NOT NULL DEFAULT 'blocked',
  input_json            JSON          NULL,
  input_sha256          CHAR(64)      NOT NULL,
  output_json           JSON          NULL,
  output_artifact_uri   TEXT          NULL,
  output_sha256         CHAR(64)      NULL,
  output_bytes          BIGINT        NULL,
  attempt_count         INT           NOT NULL DEFAULT 0,
  max_attempts          INT           NOT NULL DEFAULT 3,
  lease_generation      BIGINT        NOT NULL DEFAULT 0,
  active_worker_id      VARCHAR(128)  NULL,
  lease_until           TIMESTAMP(3)  NULL,
  provider              VARCHAR(64)   NULL,
  model                 VARCHAR(255)  NULL,
  prompt_version        VARCHAR(64)   NULL,
  input_tokens          BIGINT        NULL,
  output_tokens         BIGINT        NULL,
  estimated_cost_usd    DECIMAL(12,6) NULL,
  duration_ms           BIGINT        NULL,
  error_code            VARCHAR(128)  NULL,
  error_message         TEXT          NULL,
  retryable             BOOLEAN       NULL,
  started_at            TIMESTAMP(3)  NULL,
  completed_at          TIMESTAMP(3)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_draft_stage_runs_workflow
    FOREIGN KEY (workflow_id) REFERENCES spec_factory_draft_workflows(id),
  CONSTRAINT fk_spec_factory_draft_stage_runs_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uniq_spec_factory_draft_stage (workflow_id, stage_name),
  INDEX idx_spec_factory_draft_stage_claim
    (status, stage_order, lease_until, created_at, id),
  INDEX idx_spec_factory_draft_stage_workflow
    (workflow_id, stage_order, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE spec_factory_drafts
  ADD INDEX idx_spec_factory_drafts_workflow (workflow_id),
  ADD CONSTRAINT fk_spec_factory_drafts_workflow
    FOREIGN KEY (workflow_id) REFERENCES spec_factory_draft_workflows(id);

ALTER TABLE compose_handoffs
  ADD CONSTRAINT fk_compose_handoffs_draft_workflow
  FOREIGN KEY (draft_workflow_id) REFERENCES spec_factory_draft_workflows(id);

CREATE TABLE IF NOT EXISTS spec_factory_repair_runs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  repair_type         VARCHAR(64)   NOT NULL,
  status              ENUM('running','completed','completed_with_errors','failed')
                                    NOT NULL DEFAULT 'running',
  dry_run             BOOLEAN       NOT NULL DEFAULT TRUE,
  requested_by        VARCHAR(128)  NULL,
  cursor_session_id   BIGINT        NULL,
  inspected_count     BIGINT        NOT NULL DEFAULT 0,
  queued_count        BIGINT        NOT NULL DEFAULT 0,
  succeeded_count     BIGINT        NOT NULL DEFAULT 0,
  failed_count        BIGINT        NOT NULL DEFAULT 0,
  report_uri          TEXT          NULL,
  report_sha256       CHAR(64)      NULL,
  error_message       TEXT          NULL,
  accepted_by         VARCHAR(128)  NULL,
  acceptance_note     TEXT          NULL,
  accepted_at         TIMESTAMP(3)  NULL,
  started_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at        TIMESTAMP(3)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_repair_runs_type (repair_type, created_at),
  INDEX idx_spec_factory_repair_runs_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_repair_items (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  repair_run_id       BIGINT        NOT NULL,
  session_id          BIGINT        NULL,
  source_id           BIGINT        NULL,
  status              ENUM('planned','queued','succeeded','skipped','failed')
                                    NOT NULL DEFAULT 'planned',
  prior_context_version BIGINT      NULL,
  target_context_version BIGINT     NULL,
  agent_task_id       BIGINT        NULL,
  handoff_id          BIGINT        NULL,
  details_json        JSON          NULL,
  error_code          VARCHAR(128)  NULL,
  error_message       TEXT          NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_repair_items_run
    FOREIGN KEY (repair_run_id) REFERENCES spec_factory_repair_runs(id),
  CONSTRAINT fk_spec_factory_repair_items_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_spec_factory_repair_items_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id),
  CONSTRAINT fk_spec_factory_repair_items_handoff
    FOREIGN KEY (handoff_id) REFERENCES compose_handoffs(id),
  UNIQUE KEY uniq_spec_factory_repair_item_session (repair_run_id, session_id),
  INDEX idx_spec_factory_repair_items_status (repair_run_id, status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_prompt_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  prompt_version VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  purposes_json JSON NOT NULL,
  source VARCHAR(255) NOT NULL,
  changelog_json JSON NOT NULL,
  schema_expectation VARCHAR(128) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uniq_spec_factory_prompt_versions_version (prompt_version),
  INDEX idx_spec_factory_prompt_versions_active (active, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_worker_heartbeats (
  worker_id VARCHAR(128) PRIMARY KEY,
  mode VARCHAR(32) NOT NULL,
  hostname VARCHAR(255) NULL,
  process_id INT NULL,
  capabilities_json JSON NOT NULL,
  started_at TIMESTAMP(3) NOT NULL,
  heartbeat_at TIMESTAMP(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_worker_heartbeats_mode (mode, heartbeat_at),
  INDEX idx_spec_factory_worker_heartbeats_heartbeat (heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_llm_calls (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NULL,
  turn_job_id BIGINT NULL,
  agent_task_id BIGINT NULL,
  request_id VARCHAR(128) NULL,
  purpose VARCHAR(64) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  prompt_version VARCHAR(64) NULL,
  context_version_used BIGINT NULL,
  input_tokens BIGINT NULL,
  output_tokens BIGINT NULL,
  total_tokens BIGINT NULL,
  latency_ms BIGINT NULL,
  estimated_cost_usd DECIMAL(12,6) NULL,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(128) NULL,
  redacted_prompt_uri TEXT NULL,
  redacted_response_uri TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_llm_calls_session (session_id, created_at),
  INDEX idx_spec_factory_llm_calls_turn (turn_job_id),
  INDEX idx_spec_factory_llm_calls_task (agent_task_id),
  INDEX idx_spec_factory_llm_calls_request (request_id, id),
  INDEX idx_spec_factory_llm_calls_created (created_at),
  INDEX idx_spec_factory_llm_calls_provider_model (provider, model, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_session_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT       NOT NULL,
  event_type      VARCHAR(64)  NOT NULL,
  sequence        BIGINT       NULL,
  payload_json    JSON         NOT NULL,
  payload_bytes   INT          NOT NULL DEFAULT 0,
  actor_type      VARCHAR(32)  NULL,
  actor_id        VARCHAR(128) NULL,
  request_id      VARCHAR(128) NULL,
  turn_job_id     BIGINT       NULL,
  agent_task_id   BIGINT       NULL,
  context_version BIGINT       NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_events_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_session_events_turn_job
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id) ON DELETE SET NULL,
  CONSTRAINT fk_compose_session_events_agent_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_compose_session_events_session_sequence (session_id, sequence),
  INDEX idx_compose_session_events_session_created (session_id, created_at),
  INDEX idx_compose_session_events_session_id (session_id, id),
  INDEX idx_compose_session_events_turn_job (turn_job_id),
  INDEX idx_compose_session_events_agent_task (agent_task_id),
  INDEX idx_compose_session_events_request (request_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_stream_tokens (
  token_hash   CHAR(64)     PRIMARY KEY,
  session_id   BIGINT       NOT NULL,
  expires_at   TIMESTAMP(3) NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at TIMESTAMP(3) NULL,
  revoked_at   TIMESTAMP(3) NULL,

  CONSTRAINT fk_compose_stream_tokens_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_stream_tokens_session (session_id),
  INDEX idx_compose_stream_tokens_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
