-- Migration 039: add 'awaiting_upload' state for file sources pending browser upload (Phase 2).
SET @needs := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'conversion_status'
    AND COLUMN_TYPE NOT LIKE '%awaiting_upload%'
);
SET @ddl := IF(
  @needs = 1,
  "ALTER TABLE compose_session_sources MODIFY COLUMN conversion_status ENUM('awaiting_upload','pending','converting','converted','unsupported','failed') NOT NULL DEFAULT 'pending'",
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @needs := NULL; SET @ddl := NULL;
