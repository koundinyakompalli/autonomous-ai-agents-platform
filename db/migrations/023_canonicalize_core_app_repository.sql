-- Migration 023: canonicalize core-app repository metadata.
--
-- Historical explicit GitHub repo resolution inserted many
-- `cp-medhok-monorepo` rows for the same GitHub repository already represented
-- by the canonical OneShot `core-app` row. Fold those duplicates into
-- `core-app` so routing sees one repo identity.

SET @core_canonical_repo_name = _utf8mb4'core-app' COLLATE utf8mb4_unicode_ci;
SET @core_legacy_repo_name = _utf8mb4'cp-medhok-monorepo' COLLATE utf8mb4_unicode_ci;
SET @core_repo_url = _utf8mb4'https://github.com/mhk-repos/cp-medhok-monorepo.git' COLLATE utf8mb4_unicode_ci;
SET @core_repo_description = _utf8mb4'Core MedHOK monorepo containing primary UI, APIs, and business logic' COLLATE utf8mb4_unicode_ci;
SET @core_repo_branch = _utf8mb4'master' COLLATE utf8mb4_unicode_ci;
SET @core_target_id = NULL;

SELECT id
  INTO @core_target_id
  FROM code_repositories
 WHERE repo_name = @core_canonical_repo_name
 ORDER BY id
 LIMIT 1;

SELECT COALESCE(
  @core_target_id,
  (
    SELECT id
      FROM code_repositories
     WHERE repo_url = @core_repo_url
        OR repo_name = @core_legacy_repo_name
     ORDER BY id
     LIMIT 1
  )
) INTO @core_target_id;

INSERT INTO code_repositories (repo_name, repo_url, description, default_branch)
SELECT @core_canonical_repo_name, @core_repo_url, @core_repo_description, @core_repo_branch
 WHERE @core_target_id IS NULL;

SELECT id
  INTO @core_target_id
  FROM code_repositories
 WHERE repo_name = @core_canonical_repo_name
    OR repo_url = @core_repo_url
    OR repo_name = @core_legacy_repo_name
 ORDER BY CASE WHEN repo_name = @core_canonical_repo_name THEN 0 ELSE 1 END, id
 LIMIT 1;

UPDATE code_repositories
   SET repo_name = @core_canonical_repo_name,
       repo_url = @core_repo_url,
       description = @core_repo_description,
       default_branch = @core_repo_branch
 WHERE id = @core_target_id;

SET @core_target_id_text = CAST(@core_target_id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci;

CREATE TEMPORARY TABLE tmp_core_app_duplicate_repos (
  id INT PRIMARY KEY,
  id_text VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL
);

INSERT INTO tmp_core_app_duplicate_repos (id, id_text)
SELECT id, CAST(id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci
  FROM code_repositories
 WHERE id <> @core_target_id
   AND (
     repo_name = @core_legacy_repo_name
     OR repo_url = @core_repo_url
   );

UPDATE oneshot_runs target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.repo_id = duplicate_repo.id
   SET target.repo_id = @core_target_id;

UPDATE oneshot_deployments target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.repo_id = duplicate_repo.id
   SET target.repo_id = @core_target_id;

UPDATE router_decisions target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.top1_repo_id = duplicate_repo.id
   SET target.top1_repo_id = @core_target_id;

UPDATE router_decisions target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.top2_repo_id = duplicate_repo.id
   SET target.top2_repo_id = @core_target_id;

UPDATE router_decisions target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.chosen_repo_id = duplicate_repo.id
   SET target.chosen_repo_id = @core_target_id;

UPDATE router_confirmations target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.resolved_repo_id = duplicate_repo.id
   SET target.resolved_repo_id = @core_target_id;

DELETE duplicate_index
  FROM historical_ticket_index duplicate_index
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON duplicate_index.routed_repo_id = duplicate_repo.id
  JOIN historical_ticket_index target_index
    ON target_index.ticket_id = duplicate_index.ticket_id
   AND target_index.included_reason = duplicate_index.included_reason
   AND target_index.routed_repo_id = @core_target_id;

UPDATE historical_ticket_index target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.routed_repo_id = duplicate_repo.id
   SET target.routed_repo_id = @core_target_id;

UPDATE router_truth_set target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.correct_repo_id = duplicate_repo.id
   SET target.correct_repo_id = @core_target_id;

UPDATE task_management target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON FIND_IN_SET(duplicate_repo.id_text, target.related_code COLLATE utf8mb4_unicode_ci)
   SET target.related_code = TRIM(BOTH ',' FROM REPLACE(
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, target.related_code COLLATE utf8mb4_unicode_ci, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, duplicate_repo.id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, @core_target_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci)
   ))
 WHERE target.related_code IS NOT NULL;

UPDATE task_management
   SET related_code = TRIM(BOTH ',' FROM REPLACE(
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, related_code COLLATE utf8mb4_unicode_ci, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, @core_target_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci, @core_target_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, @core_target_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci)
   ))
 WHERE related_code IS NOT NULL
   AND related_code COLLATE utf8mb4_unicode_ci LIKE CONCAT(_utf8mb4'%' COLLATE utf8mb4_unicode_ci, @core_target_id_text, _utf8mb4',%' COLLATE utf8mb4_unicode_ci);

DELETE target
  FROM code_repositories target
  JOIN tmp_core_app_duplicate_repos duplicate_repo
    ON target.id = duplicate_repo.id;

UPDATE code_repositories
   SET repo_name = @core_canonical_repo_name,
       repo_url = @core_repo_url,
       description = @core_repo_description,
       default_branch = @core_repo_branch
 WHERE id = @core_target_id;

DROP TEMPORARY TABLE tmp_core_app_duplicate_repos;
