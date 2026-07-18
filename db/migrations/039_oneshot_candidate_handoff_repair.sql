-- Migration 039: repair OneShot v2 candidate handoff rows.
--
-- OneShot workspace mode is v2-only. This repair is intentionally idempotent:
-- it normalizes dirty legacy mode values and backfills missing current
-- candidate rows only when run state and the implementation artifact agree.

UPDATE oneshot_runs
SET workspace_mode = 'v2'
WHERE workspace_mode IS NULL OR workspace_mode <> 'v2';

UPDATE oneshot_workspace_state
SET workspace_mode = 'v2'
WHERE workspace_mode IS NULL OR workspace_mode <> 'v2';

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
         'source', 'migration_039_candidate_handoff_repair',
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

UPDATE oneshot_candidate_versions cv
JOIN oneshot_runs r
  ON r.id = cv.oneshot_run_id
JOIN oneshot_artifacts a
  ON a.oneshot_run_id = r.id
 AND a.stage = 'implementation'
 AND a.version = r.current_implementation_version
LEFT JOIN oneshot_candidate_versions current_cv
  ON current_cv.oneshot_run_id = r.id
 AND current_cv.status = 'current'
SET cv.status = 'current',
    cv.target_files_json = COALESCE(
      cv.target_files_json,
      JSON_EXTRACT(a.metadata_json, '$.changedFiles'),
      JSON_ARRAY()
    ),
    cv.metadata_json = COALESCE(
      cv.metadata_json,
      JSON_OBJECT(
        'source', 'migration_039_candidate_handoff_repair',
        'implementationBranch', r.current_implementation_branch
      )
    ),
    cv.finalized_at = COALESCE(cv.finalized_at, a.completed_at, NOW(6))
WHERE r.current_implementation_version IS NOT NULL
  AND r.current_implementation_commit_sha IS NOT NULL
  AND current_cv.id IS NULL
  AND cv.candidate_version = r.current_implementation_version
  AND cv.candidate_commit_sha = r.current_implementation_commit_sha
  AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.implementationCommitSha')) =
    r.current_implementation_commit_sha;

UPDATE oneshot_workspace_state ws
JOIN oneshot_runs r
  ON r.id = ws.oneshot_run_id
JOIN oneshot_candidate_versions cv
  ON cv.oneshot_run_id = r.id
 AND cv.status = 'current'
 AND cv.candidate_version = r.current_implementation_version
 AND cv.candidate_commit_sha = r.current_implementation_commit_sha
SET ws.workspace_mode = 'v2',
    ws.workspace_phase = CASE
      WHEN ws.current_candidate_sha IS NULL THEN 'candidate_finalized'
      ELSE ws.workspace_phase
    END,
    ws.workspace_head_sha = CASE
      WHEN ws.current_candidate_sha IS NULL
        OR ws.workspace_head_sha IS NULL
        OR ws.workspace_head_sha = ws.base_commit_sha
      THEN cv.candidate_commit_sha
      ELSE ws.workspace_head_sha
    END,
    ws.current_candidate_version = cv.candidate_version,
    ws.current_candidate_sha = cv.candidate_commit_sha,
    ws.updated_at = NOW(6)
WHERE ws.workspace_mode IS NULL
   OR ws.workspace_mode <> 'v2'
   OR ws.current_candidate_version IS NULL
   OR ws.current_candidate_sha IS NULL;
