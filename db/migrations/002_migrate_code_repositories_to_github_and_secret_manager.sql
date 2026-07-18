-- Migration: move code_repositories to GitHub-only metadata
-- and stop storing inline repository credentials in MySQL.

-- Normalize the historical React UI repo name so it matches code expectations.
UPDATE code_repositories
   SET repo_name = 'React-based-new-ui'
 WHERE repo_name = 'React-new-ui';

-- Update repository URLs to the migrated GitHub remotes and clear legacy auth.
UPDATE code_repositories
   SET repo_url = CASE repo_name
                    WHEN 'core-app' THEN 'https://github.com/mhk-repos/cp-medhok-monorepo.git'
                    WHEN 'client-services' THEN 'https://github.com/mhk-repos/cp-client-services-monorepo.git'
                    WHEN 'batch-jobs' THEN 'https://github.com/mhk-repos/cp-batch-monorepo.git'
                    WHEN 'provider-portal' THEN 'https://github.com/mhk-repos/cp-provider-portal.git'
                    WHEN 'React-based-new-ui' THEN 'https://github.com/mhk-repos/cp-mhk-smart-prominence.git'
                    ELSE repo_url
                  END,
       gitType = 'github',
       token = NULL,
       username = NULL,
       password = NULL
 WHERE repo_name IN (
   'core-app',
   'client-services',
   'batch-jobs',
   'provider-portal',
   'React-based-new-ui',
   'Ai-agents',
   'Document-ai'
 );
