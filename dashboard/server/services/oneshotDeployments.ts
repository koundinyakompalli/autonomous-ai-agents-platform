import mysql from 'mysql2/promise'
import { getPool } from '../db.js'
import { dispatchCoreAppPreviewDeployment } from './githubActionsDispatch.js'
import type {
  OneShotDeploymentStatus,
  OneShotDeploymentSummary,
} from '../types/oneshot.js'
import type {
  OneShotDeploymentCallbackBody,
  OneShotDeploymentRecord,
  OperatorIdentity,
} from '../types/oneshotDeployments.js'

const DEPLOYMENT_TABLE_NAME = 'oneshot_deployments'
const CORE_APP_REPO_NAME = 'core-app'
const CORE_APP_SLOT_NAME = 'core-app-preview'
const DEFAULT_PREVIEW_URL = 'https://client-a-cp-dev-mhk-core.mhkdevsandbox.com/medhok/'
const DEFAULT_ECS_CLUSTER = 'CLIENT-A'
const DEFAULT_ECS_SERVICE = 'CLIENT-A-cp-dev-mhk-core'

const INFLIGHT_DEPLOYMENT_STATUSES: OneShotDeploymentStatus[] = [
  'requested',
  'awaiting_approval',
  'building',
  'pushing',
  'deploying',
]

const TERMINAL_DEPLOYMENT_STATUSES: OneShotDeploymentStatus[] = [
  'active',
  'failed',
  'superseded',
  'cancelled',
]

type DeploymentRow = mysql.RowDataPacket & {
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
  created_at: Date | string
  updated_at: Date | string
  completed_at: Date | string | null
}

type RunDeployContextRow = mysql.RowDataPacket & {
  oneshot_run_id: number
  jira_key: string
  repo_id: number
  repo_name: string
  repo_url: string
  run_state: string
  final_disposition: string | null
  current_pr_url: string | null
  current_implementation_branch: string | null
  current_implementation_commit_sha: string | null
  implementation_metadata_json: Record<string, unknown> | string | null
}

interface CreateDeploymentRequestInput {
  oneshotRunId: number
  operator: OperatorIdentity
}

interface DeploymentCallbackInput {
  deploymentId: number
  payload: OneShotDeploymentCallbackBody
}

interface DeploymentUpdateFields {
  status?: OneShotDeploymentStatus
  workflow_run_id?: number | null
  workflow_url?: string | null
  image_uri?: string | null
  task_definition_arn?: string | null
  preview_url?: string | null
  error?: string | null
  superseded_by?: number | null
  completed_at?: Date | null
}

let deploymentTableExistsCache: boolean | null = null

export class OneShotDeploymentError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'OneShotDeploymentError'
  }
}

function getCoreAppPreviewUrl(): string {
  return process.env.COREAPP_PREVIEW_URL?.trim() || DEFAULT_PREVIEW_URL
}

function getCoreAppPreviewCluster(): string {
  return process.env.COREAPP_PREVIEW_ECS_CLUSTER?.trim() || DEFAULT_ECS_CLUSTER
}

function getCoreAppPreviewService(): string {
  return process.env.COREAPP_PREVIEW_ECS_SERVICE?.trim() || DEFAULT_ECS_SERVICE
}

function getRequiredCallbackSecret(): string {
  const secret = process.env.ONESHOT_DEPLOY_WEBHOOK_SECRET?.trim()
  if (!secret) {
    throw new OneShotDeploymentError('ONESHOT_DEPLOY_WEBHOOK_SECRET is not configured', 503)
  }
  return secret
}

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}

function parseJsonObject(value: Record<string, unknown> | string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return null
    }
  }

  return value
}

function mapDeploymentRecord(row: DeploymentRow): OneShotDeploymentRecord {
  return {
    id: row.id,
    oneshotRunId: row.oneshot_run_id,
    slotName: row.slot_name,
    repoId: row.repo_id,
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    prUrl: row.pr_url,
    requestedBy: row.requested_by,
    requestedByDisplay: row.requested_by_display,
    status: row.status,
    workflowRunId: row.workflow_run_id,
    workflowUrl: row.workflow_url,
    imageUri: row.image_uri,
    taskDefinitionArn: row.task_definition_arn,
    ecsClusterName: row.ecs_cluster_name,
    ecsServiceName: row.ecs_service_name,
    previewUrl: row.preview_url,
    error: row.error,
    supersededBy: row.superseded_by,
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
    completedAt: toIsoString(row.completed_at),
  }
}

