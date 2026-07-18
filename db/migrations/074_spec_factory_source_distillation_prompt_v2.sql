-- Migration 074: Register the strict source-distillation structured-output contract.
--
-- Apply before deploying an image that emits source_distillation@v2 when the
-- durable prompt registry is enabled.

UPDATE spec_factory_prompt_versions
SET active = 0,
    updated_at = CURRENT_TIMESTAMP(3)
WHERE prompt_version = 'source_distillation@v1';

INSERT INTO spec_factory_prompt_versions
  (prompt_version, version, active, purposes_json, source, changelog_json,
   schema_expectation)
VALUES
  (
    'source_distillation@v2',
    2,
    1,
    JSON_ARRAY('source_distillation'),
    'src/spec-factory/agents/context-executors.ts',
    JSON_ARRAY('Require canonical non-empty text on every structured distillation item.'),
    'SourceDistillationPatchSchema'
  )
ON DUPLICATE KEY UPDATE
  version = VALUES(version),
  active = VALUES(active),
  purposes_json = VALUES(purposes_json),
  source = VALUES(source),
  changelog_json = VALUES(changelog_json),
  schema_expectation = VALUES(schema_expectation),
  updated_at = CURRENT_TIMESTAMP(3);
