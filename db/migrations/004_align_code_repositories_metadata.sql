-- Migration: reconcile canonical GitHub repository metadata after schema
-- normalization. Safe to run multiple times.

-- Preserve the normalized React UI repo name used by the runtime.
UPDATE code_repositories
   SET repo_name = 'React-based-new-ui'
 WHERE repo_name = 'React-new-ui';

-- Ensure canonical GitHub URLs for the known shared repositories.
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
   END,
       default_branch = CASE repo_name
     WHEN 'core-app' THEN 'master'
     WHEN 'client-services' THEN 'master'
     WHEN 'batch-jobs' THEN 'master'
     WHEN 'provider-portal' THEN 'master'
     WHEN 'React-based-new-ui' THEN 'main'
     WHEN 'Ai-agents' THEN 'master'
     WHEN 'Document-ai' THEN 'main'
     WHEN 'mp-web' THEN 'master'
     WHEN 'mp-product-client-configs' THEN 'main'
     ELSE default_branch
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
