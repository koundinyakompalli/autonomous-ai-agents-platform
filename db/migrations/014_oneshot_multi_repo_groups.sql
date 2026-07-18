-- Migration 014: allow coordinated multi-repo OneShot qualification.
--
-- OneShot child runs remain single-repository. A source Jira ticket that
-- genuinely requires multiple CP repositories can now have one active child run
-- per repo under a shared group.

CREATE TABLE IF NOT EXISTS oneshot_run_groups (
  id                        BIGINT AUTO_INCREMENT PRIMARY KEY,
  jira_key                  VARCHAR(50) NOT NULL,
  source_task_management_id INT         NOT NULL,
  status                    VARCHAR(50) NOT NULL DEFAULT 'active',
  metadata_json             JSON        NULL,
  created_at                TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_oneshot_run_groups_task_management
    FOREIGN KEY (source_task_management_id) REFERENCES task_management(id),

  INDEX idx_oneshot_run_groups_jira_key (jira_key),
  INDEX idx_oneshot_run_groups_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE oneshot_runs
  ADD COLUMN run_group_id BIGINT NULL AFTER id,
  ADD INDEX idx_oneshot_run_group (run_group_id),
  ADD CONSTRAINT fk_oneshot_runs_group
    FOREIGN KEY (run_group_id) REFERENCES oneshot_run_groups(id);

ALTER TABLE oneshot_runs
  DROP INDEX uk_active_jira,
  DROP COLUMN active_jira_key,
  ADD COLUMN active_jira_repo_key VARCHAR(120)
    GENERATED ALWAYS AS (
      CASE
        WHEN state IN ('completed', 'blocked', 'failed') THEN NULL
        ELSE CONCAT(jira_key, '#', repo_id)
      END
    ) STORED,
  ADD UNIQUE KEY uk_active_jira_repo (active_jira_repo_key);
