-- Migration 017: add composite indexes for OneShot per-run event/artifact reads.
--
-- Code review budget preflight and dashboard timelines read one run at a time
-- in chronological order. These indexes avoid large filesorts on JSON-heavy
-- metadata rows when active runs have many events.
--
-- Keep this idempotent: prod may receive the online index hotfix before this
-- migration is replayed during normal environment sync.

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_run_events'
    AND index_name = 'idx_oneshot_run_events_run_occurred_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE oneshot_run_events ADD INDEX idx_oneshot_run_events_run_occurred_id (oneshot_run_id, occurred_at, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_run_events'
    AND index_name = 'idx_oneshot_run_events_budget_stage'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE oneshot_run_events ADD INDEX idx_oneshot_run_events_budget_stage (oneshot_run_id, event_type, stage, occurred_at, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_artifacts'
    AND index_name = 'idx_oneshot_artifacts_run_created_version_id'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE oneshot_artifacts ADD INDEX idx_oneshot_artifacts_run_created_version_id (oneshot_run_id, created_at, version, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := NULL;
SET @ddl := NULL;
