-- Migration 009: move Anthropic-backed agents to Claude Sonnet 4.6 and
-- seed OneShot queue-consumer agent rows so every runtime resolves its model
-- from the agents table.

UPDATE agents
SET model = 'us.anthropic.claude-sonnet-4-6'
WHERE model LIKE 'us.anthropic.%';

INSERT INTO agents (name, description, task_type, model, jql, is_active) VALUES
(
  'PLANNER',
  'OneShot planner queue consumer',
  'oneshot_planning',
  'us.anthropic.claude-sonnet-4-6',
  '',
  FALSE
),
(
  'REVIEWER',
  'OneShot reviewer queue consumer',
  'oneshot_review',
  'gpt-5.4',
  '',
  FALSE
),
(
  'IMPLEMENTER',
  'OneShot implementer queue consumer',
  'oneshot_implementation',
  'us.anthropic.claude-sonnet-4-6',
  '',
  FALSE
)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  updated_at = CURRENT_TIMESTAMP;
