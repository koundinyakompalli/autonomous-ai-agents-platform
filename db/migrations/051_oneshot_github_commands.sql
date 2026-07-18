-- Migration 051: durable OneShot GitHub slash-command intake.
--
-- Records GitHub issue_comment webhook deliveries for /oneshot commands so
-- retries are idempotent and accepted/coalesced PR feedback can be loaded by
-- the planner revision that consumes it.

CREATE TABLE IF NOT EXISTS oneshot_github_commands (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id           BIGINT        NULL,
  delivery_id              VARCHAR(128)  NOT NULL,
  repository_full_name     VARCHAR(255)  NOT NULL,
  pull_number              INT           NOT NULL,
  comment_id               VARCHAR(64)   NOT NULL,
  comment_url              VARCHAR(1024) NULL,
  requester_login          VARCHAR(255)  NOT NULL,
  author_association       VARCHAR(64)   NULL,
  command_text             TEXT          NOT NULL,
  requested_plan_version   INT           NULL,
  status                   VARCHAR(50)   NOT NULL,
  response_comment_url     VARCHAR(1024) NULL,
  rejection_reason         VARCHAR(255)  NULL,
  created_at               TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at               TIMESTAMP(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  CONSTRAINT fk_oneshot_github_commands_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id)
    ON DELETE SET NULL,

  UNIQUE KEY uk_oneshot_github_commands_delivery (delivery_id),
  INDEX idx_oneshot_github_commands_run_plan (oneshot_run_id, requested_plan_version, status),
  INDEX idx_oneshot_github_commands_pr (repository_full_name, pull_number, created_at),
  INDEX idx_oneshot_github_commands_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
