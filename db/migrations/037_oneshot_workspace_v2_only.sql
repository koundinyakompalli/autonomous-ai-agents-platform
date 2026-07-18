-- Migration 037: make OneShot workspace mode v2-only.
--
-- Workspace v2 is now the only supported OneShot runtime workspace mode. Existing
-- nullable or v1 rows are normalized before tightening the enum.

UPDATE oneshot_runs
SET workspace_mode = 'v2'
WHERE workspace_mode IS NULL OR workspace_mode <> 'v2';

ALTER TABLE oneshot_runs
  MODIFY COLUMN workspace_mode ENUM('v2') NOT NULL DEFAULT 'v2';

UPDATE oneshot_workspace_state
SET workspace_mode = 'v2'
WHERE workspace_mode <> 'v2';

ALTER TABLE oneshot_workspace_state
  MODIFY COLUMN workspace_mode ENUM('v2') NOT NULL DEFAULT 'v2';
