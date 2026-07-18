-- Migration 038: persist OneShot run branch contracts and backfill v2 candidates.

SET @run_branch_name_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'run_branch_name'
);
SET @ddl := IF(
  @run_branch_name_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN run_branch_name VARCHAR(255) NULL AFTER base_commit_sha, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @run_branch_base_sha_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'run_branch_base_sha'
);
SET @ddl := IF(
  @run_branch_base_sha_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN run_branch_base_sha VARCHAR(40) NULL AFTER run_branch_name, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @run_branch_created_at_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND column_name = 'run_branch_created_at'
);
SET @ddl := IF(
  @run_branch_created_at_exists = 0,
  'ALTER TABLE oneshot_runs ADD COLUMN run_branch_created_at TIMESTAMP(6) NULL AFTER run_branch_base_sha, ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE oneshot_runs
SET run_branch_name = COALESCE(
      run_branch_name,
      CONCAT(
        'oneshot/',
        LOWER(REGEXP_REPLACE(jira_key, '[^[:alnum:]]+', '-')),
        '-run-',
        id
      )
    ),
    run_branch_base_sha = COALESCE(run_branch_base_sha, base_commit_sha),
    run_branch_created_at = COALESCE(run_branch_created_at, created_at, NOW(6));

UPDATE oneshot_runs
SET current_implementation_branch = run_branch_name
WHERE run_branch_name IS NOT NULL
  AND (
    current_implementation_branch IS NULL
    OR current_implementation_branch <> run_branch_name
  );

SET @run_branch_index_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'oneshot_runs'
    AND index_name = 'idx_oneshot_run_branch_name'
);
SET @ddl := IF(
  @run_branch_index_exists = 0,
  'ALTER TABLE oneshot_runs ADD INDEX idx_oneshot_run_branch_name (run_branch_name), ALGORITHM=INPLACE, LOCK=NONE',
  'DO 0'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO oneshot_candidate_versions (
  oneshot_run_id,
  candidate_version,
  candidate_commit_sha,
  previous_candidate_commit_sha,
  status,
  target_files_json,
  metadata_json,
  finalized_at
)
SELECT r.id,
       r.current_implementation_version,
       r.current_implementation_commit_sha,
       NULL,
       'current',
       COALESCE(JSON_EXTRACT(a.metadata_json, '$.changedFiles'), JSON_ARRAY()),
       JSON_OBJECT(
         'source', 'migration_038_run_branch_contract_backfill',
         'implementationBranch', r.current_implementation_branch
       ),
       COALESCE(a.completed_at, NOW(6))
FROM oneshot_runs r
JOIN oneshot_artifacts a
  ON a.oneshot_run_id = r.id
 AND a.stage = 'implementation'
 AND a.version = r.current_implementation_version
LEFT JOIN oneshot_candidate_versions current_cv
  ON current_cv.oneshot_run_id = r.id
 AND current_cv.status = 'current'
LEFT JOIN oneshot_candidate_versions version_cv
  ON version_cv.oneshot_run_id = r.id
 AND version_cv.candidate_version = r.current_implementation_version
WHERE r.current_implementation_version IS NOT NULL
  AND r.current_implementation_commit_sha IS NOT NULL
  AND current_cv.id IS NULL
  AND version_cv.id IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.implementationCommitSha')) =
    r.current_implementation_commit_sha;
