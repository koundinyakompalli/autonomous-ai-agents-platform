-- Migration 034: Track Spec Factory intake refreshes without touching existing ticket rows.

CREATE TABLE IF NOT EXISTS spec_factory_intake_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  intake_source   VARCHAR(50) NOT NULL,
  status          ENUM('succeeded','failed') NOT NULL,
  scanned         INT NOT NULL DEFAULT 0,
  inserted_count  INT NOT NULL DEFAULT 0,
  matched         INT NOT NULL DEFAULT 0,
  claimed         INT NOT NULL DEFAULT 0,
  claim_failures  INT NOT NULL DEFAULT 0,
  auto_queued     INT NOT NULL DEFAULT 0,
  error_message   TEXT NULL,
  started_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_intake_source_status_finished (intake_source, status, finished_at, id),
  INDEX idx_spec_factory_intake_finished (finished_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
