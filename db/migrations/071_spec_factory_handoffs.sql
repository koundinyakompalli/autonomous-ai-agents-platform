-- Migration 071: durable Compose handoffs and immutable handoff snapshots.

CREATE TABLE IF NOT EXISTS compose_handoffs (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                 BIGINT        NOT NULL,
  source_id                  BIGINT        NULL,
  idempotency_key            VARCHAR(191)  NOT NULL,
  requested_by               VARCHAR(128)  NULL,
  status                     ENUM(
    'requested','snapshot_building','snapshot_ready','draft_queued','drafting',
    'draft_ready','approved','publishing','published','failed','cancelled'
  ) NOT NULL DEFAULT 'requested',
  requested_context_version  BIGINT        NULL,
  context_version_used       BIGINT        NULL,
  message_high_watermark_id  BIGINT        NULL,
  source_revision_set_hash   CHAR(64)      NULL,
  repository_manifest_hash   CHAR(64)      NULL,
  build_agent_task_id        BIGINT        NULL,
  snapshot_id                BIGINT        NULL,
  draft_workflow_id          BIGINT        NULL,
  error_code                 VARCHAR(128)  NULL,
  error_message              TEXT          NULL,
  created_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                           ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at               TIMESTAMP(3)  NULL,

  CONSTRAINT fk_compose_handoffs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_handoffs_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_compose_handoffs_build_task
    FOREIGN KEY (build_agent_task_id) REFERENCES compose_agent_tasks(id),
  UNIQUE KEY uniq_compose_handoff_idempotency (session_id, idempotency_key),
  INDEX idx_compose_handoffs_session_status (session_id, status, created_at),
  INDEX idx_compose_handoffs_source (source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS compose_handoff_snapshots (
  id                         BIGINT AUTO_INCREMENT PRIMARY KEY,
  handoff_id                 BIGINT        NOT NULL,
  session_id                 BIGINT        NOT NULL,
  source_id                  BIGINT        NOT NULL,
  schema_version             INT           NOT NULL DEFAULT 2,
  context_version            BIGINT        NULL,
  message_high_watermark_id  BIGINT        NULL,
  source_revision_set_hash   CHAR(64)      NOT NULL,
  repository_manifest_hash   CHAR(64)      NOT NULL,
  snapshot_json              JSON          NOT NULL,
  artifact_uri               TEXT          NOT NULL,
  artifact_sha256            CHAR(64)      NOT NULL,
  artifact_bytes             BIGINT        NOT NULL,
  markdown_artifact_uri      TEXT          NULL,
  markdown_artifact_sha256   CHAR(64)      NULL,
  markdown_artifact_bytes    BIGINT        NULL,
  status                     ENUM('building','ready','failed','superseded')
                               NOT NULL DEFAULT 'building',
  created_by                 VARCHAR(128)  NULL,
  created_at                 TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at               TIMESTAMP(3)  NULL,

  CONSTRAINT fk_compose_handoff_snapshots_handoff
    FOREIGN KEY (handoff_id) REFERENCES compose_handoffs(id),
  CONSTRAINT fk_compose_handoff_snapshots_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_handoff_snapshots_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uniq_compose_handoff_snapshot_handoff (handoff_id),
  INDEX idx_compose_handoff_snapshots_session (session_id, created_at),
  INDEX idx_compose_handoff_snapshots_source (source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE()
      AND table_name = 'compose_handoffs'
      AND constraint_name = 'fk_compose_handoffs_snapshot') = 0,
  'ALTER TABLE compose_handoffs ADD CONSTRAINT fk_compose_handoffs_snapshot FOREIGN KEY (snapshot_id) REFERENCES compose_handoff_snapshots(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