function getDeploymentLight(status: OneShotDeploymentStatus): OneShotDeploymentSummary['light'] {
  if (status === 'active') {
    return 'green'
  }
  if (INFLIGHT_DEPLOYMENT_STATUSES.includes(status)) {
    return 'amber'
  }
  return 'red'
}

function resolveImplementationIdentity(row: RunDeployContextRow): {
  implementationBranch: string | null
  implementationCommitSha: string | null
} {
  const metadata = parseJsonObject(row.implementation_metadata_json)
  const implementationBranch =
    row.current_implementation_branch
    || (typeof metadata?.implementationBranch === 'string' ? metadata.implementationBranch : null)
  const implementationCommitSha =
    row.current_implementation_commit_sha
    || (typeof metadata?.implementationCommitSha === 'string' ? metadata.implementationCommitSha : null)

  return {
    implementationBranch,
    implementationCommitSha,
  }
}

async function queryDeploymentTableExists(forceRefresh = false): Promise<boolean> {
  if (!forceRefresh && deploymentTableExistsCache === true) {
    return deploymentTableExistsCache
  }

  const [rows] = await getPool().query<Array<mysql.RowDataPacket & { table_name: string }>>(
    `SELECT TABLE_NAME AS table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [DEPLOYMENT_TABLE_NAME],
  )

  const exists = rows.length > 0
  deploymentTableExistsCache = exists ? true : null
  return exists
}

export async function isOneShotDeploymentRequestSupported(): Promise<boolean> {
  return queryDeploymentTableExists()
}

async function getDeploymentById(
  executor: mysql.Pool | mysql.PoolConnection,
  deploymentId: number,
  lockForUpdate = false,
): Promise<OneShotDeploymentRecord | null> {
  const lockClause = lockForUpdate ? ' FOR UPDATE' : ''
  const [rows] = await executor.query<DeploymentRow[]>(
    `SELECT * FROM oneshot_deployments WHERE id = ? LIMIT 1${lockClause}`,
    [deploymentId],
  )

  return rows.length > 0 ? mapDeploymentRecord(rows[0]) : null
}

async function getRunDeployContext(
  executor: mysql.Pool | mysql.PoolConnection,
  oneshotRunId: number,
): Promise<RunDeployContextRow | null> {
  const [rows] = await executor.query<RunDeployContextRow[]>(
    `SELECT
       r.id AS oneshot_run_id,
       r.jira_key,
	       r.repo_id,
	       r.state AS run_state,
	       r.final_disposition,
	       r.current_pr_url,
       r.current_implementation_branch,
       r.current_implementation_commit_sha,
       cr.repo_name,
       cr.repo_url,
       ia.metadata_json AS implementation_metadata_json
     FROM oneshot_runs r
     JOIN code_repositories cr
       ON cr.id = r.repo_id
     LEFT JOIN oneshot_artifacts ia
       ON ia.oneshot_run_id = r.id
      AND ia.stage = 'implementation'
      AND ia.version = r.current_implementation_version
     WHERE r.id = ?
     LIMIT 1
     FOR UPDATE`,
    [oneshotRunId],
  )

  return rows[0] ?? null
}

async function updateDeploymentRow(
  executor: mysql.Pool | mysql.PoolConnection,
  deploymentId: number,
  fields: DeploymentUpdateFields,
): Promise<void> {
  const setClauses = ['updated_at = NOW()']
  const values: Array<string | number | Date | null> = []

  const orderedFields: Array<keyof DeploymentUpdateFields> = [
    'status',
    'workflow_run_id',
    'workflow_url',
    'image_uri',
    'task_definition_arn',
    'preview_url',
    'error',
    'superseded_by',
    'completed_at',
  ]

  for (const field of orderedFields) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      setClauses.push(`${field} = ?`)
      values.push(fields[field] ?? null)
    }
  }

  values.push(deploymentId)

  await executor.query(
    `UPDATE oneshot_deployments
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
    values,
  )
}

