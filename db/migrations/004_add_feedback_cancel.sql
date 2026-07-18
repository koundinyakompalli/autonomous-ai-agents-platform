-- Migration 004: Add feedback and cancellation support
-- Adds two independent capabilities:
--
--   1. chat_sessions.feedback — captures a thumbs-up / thumbs-down signal from the
--      Teams user after a result is delivered, enabling quality tracking per session.
--
--   2. task_management.cancelled_by / cancelled_at — records which Teams user
--      cancelled a task and the exact moment it was cancelled, supporting audit
--      trails and cancellation analytics.

-- 1. User feedback on results (thumbs up/down after delivery)
ALTER TABLE chat_sessions
  ADD COLUMN feedback ENUM('positive', 'negative') NULL
  AFTER summary;

-- 2. Track who cancelled a task and when
ALTER TABLE task_management
  ADD COLUMN cancelled_by VARCHAR(128) NULL COMMENT 'Teams user ID who cancelled this task'
  AFTER error_message,
  ADD COLUMN cancelled_at TIMESTAMP NULL
  AFTER cancelled_by;
