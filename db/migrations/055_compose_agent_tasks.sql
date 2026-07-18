-- Migration 055: Durable Compose agent task ledger.

CREATE TABLE IF NOT EXISTS compose_agent_tasks (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                 BIGINT       NOT NULL,
  turn_job_id                BIGINT       NULL,
  capability                 VARCHAR(64)  NOT NULL,
  executor_type              VARCHAR(64)  NULL,
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
  INDEX idx_compose_agent_tasks_output_source (output_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
