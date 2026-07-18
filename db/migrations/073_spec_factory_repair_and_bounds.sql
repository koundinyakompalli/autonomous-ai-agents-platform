-- Migration 073: repair tracking, context schema provenance, and hard research rounds.

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'compose_context_versions'
      AND column_name = 'schema_version') = 0,
  'ALTER TABLE compose_context_versions ADD COLUMN schema_version INT NOT NULL DEFAULT 3 AFTER version, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'compose_turn_jobs'
      AND column_name = 'research_round_count') = 0,
  'ALTER TABLE compose_turn_jobs ADD COLUMN research_round_count INT NOT NULL DEFAULT 0 AFTER max_attempts, ADD COLUMN max_research_rounds INT NOT NULL DEFAULT 3 AFTER research_round_count, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS spec_factory_repair_runs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  repair_type         VARCHAR(64)   NOT NULL,
  status              ENUM('running','completed','completed_with_errors','failed')
                                    NOT NULL DEFAULT 'running',
  dry_run             BOOLEAN       NOT NULL DEFAULT TRUE,
  requested_by        VARCHAR(128)  NULL,
  cursor_session_id   BIGINT        NULL,
  inspected_count     BIGINT        NOT NULL DEFAULT 0,
  queued_count        BIGINT        NOT NULL DEFAULT 0,
  succeeded_count     BIGINT        NOT NULL DEFAULT 0,
  failed_count        BIGINT        NOT NULL DEFAULT 0,
  report_uri          TEXT          NULL,
  report_sha256       CHAR(64)      NULL,
  error_message       TEXT          NULL,
  accepted_by         VARCHAR(128)  NULL,
  acceptance_note     TEXT          NULL,
  accepted_at         TIMESTAMP(3)  NULL,
  started_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at        TIMESTAMP(3)  NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),

  INDEX idx_spec_factory_repair_runs_type (repair_type, created_at),
  INDEX idx_spec_factory_repair_runs_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS spec_factory_repair_items (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  repair_run_id       BIGINT        NOT NULL,
  session_id          BIGINT        NULL,
  source_id           BIGINT        NULL,
  status              ENUM('planned','queued','succeeded','skipped','failed')
                                    NOT NULL DEFAULT 'planned',
  prior_context_version BIGINT      NULL,
  target_context_version BIGINT     NULL,
  agent_task_id       BIGINT        NULL,
  handoff_id          BIGINT        NULL,
  details_json        JSON          NULL,
  error_code          VARCHAR(128)  NULL,
  error_message       TEXT          NULL,
  created_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_repair_items_run
    FOREIGN KEY (repair_run_id) REFERENCES spec_factory_repair_runs(id),
  CONSTRAINT fk_spec_factory_repair_items_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_spec_factory_repair_items_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id),
  CONSTRAINT fk_spec_factory_repair_items_handoff
    FOREIGN KEY (handoff_id) REFERENCES compose_handoffs(id),
  UNIQUE KEY uniq_spec_factory_repair_item_session (repair_run_id, session_id),
  INDEX idx_spec_factory_repair_items_status (repair_run_id, status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
