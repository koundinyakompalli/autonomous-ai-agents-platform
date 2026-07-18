-- Migration 043: live Jira and Confluence source kinds for Compose.

SET @kind_type := (
  SELECT column_type
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'kind'
);
SET @ddl := IF(
  @kind_type NOT LIKE '%jira%' OR @kind_type NOT LIKE '%confluence%',
  "ALTER TABLE compose_session_sources MODIFY COLUMN kind ENUM('file','youtube','chat','note','jira','confluence') NOT NULL",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @kind_type := NULL;
SET @ddl := NULL;
