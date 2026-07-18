import type {
  InvestigationEnvironment,
  InvestigationQueryPack,
} from '../types/investigation.js'

const DEFAULT_QUERY_PACKS: InvestigationQueryPack[] = [
  {
    id: 'transaction_status_lookup',
    description: 'Look up a bounded transaction record by operational identifier.',
    environments: ['DEV', 'INT', 'UAT', 'STAGE', 'PROD_REPLICA'],
    allowedTables: ['transaction_status'],
    parameterNames: ['transaction_id'],
    sql: 'SELECT transaction_id, status, updated_at FROM transaction_status WHERE transaction_id = ? LIMIT 25',
    maxRows: 25,
    timeoutMs: 3_000,
    redactionTags: ['operational_metadata_only'],
  },
  {
    id: 'feature_flag_verification',
    description: 'Check feature/config state for a client-scoped setting.',
    environments: ['DEV', 'INT', 'UAT', 'STAGE', 'PROD_REPLICA'],
    allowedTables: ['client_feature_flags', 'client_configurations'],
    parameterNames: ['client_id', 'flag_name'],
    sql: 'SELECT client_id, flag_name, enabled, updated_at FROM client_feature_flags WHERE client_id = ? AND flag_name = ? LIMIT 50',
    maxRows: 50,
    timeoutMs: 3_000,
    redactionTags: ['config_only'],
  },
  {
    id: 'job_state_check',
    description: 'Check bounded batch/integration job state in an approved table.',
    environments: ['DEV', 'INT', 'UAT', 'STAGE', 'PROD_REPLICA'],
    allowedTables: ['batch_job_status', 'batch_job_history', 'data_sync_jobs'],
    parameterNames: ['job_name'],
    sql: 'SELECT job_name, status, last_started_at, last_finished_at FROM batch_job_status WHERE job_name = ? LIMIT 50',
    maxRows: 50,
    timeoutMs: 3_000,
    redactionTags: ['job_metadata_only'],
  },
  {
    id: 'clienta_schema_inventory',
    description: 'Collect a bounded RDS schema inventory for Client A without touching business tables directly.',
    environments: ['DEV'],
    allowedTables: ['investigation_meta.clienta_schema_inventory'],
    parameterNames: [],
    sql: 'SELECT table_schema, table_count FROM investigation_meta.clienta_schema_inventory ORDER BY table_count DESC LIMIT 10',
    maxRows: 10,
    timeoutMs: 5_000,
    redactionTags: ['metadata_only'],
  },
  {
    id: 'clienta_table_inventory',
    description: 'List a bounded set of tables for Client A RDS triage.',
    environments: ['DEV'],
    allowedTables: ['investigation_meta.clienta_table_inventory'],
    parameterNames: [],
    sql: 'SELECT table_schema, table_name, engine FROM investigation_meta.clienta_table_inventory ORDER BY table_schema, table_name LIMIT 25',
    maxRows: 25,
    timeoutMs: 5_000,
    redactionTags: ['metadata_only'],
  },
]

export class QueryPackRegistry {
  private readonly packs: Map<string, InvestigationQueryPack>

  constructor(customPacks: InvestigationQueryPack[] = []) {
    this.packs = new Map(
      [...DEFAULT_QUERY_PACKS, ...customPacks].map(pack => [pack.id, pack]),
    )
  }

  getAll(): InvestigationQueryPack[] {
    return Array.from(this.packs.values())
  }

  getById(id: string): InvestigationQueryPack | null {
    return this.packs.get(id) ?? null
  }

  getForEnvironment(environment: InvestigationEnvironment): InvestigationQueryPack[] {
    return this.getAll().filter(pack => pack.environments.includes(environment))
  }
}
