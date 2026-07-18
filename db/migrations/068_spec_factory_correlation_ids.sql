-- Migration 068: persist API request correlation across Spec Factory handoffs.

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'spec_factory_events'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE spec_factory_events ADD COLUMN request_id VARCHAR(128) NULL AFTER actor, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'spec_factory_events'
    AND index_name = 'idx_spec_factory_events_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE spec_factory_events ADD INDEX idx_spec_factory_events_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'spec_factory_processing_jobs'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE spec_factory_processing_jobs ADD COLUMN request_id VARCHAR(128) NULL AFTER requested_by, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'spec_factory_processing_jobs'
    AND index_name = 'idx_spec_factory_jobs_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE spec_factory_processing_jobs ADD INDEX idx_spec_factory_jobs_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'compose_session_sources'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN request_id VARCHAR(128) NULL AFTER session_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'compose_session_sources'
    AND index_name = 'idx_compose_session_sources_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_session_sources ADD INDEX idx_compose_session_sources_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'compose_turn_jobs'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_turn_jobs ADD COLUMN request_id VARCHAR(128) NULL AFTER request_hash, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'compose_turn_jobs'
    AND index_name = 'idx_compose_turn_jobs_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_turn_jobs ADD INDEX idx_compose_turn_jobs_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'compose_agent_tasks'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_agent_tasks ADD COLUMN request_id VARCHAR(128) NULL AFTER executor_type, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'compose_agent_tasks'
    AND index_name = 'idx_compose_agent_tasks_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_agent_tasks ADD INDEX idx_compose_agent_tasks_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'spec_factory_llm_calls'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE spec_factory_llm_calls ADD COLUMN request_id VARCHAR(128) NULL AFTER agent_task_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'spec_factory_llm_calls'
    AND index_name = 'idx_spec_factory_llm_calls_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE spec_factory_llm_calls ADD INDEX idx_spec_factory_llm_calls_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'compose_session_events'
    AND column_name = 'request_id'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_session_events ADD COLUMN request_id VARCHAR(128) NULL AFTER actor_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'compose_session_events'
    AND index_name = 'idx_compose_session_events_request'
);
SET @ddl := IF(@exists = 0,
  'ALTER TABLE compose_session_events ADD INDEX idx_compose_session_events_request (request_id, id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @exists := NULL;
SET @ddl := NULL;
