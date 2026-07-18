-- Migration 036: add OneShot TRACE and VERIFY artifact stages.
-- TRACE and VERIFY run inside the planning consumer before plan review.

ALTER TABLE oneshot_artifacts
  MODIFY COLUMN stage ENUM(
    'qualification',
    'plan',
    'trace',
    'verify',
    'review',
    'implementation',
    'code_review',
    'test_result'
  ) NOT NULL;
