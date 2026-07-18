-- Migration 070: transactional outbox and idempotent queue consumer receipts.

CREATE TABLE IF NOT EXISTS spec_factory_outbox (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  aggregate_type  VARCHAR(64)  NOT NULL,
  aggregate_id    VARCHAR(128) NOT NULL,
  event_type      VARCHAR(128) NOT NULL,
  schema_version  INT          NOT NULL DEFAULT 1,
  dedupe_key      VARCHAR(191) NOT NULL,
  payload_json    JSON         NOT NULL,
  status          ENUM('pending','publishing','published','failed','dead') NOT NULL DEFAULT 'pending',
  publish_attempts INT         NOT NULL DEFAULT 0,
  available_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_owner     VARCHAR(128) NULL,
  lease_until     TIMESTAMP(3) NULL,
  published_at    TIMESTAMP(3) NULL,
  last_error      TEXT         NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uniq_spec_factory_outbox_dedupe (dedupe_key),
  INDEX idx_spec_factory_outbox_claim (status, available_at, lease_until, id),
  INDEX idx_spec_factory_outbox_aggregate (aggregate_type, aggregate_id, id),
  INDEX idx_spec_factory_outbox_published (published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TRIGGER IF EXISTS trg_compose_source_conversion_insert_outbox;
CREATE TRIGGER trg_compose_source_conversion_insert_outbox
AFTER INSERT ON compose_session_sources
FOR EACH ROW
INSERT INTO spec_factory_outbox
  (aggregate_type, aggregate_id, event_type, schema_version, dedupe_key,
   payload_json, status, available_at)
SELECT
  'source_conversion',
  CAST(NEW.id AS CHAR),
  'source.conversion.queued',
  1,
  CONCAT('source-conversion:', NEW.id, ':g', NEW.conversion_attempts + 1),
  JSON_OBJECT(
    'sessionId', NEW.session_id,
    'sourceId', NEW.id,
    'sourceKind', NEW.kind,
    'queueGeneration', NEW.conversion_attempts + 1
  ),
  'pending',
  COALESCE(NEW.conversion_lease_expires_at, CURRENT_TIMESTAMP(3))
WHERE NEW.conversion_status = 'pending'
ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id);

DROP TRIGGER IF EXISTS trg_compose_source_conversion_update_outbox;
CREATE TRIGGER trg_compose_source_conversion_update_outbox
AFTER UPDATE ON compose_session_sources
FOR EACH ROW
INSERT INTO spec_factory_outbox
  (aggregate_type, aggregate_id, event_type, schema_version, dedupe_key,
   payload_json, status, available_at)
SELECT
  'source_conversion',
  CAST(NEW.id AS CHAR),
  'source.conversion.queued',
  1,
  CONCAT('source-conversion:', NEW.id, ':g', NEW.conversion_attempts + 1),
  JSON_OBJECT(
    'sessionId', NEW.session_id,
    'sourceId', NEW.id,
    'sourceKind', NEW.kind,
    'queueGeneration', NEW.conversion_attempts + 1
  ),
  'pending',
  COALESCE(NEW.conversion_lease_expires_at, CURRENT_TIMESTAMP(3))
WHERE NEW.conversion_status = 'pending'
  AND OLD.conversion_status <> 'pending'
ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id);


CREATE TABLE IF NOT EXISTS spec_factory_queue_receipts (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  consumer_name   VARCHAR(128) NOT NULL,
  message_id      VARCHAR(191) NOT NULL,
  outbox_id       BIGINT       NULL,
  queue_generation BIGINT      NOT NULL DEFAULT 1,
  status          ENUM('processing','completed','failed') NOT NULL DEFAULT 'processing',
  lease_token     CHAR(36)     NULL,
  lease_until     TIMESTAMP(3) NULL,
  result_json     JSON         NULL,
  error_message   TEXT         NULL,
  started_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    TIMESTAMP(3) NULL,
  updated_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_spec_factory_queue_receipts_outbox
    FOREIGN KEY (outbox_id) REFERENCES spec_factory_outbox(id),
  UNIQUE KEY uniq_spec_factory_queue_receipt (consumer_name, message_id),
  INDEX idx_spec_factory_queue_receipts_status (status, lease_until, updated_at),
  INDEX idx_spec_factory_queue_receipts_outbox (outbox_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
