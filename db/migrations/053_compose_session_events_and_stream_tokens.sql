-- Migration 053: Compose durable session events and DB-backed stream tokens.

CREATE TABLE IF NOT EXISTS compose_session_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT       NOT NULL,
  event_type      VARCHAR(64)  NOT NULL,
  sequence        BIGINT       NULL,
  payload_json    JSON         NOT NULL,
  payload_bytes   INT          NOT NULL DEFAULT 0,
  actor_type      VARCHAR(32)  NULL,
  actor_id        VARCHAR(128) NULL,
  turn_job_id     BIGINT       NULL,
  agent_task_id   BIGINT       NULL,
  context_version BIGINT       NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_events_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  UNIQUE KEY uniq_compose_session_events_session_sequence (session_id, sequence),
  INDEX idx_compose_session_events_session_created (session_id, created_at),
  INDEX idx_compose_session_events_session_id (session_id, id),
  INDEX idx_compose_session_events_turn_job (turn_job_id),
  INDEX idx_compose_session_events_agent_task (agent_task_id)
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
