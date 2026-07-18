-- Migration 010: extend OneShot pipeline with code review and testing stages.
-- Adds version-tracking columns for the two new post-implementation stages
-- and a unified verification loop counter that covers both code review
-- NEEDS_CHANGES and test failure routing back to the implementer.

-- 1. New version columns for code review and test artifacts
ALTER TABLE oneshot_runs
  ADD COLUMN current_code_review_version INT NULL
    AFTER current_implementation_commit_sha,
  ADD COLUMN current_test_version INT NULL
    AFTER current_code_review_version;

-- 2. Unified verification loop counter (code review + test failures)
ALTER TABLE oneshot_runs
  ADD COLUMN verification_loop_count INT NOT NULL DEFAULT 0
    AFTER current_test_version,
  ADD COLUMN max_verification_loops INT NOT NULL DEFAULT 3
    AFTER verification_loop_count;

-- 3. Extend artifact stage ENUM to include code_review and test_result
ALTER TABLE oneshot_artifacts
  MODIFY COLUMN stage ENUM(
    'qualification',
    'plan',
    'review',
    'implementation',
    'code_review',
    'test_result'
  ) NOT NULL;

-- 4. Seed agent rows for the two new queue consumers
INSERT INTO agents (name, description, task_type, model, jql, is_active) VALUES
(
  'CODE_REVIEWER',
  'OneShot code reviewer queue consumer',
  'oneshot_code_review',
  'gpt-5.4',
  '',
  FALSE
),
(
  'TESTER',
  'OneShot tester queue consumer (deterministic, no LLM)',
  'oneshot_testing',
  'none',
  '',
  FALSE
)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  updated_at = CURRENT_TIMESTAMP;
