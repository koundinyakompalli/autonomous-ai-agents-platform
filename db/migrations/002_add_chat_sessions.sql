-- ============================================================================
-- Migration 002: Harvey chat sessions + task_management source discrimination
-- ============================================================================
-- Adds multi-turn conversation state for Teams/web users interacting with
-- Harvey, the conversational intake agent.
--
-- CRITICAL: Also adds a `source` column to task_management so the
-- Orchestrator's v_pending_jira_posts view does not accidentally pick up
-- Harvey-originated tasks and try to post them to JIRA.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. chat_sessions table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  session_id            VARCHAR(64) NOT NULL UNIQUE,          -- UUID
  user_id               VARCHAR(128) NOT NULL,                -- Teams user ID or web auth ID
  user_name             VARCHAR(128) NOT NULL,
  channel               ENUM('teams', 'web') NOT NULL DEFAULT 'teams',

  -- 'delivering' enables an atomic claim pattern to prevent duplicate delivery
  status                ENUM('active', 'routing', 'task_created', 'delivering', 'completed', 'delivered', 'abandoned')
                          NOT NULL DEFAULT 'active',

  resolved_agent_id     INT NULL,                             -- FK: agents.id (once determined)
  resolved_customer_id  INT NULL,                             -- FK: customer_branches.id
  resolved_repo_ids     TEXT NULL,                            -- CSV of repo IDs
  task_management_id    INT NULL,                             -- FK: task_management.id (once submitted)
  jira_number           VARCHAR(32) NULL,                     -- JIRA ticket if created
  conversation_reference JSON NULL,                           -- Teams ConversationReference for proactive messaging

  -- Explicit DEFAULT '[]' for broader MySQL 5.7 / Aurora compatibility
  messages_json         JSON NOT NULL DEFAULT ('[]'),         -- Full conversation history

  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Foreign keys
  CONSTRAINT fk_cs_agent      FOREIGN KEY (resolved_agent_id)    REFERENCES agents(id),
  CONSTRAINT fk_cs_customer   FOREIGN KEY (resolved_customer_id) REFERENCES customer_branches(id),
  CONSTRAINT fk_cs_task_mgmt  FOREIGN KEY (task_management_id)   REFERENCES task_management(id),

  -- Indexes
  -- Composite index covers stale-session cleanup queries and active-session
  -- lookups: WHERE user_id = ? AND status = ? ORDER BY updated_at
  INDEX idx_cs_user_active (user_id, status, updated_at),
  INDEX idx_cs_status (status),
  INDEX idx_cs_task_mgmt (task_management_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- NOTE: Unique-active-session-per-user enforcement is handled in application
-- code via GET_LOCK, because MySQL does not support partial unique indexes.

-- ----------------------------------------------------------------------------
-- 2. Back-reference from task_management -> chat_sessions
-- ----------------------------------------------------------------------------
ALTER TABLE task_management
  ADD COLUMN chat_session_id INT NULL AFTER task_s3_key,
  ADD CONSTRAINT fk_tm_chat_session FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id);

-- ----------------------------------------------------------------------------
-- 3. Source discrimination on task_management
-- ----------------------------------------------------------------------------
-- Without this column the Orchestrator's v_pending_jira_posts view will pick
-- up Harvey-originated tasks and attempt to post them to JIRA.  The default
-- is 'jira' so all existing rows are unaffected.
ALTER TABLE task_management
  ADD COLUMN source ENUM('jira', 'harvey', 'api') NOT NULL DEFAULT 'jira' AFTER status;
