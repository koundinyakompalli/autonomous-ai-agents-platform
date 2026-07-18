-- Migration 016: Watchdog session shell foundation.
-- Stores Watchdog draft sessions, run attempts, durable SSE events, evidence,
-- findings, clarifications, audit events, and DARCI handoff tracking.

CREATE TABLE IF NOT EXISTS watchdog_sessions (
  id                       VARCHAR(64) PRIMARY KEY,
  title                    VARCHAR(240) NOT NULL,
  mode                     ENUM('jira', 'natural_language', 'manual') NOT NULL,
  status                   ENUM('draft', 'queued', 'running', 'awaiting_user_input', 'completed', 'failed', 'expired')
                             NOT NULL DEFAULT 'draft',
  owner_id                 VARCHAR(255) NOT NULL,
  owner_display            VARCHAR(255) NOT NULL,
  auth_source              ENUM('alb_oidc', 'local_dev') NOT NULL,
  jira_key                 VARCHAR(50) NULL,
  jira_snapshot            JSON NULL,
  natural_language_prompt  TEXT NULL,
  approved_scope           JSON NULL,
  draft_scope              JSON NULL,
  last_run_attempt_id      VARCHAR(64) NULL,
  expires_at               DATETIME(3) NULL,
  created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_watchdog_sessions_owner_updated (owner_id, updated_at),
  INDEX idx_watchdog_sessions_status_updated (status, updated_at),
  INDEX idx_watchdog_sessions_jira_key (jira_key),
  INDEX idx_watchdog_sessions_status_expires (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_run_attempts (
  id                  VARCHAR(64) PRIMARY KEY,
  session_id          VARCHAR(64) NOT NULL,
  attempt_number      INT NOT NULL,
  trigger_cause       ENUM('initial', 'approval', 'clarification_resume', 'user_rerun', 'expiry_rerun') NOT NULL,
  status              ENUM('queued', 'running', 'awaiting_user_input', 'completed', 'failed', 'expired') NOT NULL,
  correlation_id      VARCHAR(64) NOT NULL,
  approved_scope      JSON NOT NULL,
  provider_key        VARCHAR(64) NULL,
  model_id            VARCHAR(200) NULL,
  failure_code        VARCHAR(120) NULL,
  failure_message     TEXT NULL,
  metrics_json        JSON NULL,
  claimed_by_replica  VARCHAR(240) NULL,
  claimed_at          DATETIME(3) NULL,
  started_at          DATETIME(3) NULL,
  finished_at         DATETIME(3) NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_watchdog_run_attempts_session_attempt (session_id, attempt_number),
  INDEX idx_watchdog_run_attempts_session_created (session_id, created_at),
  INDEX idx_watchdog_run_attempts_correlation (correlation_id),
  INDEX idx_watchdog_run_attempts_status_updated (status, updated_at),
  INDEX idx_watchdog_run_attempts_status_claimed (status, claimed_at),

  CONSTRAINT fk_watchdog_run_attempts_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_clarifications (
  id               VARCHAR(64) PRIMARY KEY,
  session_id       VARCHAR(64) NOT NULL,
  run_attempt_id   VARCHAR(64) NOT NULL,
  status           ENUM('open', 'answered', 'expired') NOT NULL DEFAULT 'open',
  question         TEXT NOT NULL,
  choices          JSON NULL,
  context_json     JSON NULL,
  answer_json      JSON NULL,
  answered_by      VARCHAR(255) NULL,
  answered_at      DATETIME(3) NULL,
  expires_at       DATETIME(3) NOT NULL,
  open_session_id  VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE WHEN status = 'open' THEN session_id ELSE NULL END
    ) STORED,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_watchdog_clarifications_open_session (open_session_id),
  INDEX idx_watchdog_clarifications_run_attempt (run_attempt_id),
  INDEX idx_watchdog_clarifications_status_expires (status, expires_at),

  CONSTRAINT fk_watchdog_clarifications_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id),
  CONSTRAINT fk_watchdog_clarifications_run_attempt
    FOREIGN KEY (run_attempt_id) REFERENCES watchdog_run_attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_evidence_artifacts (
  id              VARCHAR(64) PRIMARY KEY,
  session_id      VARCHAR(64) NOT NULL,
  run_attempt_id  VARCHAR(64) NOT NULL,
  kind            VARCHAR(64) NOT NULL,
  title           VARCHAR(240) NOT NULL,
  summary         TEXT NULL,
  source_tool     VARCHAR(160) NOT NULL,
  source_ref_json JSON NOT NULL,
  time_window     JSON NULL,
  s3_bucket       VARCHAR(255) NULL,
  s3_key          VARCHAR(1024) NULL,
  sha256          VARCHAR(64) NULL,
  byte_count      BIGINT NULL,
  expires_at      DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_watchdog_evidence_session_created (session_id, created_at),
  INDEX idx_watchdog_evidence_run_created (run_attempt_id, created_at),
  INDEX idx_watchdog_evidence_kind_created (kind, created_at),
  INDEX idx_watchdog_evidence_expires (expires_at),

  CONSTRAINT fk_watchdog_evidence_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id),
  CONSTRAINT fk_watchdog_evidence_run_attempt
    FOREIGN KEY (run_attempt_id) REFERENCES watchdog_run_attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_findings (
  id              VARCHAR(64) PRIMARY KEY,
  session_id      VARCHAR(64) NOT NULL,
  run_attempt_id  VARCHAR(64) NOT NULL,
  kind            ENUM('finding', 'no_evidence', 'limitation') NOT NULL,
  severity        ENUM('info', 'low', 'medium', 'high', 'critical') NOT NULL,
  title           VARCHAR(240) NOT NULL,
  summary         TEXT NOT NULL,
  details         TEXT NULL,
  confidence      DECIMAL(5,4) NULL,
  evidence_ids    JSON NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_watchdog_findings_session_created (session_id, created_at),
  INDEX idx_watchdog_findings_run_severity (run_attempt_id, severity),

  CONSTRAINT fk_watchdog_findings_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id),
  CONSTRAINT fk_watchdog_findings_run_attempt
    FOREIGN KEY (run_attempt_id) REFERENCES watchdog_run_attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_server_events (
  id              VARCHAR(64) PRIMARY KEY,
  session_id      VARCHAR(64) NOT NULL,
  run_attempt_id  VARCHAR(64) NULL,
  correlation_id  VARCHAR(64) NOT NULL,
  event_type      VARCHAR(80) NOT NULL,
  sequence        BIGINT NOT NULL,
  payload_json    JSON NOT NULL,
  expires_at      DATETIME(3) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_watchdog_server_events_session_sequence (session_id, sequence),
  INDEX idx_watchdog_server_events_session_created (session_id, created_at),
  INDEX idx_watchdog_server_events_expires (expires_at),

  CONSTRAINT fk_watchdog_server_events_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id),
  CONSTRAINT fk_watchdog_server_events_run_attempt
    FOREIGN KEY (run_attempt_id) REFERENCES watchdog_run_attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_darci_handoffs (
  id                     VARCHAR(64) PRIMARY KEY,
  session_id             VARCHAR(64) NOT NULL,
  run_attempt_id         VARCHAR(64) NOT NULL,
  finding_ids            JSON NOT NULL,
  requested_by           VARCHAR(255) NOT NULL,
  requested_by_display   VARCHAR(255) NOT NULL,
  status                 ENUM('queued', 'task_created', 'running', 'delivering', 'delivered', 'failed', 'cancelled')
                           NOT NULL DEFAULT 'queued',
  task_management_id     INT NULL,
  task_id                INT NULL,
  task_s3_bucket         VARCHAR(255) NULL,
  task_s3_key            VARCHAR(1024) NULL,
  result_s3_bucket       VARCHAR(255) NULL,
  result_s3_key          VARCHAR(1024) NULL,
  result_artifact_id     VARCHAR(64) NULL,
  error_message          TEXT NULL,
  claimed_at             DATETIME(3) NULL,
  finished_at            DATETIME(3) NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_watchdog_darci_task_management (task_management_id),
  INDEX idx_watchdog_darci_session_created (session_id, created_at),
  INDEX idx_watchdog_darci_status_updated (status, updated_at),

  CONSTRAINT fk_watchdog_darci_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id),
  CONSTRAINT fk_watchdog_darci_run_attempt
    FOREIGN KEY (run_attempt_id) REFERENCES watchdog_run_attempts(id),
  CONSTRAINT fk_watchdog_darci_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchdog_audit_events (
  id              VARCHAR(64) PRIMARY KEY,
  session_id      VARCHAR(64) NULL,
  run_attempt_id  VARCHAR(64) NULL,
  correlation_id  VARCHAR(64) NOT NULL,
  actor_id        VARCHAR(255) NOT NULL,
  actor_type      ENUM('operator', 'system', 'agent_runtime', 'mcp') NOT NULL,
  event_type      VARCHAR(120) NOT NULL,
  payload_json    JSON NOT NULL,
  expires_at      DATETIME(3) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_watchdog_audit_session_created (session_id, created_at),
  INDEX idx_watchdog_audit_correlation_created (correlation_id, created_at),
  INDEX idx_watchdog_audit_actor_created (actor_id, created_at),
  INDEX idx_watchdog_audit_expires (expires_at),

  CONSTRAINT fk_watchdog_audit_session
    FOREIGN KEY (session_id) REFERENCES watchdog_sessions(id),
  CONSTRAINT fk_watchdog_audit_run_attempt
    FOREIGN KEY (run_attempt_id) REFERENCES watchdog_run_attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
