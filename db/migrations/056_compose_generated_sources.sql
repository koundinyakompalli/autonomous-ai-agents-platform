-- Migration 056: Generated research source support.

ALTER TABLE compose_session_sources
  MODIFY COLUMN kind ENUM('file','youtube','chat','note','jira','confluence','generated_research') NOT NULL;

SET @compose_source_origin_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'source_origin'
);
SET @ddl := IF(
  @compose_source_origin_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN source_origin VARCHAR(32) NOT NULL DEFAULT ''user'' AFTER source_contribution, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_generated_by_task_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'generated_by_task_id'
);
SET @ddl := IF(
  @compose_generated_by_task_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN generated_by_task_id BIGINT NULL AFTER source_origin, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_parent_source_ids_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'parent_source_ids_json'
);
SET @ddl := IF(
  @compose_parent_source_ids_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN parent_source_ids_json JSON NULL AFTER generated_by_task_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_context_version_used_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'context_version_used'
);
SET @ddl := IF(
  @compose_context_version_used_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN context_version_used BIGINT NULL AFTER parent_source_ids_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_evidence_json_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'evidence_json'
);
SET @ddl := IF(
  @compose_evidence_json_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN evidence_json JSON NULL AFTER context_version_used, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_confidence_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'confidence'
);
SET @ddl := IF(
  @compose_confidence_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN confidence VARCHAR(32) NULL AFTER evidence_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_artifact_uri_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'artifact_uri'
);
SET @ddl := IF(
  @compose_artifact_uri_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN artifact_uri TEXT NULL AFTER confidence, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_artifact_sha_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'artifact_sha256'
);
SET @ddl := IF(
  @compose_artifact_sha_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN artifact_sha256 CHAR(64) NULL AFTER artifact_uri, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_artifact_bytes_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'artifact_bytes'
);
SET @ddl := IF(
  @compose_artifact_bytes_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN artifact_bytes BIGINT NULL AFTER artifact_sha256, ALGORITHM=INPLACE, LOCK=NONE',
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
  @compose_generated_task_index_exists = 0,
  'ALTER TABLE compose_session_sources ADD INDEX idx_compose_session_sources_generated_task (generated_by_task_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_generated_task_fk_exists := (
  SELECT COUNT(*)
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND constraint_name = 'fk_compose_session_sources_generated_task'
);
SET @ddl := IF(
  @compose_generated_task_fk_exists = 0,
  'ALTER TABLE compose_session_sources ADD CONSTRAINT fk_compose_session_sources_generated_task FOREIGN KEY (generated_by_task_id) REFERENCES compose_agent_tasks(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
