-- Migration 011: persist ANVIL and FORGE as active agents in the default schema.
-- This keeps fresh environments aligned with the live worker catalog, where both
-- workers are expected to be present and polling once their ECS services are up.

INSERT INTO agents (name, description, task_type, model, jql, is_active)
VALUES
  (
    'ANVIL',
    'Automated Normalization of YAML from Implementation Layouts',
    'config_generation',
    'us.anthropic.claude-sonnet-4-6',
    'labels in (ANVIL) AND labels not in (ANVIL_DONE) ORDER BY updated DESC',
    TRUE
  ),
  (
    'FORGE',
    'Failure Operations Root-cause Guidance Engine',
    'mp_failure_analysis',
    'us.anthropic.claude-sonnet-4-6',
    'labels in (FORGE) AND labels not in (FORGE_DONE) ORDER BY priority DESC, created ASC',
    TRUE
  )
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;
