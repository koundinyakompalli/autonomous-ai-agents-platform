-- Migration 042: optional password protection for Compose sessions.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'password_hash'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE compose_sessions ADD COLUMN password_hash VARCHAR(255) NULL AFTER readiness_json, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := NULL;
SET @ddl := NULL;
