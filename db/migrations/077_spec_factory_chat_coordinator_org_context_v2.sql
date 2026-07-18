-- Migration 077: Register the organization-aware chat coordinator prompt.
--
-- Apply before deploying an image that emits chat_coordinator@v2 when the
-- durable prompt registry is enabled.

UPDATE spec_factory_prompt_versions
SET active = 0,
    updated_at = CURRENT_TIMESTAMP(3)
WHERE prompt_version = 'chat_coordinator@v1';

INSERT INTO spec_factory_prompt_versions
  (prompt_version, version, active, purposes_json, source, changelog_json,
   schema_expectation)
VALUES
  (
    'chat_coordinator@v2',
    2,
    1,
    JSON_ARRAY('chat_coordinator_fast', 'chat_coordinator_strong'),
    'src/spec-factory/agents/chat-coordinator.ts',
    JSON_ARRAY('Add the versioned MHK organizational baseline and deterministic retrieval of relevant detailed sections.'),
    'CoordinatorDecisionSchema'
  )
ON DUPLICATE KEY UPDATE
  version = VALUES(version),
  active = VALUES(active),
  purposes_json = VALUES(purposes_json),
  source = VALUES(source),
  changelog_json = VALUES(changelog_json),
  schema_expectation = VALUES(schema_expectation),
  updated_at = CURRENT_TIMESTAMP(3);
