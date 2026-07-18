-- Migration 061: support gateway global daily budget checks.

SET @llm_calls_created_idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'spec_factory_llm_calls'
    AND index_name = 'idx_spec_factory_llm_calls_created'
);

SET @llm_calls_created_idx_sql := IF(
  @llm_calls_created_idx_exists = 0,
  'ALTER TABLE spec_factory_llm_calls ADD INDEX idx_spec_factory_llm_calls_created (created_at), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT ''idx_spec_factory_llm_calls_created already exists'''
);

PREPARE llm_calls_created_idx_stmt FROM @llm_calls_created_idx_sql;
EXECUTE llm_calls_created_idx_stmt;
DEALLOCATE PREPARE llm_calls_created_idx_stmt;
