import type { OneShotDeploymentStatus } from './oneshot.js'

export interface OperatorIdentity {
  id: string
  display: string
}

export interface CreateOneShotDeploymentRequestBody {
  oneshotRunId: number
}

export interface OneShotDeploymentCallbackBody {
  status: Exclude<OneShotDeploymentStatus, 'requested' | 'superseded'>
  workflowRunId?: number | null
  workflowUrl?: string | null
  imageUri?: string | null
  taskDefinitionArn?: string | null
  previewUrl?: string | null
  error?: string | null
}

export interface OneShotDeploymentRecord {
  id: number
  oneshotRunId: number
  slotName: string
  repoId: number
  branchName: string
  commitSha: string
  prUrl: string | null
  requestedBy: string | null
  requestedByDisplay: string | null
  status: OneShotDeploymentStatus
  workflowRunId: number | null
  workflowUrl: string | null
  imageUri: string | null
  taskDefinitionArn: string | null
  ecsClusterName: string
  ecsServiceName: string
  previewUrl: string | null
  error: string | null
  supersededBy: number | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface DispatchCoreAppPreviewDeployInput {
  deploymentId: number
  oneshotRunId: number
  repoUrl: string
  branchName: string
  commitSha: string
  prUrl: string | null
  slotName: string
  requestedBy: string
}

export interface DispatchCoreAppPreviewDeployResult {
  workflowUrl: string
}
