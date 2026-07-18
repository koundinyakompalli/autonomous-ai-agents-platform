-- Migration 044: persist OneShot ticket type metadata for analytics.

SET @jira_issue_type_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'jira_issue_type'
);
SET @ddl := IF(
  @jira_issue_type_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN jira_issue_type VARCHAR(100) NULL AFTER jira_key, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ticket_type_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'ticket_type'
);
SET @ddl := IF(
  @ticket_type_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN ticket_type VARCHAR(50) NOT NULL DEFAULT ''unknown'' AFTER jira_issue_type, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ticket_type_source_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'ticket_type_source'
);
SET @ddl := IF(
  @ticket_type_source_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN ticket_type_source VARCHAR(50) NOT NULL DEFAULT ''unknown'' AFTER ticket_type, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ticket_type_updated_by_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'ticket_type_updated_by'
);
SET @ddl := IF(
  @ticket_type_updated_by_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN ticket_type_updated_by VARCHAR(255) NULL AFTER ticket_type_source, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ticket_type_updated_at_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'ticket_type_updated_at'
);
SET @ddl := IF(
  @ticket_type_updated_at_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN ticket_type_updated_at TIMESTAMP(6) NULL AFTER ticket_type_updated_by, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE oneshot_runs r
JOIN task_management tm
  ON tm.id = r.source_task_management_id
JOIN tasks t
  ON t.id = tm.task_id
SET r.jira_issue_type = TRIM(
      REGEXP_REPLACE(
        REGEXP_SUBSTR(t.task_description, '- \\*\\*Type\\*\\*: [^\\r\\n]+'),
        '^- \\*\\*Type\\*\\*: ',
        ''
      )
    )
WHERE r.jira_issue_type IS NULL
  AND t.task_description REGEXP '- \\*\\*Type\\*\\*: [^\\r\\n]+';

UPDATE oneshot_runs r
LEFT JOIN oneshot_artifacts qa
  ON qa.oneshot_run_id = r.id
 AND qa.stage = 'qualification'
 AND qa.version = 1
LEFT JOIN task_management tm
  ON tm.id = r.source_task_management_id
LEFT JOIN tasks t
  ON t.id = tm.task_id
SET r.ticket_type = CASE
      WHEN JSON_UNQUOTE(JSON_EXTRACT(qa.metadata_json, '$.processing_mode')) = 'sonar_autofix'
        THEN 'sonar'
      WHEN JSON_UNQUOTE(JSON_EXTRACT(qa.metadata_json, '$.processing_mode')) = 'security_wiz'
        THEN 'security'
      WHEN LOWER(COALESCE(REGEXP_SUBSTR(t.task_description, '^# Task: [^\\r\\n]+'), '')) REGEXP 'sonarqube|sonar'
        THEN 'sonar'
      WHEN LOWER(COALESCE(REGEXP_SUBSTR(t.task_description, '^# Task: [^\\r\\n]+'), '')) REGEXP 'wiz|security'
        THEN 'security'
      WHEN LOWER(COALESCE(REGEXP_SUBSTR(t.task_description, '^# Task: [^\\r\\n]+'), '')) REGEXP '(^|[^[:alnum:]_])(retro(fit)?|forward[- ]?port|back[- ]?port)([^[:alnum:]_]|$)'
        THEN 'retrofit'
      ELSE r.ticket_type
    END,
    r.ticket_type_source = CASE
      WHEN JSON_UNQUOTE(JSON_EXTRACT(qa.metadata_json, '$.processing_mode')) IN ('sonar_autofix', 'security_wiz')
        THEN 'backfill_processing_mode'
      WHEN LOWER(COALESCE(REGEXP_SUBSTR(t.task_description, '^# Task: [^\\r\\n]+'), '')) REGEXP 'sonarqube|sonar|wiz|security'
        THEN 'backfill_title'
      WHEN LOWER(COALESCE(REGEXP_SUBSTR(t.task_description, '^# Task: [^\\r\\n]+'), '')) REGEXP '(^|[^[:alnum:]_])(retro(fit)?|forward[- ]?port|back[- ]?port)([^[:alnum:]_]|$)'
        THEN 'backfill_retrofit_title'
      ELSE r.ticket_type_source
    END
WHERE r.ticket_type = 'unknown';

UPDATE oneshot_runs
SET ticket_type = CASE
      WHEN LOWER(jira_issue_type) IN ('defect', 'bug') THEN 'defect'
      WHEN LOWER(jira_issue_type) = 'story' THEN 'story'
      ELSE 'other'
    END,
    ticket_type_source = 'backfill_jira_issue_type'
WHERE ticket_type = 'unknown'
  AND jira_issue_type IS NOT NULL
  AND TRIM(jira_issue_type) <> '';

SET @ticket_type_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND index_name = 'idx_oneshot_ticket_type'
);
SET @ddl := IF(
  @ticket_type_index_exists = 0,
  'ALTER TABLE oneshot_runs ADD INDEX idx_oneshot_ticket_type (ticket_type), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
