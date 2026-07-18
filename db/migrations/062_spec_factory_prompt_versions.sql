-- Migration 062: Durable Spec Factory prompt registry.
--
-- The application can continue to use the in-code registry by default. When
-- SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=db is enabled, the LLM Gateway resolves
-- prompt purpose@vN values from this table before any paid provider call.

CREATE TABLE IF NOT EXISTS spec_factory_prompt_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  prompt_version VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  purposes_json JSON NOT NULL,
  source VARCHAR(255) NOT NULL,
  changelog_json JSON NOT NULL,
  schema_expectation VARCHAR(128) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),

  UNIQUE KEY uniq_spec_factory_prompt_versions_version (prompt_version),
  INDEX idx_spec_factory_prompt_versions_active (active, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO spec_factory_prompt_versions
  (prompt_version, version, active, purposes_json, source, changelog_json,
   schema_expectation)
VALUES
  (
    'chat_coordinator@v1',
    1,
    1,
    JSON_ARRAY('chat_coordinator_fast', 'chat_coordinator_strong'),
    'src/spec-factory/agents/chat-coordinator.ts',
    JSON_ARRAY('Initial structured coordinator decision prompt.'),
    'CoordinatorDecisionSchema'
  ),
  (
    'critic_review@v1',
    1,
    1,
    JSON_ARRAY('critic_review'),
    'src/spec-factory/agents/critic-agent.ts',
    JSON_ARRAY('Initial evidence critic prompt.'),
    'CriticReviewSchema'
  ),
  (
    'source_distillation@v1',
    1,
    1,
    JSON_ARRAY('source_distillation'),
    'src/spec-factory/agents/context-executors.ts',
    JSON_ARRAY('Initial source distillation gateway purpose registration.'),
    NULL
  ),
  (
    'context_merge@v1',
    1,
    1,
    JSON_ARRAY('context_merge'),
    'src/spec-factory/agents/context-executors.ts',
    JSON_ARRAY('Initial context merge gateway purpose registration.'),
    NULL
  ),
  (
    'handoff_synthesis@v1',
    1,
    1,
    JSON_ARRAY('handoff_synthesis'),
    'src/spec-factory/compose-handoff-bundle.ts',
    JSON_ARRAY('Initial handoff synthesis gateway purpose registration.'),
    NULL
  ),
  (
    'conversation_summary@v1',
    1,
    1,
    JSON_ARRAY('conversation_summary'),
    'src/spec-factory/llm/llm-gateway.ts',
    JSON_ARRAY('Initial conversation summary gateway purpose registration.'),
    NULL
  )
ON DUPLICATE KEY UPDATE
  version = VALUES(version),
  active = VALUES(active),
  purposes_json = VALUES(purposes_json),
  source = VALUES(source),
  changelog_json = VALUES(changelog_json),
  schema_expectation = VALUES(schema_expectation),
  updated_at = CURRENT_TIMESTAMP(3);
