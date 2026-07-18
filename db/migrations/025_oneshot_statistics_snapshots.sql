-- Migration 025: persist AI-assisted OneShot Statistics snapshots.

CREATE TABLE IF NOT EXISTS oneshot_statistics_snapshots (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  range_key             ENUM('24h', '7d', '30d', 'all') NOT NULL,
  data_fingerprint      CHAR(40)                         NOT NULL,
  status                ENUM('ready', 'invalid', 'failed') NOT NULL,
  snapshot_json         JSON                             NULL,
  provider              VARCHAR(50)                      NULL,
  model                 VARCHAR(160)                     NULL,
  generated_at          TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at            TIMESTAMP(3)                     NULL,
  error_message         TEXT                             NULL,
  invalid_output_sample TEXT                             NULL,
  created_at            TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_oneshot_statistics_range_generated (range_key, generated_at, id),
  INDEX idx_oneshot_statistics_range_status_generated (range_key, status, generated_at, id),
  INDEX idx_oneshot_statistics_fingerprint (data_fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_statistics_refresh_state (
  range_key                ENUM('24h', '7d', '30d', 'all') PRIMARY KEY,
  latest_snapshot_id       BIGINT       NULL,
  refresh_started_at       TIMESTAMP(3) NULL,
  refresh_lease_expires_at TIMESTAMP(3) NULL,
  next_retry_at            TIMESTAMP(3) NULL,
  attempt_count            INT          NOT NULL DEFAULT 0,
  last_attempt_at          TIMESTAMP(3) NULL,
  last_error               TEXT         NULL,
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_oneshot_statistics_latest_snapshot
    FOREIGN KEY (latest_snapshot_id) REFERENCES oneshot_statistics_snapshots(id),

  INDEX idx_oneshot_statistics_refresh_lease (refresh_lease_expires_at),
  INDEX idx_oneshot_statistics_next_retry (next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
