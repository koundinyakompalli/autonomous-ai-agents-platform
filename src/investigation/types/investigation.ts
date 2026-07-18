export const INVESTIGATION_ENVIRONMENTS = [
  'DEV',
  'INT',
  'UAT',
  'STAGE',
  'PROD_REPLICA',
] as const

export type InvestigationEnvironment = (typeof INVESTIGATION_ENVIRONMENTS)[number]

export const INVESTIGATION_RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_review',
  'completed',
  'escalated',
  'failed',
] as const

export type InvestigationRunStatus = (typeof INVESTIGATION_RUN_STATUSES)[number]

export const INVESTIGATION_STAGES = [
  'intake',
  'aws_triage',
  'code_probe',
  'data_probe',
  'host_probe',
  'correlation',
  'summary',
] as const

export type InvestigationStage = (typeof INVESTIGATION_STAGES)[number]

export const INVESTIGATION_ADAPTERS = [
  'aws',
  'code',
  'data',
  'host',
] as const

export type InvestigationAdapterKind = (typeof INVESTIGATION_ADAPTERS)[number]

export const FINDING_SEVERITIES = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
] as const

export type InvestigationSeverity = (typeof FINDING_SEVERITIES)[number]

export interface InvestigationTimeWindow {
  startTs: string
  endTs: string
}

export interface InvestigationTicketCommentContext {
  id: string
  created?: string
  updated?: string
  body: string
}

export interface InvestigationObservedFieldLength {
  fieldName: string
  path: string
  length: number
  sourceRef: string
}

export interface InvestigationTicketAttachmentContext {
  id: string
  filename: string
  mimeType?: string
  size?: number
  created?: string
  extractionStatus: 'metadata_only' | 'text_extracted' | 'skipped' | 'failed'
  textExcerpt?: string
  extractedTerms?: string[]
  payloadFieldTerms?: string[]
  observedFieldLengths?: InvestigationObservedFieldLength[]
  sha256?: string
  contentRef?: string
}

export interface InvestigationTicketIdentifierContext {
  kind: 'case_number' | 'member_identifier'
  source: 'description' | 'comment' | 'attachment'
  value: string
  sensitive: true
}

export type InvestigationEvidenceAnchorKind =
  | 'case_number'
  | 'member_identifier'
  | 'job_name'
  | 'batch_name'
  | 'file_name'
  | 'extract_id'
  | 'transaction_id'
  | 'letter_id'
  | 'fax_id'
  | 'config_key'

export type InvestigationEvidenceAnchorSource =
  | 'description'
  | 'comment'
  | 'attachment'
  | 'runtime'
  | 'code'
  | 'operator'

export interface InvestigationEvidenceAnchor {
  kind: InvestigationEvidenceAnchorKind
  source: InvestigationEvidenceAnchorSource
  value: string
  label?: string
  sensitive: boolean
}

export interface InvestigationDataFlowColumnHint {
  name: string
  propertyName?: string
  linkedFields?: string[]
}

export interface InvestigationDataFlowHint {
  sourceRepo: string
  sourcePath: string
  sourceLine?: number
  sourceTerm?: string
  modelName?: string
  linkedFields?: string[]
  provenance?: 'runtime_context' | 'derived_reference' | 'direct_field_match'
  artifactType: 'hibernate_mapping' | 'sql_literal' | 'hql_literal' | 'config_reference' | 'unknown'
  tableName: string
  columns?: InvestigationDataFlowColumnHint[]
}

export interface InvestigationDiagnosticContext {
  codeEvidenceTerms?: string[]
  codeEvidencePaths?: string[]
  codeEvidencePreviews?: string[]
  runtimeEvidenceTerms?: string[]
  runtimeEvidencePreviews?: string[]
  runtimeFailureColumns?: string[]
  dataFlowHints?: InvestigationDataFlowHint[]
}

export interface InvestigationPlanningContext {
  activeProbeId?: string
  activeProbeIntent?: InvestigationProbeIntent
  workflowType?: string
  causeHypotheses?: string[]
  planningIteration?: number
  evidenceGoals?: string[]
  searchHints?: string[]
  expectedComparison?: string[]
  acceptanceCriteria?: string[]
}

export const INVESTIGATION_PROBE_INTENTS = [
  'resolve_runtime_scope',
  'find_runtime_failure',
  'identify_failing_stage',
  'trace_message_route',
  'identify_queue_consumer',
  'inspect_serverless_runtime_failure',
  'compare_message_contract',
  'inspect_deployed_handler',
  'verify_recovery_semantics',
  'identify_executing_program',
  'trace_code_path',
  'trace_setting_to_code_consumer',
  'read_effective_configuration',
  'verify_affected_entity_state',
  'read_persistence_constraint',
  'compare_observed_value_to_constraint',
  'compare_affected_to_unaffected_scope',
  'correlate_change_with_failure',
  'verify_recovery',
] as const

export type InvestigationProbeIntent = (typeof INVESTIGATION_PROBE_INTENTS)[number]

export const INVESTIGATION_EVIDENCE_FACT_TYPES = [
  'symptom',
  'runtime_failure',
  'scope_state',
  'record_state',
  'job_execution',
  'configuration',
  'code_relationship',
  'schema_constraint',
  'comparison',
  'change',
  'recovery',
  'prevention',
] as const

export type InvestigationEvidenceFactType = (typeof INVESTIGATION_EVIDENCE_FACT_TYPES)[number]

