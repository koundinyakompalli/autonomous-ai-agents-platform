-- Migration 018: workspace v2 metadata, leases, and candidate version history.
--
-- This migration is additive and nullable so workspace v2 can be enabled only
-- for newly-created runs while in-flight v1 runs continue to use the existing
-- workspace manager.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'workspace_mode'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN workspace_mode ENUM(''v1'', ''v2'') NULL AFTER run_group_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS oneshot_workspace_leases (
  scope           VARCHAR(191) PRIMARY KEY,
  fencing_token   BIGINT       NOT NULL DEFAULT 0,
  owner_task_arn  VARCHAR(512) NULL,
  owner_stage     VARCHAR(64)  NULL,
  heartbeat_at    TIMESTAMP(6) NULL,
  expires_at      TIMESTAMP(6) NULL,
  metadata_json   JSON         NULL,
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  INDEX idx_oneshot_workspace_leases_expiry (expires_at),
  INDEX idx_oneshot_workspace_leases_owner (owner_task_arn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_workspace_state (
  oneshot_run_id              BIGINT PRIMARY KEY,
  workspace_mode              ENUM('v1', 'v2') NOT NULL DEFAULT 'v2',
  workspace_path              VARCHAR(1024) NULL,
  state_path                  VARCHAR(1024) NULL,
  workspace_phase             VARCHAR(64)   NULL,
  workspace_head_sha          VARCHAR(40)   NULL,
  base_commit_sha             VARCHAR(40)   NULL,
  current_candidate_version   INT           NULL,
  current_candidate_sha       VARCHAR(40)   NULL,
  last_repo_fetch_at          TIMESTAMP(6)  NULL,
  last_remote_head_sha        VARCHAR(40)   NULL,
  metadata_json               JSON          NULL,
  created_at                  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at                  TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  CONSTRAINT fk_oneshot_workspace_state_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE CASCADE,

  INDEX idx_oneshot_workspace_state_phase (workspace_phase),
  INDEX idx_oneshot_workspace_state_candidate (current_candidate_sha)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_candidate_versions (
  id                                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id                      BIGINT      NOT NULL,
  candidate_version                   INT         NOT NULL,
  candidate_commit_sha                VARCHAR(40) NOT NULL,
  previous_candidate_commit_sha       VARCHAR(40) NULL,
  status                              VARCHAR(50) NOT NULL DEFAULT 'current',
  superseded_by_candidate_version     INT         NULL,
  target_files_json                   JSON        NULL,
  metadata_json                       JSON        NULL,
  created_at                          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finalized_at                        TIMESTAMP(6) NULL,

  CONSTRAINT fk_oneshot_candidate_versions_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE CASCADE,

  UNIQUE KEY uk_oneshot_candidate_versions_run_version (oneshot_run_id, candidate_version),
  INDEX idx_oneshot_candidate_versions_run_sha (oneshot_run_id, candidate_commit_sha),
  INDEX idx_oneshot_candidate_versions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @col_exists := NULL;
SET @ddl := NULL;
