-- Migration 046: Compose workspace retention cleanup metadata.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'archived_at'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN archived_at TIMESTAMP(3) NULL AFTER status, ALGORITHM=INPLACE, LOCK=NONE",
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
    AND column_name = 'workspace_cleaned_at'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN workspace_cleaned_at TIMESTAMP(3) NULL AFTER workspace_path, ALGORITHM=INPLACE, LOCK=NONE",
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
    AND column_name = 'workspace_cleanup_error'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN workspace_cleanup_error TEXT NULL AFTER workspace_cleaned_at, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND index_name = 'idx_compose_sessions_cleanup'
);
SET @ddl := IF(
  @idx_exists = 0,
  "ALTER TABLE compose_sessions ADD INDEX idx_compose_sessions_cleanup (status, archived_at, workspace_cleaned_at), ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
