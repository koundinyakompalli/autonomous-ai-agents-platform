-- Migration 069: bounded cumulative context patches and immutable source revisions.

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_versions' AND column_name = 'implementation_findings_json') = 0,
  'ALTER TABLE compose_context_versions ADD COLUMN implementation_findings_json JSON NULL AFTER facts_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_versions' AND column_name = 'requirements_json') = 0,
  'ALTER TABLE compose_context_versions ADD COLUMN requirements_json JSON NULL AFTER implementation_findings_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_versions' AND column_name = 'constraints_json') = 0,
  'ALTER TABLE compose_context_versions ADD COLUMN constraints_json JSON NULL AFTER requirements_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_versions' AND column_name = 'risks_json') = 0,
  'ALTER TABLE compose_context_versions ADD COLUMN risks_json JSON NULL AFTER decisions_json, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND column_name = 'schema_version') = 0,
  'ALTER TABLE compose_context_patches ADD COLUMN schema_version INT NOT NULL DEFAULT 4 AFTER base_context_version, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND column_name = 'patch_kind') = 0,
  'ALTER TABLE compose_context_patches ADD COLUMN patch_kind VARCHAR(32) NOT NULL DEFAULT ''source_distillation'' AFTER schema_version, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND column_name = 'turn_job_id') = 0,
  'ALTER TABLE compose_context_patches ADD COLUMN turn_job_id BIGINT NULL AFTER agent_task_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND column_name = 'idempotency_key') = 0,
  'ALTER TABLE compose_context_patches ADD COLUMN idempotency_key VARCHAR(191) NULL AFTER patch_kind, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND column_name = 'message_ids_json') = 0,
  'ALTER TABLE compose_context_patches ADD COLUMN message_ids_json JSON NULL AFTER idempotency_key, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS compose_source_revisions (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT        NOT NULL,
  source_id       BIGINT        NOT NULL,
  revision_number BIGINT        NOT NULL,
  content_sha256  CHAR(64)      NOT NULL,
  artifact_uri    TEXT          NOT NULL,
  artifact_sha256 CHAR(64)      NOT NULL,
  artifact_bytes  BIGINT        NOT NULL,
  content_type    VARCHAR(128)  NULL,
  status          ENUM('ready','superseded','deleted') NOT NULL DEFAULT 'ready',
  created_by      VARCHAR(128)  NULL,
  created_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_source_revisions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_source_revisions_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  UNIQUE KEY uniq_compose_source_revision_number (source_id, revision_number),
  UNIQUE KEY uniq_compose_source_revision_content (source_id, content_sha256),
  INDEX idx_compose_source_revisions_session (session_id, created_at),
  INDEX idx_compose_source_revisions_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_source_chunks (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id       BIGINT       NOT NULL,
  source_id        BIGINT       NOT NULL,
  source_revision_id BIGINT     NOT NULL,
  chunk_index      INT          NOT NULL,
  start_offset     BIGINT       NOT NULL,
  end_offset       BIGINT       NOT NULL,
  token_estimate   INT          NOT NULL,
  content_text     MEDIUMTEXT   NOT NULL,
  content_sha256   CHAR(64)     NOT NULL,
  artifact_uri     TEXT         NOT NULL,
  artifact_sha256  CHAR(64)     NOT NULL,
  artifact_bytes   BIGINT       NOT NULL,
  status           ENUM('ready','superseded','deleted') NOT NULL DEFAULT 'ready',
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_source_chunks_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_source_chunks_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  CONSTRAINT fk_compose_source_chunks_revision
    FOREIGN KEY (source_revision_id) REFERENCES compose_source_revisions(id),
  UNIQUE KEY uniq_compose_source_chunk_index (source_revision_id, chunk_index),
  UNIQUE KEY uniq_compose_source_chunk_content (source_revision_id, content_sha256),
  INDEX idx_compose_source_chunks_source (source_id, source_revision_id),
  INDEX idx_compose_source_chunks_session (session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND column_name = 'source_revision_id') = 0,
  'ALTER TABLE compose_context_patches ADD COLUMN source_revision_id BIGINT NULL AFTER source_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_session_sources' AND column_name = 'current_revision_id') = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN current_revision_id BIGINT NULL AFTER artifact_bytes, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_session_sources' AND column_name = 'content_sha256') = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN content_sha256 CHAR(64) NULL AFTER current_revision_id, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'compose_session_sources' AND column_name = 'deleted_at') = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN deleted_at TIMESTAMP(3) NULL AFTER content_sha256, ADD COLUMN deleted_by VARCHAR(128) NULL AFTER deleted_at, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'compose_context_patches' AND index_name = 'uniq_compose_context_patch_idempotency') = 0,
  'ALTER TABLE compose_context_patches ADD UNIQUE KEY uniq_compose_context_patch_idempotency (session_id, idempotency_key), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'compose_context_patches' AND constraint_name = 'fk_compose_context_patches_turn') = 0,
  'ALTER TABLE compose_context_patches ADD CONSTRAINT fk_compose_context_patches_turn FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'compose_context_patches' AND constraint_name = 'fk_compose_context_patches_revision') = 0,
  'ALTER TABLE compose_context_patches ADD CONSTRAINT fk_compose_context_patches_revision FOREIGN KEY (source_revision_id) REFERENCES compose_source_revisions(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
