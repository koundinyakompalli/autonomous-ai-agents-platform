-- Migration 022: canonicalize BI Datamart repository metadata.
--
-- Production had a legacy `BI-datamart` row and a newer canonical
-- `cp-medhok-bi-datamart-monorepo` row pointing at the same GitHub repo. Keep
-- the legacy id when present so existing references remain stable.

SET @bi_legacy_repo_name = _utf8mb4'BI-datamart' COLLATE utf8mb4_unicode_ci;
SET @bi_canonical_repo_name = _utf8mb4'cp-medhok-bi-datamart-monorepo' COLLATE utf8mb4_unicode_ci;
SET @bi_repo_url = _utf8mb4'https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git' COLLATE utf8mb4_unicode_ci;
SET @bi_repo_description = _utf8mb4'MedHOK BI Data Mart monorepo for member data mart reporting, report metadata, and warehouse/reporting extracts' COLLATE utf8mb4_unicode_ci;
SET @bi_repo_branch = _utf8mb4'master' COLLATE utf8mb4_unicode_ci;
SET @bi_legacy_id = NULL;
SET @bi_canonical_id = NULL;
SET @bi_target_id = NULL;
SET @bi_duplicate_id = NULL;

SELECT id
  INTO @bi_legacy_id
  FROM code_repositories
 WHERE repo_name = @bi_legacy_repo_name
 LIMIT 1;

SELECT id
  INTO @bi_canonical_id
  FROM code_repositories
 WHERE repo_name = @bi_canonical_repo_name
 LIMIT 1;

INSERT INTO code_repositories (repo_name, repo_url, description, default_branch)
SELECT @bi_canonical_repo_name, @bi_repo_url, @bi_repo_description, @bi_repo_branch
 WHERE @bi_legacy_id IS NULL
   AND @bi_canonical_id IS NULL;

SET @bi_legacy_id = NULL;
SET @bi_canonical_id = NULL;

SELECT id
  INTO @bi_legacy_id
  FROM code_repositories
 WHERE repo_name = @bi_legacy_repo_name
 LIMIT 1;

SELECT id
  INTO @bi_canonical_id
  FROM code_repositories
 WHERE repo_name = @bi_canonical_repo_name
 LIMIT 1;

SET @bi_target_id = COALESCE(@bi_legacy_id, @bi_canonical_id);
SET @bi_duplicate_id = CASE
  WHEN @bi_legacy_id IS NOT NULL
   AND @bi_canonical_id IS NOT NULL
   AND @bi_legacy_id <> @bi_canonical_id
  THEN @bi_canonical_id
  ELSE NULL
END;
SET @bi_target_id_text = CAST(@bi_target_id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci;
SET @bi_duplicate_id_text = CAST(@bi_duplicate_id AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci;

UPDATE oneshot_runs
   SET repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND repo_id = @bi_duplicate_id;

UPDATE oneshot_deployments
   SET repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND repo_id = @bi_duplicate_id;

UPDATE router_decisions
   SET top1_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND top1_repo_id = @bi_duplicate_id;

UPDATE router_decisions
   SET top2_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND top2_repo_id = @bi_duplicate_id;

UPDATE router_decisions
   SET chosen_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND chosen_repo_id = @bi_duplicate_id;

UPDATE router_confirmations
   SET resolved_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND resolved_repo_id = @bi_duplicate_id;

DELETE duplicate_index
  FROM historical_ticket_index duplicate_index
  JOIN historical_ticket_index target_index
    ON target_index.ticket_id = duplicate_index.ticket_id
   AND target_index.included_reason = duplicate_index.included_reason
   AND target_index.routed_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND duplicate_index.routed_repo_id = @bi_duplicate_id;

UPDATE historical_ticket_index
   SET routed_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND routed_repo_id = @bi_duplicate_id;

UPDATE router_truth_set
   SET correct_repo_id = @bi_target_id
 WHERE @bi_duplicate_id IS NOT NULL
   AND correct_repo_id = @bi_duplicate_id;

UPDATE task_management
   SET related_code = TRIM(BOTH ',' FROM REPLACE(
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, related_code, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, @bi_duplicate_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     _utf8mb4',' COLLATE utf8mb4_unicode_ci
   ))
 WHERE @bi_duplicate_id IS NOT NULL
   AND related_code IS NOT NULL
   AND FIND_IN_SET(@bi_target_id_text, related_code)
   AND FIND_IN_SET(@bi_duplicate_id_text, related_code);

UPDATE task_management
   SET related_code = TRIM(BOTH ',' FROM REPLACE(
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, related_code, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, @bi_duplicate_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci),
     CONCAT(_utf8mb4',' COLLATE utf8mb4_unicode_ci, @bi_target_id_text, _utf8mb4',' COLLATE utf8mb4_unicode_ci)
   ))
 WHERE @bi_duplicate_id IS NOT NULL
   AND related_code IS NOT NULL
   AND FIND_IN_SET(@bi_duplicate_id_text, related_code);

DELETE FROM code_repositories
 WHERE @bi_duplicate_id IS NOT NULL
   AND id = @bi_duplicate_id;

UPDATE code_repositories
   SET repo_name = @bi_canonical_repo_name,
       repo_url = @bi_repo_url,
       description = @bi_repo_description,
       default_branch = @bi_repo_branch
 WHERE id = @bi_target_id;
