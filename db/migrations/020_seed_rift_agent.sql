-- Migration 017: persist RIFT as an active agent in the default schema.
-- RIFT (Regression Investigation & Fix Tracker) analyzes upgrade defects by
-- comparing code across two branches. Without this row the Orchestrator's
-- JIRA polling loop (getActiveAgents) never issues a query for the RIFT
-- label, so adding the label on a ticket does not trigger the agent.

INSERT INTO agents (name, description, task_type, model, jql, is_active)
VALUES
  (
    'RIFT',
    'Regression Investigation & Fix Tracker',
    'upgrade_defect_analysis',
    'us.anthropic.claude-sonnet-4-6',
    'labels in (RIFT) AND labels not in (RIFT_DONE) ORDER BY updated DESC',
    TRUE
  )
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;
