-- Migration 015: seed additional CP/application repositories enabled for OneShot routing.

INSERT INTO code_repositories (repo_name, repo_url, description, default_branch) VALUES
('interop', 'https://github.com/mhk-repos/cp-interoperability-monorepo.git',
 'CP interoperability monorepo for interoperability, FHIR, CDS Hooks, and external integration work',
 'main'),
('data-visor', 'https://github.com/mhk-repos/cp-datalake-pipeline.git',
 'Data Visor / data lake pipeline tooling for reference table validation and reporting query support',
 'main')
ON DUPLICATE KEY UPDATE
  repo_url = VALUES(repo_url),
  description = VALUES(description),
  default_branch = VALUES(default_branch);
