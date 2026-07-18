-- Append-only ticket-readiness scores captured from OneShot intake text.

CREATE TABLE IF NOT EXISTS oneshot_ticket_readiness_scores (
  id                            BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_management_id            INT                              NOT NULL,
  rubric_version                VARCHAR(24)                      NOT NULL,
  detection_patterns_version    VARCHAR(24)                      NOT NULL,
  source_text_sha               CHAR(40)                         NOT NULL,
  score_source                  ENUM('intake', 'backfill')       NOT NULL,
  score_json                    JSON                             NOT NULL,
  scored_at                     TIMESTAMP(3)                     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_oneshot_ticket_readiness_scores_task_management
    FOREIGN KEY (task_management_id) REFERENCES task_management(id),

  UNIQUE KEY uq_oneshot_ticket_readiness_task_text_source (
    task_management_id,
    rubric_version,
    detection_patterns_version,
    source_text_sha,
    score_source
  ),
  INDEX idx_oneshot_ticket_readiness_task (
    task_management_id,
    rubric_version,
    detection_patterns_version,
    source_text_sha
  ),
  INDEX idx_oneshot_ticket_readiness_scored_at (scored_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