export async function getLatestDeploymentsByRunIds(
  runIds: number[],
): Promise<Map<number, OneShotDeploymentRecord>> {
  if (runIds.length === 0 || !(await queryDeploymentTableExists())) {
    return new Map()
  }

  const placeholders = runIds.map(() => '?').join(', ')
  const [rows] = await getPool().query<DeploymentRow[]>(
    `SELECT d.*
     FROM oneshot_deployments d
     JOIN (
       SELECT oneshot_run_id, MAX(id) AS latest_id
       FROM oneshot_deployments
       WHERE oneshot_run_id IN (${placeholders})
       GROUP BY oneshot_run_id
     ) latest
       ON latest.latest_id = d.id`,
    runIds,
  )

  return new Map(rows.map((row) => [row.oneshot_run_id, mapDeploymentRecord(row)]))
}

export function buildDeploymentSummaryFromRecord(
  deployment: OneShotDeploymentRecord | null,
  eligible: boolean,
): OneShotDeploymentSummary {
  if (!eligible) {
    return {
      eligible: false,
      ready: false,
      light: 'grey',
      status: 'not_eligible',
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    }
  }

  if (!deployment) {
    // Eligible AND no deployment record of any kind: this is the true
    // "deploy ready" state we surface on the dashboard.
    return {
      eligible: true,
      ready: true,
      light: 'red',
      status: 'ready',
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    }
  }

  // A deployment record exists in any status (active, failed, cancelled,
  // superseded, or in-flight). Keep `eligible: true` for backward
  // compatibility, but mark `ready: false` so the dashboard no longer
  // conflates these with runs that have never been deployed.
  return {
    eligible: true,
    ready: false,
    light: getDeploymentLight(deployment.status),
    status: deployment.status,
    active: deployment.status === 'active',
    previewUrl: deployment.previewUrl,
    workflowUrl: deployment.workflowUrl,
    imageUri: deployment.imageUri,
    deployedCommitSha: deployment.commitSha,
  }
}

