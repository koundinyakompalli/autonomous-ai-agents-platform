-- Migration 012: add OneShot run event audit trail and per-stage attempt counters.
-- This is intentionally idempotent because some environments may have received
-- the prototype DDL outside the canonical db/migrations chain.

ALTER TABLE oneshot_runs
  ADD COLUMN IF NOT EXISTS planning_attempt_count INT NOT NULL DEFAULT 0
    AFTER max_verification_loops,
  ADD COLUMN IF NOT EXISTS implementation_attempt_count INT NOT NULL DEFAULT 0
    AFTER planning_attempt_count,
  ADD COLUMN IF NOT EXISTS code_review_attempt_count INT NOT NULL DEFAULT 0
    AFTER implementation_attempt_count;

CREATE TABLE IF NOT EXISTS oneshot_run_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  oneshot_run_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  from_state VARCHAR(64) DEFAULT NULL,
  to_state VARCHAR(64) DEFAULT NULL,
  stage VARCHAR(64) DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_run_events_run_id (oneshot_run_id),
  INDEX idx_run_events_occurred_at (occurred_at),
  CONSTRAINT fk_run_events_run
    FOREIGN KEY (oneshot_run_id)
    REFERENCES oneshot_runs (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