export interface InvestigationEvidenceFact {
  id: string
  type: InvestigationEvidenceFactType
  subject: string
  predicate: string
  object?: string
  value?: string | number | boolean
  unit?: string
  symptomClusterId?: string
  chainIds?: string[]
  confidence: number
  evidenceRefs: string[]
  provenance: {
    adapter: InvestigationAdapterKind
    probeId?: string
    clientId: string
    environment: InvestigationEnvironment
    releaseVersion?: string
    observedAt?: string
    sourceRef: string
    redactionState: 'redacted' | 'metadata_only' | 'not_sensitive'
  }
}

export interface InvestigationSymptomCluster {
  id: string
  label: string
  evidenceRefs: string[]
  material: boolean
  explainedByChainIds: string[]
}

export interface InvestigationTicketContext {
  source?: 'jira'
  jiraKey?: string
  fetchStatus?: 'fetched' | 'unavailable'
  title?: string
  statusName?: string
  environmentName?: string
  releaseVersion?: string
  createdAt?: string
  updatedAt?: string
  labels?: string[]
  clientName?: string
  codeVersion?: string
  descriptionPresent?: boolean
  commentCount?: number
  description?: string
  comments?: InvestigationTicketCommentContext[]
  attachments?: InvestigationTicketAttachmentContext[]
  identifiers?: InvestigationTicketIdentifierContext[]
  extractedTerms?: string[]
  failureReason?: string
  evidenceAnchors?: InvestigationEvidenceAnchor[]
  timeWindow?: InvestigationTimeWindow
}

export interface InvestigationScope {
  clientId: string
  environment: InvestigationEnvironment
  serviceIds: string[]
  workflowType?: 'incident_investigation' | 'planned_data_change'
  codeVersion?: string
  releaseVersion?: string
  timeWindow?: InvestigationTimeWindow
  keywords?: string[]
  repoNames?: string[]
  hostTargets?: string[]
  evidenceAnchors?: InvestigationEvidenceAnchor[]
  ticketContext?: InvestigationTicketContext
  diagnosticContext?: InvestigationDiagnosticContext
  planningContext?: InvestigationPlanningContext
}

export type InvestigationLogSourceKind = 'cloudwatch' | 's3_archive'

export interface InvestigationLogSource {
  id: string
  clientId: string
  environment: InvestigationEnvironment
  envId?: string
  region?: string
  serviceId?: string
  component?: string
  kind: InvestigationLogSourceKind
  logGroupName?: string
  logGroupTemplate?: string
  filterPattern?: string
  maxEvents?: number
  bucket?: string
  prefix?: string
  prefixTemplate?: string
  maxObjects?: number
  optional?: boolean
  enabled: boolean
  notes?: string
}

export interface InvestigationConstraints {
  timeoutMs: number
  maxRows?: number
  maxArtifacts?: number
  redactionRequired: true
}

export interface InvestigationAdapterRequest {
  runId: string
  jiraKey: string
  adapter: InvestigationAdapterKind
  scope: InvestigationScope
  constraints: InvestigationConstraints
  /**
   * Allows long-running adapters to publish completed, immutable probe slices.
   * The control plane retains these slices even when a later probe hits its
   * wall-clock budget.
   */
  onPartialResult?: (result: InvestigationAdapterResult) => void
}

export interface InvestigationFinding {
  id: string
  adapter: InvestigationAdapterKind
  type: string
  severity: InvestigationSeverity
  confidence: number
  title: string
  summary: string
  evidenceRefs: string[]
  requiresCodeChange: boolean
  requiresDataChange: boolean
  metadata?: Record<string, unknown>
}

export interface InvestigationEvidenceArtifact {
  id: string
  adapter: InvestigationAdapterKind
  title: string
  summary: string
  contentType: string
  storageRef?: {
    bucket?: string
    key?: string
  }
  metadata?: Record<string, unknown>
}

export interface InvestigationAdapterTelemetry {
  durationMs: number
  requestsIssued: number
  rowsRead?: number
  artifactsStored?: number
  traceSteps?: InvestigationAdapterTraceStep[]
}

export interface InvestigationAdapterResult {
  findings: InvestigationFinding[]
  evidence: InvestigationEvidenceArtifact[]
  telemetry: InvestigationAdapterTelemetry
}

export interface InvestigationAdapterTraceStep {
  id: string
  adapter: InvestigationAdapterKind
  phase:
    | 'resolve_target'
    | 'fetch_log_events'
    | 'discover_topology'
    | 'inspect_runtime'
    | 'compare_contract'
    | 'inspect_artifact'
    | 'load_secret'
    | 'open_connection'
    | 'select_query_pack'
    | 'validate_query'
    | 'execute_query'
    | 'redact_results'
    | 'persist_evidence'
    | 'close_connection'
  title: string
  detail: string
  startedAt: string
  completedAt?: string
  queryPackId?: string
  connectionTargetId?: string
  safeSql?: string
  rowCount?: number
}

export interface InvestigationRunRecord {
  id: string
  jiraKey: string
  title: string
  scope: InvestigationScope
  status: InvestigationRunStatus
  currentStage: InvestigationStage
  confidence: number | null
  summary: string | null
  createdAt: string
  updatedAt: string
}

export interface InvestigationCorrelationResult {
  confidence: number
  summary: string
  shouldEscalate: boolean
  shouldProbeCode: boolean
  shouldProbeData: boolean
  shouldProbeHost: boolean
  shouldComplete: boolean
}

export interface InvestigationQueryPack {
  id: string
  description: string
  environments: InvestigationEnvironment[]
  allowedTables: string[]
  parameterNames: string[]
  sql: string
  maxRows: number
  timeoutMs: number
  redactionTags?: string[]
}
