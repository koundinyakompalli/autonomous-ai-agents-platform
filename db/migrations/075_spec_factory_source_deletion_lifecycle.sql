CREATE TABLE IF NOT EXISTS compose_source_deletions (
  id                          BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                  BIGINT       NOT NULL,
  source_id                   BIGINT       NOT NULL,
  source_title                VARCHAR(400) NOT NULL,
  deleted_by                  VARCHAR(128) NULL,
  status                      ENUM(
    'undoable','restored','purging','purged','failed'
  ) NOT NULL DEFAULT 'undoable',
  undo_until                  TIMESTAMP(3) NOT NULL,
  invalidated_source_ids_json JSON         NOT NULL,
  invalidated_handoff_ids_json JSON        NOT NULL,
  restored_by                 VARCHAR(128) NULL,
  restored_at                 TIMESTAMP(3) NULL,
  purge_started_at            TIMESTAMP(3) NULL,
  purged_at                   TIMESTAMP(3) NULL,
  purge_error                 TEXT         NULL,
  deleted_file_count          BIGINT       NOT NULL DEFAULT 0,
  deleted_object_count        BIGINT       NOT NULL DEFAULT 0,
  created_at                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                             ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_source_deletions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_source_deletions_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  INDEX idx_compose_source_deletions_session (session_id, created_at, id),
  INDEX idx_compose_source_deletions_purge (status, undo_until, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @add_source_deletion_id = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'compose_session_sources'
     AND column_name = 'deletion_id') = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN deletion_id BIGINT NULL AFTER deleted_by, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE add_source_deletion_id_stmt FROM @add_source_deletion_id;
EXECUTE add_source_deletion_id_stmt;
DEALLOCATE PREPARE add_source_deletion_id_stmt;

SET @add_source_purged_at = IF(
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'compose_session_sources'
     AND column_name = 'purged_at') = 0,
  'ALTER TABLE compose_session_sources ADD COLUMN purged_at TIMESTAMP(3) NULL AFTER deletion_id, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE add_source_purged_at_stmt FROM @add_source_purged_at;
EXECUTE add_source_purged_at_stmt;
DEALLOCATE PREPARE add_source_purged_at_stmt;

SET @add_source_deletion_index = IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'compose_session_sources'
     AND index_name = 'idx_compose_session_sources_deletion') = 0,
  'ALTER TABLE compose_session_sources ADD INDEX idx_compose_session_sources_deletion (deletion_id, deleted_at, id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE add_source_deletion_index_stmt FROM @add_source_deletion_index;
EXECUTE add_source_deletion_index_stmt;
DEALLOCATE PREPARE add_source_deletion_index_stmt;
