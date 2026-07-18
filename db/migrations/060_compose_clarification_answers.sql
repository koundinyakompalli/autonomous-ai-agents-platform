-- Migration 060: Idempotent clarification-answer resume for parked Compose turns.

SET @compose_turn_clarification_answer_message_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_turn_jobs'
    AND column_name = 'clarification_answer_message_id'
);
SET @ddl := IF(
  @compose_turn_clarification_answer_message_exists = 0,
  'ALTER TABLE compose_turn_jobs ADD COLUMN clarification_answer_message_id BIGINT NULL AFTER clarification_expires_at, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_turn_clarification_answer_key_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_turn_jobs'
    AND column_name = 'clarification_answer_idempotency_key'
);
SET @ddl := IF(
  @compose_turn_clarification_answer_key_exists = 0,
  'ALTER TABLE compose_turn_jobs ADD COLUMN clarification_answer_idempotency_key VARCHAR(128) NULL AFTER clarification_answer_message_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_turn_clarification_answer_message_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_turn_jobs'
    AND index_name = 'idx_compose_turn_jobs_clarification_answer_message'
);
SET @ddl := IF(
  @compose_turn_clarification_answer_message_index_exists = 0,
  'ALTER TABLE compose_turn_jobs ADD INDEX idx_compose_turn_jobs_clarification_answer_message (clarification_answer_message_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_turn_clarification_answer_key_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_turn_jobs'
    AND index_name = 'uniq_turn_clarification_answer_idempotency'
);
SET @ddl := IF(
  @compose_turn_clarification_answer_key_index_exists = 0,
  'ALTER TABLE compose_turn_jobs ADD UNIQUE KEY uniq_turn_clarification_answer_idempotency (session_id, clarification_answer_idempotency_key), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_turn_clarification_answer_fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'compose_turn_jobs'
    AND constraint_name = 'fk_compose_turn_jobs_clarification_answer_message'
);
SET @ddl := IF(
  @compose_turn_clarification_answer_fk_exists = 0,
  'ALTER TABLE compose_turn_jobs ADD CONSTRAINT fk_compose_turn_jobs_clarification_answer_message FOREIGN KEY (clarification_answer_message_id) REFERENCES compose_session_messages(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
