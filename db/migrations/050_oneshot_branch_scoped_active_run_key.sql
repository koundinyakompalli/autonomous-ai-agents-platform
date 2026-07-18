-- Migration 050: scope active OneShot duplicate-run protection by branch.
--
-- Multi-branch retrofit creates multiple active child runs for the same Jira
-- ticket and repository, one per target branch. Keep duplicate protection for
-- the same Jira/repo/branch while allowing distinct retrofit target branches.

ALTER TABLE oneshot_runs
  DROP INDEX uk_active_jira_repo,
  DROP COLUMN active_jira_repo_key,
  ADD COLUMN active_jira_repo_key           VARCHAR(360)
    GENERATED ALWAYS AS (
      CASE
        WHEN state IN ('completed', 'blocked', 'failed') THEN NULL
        ELSE CONCAT(jira_key, '#', repo_id, '#', branch_name)
      END
    ) STORED,
  ADD UNIQUE KEY uk_active_jira_repo (active_jira_repo_key);
