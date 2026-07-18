import { createHash } from 'crypto'
import type {
  DispatchCoreAppPreviewDeployInput,
  DispatchCoreAppPreviewDeployResult,
} from '../types/oneshotDeployments.js'

function getRequiredDispatchToken(): string {
  const token = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN?.trim()
  if (!token) {
    throw new Error('GITHUB_ACTIONS_DISPATCH_TOKEN is required for preview workflow dispatch')
  }
  return token
}

function getGitHubApiBaseUrl(): string {
  return process.env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com'
}

function getWorkflowOwner(): string {
  return process.env.GITHUB_ACTIONS_REPO_OWNER?.trim() || 'mhk-repos'
}

function getWorkflowRepo(): string {
  return process.env.GITHUB_ACTIONS_REPO_NAME?.trim() || 'cp-autonomous-ai-agents-platform'
}

function getWorkflowRef(): string {
  return process.env.GITHUB_ACTIONS_DISPATCH_REF?.trim() || 'main'
}

function getWorkflowId(): string {
  return process.env.COREAPP_PREVIEW_WORKFLOW_ID?.trim() || 'coreapp-preview-deploy.yml'
}

function getWorkflowUrl(owner: string, repo: string, workflowId: string): string {
  return `https://github.com/${owner}/${repo}/actions/workflows/${workflowId}`
}

function buildIdempotencyKey(input: DispatchCoreAppPreviewDeployInput): string {
  return createHash('sha256')
    .update(`${input.deploymentId}:${input.commitSha}:${input.branchName}`)
    .digest('hex')
}

export async function dispatchCoreAppPreviewDeployment(
  input: DispatchCoreAppPreviewDeployInput,
): Promise<DispatchCoreAppPreviewDeployResult> {
  const owner = getWorkflowOwner()
  const repo = getWorkflowRepo()
  const workflowId = getWorkflowId()
  const workflowUrl = getWorkflowUrl(owner, repo, workflowId)

  const response = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${getRequiredDispatchToken()}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: getWorkflowRef(),
        inputs: {
          deployment_id: String(input.deploymentId),
          oneshot_run_id: String(input.oneshotRunId),
          repo_url: input.repoUrl,
          branch_name: input.branchName,
          commit_sha: input.commitSha,
          pr_url: input.prUrl ?? '',
          slot_name: input.slotName,
          requested_by: input.requestedBy,
          idempotency_key: buildIdempotencyKey(input),
        },
      }),
    },
  )

  if (response.status !== 204) {
    const payload = await response.text().catch(() => '')
    throw new Error(
      `GitHub workflow dispatch failed with status ${response.status}${payload ? `: ${payload}` : ''}`,
    )
  }

  return { workflowUrl }
}
