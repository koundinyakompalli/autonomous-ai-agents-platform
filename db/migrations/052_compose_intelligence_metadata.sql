-- Migration 052: Compose session persona/activity and source intelligence metadata.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'agent_persona_key'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN agent_persona_key VARCHAR(80) NULL AFTER created_by_display, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'agent_persona_name'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN agent_persona_name VARCHAR(120) NULL AFTER agent_persona_key, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'last_active_at'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN last_active_at TIMESTAMP(3) NULL AFTER readiness_json, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'last_action'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN last_action VARCHAR(80) NULL AFTER last_active_at, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'last_actor'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN last_actor VARCHAR(120) NULL AFTER last_action, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'active_turn_started_at'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN active_turn_started_at TIMESTAMP(3) NULL AFTER last_actor, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'source_summary'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_session_sources ADD COLUMN source_summary TEXT NULL AFTER markdown_content, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'source_entities_json'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_session_sources ADD COLUMN source_entities_json JSON NULL AFTER source_summary, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'source_usefulness'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_session_sources ADD COLUMN source_usefulness VARCHAR(40) NULL AFTER source_entities_json, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'source_contribution'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_session_sources ADD COLUMN source_contribution TEXT NULL AFTER source_usefulness, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := NULL;
SET @ddl := NULL;
