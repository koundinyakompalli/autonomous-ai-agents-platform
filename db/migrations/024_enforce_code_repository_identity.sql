-- Migration 024: enforce code repository identity.
--
-- Repository aliases belong in metadata/profile configuration. The relational
-- table should keep one canonical row per repository name and GitHub URL.

SET @repo_name_unique_exists = (
  SELECT COUNT(*)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'code_repositories'
     AND column_name = 'repo_name'
     AND non_unique = 0
);

SET @repo_url_unique_exists = (
  SELECT COUNT(*)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'code_repositories'
     AND column_name = 'repo_url'
     AND non_unique = 0
);

SET @add_repo_name_unique_sql = IF(
  @repo_name_unique_exists = 0,
  'ALTER TABLE code_repositories ADD UNIQUE KEY uk_code_repositories_repo_name (repo_name)',
  'SELECT 1'
);

PREPARE add_repo_name_unique_stmt FROM @add_repo_name_unique_sql;
EXECUTE add_repo_name_unique_stmt;
DEALLOCATE PREPARE add_repo_name_unique_stmt;

SET @add_repo_url_unique_sql = IF(
  @repo_url_unique_exists = 0,
  'ALTER TABLE code_repositories ADD UNIQUE KEY uk_code_repositories_repo_url (repo_url)',
  'SELECT 1'
);

PREPARE add_repo_url_unique_stmt FROM @add_repo_url_unique_sql;
EXECUTE add_repo_url_unique_stmt;
DEALLOCATE PREPARE add_repo_url_unique_stmt;
