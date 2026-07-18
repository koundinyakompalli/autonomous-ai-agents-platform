-- Migration 005: OneShot durable workflow schema
-- Adds the phase-1 database foundation for the PFOS / OneShot pipeline.

CREATE TABLE IF NOT EXISTS oneshot_runs (
  id                             BIGINT AUTO_INCREMENT PRIMARY KEY,
  jira_key                       VARCHAR(50)  NOT NULL,
  source_task_management_id      INT          NOT NULL,
  customer_id                    INT          NOT NULL,
  repo_id                        INT          NOT NULL,
  branch_name                    VARCHAR(255) NOT NULL,
  base_commit_sha                VARCHAR(40)  NOT NULL,
  state                          VARCHAR(50)  NOT NULL DEFAULT 'queued_for_planning',
  active_jira_key                VARCHAR(50)
    GENERATED ALWAYS AS (
      CASE
        WHEN state IN ('completed', 'blocked', 'failed') THEN NULL
        ELSE jira_key
      END
    ) STORED,
  max_review_loops               INT          NOT NULL DEFAULT 3,
  review_loop_count              INT          NOT NULL DEFAULT 0,
  current_plan_version           INT          NULL,
  current_review_version         INT          NULL,
  current_implementation_version INT          NULL,
  current_pr_url                 VARCHAR(1024) NULL,
  final_disposition              VARCHAR(50)  NULL,
  last_error                     TEXT         NULL,
  max_total_tokens               INT          NOT NULL DEFAULT 2000000,
  total_tokens_used              INT          NOT NULL DEFAULT 0,
  created_at                     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_active_jira (active_jira_key),
  CONSTRAINT fk_oneshot_runs_task_management
    FOREIGN KEY (source_task_management_id) REFERENCES task_management(id),
  CONSTRAINT fk_oneshot_runs_customer
    FOREIGN KEY (customer_id) REFERENCES customer_branches(id),
  CONSTRAINT fk_oneshot_runs_repo
    FOREIGN KEY (repo_id) REFERENCES code_repositories(id),

  INDEX idx_state (state),
  INDEX idx_jira_key (jira_key),
  INDEX idx_state_updated (state, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_artifacts (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id BIGINT       NOT NULL,
  stage          ENUM('qualification', 'plan', 'review', 'implementation') NOT NULL,
  version        INT          NOT NULL,
  status         VARCHAR(50)  NOT NULL,
  s3_bucket      VARCHAR(255) NOT NULL,
  s3_key         VARCHAR(1024) NOT NULL,
  provider       VARCHAR(50)  NULL,
  model          VARCHAR(100) NULL,
  metadata_json  JSON         NULL,
  started_at     TIMESTAMP    NULL,
  completed_at   TIMESTAMP    NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uk_run_stage_version (oneshot_run_id, stage, version),
  CONSTRAINT fk_oneshot_artifacts_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),

  INDEX idx_run_id (oneshot_run_id),
  INDEX idx_stage (stage)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_notifications (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id   BIGINT       NOT NULL,
  jira_key         VARCHAR(50)  NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  body_markdown    TEXT         NOT NULL,
  status           ENUM('pending', 'posting', 'posted', 'failed') NOT NULL DEFAULT 'pending',
  error            TEXT         NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at        TIMESTAMP    NULL,

  CONSTRAINT fk_oneshot_notifications_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),

  INDEX idx_status (status),
  INDEX idx_run_id (oneshot_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW v_oneshot_stuck_runs AS
SELECT id, jira_key, state, updated_at
FROM oneshot_runs
WHERE state LIKE 'queued_for_%'
  AND updated_at < NOW() - INTERVAL 10 MINUTE;
