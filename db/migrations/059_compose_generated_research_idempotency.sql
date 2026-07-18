-- Migration 059: Enforce one generated research source per agent task.

-- If a rollout previously double-ran a research task, keep the task's
-- recorded output_source_id when available; otherwise keep the earliest source
-- row. Duplicate rows remain as historical sources, but no longer claim the
-- canonical generated_by_task_id before the unique key is added.
UPDATE compose_session_sources s
JOIN (
  SELECT
    s2.generated_by_task_id,
    COALESCE(
      MIN(CASE WHEN t.output_source_id = s2.id THEN s2.id END),
      MIN(s2.id)
    ) AS keep_source_id
  FROM compose_session_sources s2
  LEFT JOIN compose_agent_tasks t
    ON t.id = s2.generated_by_task_id
  WHERE s2.generated_by_task_id IS NOT NULL
  GROUP BY s2.generated_by_task_id
  HAVING COUNT(*) > 1
) duplicate_tasks
  ON duplicate_tasks.generated_by_task_id = s.generated_by_task_id
SET s.generated_by_task_id = NULL
WHERE s.id <> duplicate_tasks.keep_source_id;

SET @compose_generated_task_unique_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND index_name = 'uk_compose_session_sources_generated_task'
);
SET @ddl := IF(
  @compose_generated_task_unique_exists = 0,
  'ALTER TABLE compose_session_sources ADD UNIQUE KEY uk_compose_session_sources_generated_task (generated_by_task_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_generated_task_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND index_name = 'idx_compose_session_sources_generated_task'
);
SET @ddl := IF(
  @compose_generated_task_index_exists > 0,
  'ALTER TABLE compose_session_sources DROP INDEX idx_compose_session_sources_generated_task, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
