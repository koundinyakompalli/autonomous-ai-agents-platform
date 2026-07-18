-- Migration 038: Compose source markdown_content + conversion claim index (Phase 2).

-- 1. markdown_content holds the converted Markdown for a source (notes, files, URLs).
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'markdown_content'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN markdown_content MEDIUMTEXT NULL AFTER markdown_path, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Index to claim pending sources efficiently (worker queue).
SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND index_name = 'idx_compose_sources_status_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE compose_session_sources ADD INDEX idx_compose_sources_status_id (conversion_status, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := NULL;
SET @idx_exists := NULL;
SET @ddl := NULL;
