-- Migration 053: allow multiple Spec Factory child stories for the same repo.
--
-- Spec Factory originally emitted one child story per repository, so the child
-- table enforced uniqueness on (draft_id, repo_name). Compose now emits modular
-- child stories, and several stories can intentionally target the same repo.

SET @child_repo_unique_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_child_tickets'
    AND index_name = 'uk_spec_factory_child_repo'
);

SET @ddl := IF(
  @child_repo_unique_exists > 0,
  'ALTER TABLE spec_factory_child_tickets DROP INDEX uk_spec_factory_child_repo, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @child_repo_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_child_tickets'
    AND index_name = 'idx_spec_factory_child_draft_repo'
);

SET @ddl := IF(
  @child_repo_index_exists = 0,
  'ALTER TABLE spec_factory_child_tickets ADD INDEX idx_spec_factory_child_draft_repo (draft_id, repo_name), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
