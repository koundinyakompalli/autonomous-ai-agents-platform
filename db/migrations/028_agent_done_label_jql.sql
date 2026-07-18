-- Migration 028: exclude agent-completed Jira issues from label polling.
-- Successful non-OneShot agents now add an AGENT_DONE label after posting
-- results. Keep the existing DB duplicate-check, but stop future poll cycles
-- from selecting tickets already completed by the same agent.

UPDATE agents
   SET jql = 'labels in (DARCI) AND labels not in (DARCI_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'DARCI';

UPDATE agents
   SET jql = 'labels in (SCRIBE) AND labels not in (SCRIBE_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'SCRIBE';

UPDATE agents
   SET jql = 'labels in (PRISM) AND labels not in (PRISM_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'PRISM';

UPDATE agents
   SET jql = 'labels in (HERMES) AND labels not in (HERMES_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'HERMES';

UPDATE agents
   SET jql = 'labels in (SENTRY) AND labels not in (SENTRY_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'SENTRY';

UPDATE agents
   SET jql = 'labels in (BEACON) AND labels not in (BEACON_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BEACON';

UPDATE agents
   SET jql = 'labels = "BCAT" AND labels != "bcat-planned" AND labels != "bcat-processed" AND labels not in (BCAT_PLANNER_DONE) AND "Approvers" is not EMPTY ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BCAT-PLANNER';

UPDATE agents
   SET jql = 'labels = "BCAT" AND labels = "bcat-planned" AND labels != "bcat-processed" AND labels not in (BCAT_EXECUTOR_DONE) AND "Approvers" is not EMPTY ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BCAT-EXECUTOR';

UPDATE agents
   SET jql = 'project = SEN AND labels in (VERITAS) AND labels not in (VERITAS-COMPLETED) AND labels not in (VERITAS_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'VERITAS';

UPDATE agents
   SET jql = 'labels in (SRLOG) AND labels not in (SRLOG_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'SRLOG';

UPDATE agents
   SET jql = 'labels in (FORGE) AND labels not in (FORGE_DONE) ORDER BY priority DESC, created ASC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'FORGE';

UPDATE agents
   SET jql = 'labels in (ANVIL) AND labels not in (ANVIL_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'ANVIL';

UPDATE agents
   SET jql = 'project = CPSUP AND labels = "BC-INTAKE" AND labels not in (BC_INTAKE_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'BC-INTAKE';

UPDATE agents
   SET jql = 'labels = "rift" AND labels not in (RIFT_DONE) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'RIFT';
