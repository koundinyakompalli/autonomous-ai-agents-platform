-- Migration: finalize code_repositories as GitHub-only metadata.
-- Run this after the runtime and agent-registry Lambda have been updated to the
-- metadata-only model.

-- Preserve the normalized React UI repo name used by the runtime.
UPDATE code_repositories
   SET repo_name = 'React-based-new-ui'
 WHERE repo_name = 'React-new-ui';

-- Align canonical GitHub URLs before the schema cleanup in case migration 002
-- was skipped or only partially applied.
UPDATE code_repositories
   SET repo_url = CASE repo_name
     WHEN 'core-app' THEN 'https://github.com/mhk-repos/cp-medhok-monorepo.git'
     WHEN 'client-services' THEN 'https://github.com/mhk-repos/cp-client-services-monorepo.git'
     WHEN 'batch-jobs' THEN 'https://github.com/mhk-repos/cp-batch-monorepo.git'
     WHEN 'provider-portal' THEN 'https://github.com/mhk-repos/cp-provider-portal.git'
     WHEN 'React-based-new-ui' THEN 'https://github.com/mhk-repos/cp-mhk-smart-prominence.git'
     WHEN 'Ai-agents' THEN 'https://github.com/mhk-repos/enterprise-ai-agent-platform.git'
     WHEN 'Document-ai' THEN 'https://github.com/mhk-repos/document-ai.git'
     WHEN 'mp-web' THEN 'https://github.com/mhk-repos/mp-web.git'
     WHEN 'mp-product-client-configs' THEN 'https://github.com/mhk-repos/mp-product-client-configs.git'
     ELSE repo_url
   END
 WHERE repo_name IN (
   'core-app',
   'client-services',
   'batch-jobs',
   'provider-portal',
   'React-based-new-ui',
   'Ai-agents',
   'Document-ai',
   'mp-web',
   'mp-product-client-configs'
 );

-- Add explicit default-branch metadata before dropping legacy auth columns.
ALTER TABLE code_repositories
  ADD COLUMN default_branch VARCHAR(255) NULL
    COMMENT 'Default branch to use when a task targets the repo base branch'
    AFTER description;

-- Backfill known legacy product repos that still default to master on GitHub.
UPDATE code_repositories
   SET default_branch = 'master'
 WHERE repo_name IN (
   'core-app',
   'client-services',
   'batch-jobs',
   'provider-portal',
   'React-based-new-ui',
   'React-new-ui',
   'mp-web'
 );

-- All remaining repositories default to main unless explicitly overridden.
UPDATE code_repositories
   SET default_branch = 'main'
 WHERE default_branch IS NULL
    OR default_branch = '';

ALTER TABLE code_repositories
  MODIFY COLUMN default_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  DROP INDEX idx_git_type,
  DROP COLUMN gitType,
  DROP COLUMN token,
  DROP COLUMN username,
  DROP COLUMN password;
