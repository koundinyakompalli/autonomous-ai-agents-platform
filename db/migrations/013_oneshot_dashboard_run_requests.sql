-- Migration 013: durable dashboard-submitted OneShot run requests.
-- Stores asynchronous Jira-key submissions from the dashboard so the
-- orchestrator can process them through the QUALIFIER assignment flow.

CREATE TABLE IF NOT EXISTS oneshot_dashboard_run_requests (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  jira_key              VARCHAR(50)  NOT NULL,
  requested_by          VARCHAR(255) NOT NULL,
  requested_by_display  VARCHAR(255) NOT NULL,
  status                ENUM('queued', 'processing', 'task_created', 'failed')
                          NOT NULL DEFAULT 'queued',
  error_message         TEXT         NULL,
  task_management_id    INT          NULL,
  active_jira_key       VARCHAR(50)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('queued', 'processing') THEN jira_key
        ELSE NULL
      END
    ) STORED,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
  started_at            TIMESTAMP    NULL,
  finished_at           TIMESTAMP    NULL,

  UNIQUE KEY uk_oneshot_dashboard_run_requests_active_jira (active_jira_key),
  INDEX idx_oneshot_dashboard_run_requests_status_created (status, created_at),
  INDEX idx_oneshot_dashboard_run_requests_jira_key (jira_key),
  INDEX idx_oneshot_dashboard_run_requests_task_management (task_management_id),

  CONSTRAINT fk_oneshot_dashboard_run_requests_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
