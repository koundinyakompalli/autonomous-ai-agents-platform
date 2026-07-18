-- Migration 032: Spec Factory Louise-to-OneShot workflow.

CREATE TABLE IF NOT EXISTS spec_factory_sources (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_jira_key     VARCHAR(50)  NOT NULL,
  source_summary      VARCHAR(255) NOT NULL,
  source_status       VARCHAR(100) NULL,
  source_labels_json  JSON         NULL,
  loe_hours           DECIMAL(8,2) NULL,
  state               ENUM('candidate','drafting','draft_ready','approved','oneshot_submitted','needs_attention','archived') NOT NULL DEFAULT 'candidate',
  approved_epic_key   VARCHAR(50)  NULL,
  last_seen_at        TIMESTAMP(3) NULL,
  submitted_at        TIMESTAMP(3) NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_spec_factory_source_key (source_jira_key),
  INDEX idx_spec_factory_sources_state_updated (state, updated_at, id),
  INDEX idx_spec_factory_sources_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_drafts (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id              BIGINT      NOT NULL,
  version                INT         NOT NULL,
  status                 ENUM('generating','ready','approved','superseded','failed') NOT NULL DEFAULT 'generating',
  draft_json             JSON        NULL,
  rendered_markdown      MEDIUMTEXT  NULL,
  evidence_manifest_json JSON        NULL,
  model_metadata_json    JSON        NULL,
  approved_by            VARCHAR(255) NULL,
  approved_at            TIMESTAMP(3) NULL,
  error_message          TEXT        NULL,
  created_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_drafts_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_spec_factory_draft_version (source_id, version),
  INDEX idx_spec_factory_drafts_id_source (id, source_id),
  INDEX idx_spec_factory_drafts_source_status (source_id, status, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_child_tickets (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id           BIGINT       NOT NULL,
  draft_id            BIGINT       NOT NULL,
  repo_id             INT          NULL,
  repo_name           VARCHAR(255) NOT NULL,
  summary             VARCHAR(255) NOT NULL,
  description         MEDIUMTEXT   NOT NULL,
  loe_hours           DECIMAL(8,2) NULL,
  jira_key            VARCHAR(50)  NULL,
  state               ENUM('draft','created','pfos_labeled','oneshot_requested','oneshot_running','oneshot_terminal','failed') NOT NULL DEFAULT 'draft',
  oneshot_request_id  BIGINT       NULL,
  oneshot_run_id      BIGINT       NULL,
  error_message       TEXT         NULL,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_child_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  CONSTRAINT fk_spec_factory_child_draft_source
    FOREIGN KEY (draft_id) REFERENCES spec_factory_drafts(id),
  UNIQUE KEY uk_spec_factory_child_repo (draft_id, repo_name),
  UNIQUE KEY uk_spec_factory_child_jira (jira_key),
  INDEX idx_spec_factory_child_source_state (source_id, state),
  INDEX idx_spec_factory_child_oneshot_request (oneshot_request_id),
  INDEX idx_spec_factory_child_oneshot_run (oneshot_run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_events (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_id      BIGINT       NOT NULL,
  event_type     VARCHAR(80)  NOT NULL,
  actor          VARCHAR(255) NULL,
  metadata_json  JSON         NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_events_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  INDEX idx_spec_factory_events_source_time (source_id, created_at, id),
  INDEX idx_spec_factory_events_type_time (event_type, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