export async function createOneShotDeploymentRequest(
  input: CreateDeploymentRequestInput,
): Promise<OneShotDeploymentRecord> {
  if (!(await queryDeploymentTableExists())) {
    throw new OneShotDeploymentError('OneShot deployment control plane is not initialized', 503)
  }

  const connection = await getPool().getConnection()
  let deploymentId: number | null = null
  let dispatchInput: {
    oneshotRunId: number
    repoUrl: string
    branchName: string
    commitSha: string
    prUrl: string | null
  } | null = null

  try {
    await connection.beginTransaction()

    const run = await getRunDeployContext(connection, input.oneshotRunId)
    if (!run) {
      throw new OneShotDeploymentError(`OneShot run ${input.oneshotRunId} was not found`, 404)
    }

    if (run.repo_name !== CORE_APP_REPO_NAME) {
      throw new OneShotDeploymentError('Only core-app rows can be preview deployed', 400)
    }

    if (run.final_disposition !== 'completed_ready') {
      throw new OneShotDeploymentError('Run is not preview deployable until OneShot readiness is clean', 409)
    }

    const { implementationBranch, implementationCommitSha } = resolveImplementationIdentity(run)
    if (!implementationBranch || !implementationCommitSha) {
      throw new OneShotDeploymentError('Implementation branch and commit SHA are required before deploy', 409)
    }

    const [runDeploymentRows] = await connection.query<DeploymentRow[]>(
      `SELECT * FROM oneshot_deployments
       WHERE oneshot_run_id = ?
         AND status IN ('requested', 'awaiting_approval', 'building', 'pushing', 'deploying', 'active')
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [input.oneshotRunId],
    )
    if (runDeploymentRows.length > 0) {
      const existingStatus = runDeploymentRows[0].status
      throw new OneShotDeploymentError(
        existingStatus === 'active'
          ? 'This run is already active in the preview slot'
          : 'A deployment for this run is already in progress',
        409,
      )
    }

    const [inflightRows] = await connection.query<DeploymentRow[]>(
      `SELECT * FROM oneshot_deployments
       WHERE slot_name = ?
         AND status IN ('requested', 'awaiting_approval', 'building', 'pushing', 'deploying')
       LIMIT 1
       FOR UPDATE`,
      [CORE_APP_SLOT_NAME],
    )
    if (inflightRows.length > 0) {
      throw new OneShotDeploymentError('Another preview deployment is already in flight', 409)
    }

    const [result] = await connection.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_deployments (
         oneshot_run_id,
         slot_name,
         repo_id,
         branch_name,
         commit_sha,
         pr_url,
         requested_by,
         requested_by_display,
         status,
         ecs_cluster_name,
         ecs_service_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
      [
        run.oneshot_run_id,
        CORE_APP_SLOT_NAME,
        run.repo_id,
        implementationBranch,
        implementationCommitSha,
        run.current_pr_url,
        input.operator.id,
        input.operator.display,
        getCoreAppPreviewCluster(),
        getCoreAppPreviewService(),
      ],
    )

    deploymentId = result.insertId
    dispatchInput = {
      oneshotRunId: run.oneshot_run_id,
      repoUrl: run.repo_url,
      branchName: implementationBranch,
      commitSha: implementationCommitSha,
      prUrl: run.current_pr_url,
    }

    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  if (!deploymentId || !dispatchInput) {
    throw new OneShotDeploymentError('Failed to create deployment request', 500)
  }

  try {
    const dispatchResult = await dispatchCoreAppPreviewDeployment({
      deploymentId,
      oneshotRunId: dispatchInput.oneshotRunId,
      repoUrl: dispatchInput.repoUrl,
      branchName: dispatchInput.branchName,
      commitSha: dispatchInput.commitSha,
      prUrl: dispatchInput.prUrl,
      slotName: CORE_APP_SLOT_NAME,
      requestedBy: input.operator.id,
    })

    await updateDeploymentRow(getPool(), deploymentId, {
      workflow_url: dispatchResult.workflowUrl,
      error: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateDeploymentRow(getPool(), deploymentId, {
      status: 'failed',
      error: message,
      completed_at: new Date(),
    })
    throw new OneShotDeploymentError(message, 502)
  }

  const deployment = await getDeploymentById(getPool(), deploymentId)
  if (!deployment) {
    throw new OneShotDeploymentError(`Deployment ${deploymentId} disappeared after creation`, 500)
  }

  return deployment
}

export async function applyOneShotDeploymentCallback(
  input: DeploymentCallbackInput,
): Promise<OneShotDeploymentRecord> {
  if (!(await queryDeploymentTableExists())) {
    throw new OneShotDeploymentError('OneShot deployment control plane is not initialized', 503)
  }

  const connection = await getPool().getConnection()

  try {
    await connection.beginTransaction()

    const deployment = await getDeploymentById(connection, input.deploymentId, true)
    if (!deployment) {
      throw new OneShotDeploymentError(`Deployment ${input.deploymentId} was not found`, 404)
    }

    const terminal = TERMINAL_DEPLOYMENT_STATUSES.includes(input.payload.status)
    const updateFields: DeploymentUpdateFields = {
      status: input.payload.status,
      workflow_run_id: input.payload.workflowRunId ?? null,
      workflow_url: input.payload.workflowUrl ?? deployment.workflowUrl,
      image_uri: input.payload.imageUri ?? deployment.imageUri,
      task_definition_arn: input.payload.taskDefinitionArn ?? deployment.taskDefinitionArn,
      preview_url:
        input.payload.status === 'active'
          ? input.payload.previewUrl ?? getCoreAppPreviewUrl()
          : input.payload.previewUrl ?? deployment.previewUrl,
      error:
        input.payload.status === 'failed'
          ? input.payload.error || 'Preview deployment failed'
          : input.payload.error ?? null,
      completed_at: terminal ? new Date() : null,
    }

    await updateDeploymentRow(connection, deployment.id, updateFields)

    if (input.payload.status === 'active') {
      const [activeRows] = await connection.query<DeploymentRow[]>(
        `SELECT * FROM oneshot_deployments
         WHERE slot_name = ?
           AND status = 'active'
           AND id <> ?
         ORDER BY id DESC
         FOR UPDATE`,
        [deployment.slotName, deployment.id],
      )

      for (const activeRow of activeRows) {
        await updateDeploymentRow(connection, activeRow.id, {
          status: 'superseded',
          superseded_by: deployment.id,
          completed_at: new Date(),
          error: null,
        })
      }
    }

    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }

  const updated = await getDeploymentById(getPool(), input.deploymentId)
  if (!updated) {
    throw new OneShotDeploymentError(`Deployment ${input.deploymentId} disappeared after callback`, 500)
  }

  return updated
}

export function verifyOneShotDeploymentCallbackSecret(secretHeader: string | null | undefined): void {
  const expected = getRequiredCallbackSecret()
  if (!secretHeader || secretHeader !== expected) {
    throw new OneShotDeploymentError('Invalid OneShot deployment callback secret', 403)
  }
}
