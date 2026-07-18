-- Migration 066: Constrain durable event turn/task correlations without blocking reset.

UPDATE compose_session_events e
LEFT JOIN compose_turn_jobs j ON j.id = e.turn_job_id
SET e.turn_job_id = NULL
WHERE e.turn_job_id IS NOT NULL
  AND j.id IS NULL;

UPDATE compose_session_events e
LEFT JOIN compose_agent_tasks t ON t.id = e.agent_task_id
SET e.agent_task_id = NULL
WHERE e.agent_task_id IS NOT NULL
  AND t.id IS NULL;

SET @compose_session_events_turn_job_fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'compose_session_events'
    AND constraint_name = 'fk_compose_session_events_turn_job'
);
SET @ddl := IF(
  @compose_session_events_turn_job_fk_exists = 0,
  'ALTER TABLE compose_session_events ADD CONSTRAINT fk_compose_session_events_turn_job FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id) ON DELETE SET NULL',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_session_events_agent_task_fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'compose_session_events'
    AND constraint_name = 'fk_compose_session_events_agent_task'
);
SET @ddl := IF(
  @compose_session_events_agent_task_fk_exists = 0,
  'ALTER TABLE compose_session_events ADD CONSTRAINT fk_compose_session_events_agent_task FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id) ON DELETE SET NULL',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
