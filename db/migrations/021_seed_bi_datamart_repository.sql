-- Migration 021: seed BI/Data Mart repository enabled for OneShot routing.

UPDATE code_repositories
   SET repo_url = 'https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git',
       description = 'MedHOK BI Data Mart monorepo for member data mart reporting, report metadata, and warehouse/reporting extracts',
       default_branch = 'master'
 WHERE repo_name = 'cp-medhok-bi-datamart-monorepo';

INSERT INTO code_repositories (repo_name, repo_url, description, default_branch)
SELECT
  'cp-medhok-bi-datamart-monorepo',
  'https://github.com/mhk-repos/cp-medhok-bi-datamart-monorepo.git',
  'MedHOK BI Data Mart monorepo for member data mart reporting, report metadata, and warehouse/reporting extracts',
  'master'
WHERE NOT EXISTS (
  SELECT 1
    FROM code_repositories
   WHERE repo_name = 'cp-medhok-bi-datamart-monorepo'
);
