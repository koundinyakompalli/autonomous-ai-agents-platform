-- Migration 078: give Wiz Code (SAST) artifact runs their own dashboard mode.
--
-- Wiz Code (SAST) triage reuses the Sonar remediation pipeline internally, so
-- artifact runs were recorded with mode='sonar' and the dashboard mislabeled
-- them as "SonarQube". Add a distinct 'wiz_sast' enum value and backfill the
-- existing rows that were created from Wiz Code (SAST) scans so they display
-- as "Wiz SAST".

ALTER TABLE oneshot_artifact_runs
  MODIFY COLUMN mode
    ENUM('wiz', 'sonar', 'wiz_sast', 'documentation') NOT NULL;

-- Backfill: sonar-mode artifact rows that are actually Wiz Code (SAST) scans.
--
-- Discriminator: artifact_refs_json.sourcePrefix. TRIAGE derives this from
-- SOURCE_PREFIX (see src/orchestrator/triage/engine.ts) and writes it on every
-- artifact-run recording path; for the Wiz Code lane the value is "WIZ-CODE",
-- which real SonarQube batches ("SONAR") never carry. This field has been
-- populated since artifact-run tracking was introduced (migration 031), so it
-- reliably identifies historical Wiz SAST rows regardless of epic title format.
--
-- NOTE: the earlier title-prefix approach ("[WIZ-SAST]%") was invalid — TRIAGE
-- stores the raw Jira epic summary in `title` and no code adds that prefix.
UPDATE oneshot_artifact_runs
SET mode = 'wiz_sast'
WHERE mode = 'sonar'
  AND JSON_UNQUOTE(JSON_EXTRACT(artifact_refs_json, '$.sourcePrefix')) = 'WIZ-CODE';
