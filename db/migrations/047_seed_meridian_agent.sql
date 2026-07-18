-- Migration 047: seed MERIDIAN as the Jira-driven SQL generation worker.
-- Keep inactive by default until SSM targets, DB secrets, and Meridian API
-- runtime are configured in the deployment environment.

INSERT INTO agents (name, description, task_type, model, jql, is_active) VALUES
(
  'MERIDIAN',
  'Deterministic data SQL generation with Claude Haiku fallback for unstructured input',
  'sql_generation',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'labels in (MERIDIAN) ORDER BY updated DESC',
  FALSE
)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  updated_at = CURRENT_TIMESTAMP;
