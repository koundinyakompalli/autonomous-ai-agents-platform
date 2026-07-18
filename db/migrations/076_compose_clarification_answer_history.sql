-- Preserve every clarification answer idempotency key. A durable turn can ask
-- multiple questions, so the single latest-answer key on compose_turn_jobs is
-- insufficient for both multi-round answers and delayed HTTP retries.

SET @clarification_idempotency_column_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND column_name = 'clarification_idempotency_key'
);
SET @clarification_idempotency_column_sql := IF(
  @clarification_idempotency_column_exists = 0,
  'ALTER TABLE compose_session_messages ADD COLUMN clarification_idempotency_key VARCHAR(128) NULL AFTER message_kind, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE clarification_idempotency_column_stmt
  FROM @clarification_idempotency_column_sql;
EXECUTE clarification_idempotency_column_stmt;
DEALLOCATE PREPARE clarification_idempotency_column_stmt;

UPDATE compose_session_messages message
JOIN compose_turn_jobs turn
  ON turn.clarification_answer_message_id = message.id
 AND turn.session_id = message.session_id
SET message.clarification_idempotency_key =
      turn.clarification_answer_idempotency_key
WHERE message.message_kind = 'clarification_answer'
  AND message.clarification_idempotency_key IS NULL
  AND turn.clarification_answer_idempotency_key IS NOT NULL;

SET @clarification_idempotency_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_messages'
    AND index_name = 'uniq_compose_messages_clarification_idem'
);
SET @clarification_idempotency_index_sql := IF(
  @clarification_idempotency_index_exists = 0,
  'ALTER TABLE compose_session_messages ADD UNIQUE KEY uniq_compose_messages_clarification_idem (session_id, clarification_idempotency_key), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE clarification_idempotency_index_stmt
  FROM @clarification_idempotency_index_sql;
EXECUTE clarification_idempotency_index_stmt;
DEALLOCATE PREPARE clarification_idempotency_index_stmt;
