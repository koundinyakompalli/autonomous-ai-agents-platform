-- Migration 031: track non-pipeline OneShot artifact work.
--
-- These rows represent scan/documentation artifact workflows that are visible
-- in the OneShot dashboard but are not six-stage implementation runs.

CREATE TABLE IF NOT EXISTS oneshot_artifact_runs (
  id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_key               VARCHAR(50)  NOT NULL,
  source_parent_key        VARCHAR(50)  NULL,
  mode                     ENUM('wiz', 'sonar', 'documentation') NOT NULL,
  status                   VARCHAR(50)  NOT NULL,
  title                    VARCHAR(255) NOT NULL,
  generated_count          INT          NOT NULL DEFAULT 0,
  generated_tickets_json   JSON         NULL,
  human_review_required    TINYINT(1)   NOT NULL DEFAULT 0,
  human_review_count       INT          NOT NULL DEFAULT 0,
  review_items_json        JSON         NULL,
  evidence_json            JSON         NULL,
  artifact_refs_json       JSON         NULL,
  jira_summary             TEXT         NULL,
  completed_at             TIMESTAMP(3) NULL,
  created_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uk_oneshot_artifact_source_mode (source_key, mode),
  INDEX idx_oneshot_artifact_mode_updated (mode, updated_at, id),
  INDEX idx_oneshot_artifact_status_updated (status, updated_at, id),
  INDEX idx_oneshot_artifact_parent (source_parent_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
