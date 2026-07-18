-- Migration 033: durable Spec Factory evidence snapshots and attachment archive.

CREATE TABLE IF NOT EXISTS spec_factory_attachments (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id           BIGINT       NOT NULL,
  jira_attachment_id  VARCHAR(80)  NOT NULL,
  filename            VARCHAR(512) NOT NULL,
  mime_type           VARCHAR(255) NULL,
  size_bytes          BIGINT       NULL,
  artifact_kind       VARCHAR(50)  NOT NULL DEFAULT 'other',
  is_priority         BOOLEAN      NOT NULL DEFAULT FALSE,
  s3_bucket           VARCHAR(255) NULL,
  s3_key              VARCHAR(1024) NULL,
  sha256              CHAR(64)     NULL,
  extracted_text      MEDIUMTEXT   NULL,
  extraction_status   ENUM('stored','extracted','unsupported','failed','skipped') NOT NULL DEFAULT 'stored',
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_attachments_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_spec_factory_attachment_source_jira (source_id, jira_attachment_id),
  INDEX idx_spec_factory_attachments_source_kind (source_id, artifact_kind, id),
  INDEX idx_spec_factory_attachments_status (extraction_status, updated_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_evidence_snapshots (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id                BIGINT       NOT NULL,
  source_jira_key          VARCHAR(50)  NOT NULL,
  source_summary           VARCHAR(255) NOT NULL,
  source_status            VARCHAR(100) NULL,
  source_labels_json       JSON         NULL,
  description_markdown     MEDIUMTEXT   NULL,
  comments_json            JSON         NULL,
  loe_hours                DECIMAL(8,2) NULL,
  loe_source               VARCHAR(600) NULL,
  artifacts_json           JSON         NULL,
  repo_references_json     JSON         NULL,
  warnings_json            JSON         NULL,
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_evidence_snapshots_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_evidence_source_created (source_id, created_at, id),
  INDEX idx_spec_factory_evidence_jira_key (source_jira_key, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_processing_jobs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id       BIGINT       NOT NULL,
  job_type        VARCHAR(50)  NOT NULL,
  status          ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  requested_by    VARCHAR(255) NULL,
  worker_id       VARCHAR(255) NULL,
  error_message   TEXT         NULL,
  started_at      TIMESTAMP(3) NULL,
  finished_at     TIMESTAMP(3) NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_processing_jobs_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_jobs_status_created (status, job_type, created_at, id),
  INDEX idx_spec_factory_jobs_source_status (source_id, status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_drafts'
    AND column_name = 'evidence_snapshot_id'
);
SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE spec_factory_drafts ADD COLUMN evidence_snapshot_id BIGINT NULL AFTER version, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_drafts'
    AND index_name = 'idx_spec_factory_drafts_evidence_snapshot'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE spec_factory_drafts ADD INDEX idx_spec_factory_drafts_evidence_snapshot (evidence_snapshot_id), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := NULL;
SET @idx_exists := NULL;
SET @ddl := NULL;
