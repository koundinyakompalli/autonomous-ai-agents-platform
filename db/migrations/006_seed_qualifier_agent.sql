-- Migration 006: seed QUALIFIER agent for PFOS / OneShot Phase 2.
-- Keep it inactive by default until the queue consumers and Terraform wiring are deployed.

INSERT INTO agents (name, description, task_type, model, jql, is_active)
VALUES (
  'QUALIFIER',
  'PFOS Qualification & OneShot Control-Plane Entry',
  'qualification',
  'us.anthropic.claude-sonnet-4-6',
  'labels = PFOS ORDER BY updated DESC',
  FALSE
)
ON DUPLICATE KEY UPDATE
  description = VALUES(description),
  task_type = VALUES(task_type),
  model = VALUES(model),
  jql = VALUES(jql),
  updated_at = CURRENT_TIMESTAMP;
