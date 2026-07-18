-- Migration 040: Make Compose handoff idempotent under concurrent requests.

SET @compose_source_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND index_name = 'uk_compose_sessions_source_id'
);

SET @ddl := IF(
  @compose_source_idx_exists = 0,
  'ALTER TABLE compose_sessions ADD UNIQUE KEY uk_compose_sessions_source_id (source_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
