-- Persist Statistics-derived OneShot self-fix defect mappings.

CREATE TABLE IF NOT EXISTS oneshot_self_fix_tickets (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  candidate_key         VARCHAR(160) NOT NULL,
  range_key             ENUM('24h', '7d', '30d', 'all') NOT NULL,
  snapshot_fingerprint  CHAR(40)     NOT NULL,
  jira_key              VARCHAR(50)  NOT NULL,
  jira_url              VARCHAR(512) NULL,
  run_request_id        BIGINT       NULL,
  status                ENUM('ticket_created', 'duplicate', 'run_requested', 'failed')
                          NOT NULL DEFAULT 'ticket_created',
  candidate_metadata    JSON         NOT NULL,
  last_error            TEXT         NULL,
  active_candidate_key  VARCHAR(160)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('ticket_created', 'duplicate', 'run_requested') THEN candidate_key
        ELSE NULL
      END
    ) STORED,
  created_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                          ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_oneshot_self_fix_active_candidate (active_candidate_key),
  INDEX idx_oneshot_self_fix_candidate (candidate_key),
  INDEX idx_oneshot_self_fix_jira_key (jira_key),
  INDEX idx_oneshot_self_fix_run_request (run_request_id),

  CONSTRAINT fk_oneshot_self_fix_run_request
    FOREIGN KEY (run_request_id) REFERENCES oneshot_dashboard_run_requests(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
