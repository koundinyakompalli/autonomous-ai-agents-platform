-- Migration 054: Durable Compose turn jobs and final-output idempotency.

SET @compose_message_turn_job_id_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND column_name = 'turn_job_id'
);
SET @ddl := IF(
  @compose_message_turn_job_id_exists = 0,
  'ALTER TABLE compose_session_messages ADD COLUMN turn_job_id BIGINT NULL AFTER content, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_message_context_version_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND column_name = 'context_version_used'
);
SET @ddl := IF(
  @compose_message_context_version_exists = 0,
  'ALTER TABLE compose_session_messages ADD COLUMN context_version_used BIGINT NULL AFTER turn_job_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_message_agent_task_id_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND column_name = 'agent_task_id'
);
SET @ddl := IF(
  @compose_message_agent_task_id_exists = 0,
  'ALTER TABLE compose_session_messages ADD COLUMN agent_task_id BIGINT NULL AFTER context_version_used, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_message_kind_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND column_name = 'message_kind'
);
SET @ddl := IF(
  @compose_message_kind_exists = 0,
  'ALTER TABLE compose_session_messages ADD COLUMN message_kind VARCHAR(32) NULL AFTER agent_task_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_message_turn_job_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND index_name = 'idx_compose_session_messages_turn_job'
);
SET @ddl := IF(
  @compose_message_turn_job_index_exists = 0,
  'ALTER TABLE compose_session_messages ADD INDEX idx_compose_session_messages_turn_job (turn_job_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

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
  attempt_count              INT          NOT NULL DEFAULT 0,
  max_attempts               INT          NOT NULL DEFAULT 3,
  cancellation_requested_at  TIMESTAMP(3) NULL,
  clarification_expires_at   TIMESTAMP(3) NULL,
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
  UNIQUE KEY uniq_turn_idempotency (session_id, idempotency_key),
  INDEX idx_compose_turn_jobs_claim (status, lease_until, created_at),
  INDEX idx_compose_turn_jobs_session_status (session_id, status, created_at),
  INDEX idx_compose_turn_jobs_worker (active_worker_id),
  INDEX idx_compose_turn_jobs_user_message (user_message_id)
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
