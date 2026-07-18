-- Align repo metadata with live GitHub default branches.
-- Existing environments may already have earlier seed migrations with stale defaults.

UPDATE code_repositories
   SET default_branch = 'main'
 WHERE repo_name IN ('React-based-new-ui', 'React-new-ui')
    OR repo_url IN (
      'https://github.com/mhk-repos/cp-mhk-smart-prominence.git',
      'https://github.com/mhk-repos/cp-mhk-smart-prominence'
    );

UPDATE code_repositories
   SET default_branch = 'master'
 WHERE repo_name = 'Ai-agents'
    OR repo_url IN (
      'https://github.com/mhk-repos/enterprise-ai-agent-platform.git',
      'https://github.com/mhk-repos/enterprise-ai-agent-platform'
    );
