-- Migration 058: Global Spec Factory LLM call audit.
--
-- This table is intentionally not Compose-only: session_id, turn_job_id, and
-- agent_task_id are nullable product correlation IDs and do not carry FKs.

CREATE TABLE IF NOT EXISTS spec_factory_llm_calls (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NULL,
  turn_job_id BIGINT NULL,
  agent_task_id BIGINT NULL,
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
  INDEX idx_spec_factory_llm_calls_provider_model (provider, model, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
