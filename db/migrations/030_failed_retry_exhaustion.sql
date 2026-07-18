-- Migration 030: terminal retry-exhausted status and Jira failed-label polling throttle.
-- Once an agent reaches the processing retry cap, keep the DB row terminal
-- and stop selecting the Jira issue through the agent's label JQL.

ALTER TABLE task_management
  MODIFY status ENUM(
    'assigned',
    'in_progress',
    'waiting_repo_confirmation',
    'completed',
    'failed',
    'failed_retries_exhausted',
    'posting_to_jira',
    'posted_to_jira'
  ) NOT NULL DEFAULT 'assigned';

UPDATE task_management
   SET status = 'failed_retries_exhausted',
       updated_at = CURRENT_TIMESTAMP
 WHERE status = 'failed'
   AND retry_count >= 3;

UPDATE agents
   SET jql = 'labels in (DARCI) AND labels not in (DARCI_DONE, DARCI_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'DARCI';

UPDATE agents
   SET jql = 'labels in (SCRIBE) AND labels not in (SCRIBE_DONE, SCRIBE_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'SCRIBE';

UPDATE agents
   SET jql = 'labels in (PRISM) AND labels not in (PRISM_DONE, PRISM_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'PRISM';

UPDATE agents
   SET jql = 'labels in (HERMES) AND labels not in (HERMES_DONE, HERMES_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'HERMES';

UPDATE agents
   SET jql = 'labels in (SENTRY) AND labels not in (SENTRY_DONE, SENTRY_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'SENTRY';

UPDATE agents
   SET jql = 'labels in (BEACON) AND labels not in (BEACON_DONE, BEACON_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BEACON';

UPDATE agents
   SET jql = 'labels = "BCAT" AND labels != "bcat-planned" AND labels != "bcat-processed" AND labels not in (BCAT_PLANNER_DONE, BCAT_PLANNER_FAILED) AND "Approvers" is not EMPTY ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BCAT-PLANNER';

UPDATE agents
   SET jql = 'labels = "BCAT" AND labels = "bcat-planned" AND labels != "bcat-processed" AND labels not in (BCAT_EXECUTOR_DONE, BCAT_EXECUTOR_FAILED) AND "Approvers" is not EMPTY ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BCAT-EXECUTOR';

UPDATE agents
   SET jql = 'project = SEN AND labels in (VERITAS) AND labels not in (VERITAS-COMPLETED) AND labels not in (VERITAS_DONE, VERITAS_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'VERITAS';

UPDATE agents
   SET jql = 'labels in (SRLOG) AND labels not in (SRLOG_DONE, SRLOG_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'SRLOG';

UPDATE agents
   SET jql = 'labels in (FORGE) AND labels not in (FORGE_DONE, FORGE_FAILED) ORDER BY priority DESC, created ASC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'FORGE';

UPDATE agents
   SET jql = 'labels in (ANVIL) AND labels not in (ANVIL_DONE, ANVIL_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'ANVIL';

UPDATE agents
   SET jql = 'project = CPSUP AND labels = "BC-INTAKE" AND labels not in (BC_INTAKE_DONE, BC_INTAKE_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BC-INTAKE';

UPDATE agents
   SET jql = 'labels = "rift" AND labels not in (RIFT_DONE, RIFT_FAILED) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'RIFT';
