-- Migration 019: support dashboard run-list ordering without wide filesort.

SET @index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND index_name = 'idx_oneshot_runs_updated_id'
);

SET @ddl := IF(
  @index_exists = 0,
  'ALTER TABLE oneshot_runs ADD INDEX idx_oneshot_runs_updated_id (updated_at, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists := NULL;
SET @ddl := NULL;
