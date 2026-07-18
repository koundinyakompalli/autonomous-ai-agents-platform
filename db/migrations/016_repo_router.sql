-- RepoRouter durable routing, confirmation, profile, and learning state.

ALTER TABLE task_management
  MODIFY status ENUM(
    'assigned',
    'in_progress',
    'waiting_repo_confirmation',
    'completed',
    'failed',
    'posting_to_jira',
    'posted_to_jira'
  ) NOT NULL DEFAULT 'assigned';

CREATE TABLE IF NOT EXISTS router_decisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  task_management_id INT NULL,
  ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outcome VARCHAR(50) NOT NULL,
  decision_source VARCHAR(50) NOT NULL,
  signals_json JSON NULL,
  scores_json JSON NULL,
  top1_repo_id INT NULL,
  top1_score DECIMAL(10, 3) NULL,
  top2_repo_id INT NULL,
  top2_score DECIMAL(10, 3) NULL,
  chosen_repo_id INT NULL,
  selected_repo_ids_json JSON NULL,
  unsupported_repo_ids_json JSON NULL,
  blocking_reasons_json JSON NULL,
  llm_input_json JSON NULL,
  llm_output_json JSON NULL,
  llm_cost_usd DECIMAL(12, 6) NULL,
  current_logic_result JSON NULL,
  current_logic_disposition VARCHAR(50) NULL,
  profile_versions_json JSON NULL,
  weights_version VARCHAR(50) NULL,
  extractor_schema_version VARCHAR(100) NULL,
  snapshot_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_router_decisions_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id),
  CONSTRAINT fk_router_decisions_top1_repo
    FOREIGN KEY (top1_repo_id) REFERENCES code_repositories(id),
  CONSTRAINT fk_router_decisions_top2_repo
    FOREIGN KEY (top2_repo_id) REFERENCES code_repositories(id),
  CONSTRAINT fk_router_decisions_chosen_repo
    FOREIGN KEY (chosen_repo_id) REFERENCES code_repositories(id),

  INDEX idx_router_decisions_ticket_ts (ticket_id, ts),
  INDEX idx_router_decisions_outcome (outcome),
  INDEX idx_router_decisions_task_management (task_management_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS router_confirmations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  task_management_id INT NULL,
  router_decision_id BIGINT NULL,
  candidates_json JSON NOT NULL,
  evidence_json JSON NULL,
  jira_comment_id VARCHAR(100) NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  resolved_by VARCHAR(255) NULL,
  resolved_repo_id INT NULL,
  resolution_source ENUM(
    'jira_reply',
    'dashboard',
    'auto_timeout',
    'target_repo_field_set'
  ) NULL,
  timeout_state ENUM('pending', 'escalated', 'timed_out') NOT NULL DEFAULT 'pending',
  snapshot_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_router_confirmations_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id),
  CONSTRAINT fk_router_confirmations_decision
    FOREIGN KEY (router_decision_id) REFERENCES router_decisions(id),
  CONSTRAINT fk_router_confirmations_repo
    FOREIGN KEY (resolved_repo_id) REFERENCES code_repositories(id),

  INDEX idx_router_confirmations_ticket_pending (ticket_id, resolved_at, timeout_state),
  INDEX idx_router_confirmations_task_management (task_management_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS historical_ticket_index (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  text MEDIUMTEXT NOT NULL,
  routed_repo_id INT NOT NULL,
  disposition VARCHAR(50) NULL,
  component VARCHAR(255) NULL,
  epic_id VARCHAR(100) NULL,
  ticket_created_at TIMESTAMP NULL,
  pr_files_touched_json JSON NULL,
  included_reason ENUM('merged_pr', 'explicit_confirmation', 'backfill_seed') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_historical_ticket_index_repo
    FOREIGN KEY (routed_repo_id) REFERENCES code_repositories(id),

  UNIQUE KEY uk_historical_ticket_reason (ticket_id, routed_repo_id, included_reason),
  INDEX idx_historical_ticket_repo (routed_repo_id),
  INDEX idx_historical_ticket_created (ticket_created_at),
  FULLTEXT KEY ftx_historical_ticket_text (text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS router_truth_set (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(50) NOT NULL,
  correct_repo_id INT NOT NULL,
  label_source ENUM('auto', 'human') NOT NULL,
  labeled_by VARCHAR(255) NULL,
  labeled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  held_out_flag BOOLEAN NOT NULL DEFAULT FALSE,
  truth_set_version VARCHAR(50) NOT NULL DEFAULT '1',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_router_truth_set_repo
    FOREIGN KEY (correct_repo_id) REFERENCES code_repositories(id),

  UNIQUE KEY uk_router_truth_set_ticket_version (ticket_id, truth_set_version),
  INDEX idx_router_truth_set_held_out (held_out_flag, truth_set_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
