-- Migration 037: Compose sessions for Spec Factory (Phase 1 skeleton).

-- 1. Add `origin` to spec_factory_sources (guarded, online).
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_sources'
    AND column_name = 'origin'
);
SET @ddl := IF(
  @col_exists = 0,
  "ALTER TABLE spec_factory_sources ADD COLUMN origin ENUM('louise','compose') NOT NULL DEFAULT 'louise' AFTER state, ALGORITHM=INPLACE, LOCK=NONE",
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. compose_sessions
CREATE TABLE IF NOT EXISTS compose_sessions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  name                VARCHAR(200) NOT NULL,
  created_by          VARCHAR(120) NULL,
  created_by_display  VARCHAR(200) NULL,
  status              ENUM('draft','ready','handed_off','archived') NOT NULL DEFAULT 'draft',
  claude_session_id   VARCHAR(120) NULL,
  source_id           BIGINT       NULL,
  readiness_json      JSON         NULL,
  s3_prefix           VARCHAR(300) NOT NULL,
  workspace_path      VARCHAR(400) NOT NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_sessions_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_compose_sessions_status_updated (status, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. compose_session_sources
CREATE TABLE IF NOT EXISTS compose_session_sources (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id         BIGINT       NOT NULL,
  kind               ENUM('file','youtube','chat','note') NOT NULL,
  original_filename  VARCHAR(400) NULL,
  mime_type          VARCHAR(160) NULL,
  size_bytes         BIGINT       NULL,
  source_url         VARCHAR(2000) NULL,
  s3_key_raw         VARCHAR(500) NULL,
  converter          ENUM('markitdown','voxtral','none') NOT NULL DEFAULT 'none',
  markdown_path      VARCHAR(500) NULL,
  conversion_status  ENUM('pending','converting','converted','unsupported','failed') NOT NULL DEFAULT 'pending',
  error_message      TEXT         NULL,
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_sources_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_session_sources_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. compose_session_messages
CREATE TABLE IF NOT EXISTS compose_session_messages (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id  BIGINT       NOT NULL,
  role        ENUM('user','assistant','system') NOT NULL,
  content     MEDIUMTEXT   NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_messages_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_session_messages_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @col_exists := NULL;
SET @ddl := NULL;
