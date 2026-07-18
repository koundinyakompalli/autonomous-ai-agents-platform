-- Migration 064: per-executor runtime attempt ledger for Compose agent tasks.

CREATE TABLE IF NOT EXISTS compose_agent_runtime_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  agent_task_id BIGINT NOT NULL,
  executor_type VARCHAR(64) NOT NULL,
  provider VARCHAR(64) NULL,
  model VARCHAR(128) NULL,
  workspace_uri TEXT NULL,
  trace_uri TEXT NULL,
  output_artifact_uri TEXT NULL,
  status VARCHAR(32) NOT NULL,
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  input_tokens BIGINT NULL,
  output_tokens BIGINT NULL,
  estimated_cost_usd DECIMAL(12,6) NULL,
  error_code VARCHAR(128) NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_compose_agent_runtime_runs_task (agent_task_id),
  INDEX idx_compose_agent_runtime_runs_session (session_id, created_at),
  CONSTRAINT fk_compose_agent_runtime_runs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_agent_runtime_runs_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
