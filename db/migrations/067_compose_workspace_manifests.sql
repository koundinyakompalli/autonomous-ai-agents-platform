-- Migration 067: persist the latest derived Compose workspace manifest per session.

CREATE TABLE IF NOT EXISTS compose_workspace_manifests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  workspace_path VARCHAR(1024) NOT NULL,
  manifest_json JSON NOT NULL,
  manifest_bytes BIGINT NOT NULL,
  manifest_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uniq_compose_workspace_manifests_session (session_id),
  INDEX idx_compose_workspace_manifests_updated (updated_at),
  CONSTRAINT fk_compose_workspace_manifests_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
