-- Migration 041: Add recoverable leases for Compose source conversion.

SET @conversion_started_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'conversion_started_at'
);
SET @ddl := IF(
  @conversion_started_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN conversion_started_at TIMESTAMP(3) NULL AFTER conversion_status, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @conversion_attempts_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'conversion_attempts'
);
SET @ddl := IF(
  @conversion_attempts_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN conversion_attempts INT NOT NULL DEFAULT 0 AFTER conversion_started_at, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @conversion_lease_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'compose_session_sources'
    AND column_name = 'conversion_lease_expires_at'
);
SET @ddl := IF(
  @conversion_lease_exists = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN conversion_lease_expires_at TIMESTAMP(3) NULL AFTER conversion_attempts, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
