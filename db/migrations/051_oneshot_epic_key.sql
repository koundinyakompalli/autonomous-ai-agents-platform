-- Migration 051: persist OneShot epic context for shared epic branches.

SET @oneshot_epic_key_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'epic_key'
);
SET @ddl := IF(
  @oneshot_epic_key_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN epic_key VARCHAR(50) NULL AFTER jira_key, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @oneshot_epic_key_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND index_name = 'idx_oneshot_epic_key'
);
SET @ddl := IF(
  @oneshot_epic_key_index_exists = 0,
  'ALTER TABLE oneshot_runs ADD INDEX idx_oneshot_epic_key (epic_key), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
