-- Migration 029: allow QUALIFIER to pick up approved SonarQube autofix tickets.

UPDATE agents
   SET jql = 'labels in (PFOS, SONAR-AUTOFIX) ORDER BY updated DESC',
       updated_at = CURRENT_TIMESTAMP
 WHERE name = 'QUALIFIER';
