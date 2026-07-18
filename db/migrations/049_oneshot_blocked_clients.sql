-- Migration 049: OneShot blocked-client eligibility policy.
--
-- The policy table is managed by trusted dashboard operators. Source control
-- intentionally does not seed blocked clients.

CREATE TABLE IF NOT EXISTS oneshot_blocked_clients (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_key          VARCHAR(255) NOT NULL,
  display_name        VARCHAR(255) NOT NULL,
  reason              TEXT         NULL,
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_by          VARCHAR(255) NOT NULL,
  created_by_display  VARCHAR(255) NOT NULL,
  updated_by          VARCHAR(255) NOT NULL,
  updated_by_display  VARCHAR(255) NOT NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_oneshot_blocked_clients_key (client_key),
  INDEX idx_oneshot_blocked_clients_active (is_active, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oneshot_blocked_client_audit_events (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_key          VARCHAR(255) NOT NULL,
  display_name        VARCHAR(255) NOT NULL,
  action              ENUM('created', 'updated', 'deactivated', 'reactivated') NOT NULL,
  reason              TEXT         NULL,
  operator_id         VARCHAR(255) NOT NULL,
  operator_display    VARCHAR(255) NOT NULL,
  old_snapshot_json   JSON         NULL,
  new_snapshot_json   JSON         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX idx_oneshot_blocked_client_audit_key (client_key, created_at, id),
  INDEX idx_oneshot_blocked_client_audit_operator (operator_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
