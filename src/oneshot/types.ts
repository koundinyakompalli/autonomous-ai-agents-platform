import type { OneShotTicketType } from './ticket-type.js'

export const ONE_SHOT_STATES = [
  'queued_for_planning',
  'planning',
  'queued_for_review',
  'reviewing',
  'needs_revision',
  'approved',
  'escalated',
  'blocked',
  'queued_for_implementation',
  'implementing',
  'queued_for_code_review',
  'code_reviewing',
  'queued_for_testing',
  'testing',
  'replan_required',
  'pr_open',
  'completed',
  'failed',
] as const

export type OneShotState = (typeof ONE_SHOT_STATES)[number]

export const ONE_SHOT_ARTIFACT_STAGES = [
  'qualification',
  'plan',
  'trace',
  'verify',
  'review',
  'implementation',
  'code_review',
  'test_result',
] as const

export type ArtifactStage = (typeof ONE_SHOT_ARTIFACT_STAGES)[number]

export const ONE_SHOT_NOTIFICATION_STATUSES = [
  'pending',
  'posting',
  'posted',
  'failed',
] as const

export type NotificationStatus = (typeof ONE_SHOT_NOTIFICATION_STATUSES)[number]

export const ONE_SHOT_NOTIFICATION_TYPES = [
  'planning_completed',
  'review_completed',
  'implementation_completed',
  'implementation_plan_ready',
  'code_review_completed',
  'pr_ready',
  'pr_draft',
  'pr_needs_review',
  'pr_with_risks',
  'review_blocked',
  'review_escalated',
  'code_review_blocked',
  'code_review_escalated',
  'test_failed',
  'pr_created',
  'branch_drift',
  'run_failed',
  'budget_exceeded',
  'completed',
  'verification_only_completed',
  'progress_update',
] as const

export type NotificationType = (typeof ONE_SHOT_NOTIFICATION_TYPES)[number]

export interface OneShotRun {
  id: number
  run_group_id: number | null
  workspace_mode: OneShotWorkspaceMode
  jira_key: string
  epic_key?: string | null
  jira_issue_type: string | null
  ticket_type: OneShotTicketType
  ticket_type_source: string
  ticket_type_updated_by: string | null
  ticket_type_updated_at: Date | null
  source_task_management_id: number
  customer_id: number
  repo_id: number
  branch_name: string
  base_commit_sha: string
  run_branch_name: string | null
  run_branch_base_sha: string | null
  run_branch_created_at: Date | null
  state: OneShotState
  max_review_loops: number
  review_loop_count: number
  current_plan_version: number | null
  current_review_version: number | null
  current_implementation_version: number | null
  current_implementation_branch: string | null
  current_implementation_commit_sha: string | null
  current_code_review_version: number | null
  current_test_version: number | null
  current_pr_url: string | null
  final_disposition: string | null
  last_error: string | null
  max_total_tokens: number
  total_tokens_used: number
  verification_loop_count: number
  max_verification_loops: number
  planning_attempt_count: number
  implementation_attempt_count: number
  code_review_attempt_count: number
  created_at: Date
  updated_at: Date
}

export interface OneShotArtifact {
  id: number
  oneshot_run_id: number
  stage: ArtifactStage
  version: number
  status: string
  s3_bucket: string
  s3_key: string
  provider: string | null
  model: string | null
  metadata_json: Record<string, unknown> | null
  started_at: Date | null
  completed_at: Date | null
  created_at: Date
}

export interface OneShotNotification {
  id: number
  oneshot_run_id: number
  jira_key: string
  notification_type: NotificationType
  body_markdown: string
  status: NotificationStatus
  error: string | null
  created_at: Date
  posted_at: Date | null
}

export interface CreateOneShotRunInput {
  run_group_id?: number | null
  workspace_mode?: OneShotWorkspaceMode
  jira_key: string
  epic_key?: string | null
  jira_issue_type?: string | null
  ticket_type?: OneShotTicketType
  ticket_type_source?: string
  ticket_type_updated_by?: string | null
  ticket_type_updated_at?: Date | null
  source_task_management_id: number
  customer_id: number
  repo_id: number
  branch_name: string
  base_commit_sha: string
  run_branch_name?: string | null
  run_branch_base_sha?: string | null
  run_branch_created_at?: Date | null
  state?: OneShotState
  max_review_loops?: number
  review_loop_count?: number
  current_plan_version?: number | null
  current_review_version?: number | null
  current_implementation_version?: number | null
  current_implementation_branch?: string | null
  current_implementation_commit_sha?: string | null
  current_code_review_version?: number | null
  current_test_version?: number | null
  current_pr_url?: string | null
  final_disposition?: string | null
  last_error?: string | null
  max_total_tokens?: number
  total_tokens_used?: number
  verification_loop_count?: number
  max_verification_loops?: number
  planning_attempt_count?: number
  implementation_attempt_count?: number
  code_review_attempt_count?: number
}

export interface OneShotRunGroup {
  id: number
  jira_key: string
  source_task_management_id: number
  status: string
  metadata_json: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

export interface CreateOneShotRunGroupInput {
  jira_key: string
  source_task_management_id: number
  status?: string
  metadata_json?: Record<string, unknown> | null
}

export interface UpdateOneShotRunFields {
  current_plan_version?: number | null
  current_review_version?: number | null
  current_implementation_version?: number | null
  current_implementation_branch?: string | null
  current_implementation_commit_sha?: string | null
  current_code_review_version?: number | null
  current_test_version?: number | null
  current_pr_url?: string | null
  final_disposition?: string | null
  last_error?: string | null
  jira_issue_type?: string | null
  ticket_type?: OneShotTicketType
  ticket_type_source?: string
  ticket_type_updated_by?: string | null
  ticket_type_updated_at?: Date | null
  base_commit_sha?: string
  branch_name?: string
  run_branch_name?: string | null
  run_branch_base_sha?: string | null
  run_branch_created_at?: Date | null
  max_review_loops?: number
  review_loop_count?: number
  max_total_tokens?: number
  total_tokens_used?: number
  verification_loop_count?: number
  max_verification_loops?: number
  planning_attempt_count?: number
  implementation_attempt_count?: number
  code_review_attempt_count?: number
}

export type OneShotWorkspaceMode = 'v2'

export interface UpsertOneShotArtifactInput {
  oneshot_run_id: number
  stage: ArtifactStage
  version: number
  status: string
  s3_bucket: string
  s3_key: string
  provider?: string | null
  model?: string | null
  metadata_json?: Record<string, unknown> | null
  started_at?: Date | null
  completed_at?: Date | null
}

export interface CreateOneShotNotificationInput {
  oneshot_run_id: number
  jira_key: string
  notification_type: NotificationType
  body_markdown: string
}

export const ONE_SHOT_DEPLOYMENT_STATUSES = [
  'requested',
  'awaiting_approval',
  'building',
  'pushing',
  'deploying',
  'active',
  'failed',
  'superseded',
  'cancelled',
] as const

export type OneShotDeploymentStatus = (typeof ONE_SHOT_DEPLOYMENT_STATUSES)[number]

export interface OneShotDeployment {
  id: number
  oneshot_run_id: number
  slot_name: string
  repo_id: number
  branch_name: string
  commit_sha: string
  pr_url: string | null
  requested_by: string | null
  requested_by_display: string | null
  status: OneShotDeploymentStatus
  workflow_run_id: number | null
  workflow_url: string | null
  image_uri: string | null
  task_definition_arn: string | null
  ecs_cluster_name: string
  ecs_service_name: string
  preview_url: string | null
  error: string | null
  superseded_by: number | null
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}
