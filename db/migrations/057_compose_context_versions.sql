-- Migration 057: Compose context patches and versioned working context.

SET @compose_latest_context_version_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'latest_context_version'
);
SET @ddl := IF(
  @compose_latest_context_version_exists = 0,
  'ALTER TABLE compose_sessions ADD COLUMN latest_context_version BIGINT NULL, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_context_status_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'context_status'
);
SET @ddl := IF(
  @compose_context_status_exists = 0,
  'ALTER TABLE compose_sessions ADD COLUMN context_status VARCHAR(32) NOT NULL DEFAULT ''dirty'', ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compose_conversation_summary_uri_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_sessions'
    AND column_name = 'conversation_summary_uri'
);
SET @ddl := IF(
  @compose_conversation_summary_uri_exists = 0,
  'ALTER TABLE compose_sessions ADD COLUMN conversation_summary_uri TEXT NULL, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS compose_context_patches (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id           BIGINT       NOT NULL,
  source_id            BIGINT       NULL,
  agent_task_id        BIGINT       NULL,
  base_context_version BIGINT       NULL,
  status               ENUM('building','ready','failed','superseded') NOT NULL DEFAULT 'building',
  patch_uri            TEXT         NULL,
  artifact_sha256      CHAR(64)     NULL,
  artifact_bytes       BIGINT       NULL,
  patch_json           JSON         NULL,
  error_message        TEXT         NULL,
  created_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_context_patches_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_context_patches_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  CONSTRAINT fk_compose_context_patches_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id),
  INDEX idx_compose_context_patches_session_status (session_id, status, created_at),
  INDEX idx_compose_context_patches_source (source_id),
  INDEX idx_compose_context_patches_task (agent_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_context_versions (
  id                      BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id              BIGINT       NOT NULL,
  version                 BIGINT       NOT NULL,
  status                  ENUM('building','committed','failed','superseded') NOT NULL DEFAULT 'building',
  parent_version          BIGINT       NULL,
  artifact_uri            TEXT         NULL,
  structured_artifact_uri TEXT         NULL,
  summary_json            JSON         NULL,
  facts_json              JSON         NULL,
  open_questions_json     JSON         NULL,
  decisions_json          JSON         NULL,
  source_ids_json         JSON         NULL,
  patch_ids_json          JSON         NULL,
  created_by_task_id      BIGINT       NULL,
  artifact_sha256         CHAR(64)     NULL,
  artifact_bytes          BIGINT       NULL,
  error_message           TEXT         NULL,
  created_at              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at            TIMESTAMP(3) NULL,

  CONSTRAINT fk_compose_context_versions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_context_versions_task
    FOREIGN KEY (created_by_task_id) REFERENCES compose_agent_tasks(id),
  UNIQUE KEY uniq_compose_context_versions_session_version (session_id, version),
  INDEX idx_compose_context_versions_latest (session_id, status, version),
  INDEX idx_compose_context_versions_task (created_by_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
