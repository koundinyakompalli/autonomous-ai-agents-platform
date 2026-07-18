-- Migration 063: Spec Factory worker heartbeat inventory.
--
-- This table is process inventory, not Compose session data. It intentionally
-- has no session FK and is not part of session hard-delete cascades.

CREATE TABLE IF NOT EXISTS spec_factory_worker_heartbeats (
  worker_id VARCHAR(128) PRIMARY KEY,
  mode VARCHAR(32) NOT NULL,
  hostname VARCHAR(255) NULL,
  process_id INT NULL,
  capabilities_json JSON NOT NULL,
  started_at TIMESTAMP(3) NOT NULL,
  heartbeat_at TIMESTAMP(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_worker_heartbeats_mode (mode, heartbeat_at),
  INDEX idx_spec_factory_worker_heartbeats_heartbeat (heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
