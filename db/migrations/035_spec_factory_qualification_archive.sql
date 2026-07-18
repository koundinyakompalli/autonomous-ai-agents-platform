-- Migration 035: Spec Factory qualification reasons and archive workflow.

ALTER TABLE spec_factory_sources
  MODIFY COLUMN state ENUM(
    'candidate',
    'drafting',
    'draft_ready',
    'approved',
    'oneshot_submitted',
    'needs_attention',
    'not_qualified',
    'archived'
  ) NOT NULL DEFAULT 'candidate';

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_sources'
    AND column_name = 'qualification_reasons_json'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE spec_factory_sources ADD COLUMN qualification_reasons_json JSON NULL AFTER approved_epic_key',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE spec_factory_sources
SET state = 'not_qualified',
    qualification_reasons_json = CASE
      WHEN error_message LIKE '%repo reference%' THEN JSON_ARRAY('needs_repo')
      WHEN error_message IS NOT NULL THEN JSON_ARRAY('generation_failed')
      ELSE JSON_ARRAY('needs_information')
    END
WHERE state = 'needs_attention';

SET @col_exists := NULL;
SET @ddl := NULL;
