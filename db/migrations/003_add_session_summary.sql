-- Migration 003: Add summary column to chat_sessions
-- Enables Option B session lifecycle:
--   per-task session → complete with summary → new session inherits compact context

ALTER TABLE chat_sessions
  ADD COLUMN summary TEXT NULL COMMENT 'Compact summary of what was accomplished, injected into next session'
  AFTER messages_json;
