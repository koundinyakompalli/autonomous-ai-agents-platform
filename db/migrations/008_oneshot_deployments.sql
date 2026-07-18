-- Migration 008: preview deployment control plane for OneShot dashboard.

CREATE TABLE IF NOT EXISTS oneshot_deployments (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id      BIGINT       NOT NULL,
  slot_name           VARCHAR(100) NOT NULL DEFAULT 'core-app-preview',
  repo_id             INT          NOT NULL,
  branch_name         VARCHAR(255) NOT NULL,
  commit_sha          VARCHAR(40)  NOT NULL,
  pr_url              VARCHAR(1024) NULL,
  requested_by        VARCHAR(255) NULL,
  requested_by_display VARCHAR(255) NULL,
  status              VARCHAR(50)  NOT NULL,
  workflow_run_id     BIGINT       NULL,
  workflow_url        VARCHAR(1024) NULL,
  image_uri           VARCHAR(1024) NULL,
  task_definition_arn VARCHAR(1024) NULL,
  ecs_cluster_name    VARCHAR(255) NOT NULL,
  ecs_service_name    VARCHAR(255) NOT NULL,
  preview_url         VARCHAR(1024) NULL,
  error               TEXT         NULL,
  superseded_by       BIGINT       NULL,
  active_slot         VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN status = 'active' THEN slot_name
        ELSE NULL
      END
    ) STORED,
  inflight_slot       VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('requested', 'awaiting_approval', 'building', 'pushing', 'deploying')
          THEN slot_name
        ELSE NULL
      END
    ) STORED,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at        TIMESTAMP    NULL,

  UNIQUE KEY uk_oneshot_active_slot (active_slot),
  UNIQUE KEY uk_oneshot_inflight_slot (inflight_slot),
  CONSTRAINT fk_oneshot_deployments_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),
  CONSTRAINT fk_oneshot_deployments_repo
    FOREIGN KEY (repo_id) REFERENCES code_repositories(id),
  CONSTRAINT fk_oneshot_deployments_superseded_by
    FOREIGN KEY (superseded_by) REFERENCES oneshot_deployments(id),

  INDEX idx_oneshot_deployments_run (oneshot_run_id),
  INDEX idx_oneshot_deployments_status (status),
  INDEX idx_oneshot_deployments_slot (slot_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
