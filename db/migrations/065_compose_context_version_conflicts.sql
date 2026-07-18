-- Migration 065: Preserve context-version conflicts in the API projection.

SET @compose_context_versions_conflicts_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_context_versions'
    AND column_name = 'conflicts_json'
);
SET @ddl := IF(
  @compose_context_versions_conflicts_exists = 0,
  'ALTER TABLE compose_context_versions ADD COLUMN conflicts_json JSON NULL AFTER open_questions_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
