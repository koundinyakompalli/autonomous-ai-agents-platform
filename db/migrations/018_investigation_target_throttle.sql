-- Migration 018: Investigation Cockpit target throttle slots.
-- Stores bounded target leases for Cockpit/MERIDIAN worker concurrency.
-- This table contains operational metadata only; no Jira body, PHI, SQL, or
-- client database payloads are stored here.

CREATE TABLE IF NOT EXISTS investigation_target_slots (
  target_key        VARCHAR(240) NOT NULL,
  slot_no           INT          NOT NULL,
  run_id            VARCHAR(80)  NULL,
  lease_expires_at  DATETIME(3)  NULL,
  heartbeat_at      DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (target_key, slot_no),
  INDEX idx_investigation_target_slots_run (run_id),
  INDEX idx_investigation_target_slots_lease (lease_expires_at),
  INDEX idx_investigation_target_slots_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
