-- Migration: Add jira_username column to agents table
-- Jira Cloud requires Basic auth: base64(username:token)
-- Previously username was read from JIRA_USERNAME env var (shared across all agents)
-- Now each agent stores its own Jira account email alongside its token

ALTER TABLE agents
  ADD COLUMN jira_username VARCHAR(255) NULL
    COMMENT 'Jira account email for Basic auth (username:token)'
    AFTER jira_token;

-- Update the v_pending_jira_posts view to expose jira_username
-- so the Orchestrator can use it when posting results
CREATE OR REPLACE VIEW v_pending_jira_posts AS
SELECT
  tm.id,
  tm.jira_number,
  tm.agent_id,
  tm.customer_id,
  a.name as agent_name,
  a.model as agent_model,
  a.jira_token,
  a.jira_username,
  cb.customer as customer_name,
  cb.branch as code_branch,
  t.result_s3_bucket,
  t.result_s3_key,
  t.tokens_consumed,
  t.cost,
  t.started_at,
  t.completed_at,
  TIMESTAMPDIFF(SECOND, t.started_at, t.completed_at) as duration_seconds,
  tm.retry_count
FROM task_management tm
JOIN agents a ON tm.agent_id = a.id
JOIN tasks t ON tm.task_id = t.id
JOIN customer_branches cb ON tm.customer_id = cb.id
WHERE tm.status = 'completed'
  AND t.status = 'completed'
  AND t.result_s3_key IS NOT NULL
  AND tm.retry_count < 3
ORDER BY t.completed_at ASC;

-- Populate jira_username for all existing agents
-- Replace with the actual Jira account email used by Specter
-- UPDATE agents SET jira_username = 'your-jira-email@example.com' WHERE jira_username IS NULL;
