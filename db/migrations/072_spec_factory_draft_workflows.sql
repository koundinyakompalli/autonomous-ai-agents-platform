-- Migration 072: durable, resumable draft workflows and stage runs.

CREATE TABLE IF NOT EXISTS spec_factory_draft_workflows (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id             BIGINT        NOT NULL,
  handoff_snapshot_id   BIGINT        NULL,
  idempotency_key       VARCHAR(191)  NOT NULL,
  input_sha256          CHAR(64)      NOT NULL,
  requested_by          VARCHAR(255)  NULL,
  status                ENUM(
    'queued','running','approval_wait','approved','publishing','published',
    'failed','cancelled'
  ) NOT NULL DEFAULT 'queued',
  current_stage         VARCHAR(64)   NOT NULL DEFAULT 'evidence_snapshot',
  evidence_snapshot_id  BIGINT        NULL,
  draft_id              BIGINT        NULL,
  error_code            VARCHAR(128)  NULL,
  error_message         TEXT          NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at          TIMESTAMP(3)  NULL,

  CONSTRAINT fk_spec_factory_draft_workflows_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_spec_factory_draft_workflows_handoff_snapshot
    FOREIGN KEY (handoff_snapshot_id) REFERENCES compose_handoff_snapshots(id),
  CONSTRAINT fk_spec_factory_draft_workflows_evidence_snapshot
    FOREIGN KEY (evidence_snapshot_id) REFERENCES spec_factory_evidence_snapshots(id),
  CONSTRAINT fk_spec_factory_draft_workflows_draft
    FOREIGN KEY (draft_id) REFERENCES spec_factory_drafts(id),
  UNIQUE KEY uniq_spec_factory_draft_workflow_idem (source_id, idempotency_key),
  INDEX idx_spec_factory_draft_workflows_status (status, updated_at, id),
  INDEX idx_spec_factory_draft_workflows_handoff (handoff_snapshot_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_draft_stage_runs (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  workflow_id           BIGINT        NOT NULL,
  source_id             BIGINT        NOT NULL,
  stage_name            VARCHAR(64)   NOT NULL,
  stage_order           INT           NOT NULL,
  status                ENUM('blocked','queued','running','completed','failed','skipped','waiting')
                                      NOT NULL DEFAULT 'blocked',
  input_json            JSON          NULL,
  input_sha256          CHAR(64)      NOT NULL,
  output_json           JSON          NULL,
  output_artifact_uri   TEXT          NULL,
  output_sha256         CHAR(64)      NULL,
  output_bytes          BIGINT        NULL,
  attempt_count         INT           NOT NULL DEFAULT 0,
  max_attempts          INT           NOT NULL DEFAULT 3,
  lease_generation      BIGINT        NOT NULL DEFAULT 0,
  active_worker_id      VARCHAR(128)  NULL,
  lease_until           TIMESTAMP(3)  NULL,
  provider              VARCHAR(64)   NULL,
  model                 VARCHAR(255)  NULL,
  prompt_version        VARCHAR(64)   NULL,
  input_tokens          BIGINT        NULL,
  output_tokens         BIGINT        NULL,
  estimated_cost_usd    DECIMAL(12,6) NULL,
  duration_ms           BIGINT        NULL,
  error_code            VARCHAR(128)  NULL,
  error_message         TEXT          NULL,
  retryable             BOOLEAN       NULL,
  started_at            TIMESTAMP(3)  NULL,
  completed_at          TIMESTAMP(3)  NULL,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_draft_stage_runs_workflow
    FOREIGN KEY (workflow_id) REFERENCES spec_factory_draft_workflows(id),
  CONSTRAINT fk_spec_factory_draft_stage_runs_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uniq_spec_factory_draft_stage (workflow_id, stage_name),
  INDEX idx_spec_factory_draft_stage_claim
    (status, stage_order, lease_until, created_at, id),
  INDEX idx_spec_factory_draft_stage_workflow
    (workflow_id, stage_order, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'spec_factory_drafts'
      AND column_name = 'workflow_id') = 0,
  'ALTER TABLE spec_factory_drafts ADD COLUMN workflow_id BIGINT NULL AFTER source_id, ADD INDEX idx_spec_factory_drafts_workflow (workflow_id), ADD CONSTRAINT fk_spec_factory_drafts_workflow FOREIGN KEY (workflow_id) REFERENCES spec_factory_draft_workflows(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE constraint_schema = DATABASE() AND table_name = 'compose_handoffs'
      AND constraint_name = 'fk_compose_handoffs_draft_workflow') = 0,
  'ALTER TABLE compose_handoffs ADD CONSTRAINT fk_compose_handoffs_draft_workflow FOREIGN KEY (draft_workflow_id) REFERENCES spec_factory_draft_workflows(id)',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
