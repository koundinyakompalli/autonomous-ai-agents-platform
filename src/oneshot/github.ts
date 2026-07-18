import { createLogger } from '../utils/logger.js'
import { getGitHubCommandToken, getGitHubWriteToken } from './github-app-auth.js'

const logger = createLogger('oneshot-github')

export interface GitHubRepoRef {
  owner: string
  repo: string
}

export interface GitHubRepositoryMetadata extends GitHubRepoRef {
  fullName: string
  htmlUrl: string
  cloneUrl: string
  description: string | null
  defaultBranch: string | null
}

export interface GitHubRequestOptions {
  timeoutMs?: number
}

export interface CreateDraftPullRequestInput {
  owner: string
  repo: string
  title: string
  head: string
  base: string
  body: string
  draft?: boolean
}

export interface CreatedPullRequest {
  number: number
  url: string
  htmlUrl: string
  draft: boolean | null
  nodeId: string | null
  headSha: string | null
  draftSyncError?: string | null
  updateSyncError?: string | null
}

export interface GitHubCommitStatusSummary {
  state: 'success' | 'failure' | 'error' | 'pending' | 'unavailable' | 'unconfigured'
  description: string
  targetUrl?: string | null
  statusCount?: number
  checkRunCount?: number
  requiredCheckState?: 'none' | 'present' | 'unavailable'
  details?: string[]
}

export interface GitHubPullRequestForCommand extends GitHubRepoRef {
  pullNumber: number
  state: 'open' | 'closed' | 'unknown'
  htmlUrl: string
  headRef: string | null
  headSha: string | null
  baseRef: string | null
  draft: boolean | null
}

export interface GitHubPullRequestCommit {
  sha: string
  message: string
  htmlUrl: string | null
}

export interface GitHubPullRequestSearchResult extends GitHubRepoRef {
  pullNumber: number
  htmlUrl: string
  title: string
  state: 'open' | 'closed' | 'unknown'
}

export interface GitHubIssueCommentResult {
  id: string
  url: string
  htmlUrl: string
}

export interface GitHubCommandStatusEvidence {
  context: string
  state: string
  description: string | null
  targetUrl: string | null
}

export interface GitHubCommandCheckRunEvidence {
  name: string
  status: string
  conclusion: string | null
  htmlUrl: string | null
  outputSummary: string | null
  logSnippet: string | null
}

export interface GitHubPullRequestCommandEvidence {
  state: GitHubCommitStatusSummary['state']
  description: string
  statuses: GitHubCommandStatusEvidence[]
  checkRuns: GitHubCommandCheckRunEvidence[]
}

interface GitHubPullRequestPayload {
  number?: unknown
  url?: unknown
  html_url?: unknown
  draft?: unknown
  node_id?: unknown
  merged?: unknown
  merged_at?: unknown
  head?: unknown
}

interface GitHubCombinedStatusPayload {
  state?: unknown
  total_count?: unknown
  statuses?: unknown
}

interface GitHubCheckRunsPayload {
  total_count?: unknown
  check_runs?: unknown
}

interface GitHubIssueCommentPayload {
  id?: unknown
  url?: unknown
  html_url?: unknown
  message?: unknown
}

interface GitHubBranchProtectionPayload {
  contexts?: unknown
  checks?: unknown
}

interface GitHubGraphQlPayload {
  data?: unknown
  errors?: unknown
}

interface ParsedCiContextSummary {
  state: GitHubCommitStatusSummary['state']
  statusCount: number
  checkRunCount: number
  details: string[]
  targetUrl?: string | null
}

export interface MergedPullRequestDetails {
  owner: string
  repo: string
  pullNumber: number
  htmlUrl: string
  files: string[]
}

function toCreatedPullRequest(payload: GitHubPullRequestPayload): CreatedPullRequest {
  return {
    number: Number(payload.number),
    url: String(payload.url),
    htmlUrl: String(payload.html_url),
    draft: typeof payload.draft === 'boolean' ? payload.draft : null,
    nodeId: typeof payload.node_id === 'string' ? payload.node_id : null,
    headSha: typeof (payload.head as { sha?: unknown } | undefined)?.sha === 'string'
      ? String((payload.head as { sha: string }).sha)
      : null,
  }
}

function githubMutationsDisabled(): boolean {
  return process.env.ONESHOT_DISABLE_GITHUB_MUTATIONS?.toLowerCase() === 'true'
}

async function getRequiredGitHubWriteToken(scope: GitHubRepoRef): Promise<string> {
  if (githubMutationsDisabled()) {
    throw new Error('GitHub mutation is disabled by ONESHOT_DISABLE_GITHUB_MUTATIONS')
  }
  return getGitHubWriteToken(scope)
}

function getGitHubReadToken(): string | null {
  return (
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GITHUB_REPO_TOKEN?.trim() ||
    process.env.GITHUB_WRITE_TOKEN?.trim() ||
    null
  )
}

function getGitHubApiBaseUrl(): string {
  return process.env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com'
}

export function parseGitHubRepoUrl(repoUrl: string): GitHubRepoRef {
  const normalized = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i)
  if (!match) {
    throw new Error(`Unsupported GitHub repository URL: ${repoUrl}`)
  }

  return {
    owner: match[1],
    repo: match[2],
  }
}

export function parseGitHubRepoRef(value: string): GitHubRepoRef {
  const normalized = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (!match) {
    throw new Error(`Unsupported GitHub repository reference: ${value}`)
  }

  return {
    owner: match[1],
    repo: match[2],
  }
}

export async function fetchGitHubRepositoryMetadata(
  owner: string,
  repo: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubRepositoryMetadata | null> {
  const token = getGitHubReadToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers },
    options.timeoutMs,
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `GitHub repository lookup failed for ${owner}/${repo}: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
    )
  }

  const payload = (await response.json()) as Record<string, unknown>
  const fullName =
    typeof payload.full_name === 'string'
      ? payload.full_name
      : `${owner}/${repo}`
  const cloneUrl =
    typeof payload.clone_url === 'string'
      ? payload.clone_url
      : `https://github.com/${fullName}.git`
  const htmlUrl =
    typeof payload.html_url === 'string'
      ? payload.html_url
      : `https://github.com/${fullName}`

  return {
    owner,
    repo: typeof payload.name === 'string' ? payload.name : repo,
    fullName,
    htmlUrl,
    cloneUrl,
    description:
      typeof payload.description === 'string' ? payload.description : null,
    defaultBranch:
      typeof payload.default_branch === 'string'
        ? payload.default_branch
        : null,
  }
}

export async function searchGitHubRepositoriesByName(
  owner: string,
  query: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubRepositoryMetadata[]> {
  const token = getGitHubReadToken()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const params = new URLSearchParams({
    q: `${query} org:${owner} in:name`,
    per_page: '5',
  })
  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/search/repositories?${params.toString()}`,
    { headers },
    options.timeoutMs,
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `GitHub repository search failed for ${owner}/${query}: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
    )
  }

  const payload = (await response.json()) as Record<string, unknown>
  const items = Array.isArray(payload.items) ? payload.items : []
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const repo = item as Record<string, unknown>
      const fullName = typeof repo.full_name === 'string' ? repo.full_name : null
      const name = typeof repo.name === 'string' ? repo.name : null
      if (!fullName || !name) {
        return null
      }
      return {
        owner,
        repo: name,
        fullName,
        htmlUrl:
          typeof repo.html_url === 'string'
            ? repo.html_url
            : `https://github.com/${fullName}`,
        cloneUrl:
          typeof repo.clone_url === 'string'
            ? repo.clone_url
            : `https://github.com/${fullName}.git`,
        description:
          typeof repo.description === 'string' ? repo.description : null,
        defaultBranch:
          typeof repo.default_branch === 'string'
            ? repo.default_branch
            : null,
      } satisfies GitHubRepositoryMetadata
    })
    .filter((item): item is GitHubRepositoryMetadata => Boolean(item))
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, init)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  // Node 20+ supports composing caller cancellation with the local timeout.
  // If unavailable, preserve the existing caller-signal-wins behavior.
  const signal =
    init.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal, controller.signal])
      : init.signal ?? controller.signal
  try {
    return await fetch(url, {
      ...init,
      signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

export function parseGitHubPullRequestUrl(prUrl: string): GitHubRepoRef & { pullNumber: number } {
  const trimmed = prUrl.trim()
  const webMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i)
  if (webMatch) {
    return {
      owner: webMatch[1],
      repo: webMatch[2],
      pullNumber: Number(webMatch[3]),
    }
  }

  const apiMatch = trimmed.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:[/?#].*)?$/i)
  if (apiMatch) {
    return {
      owner: apiMatch[1],
      repo: apiMatch[2],
      pullNumber: Number(apiMatch[3]),
    }
  }

  throw new Error(`Unsupported GitHub pull request URL: ${prUrl}`)
}

async function getGitHubCommandHeaders(scope: GitHubRepoRef): Promise<Record<string, string>> {
  const token = await getGitHubCommandToken(scope)
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function normalizeEvidenceText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const redacted = value
    .replace(/\b(token|secret|password|passwd|authorization)\s*[:=]\s*[^\s"'`]+/gi, '$1=[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [REDACTED]')
  return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted
}

function mapPullRequestForCommand(
  owner: string,
  repo: string,
  pullNumber: number,
  payload: GitHubPullRequestPayload,
): GitHubPullRequestForCommand {
  const head = payload.head && typeof payload.head === 'object'
    ? payload.head as Record<string, unknown>
    : {}
  const base = (payload as unknown as { base?: unknown }).base
  const baseObject = base && typeof base === 'object'
    ? base as Record<string, unknown>
    : {}
  return {
    owner,
    repo,
    pullNumber,
    state:
      typeof (payload as unknown as { state?: unknown }).state === 'string' &&
      ((payload as unknown as { state: string }).state === 'open' ||
        (payload as unknown as { state: string }).state === 'closed')
        ? (payload as unknown as { state: 'open' | 'closed' }).state
        : 'unknown',
    htmlUrl: typeof payload.html_url === 'string'
      ? payload.html_url
      : `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
    headRef: typeof head.ref === 'string' ? head.ref : null,
    headSha: typeof head.sha === 'string' ? head.sha : null,
    baseRef: typeof baseObject.ref === 'string' ? baseObject.ref : null,
    draft: typeof payload.draft === 'boolean' ? payload.draft : null,
  }
}

export async function fetchPullRequestForCommand(input: {
  owner: string
  repo: string
  pullNumber: number
  timeoutMs?: number
}): Promise<GitHubPullRequestForCommand> {
  const headers = await getGitHubCommandHeaders(input)
  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}`,
    { headers },
    input.timeoutMs,
  )
  const payload = await response.json().catch(() => ({})) as GitHubPullRequestPayload & { message?: unknown }
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? `: ${payload.message}` : ''
    throw new Error(`GitHub pull request lookup failed with status ${response.status}${message}`)
  }
  return mapPullRequestForCommand(input.owner, input.repo, input.pullNumber, payload)
}

export async function fetchPullRequestCommits(input: {
  owner: string
  repo: string
  pullNumber: number
  timeoutMs?: number
}): Promise<GitHubPullRequestCommit[]> {
  const token = getGitHubReadToken()
  if (!token) {
    throw new Error('GitHub read token is not configured')
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const commits: GitHubPullRequestCommit[] = []
  for (let page = 1; page <= 10; page++) {
    const response = await fetchWithTimeout(
      `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/commits?per_page=100&page=${page}`,
      { headers },
      input.timeoutMs,
    )
    const payload = await response.json().catch(() => ([])) as unknown
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && !Array.isArray(payload) &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? `: ${(payload as { message: string }).message}`
          : ''
      throw new Error(`GitHub pull request commits lookup failed with status ${response.status}${message}`)
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      break
    }
    for (const item of payload) {
      const commit = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {}
      const sha = typeof commit.sha === 'string' ? commit.sha : ''
      const nestedCommit = commit.commit && typeof commit.commit === 'object' && !Array.isArray(commit.commit)
        ? commit.commit as Record<string, unknown>
        : {}
      const message = typeof nestedCommit.message === 'string'
        ? nestedCommit.message.split('\n')[0] ?? ''
        : ''
      const htmlUrl = typeof commit.html_url === 'string' ? commit.html_url : null
      if (sha) {
        commits.push({ sha, message: message || sha, htmlUrl })
      }
    }
    if (payload.length < 100) {
      break
    }
  }
  return commits
}

export async function fetchPullRequestFiles(input: {
  owner: string
  repo: string
  pullNumber: number
  timeoutMs?: number
}): Promise<string[]> {
  const token = getGitHubReadToken()
  if (!token) {
    throw new Error('GitHub read token is not configured')
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const files: string[] = []
  for (let page = 1; page <= 10; page++) {
    const response = await fetchWithTimeout(
      `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/files?per_page=100&page=${page}`,
      { headers },
      input.timeoutMs,
    )
    const payload = await response.json().catch(() => ([])) as unknown
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && !Array.isArray(payload) &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? `: ${(payload as { message: string }).message}`
          : ''
      throw new Error(`GitHub pull request files lookup failed with status ${response.status}${message}`)
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      break
    }
    for (const item of payload) {
      const record = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {}
      const filename = typeof record.filename === 'string' ? record.filename.trim() : ''
      if (filename) {
        files.push(filename)
      }
    }
    if (payload.length < 100) {
      break
    }
  }
  return Array.from(new Set(files))
}

export async function fetchPullRequestsForCommit(input: {
  owner: string
  repo: string
  sha: string
  timeoutMs?: number
}): Promise<GitHubPullRequestForCommand[]> {
  const token = getGitHubReadToken()
  if (!token) {
    throw new Error('GitHub read token is not configured')
  }
  const headers = {
    Accept: 'application/vnd.github.groot-preview+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(input.sha)}/pulls`,
    { headers },
    input.timeoutMs,
  )
  const payload = await response.json().catch(() => ([])) as unknown
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && !Array.isArray(payload) &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? `: ${(payload as { message: string }).message}`
        : ''
    throw new Error(`GitHub commit pull request lookup failed with status ${response.status}${message}`)
  }
  if (!Array.isArray(payload)) {
    return []
  }
  return payload
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null
      }
      const record = item as GitHubPullRequestPayload
      const number = Number(record.number)
      if (!Number.isFinite(number) || number <= 0) {
        return null
      }
      return mapPullRequestForCommand(input.owner, input.repo, number, record)
    })
    .filter((item): item is GitHubPullRequestForCommand => Boolean(item))
}

export async function searchMergedPullRequestsByJiraKey(input: {
  owner: string
  repo: string
  jiraKey: string
  timeoutMs?: number
}): Promise<GitHubPullRequestSearchResult[]> {
  const token = getGitHubReadToken()
  if (!token) {
    throw new Error('GitHub read token is not configured')
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const params = new URLSearchParams({
    q: [
      `repo:${input.owner}/${input.repo}`,
      'is:pr',
      'is:merged',
      input.jiraKey,
      'in:title,body',
    ].join(' '),
    sort: 'updated',
    order: 'desc',
    per_page: '10',
  })
  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/search/issues?${params.toString()}`,
    { headers },
    input.timeoutMs,
  )
  const payload = await response.json().catch(() => ({})) as unknown
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && !Array.isArray(payload) &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? `: ${(payload as { message: string }).message}`
        : ''
    throw new Error(`GitHub merged pull request search failed with status ${response.status}${message}`)
  }
  const items = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { items?: unknown }).items
    : []
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null
      }
      const record = item as Record<string, unknown>
      const htmlUrl = typeof record.html_url === 'string' ? record.html_url : ''
      if (!htmlUrl) {
        return null
      }
      try {
        const parsed = parseGitHubPullRequestUrl(htmlUrl)
        if (
          parsed.owner.toLowerCase() !== input.owner.toLowerCase() ||
          parsed.repo.toLowerCase() !== input.repo.toLowerCase()
        ) {
          return null
        }
        const state =
          record.state === 'open' || record.state === 'closed'
            ? record.state
            : 'unknown'
        return {
          owner: parsed.owner,
          repo: parsed.repo,
          pullNumber: parsed.pullNumber,
          htmlUrl,
          title: typeof record.title === 'string' ? record.title : '',
          state,
        }
      } catch {
        return null
      }
    })
    .filter((item): item is GitHubPullRequestSearchResult => Boolean(item))
}

export async function fetchRepositoryPermissionForUser(input: {
  owner: string
  repo: string
  username: string
  timeoutMs?: number
}): Promise<string> {
  const headers = await getGitHubCommandHeaders(input)
  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/collaborators/${encodeURIComponent(input.username)}/permission`,
    { headers },
    input.timeoutMs,
  )
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (response.status === 404) {
    return 'none'
  }
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? `: ${payload.message}` : ''
    throw new Error(`GitHub collaborator permission lookup failed with status ${response.status}${message}`)
  }
  return typeof payload.permission === 'string' ? payload.permission : 'unknown'
}

export async function postIssueComment(input: {
  owner: string
  repo: string
  issueNumber: number
  body: string
  timeoutMs?: number
}): Promise<GitHubIssueCommentResult> {
  if (githubMutationsDisabled()) {
    throw new Error('GitHub mutation is disabled by ONESHOT_DISABLE_GITHUB_MUTATIONS')
  }
  const headers = {
    ...(await getGitHubCommandHeaders(input)),
    'Content-Type': 'application/json',
  }
  const response = await fetchWithTimeout(
    `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: input.body }),
    },
    input.timeoutMs,
  )
  const payload = await response.json().catch(() => ({})) as GitHubIssueCommentPayload
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? `: ${payload.message}` : ''
    throw new Error(`GitHub issue comment create failed with status ${response.status}${message}`)
  }
  return {
    id: String(payload.id ?? ''),
    url: typeof payload.url === 'string' ? payload.url : '',
    htmlUrl: typeof payload.html_url === 'string' ? payload.html_url : '',
  }
}

function parseGitHubActionsJobId(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const match = value.match(/\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#].*)?$/)
  return match?.[1] ?? null
}

async function fetchActionJobLogSnippet(input: {
  owner: string
  repo: string
  jobId: string
  headers: Record<string, string>
}): Promise<string | null> {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/jobs/${input.jobId}/logs`,
    { headers: input.headers },
  )
  if (!response.ok) {
    return null
  }
  const text = await response.text().catch(() => '')
  return normalizeEvidenceText(text, 2000)
}

export async function fetchPullRequestCommandEvidence(input: {
  owner: string
  repo: string
  ref: string
  pullNumber?: number | null
}): Promise<GitHubPullRequestCommandEvidence> {
  const headers = await getGitHubCommandHeaders(input)
  const [statusResponse, checkRunsResponse] = await Promise.all([
    fetch(`${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(input.ref)}/status`, { headers }),
    fetch(`${getGitHubApiBaseUrl()}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits/${encodeURIComponent(input.ref)}/check-runs?per_page=50`, { headers }),
  ])
  const statusPayload = await statusResponse.json().catch(() => ({})) as GitHubCombinedStatusPayload
  const checkRunsPayload = await checkRunsResponse.json().catch(() => ({})) as GitHubCheckRunsPayload

  const rawStatuses = Array.isArray(statusPayload.statuses) ? statusPayload.statuses : []
  const statuses = rawStatuses
    .slice(0, 8)
    .map((status): GitHubCommandStatusEvidence | null => {
      if (!status || typeof status !== 'object') {
        return null
      }
      const raw = status as Record<string, unknown>
      return {
        context: typeof raw.context === 'string' ? raw.context : 'status',
        state: typeof raw.state === 'string' ? raw.state : 'unknown',
        description: normalizeEvidenceText(raw.description, 500),
        targetUrl: typeof raw.target_url === 'string' ? raw.target_url : null,
      }
    })
    .filter((status): status is GitHubCommandStatusEvidence => Boolean(status))

  const rawCheckRuns = Array.isArray(checkRunsPayload.check_runs) ? checkRunsPayload.check_runs : []
  const checkRuns: GitHubCommandCheckRunEvidence[] = []
  for (const raw of rawCheckRuns.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const checkRun = raw as Record<string, unknown>
    const output = checkRun.output && typeof checkRun.output === 'object'
      ? checkRun.output as Record<string, unknown>
      : {}
    const status = typeof checkRun.status === 'string' ? checkRun.status : 'unknown'
    const conclusion = typeof checkRun.conclusion === 'string' ? checkRun.conclusion : null
    const htmlUrl = typeof checkRun.html_url === 'string' ? checkRun.html_url : null
    const detailsUrl = typeof checkRun.details_url === 'string' ? checkRun.details_url : null
    const failed =
      conclusion === 'failure' ||
      conclusion === 'timed_out' ||
      conclusion === 'cancelled' ||
      conclusion === 'action_required'
    const jobId = failed
      ? parseGitHubActionsJobId(detailsUrl) ?? parseGitHubActionsJobId(htmlUrl)
      : null
    const logSnippet = jobId
      ? await fetchActionJobLogSnippet({
          owner: input.owner,
          repo: input.repo,
          jobId,
          headers,
        })
      : null
    checkRuns.push({
      name: typeof checkRun.name === 'string' ? checkRun.name : 'check',
      status,
      conclusion,
      htmlUrl,
      outputSummary: normalizeEvidenceText(output.summary, 2000),
      logSnippet,
    })
  }

  const rawState = typeof statusPayload.state === 'string' ? statusPayload.state : 'unavailable'
  const hasFailedCheck = checkRuns.some((check) =>
    check.conclusion === 'failure' ||
    check.conclusion === 'timed_out' ||
    check.conclusion === 'cancelled' ||
    check.conclusion === 'action_required')
  const hasPendingCheck = checkRuns.some((check) => check.status !== 'completed')
  const state: GitHubCommitStatusSummary['state'] =
    rawState === 'failure' || rawState === 'error' || hasFailedCheck
      ? rawState === 'error' ? 'error' : 'failure'
      : rawState === 'pending' || hasPendingCheck
        ? 'pending'
        : rawState === 'success'
          ? 'success'
          : 'unavailable'
  const description =
    state === 'failure'
      ? `GitHub CI is failing across ${statuses.length} status check(s) and ${checkRuns.length} check run(s).`
      : state === 'pending'
        ? `GitHub CI is pending across ${statuses.length} status check(s) and ${checkRuns.length} check run(s).`
        : state === 'success'
          ? `GitHub CI is passing across ${statuses.length} status check(s) and ${checkRuns.length} check run(s).`
          : 'GitHub CI evidence is unavailable.'

  return {
    state,
    description,
    statuses,
    checkRuns,
  }
}

export async function fetchMergedPullRequestDetails(
  prUrl: string,
): Promise<MergedPullRequestDetails | null> {
  const token = getGitHubReadToken()
  if (!token) {
    logger.debug('Skipping merged PR learning lookup because no GitHub read token is configured')
    return null
  }

  const parsed = parseGitHubPullRequestUrl(prUrl)
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const prResponse = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}`,
    { headers },
  )
  const prPayload = await prResponse.json().catch(() => ({}))
  if (!prResponse.ok) {
    logger.warn( {
      owner: parsed.owner,
      repo: parsed.repo,
      pullNumber: parsed.pullNumber,
      status: prResponse.status,
      payload: prPayload,
    },'Failed to query OneShot pull request merge status')
    throw new Error(`GitHub pull request lookup failed with status ${prResponse.status}`)
  }

  const pr = prPayload as GitHubPullRequestPayload
  if (pr.merged !== true && !pr.merged_at) {
    return null
  }

  const files: string[] = []
  for (let page = 1; page <= 3; page++) {
    const filesResponse = await fetch(
      `${getGitHubApiBaseUrl()}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}/files?per_page=100&page=${page}`,
      { headers },
    )
    const filesPayload = await filesResponse.json().catch(() => ([]))
    if (!filesResponse.ok) {
      logger.warn( {
        owner: parsed.owner,
        repo: parsed.repo,
        pullNumber: parsed.pullNumber,
        status: filesResponse.status,
        payload: filesPayload,
      },'Failed to query OneShot pull request files for learning')
      break
    }
    if (!Array.isArray(filesPayload) || filesPayload.length === 0) {
      break
    }
    for (const file of filesPayload) {
      const filename = (file as { filename?: unknown }).filename
      if (typeof filename === 'string' && filename.trim()) {
        files.push(filename.trim())
      }
    }
    if (filesPayload.length < 100) {
      break
    }
  }

  return {
    owner: parsed.owner,
    repo: parsed.repo,
    pullNumber: parsed.pullNumber,
    htmlUrl: typeof pr.html_url === 'string' ? pr.html_url : prUrl,
    files,
  }
}

export async function fetchCommitStatusSummary(input: {
  owner: string
  repo: string
  ref: string
  base?: string | null
  pullNumber?: number | null
}): Promise<GitHubCommitStatusSummary> {
  const token = getGitHubReadToken()
  if (!token) {
    return {
      state: 'unconfigured',
      description: 'GitHub read token is not configured; CI status was not checked.',
      statusCount: 0,
      checkRunCount: 0,
      requiredCheckState: 'unavailable',
      details: ['missing read token'],
    }
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const response = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${input.owner}/${input.repo}/commits/${input.ref}/status`,
    { headers },
  )
  const payload = await response.json().catch(() => ({})) as GitHubCombinedStatusPayload
  if (!response.ok) {
    logger.warn( {
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      status: response.status,
      payload,
    },'Failed to query OneShot branch CI status')
    return {
      state: 'unavailable',
      description: `GitHub CI status lookup failed with status ${response.status}.`,
      statusCount: 0,
      checkRunCount: 0,
      requiredCheckState: 'unavailable',
      details: [`combined status HTTP ${response.status}`],
    }
  }

  const rawState = typeof payload.state === 'string' ? payload.state : 'unavailable'
  let state: GitHubCommitStatusSummary['state'] =
    rawState === 'success' ||
    rawState === 'failure' ||
    rawState === 'error' ||
    rawState === 'pending'
      ? rawState
      : 'unavailable'
  const statuses = Array.isArray(payload.statuses) ? payload.statuses : []
  const firstTargetUrl = statuses
    .map((status) => {
      if (!status || typeof status !== 'object') {
        return null
      }
      const targetUrl = (status as { target_url?: unknown }).target_url
      return typeof targetUrl === 'string' ? targetUrl : null
    })
    .find((targetUrl): targetUrl is string => Boolean(targetUrl))
  const totalCount = typeof payload.total_count === 'number'
    ? payload.total_count
    : statuses.length
  if (totalCount === 0 && state === 'pending') {
    state = 'success'
  }

  const checkRunsResponse = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${input.owner}/${input.repo}/commits/${input.ref}/check-runs?per_page=100`,
    { headers },
  )
  const checkRunsPayload = await checkRunsResponse.json().catch(() => ({})) as GitHubCheckRunsPayload
  if (!checkRunsResponse.ok) {
    logger.warn( {
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      status: checkRunsResponse.status,
      payload: checkRunsPayload,
    },'Failed to query OneShot branch check runs')
    return {
      state: 'unavailable',
      description: `GitHub check-run lookup failed with status ${checkRunsResponse.status}.`,
      statusCount: totalCount,
      checkRunCount: 0,
      requiredCheckState: 'unavailable',
      targetUrl: firstTargetUrl ?? null,
      details: [`check-runs HTTP ${checkRunsResponse.status}`],
    }
  }

  const rawCheckRuns = Array.isArray(checkRunsPayload.check_runs)
    ? checkRunsPayload.check_runs
    : []
  const checkRunCount = typeof checkRunsPayload.total_count === 'number'
    ? checkRunsPayload.total_count
    : rawCheckRuns.length
  const checkRunDetails: string[] = []
  let hasFailingCheckRun = false
  let hasPendingCheckRun = false
  for (const raw of rawCheckRuns) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const checkRun = raw as {
      name?: unknown
      status?: unknown
      conclusion?: unknown
      html_url?: unknown
    }
    const name = typeof checkRun.name === 'string' ? checkRun.name : 'unnamed check'
    const status = typeof checkRun.status === 'string' ? checkRun.status : 'unknown'
    const conclusion = typeof checkRun.conclusion === 'string' ? checkRun.conclusion : null
    checkRunDetails.push(`${name}: ${conclusion ?? status}`)
    if (status !== 'completed') {
      hasPendingCheckRun = true
      continue
    }
    if (
      conclusion === 'failure' ||
      conclusion === 'timed_out' ||
      conclusion === 'cancelled' ||
      conclusion === 'action_required'
    ) {
      hasFailingCheckRun = true
    }
  }

  const requiredCheckState = await fetchRequiredCheckState({
    owner: input.owner,
    repo: input.repo,
    base: input.base ?? null,
    headers,
  })

  const details = [
    `combined_status:${state}:${totalCount}`,
    ...checkRunDetails.slice(0, 8),
    `required_checks:${requiredCheckState}`,
  ]

  let commitSummary: GitHubCommitStatusSummary
  if (state === 'failure' || state === 'error' || hasFailingCheckRun) {
    commitSummary = {
      state: state === 'error' ? 'error' : 'failure',
      description: `GitHub CI is failing across ${totalCount} status check(s) and ${checkRunCount} check run(s).`,
      targetUrl: firstTargetUrl ?? null,
      statusCount: totalCount,
      checkRunCount,
      requiredCheckState,
      details,
    }
  } else if (state === 'pending' || hasPendingCheckRun) {
    commitSummary = {
      state: 'pending',
      description: `GitHub CI is pending across ${totalCount} status check(s) and ${checkRunCount} check run(s).`,
      targetUrl: firstTargetUrl ?? null,
      statusCount: totalCount,
      checkRunCount,
      requiredCheckState,
      details,
    }
  } else if (totalCount === 0 && checkRunCount === 0) {
    if (requiredCheckState === 'none') {
      commitSummary = {
        state: 'success',
        description: 'No GitHub CI checks were reported and branch protection confirms no required checks.',
        targetUrl: null,
        statusCount: 0,
        checkRunCount: 0,
        requiredCheckState,
        details,
      }
    } else {
      commitSummary = {
        state: 'unavailable',
        description: 'No GitHub CI checks were reported and required-check configuration could not confirm this is safe.',
        targetUrl: null,
        statusCount: 0,
        checkRunCount: 0,
        requiredCheckState,
        details,
      }
    }
  } else {
    const finalState: GitHubCommitStatusSummary['state'] =
      checkRunCount > 0 && state === 'unavailable' ? 'success' : state
    commitSummary = {
      state: finalState,
      description:
        `GitHub CI is ${finalState} across ${totalCount} status check(s) and ${checkRunCount} check run(s).`,
      targetUrl: firstTargetUrl ?? null,
      statusCount: totalCount,
      checkRunCount,
      requiredCheckState,
      details,
    }
  }

  if (!input.pullNumber) {
    return commitSummary
  }

  const pullRequestSummary = await fetchPullRequestStatusCheckRollup({
    owner: input.owner,
    repo: input.repo,
    pullNumber: input.pullNumber,
    requiredCheckState,
    headers,
  })
  return combineCiStatusSummaries(commitSummary, pullRequestSummary)
}

function normalizeStatusState(value: unknown): GitHubCommitStatusSummary['state'] {
  const normalized = typeof value === 'string' ? value.toLowerCase() : ''
  if (normalized === 'success') {
    return 'success'
  }
  if (normalized === 'failure') {
    return 'failure'
  }
  if (normalized === 'error') {
    return 'error'
  }
  if (normalized === 'pending' || normalized === 'expected') {
    return 'pending'
  }
  return 'unavailable'
}

function normalizeCheckRunConclusion(input: {
  status: unknown
  conclusion: unknown
}): GitHubCommitStatusSummary['state'] {
  const status = typeof input.status === 'string' ? input.status.toLowerCase() : ''
  if (status && status !== 'completed') {
    return 'pending'
  }
  const conclusion = typeof input.conclusion === 'string' ? input.conclusion.toLowerCase() : ''
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
    return 'success'
  }
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled' || conclusion === 'action_required') {
    return 'failure'
  }
  if (conclusion) {
    return 'unavailable'
  }
  return status === 'completed' ? 'success' : 'unavailable'
}

function aggregateContextState(states: GitHubCommitStatusSummary['state'][]): GitHubCommitStatusSummary['state'] {
  if (states.includes('unconfigured')) {
    return 'unconfigured'
  }
  if (states.includes('error')) {
    return 'error'
  }
  if (states.includes('failure')) {
    return 'failure'
  }
  if (states.includes('pending')) {
    return 'pending'
  }
  if (states.includes('unavailable')) {
    return 'unavailable'
  }
  return 'success'
}

function parseStatusCheckRollupContexts(rawNodes: unknown): ParsedCiContextSummary {
  const nodes = Array.isArray(rawNodes) ? rawNodes : []
  let statusCount = 0
  let checkRunCount = 0
  let targetUrl: string | null = null
  const details: string[] = []
  const states: GitHubCommitStatusSummary['state'][] = []

  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const node = raw as Record<string, unknown>
    const typeName = typeof node.__typename === 'string' ? node.__typename : ''
    if (typeName === 'CheckRun') {
      checkRunCount += 1
      const name = typeof node.name === 'string' && node.name.trim() ? node.name : 'unnamed check'
      const status = typeof node.status === 'string' ? node.status : 'UNKNOWN'
      const conclusion = typeof node.conclusion === 'string' ? node.conclusion : null
      const state = normalizeCheckRunConclusion({
        status,
        conclusion,
      })
      states.push(state)
      details.push(`pull_request_check:${name}:${conclusion ?? status}`)
      if (!targetUrl && typeof node.detailsUrl === 'string') {
        targetUrl = node.detailsUrl
      }
      continue
    }
    if (typeName === 'StatusContext') {
      statusCount += 1
      const context = typeof node.context === 'string' && node.context.trim() ? node.context : 'unnamed status'
      const state = normalizeStatusState(node.state)
      states.push(state)
      details.push(`pull_request_status:${context}:${String(node.state ?? 'UNKNOWN')}`)
      if (!targetUrl && typeof node.targetUrl === 'string') {
        targetUrl = node.targetUrl
      }
    }
  }

  return {
    state: states.length > 0 ? aggregateContextState(states) : 'success',
    statusCount,
    checkRunCount,
    details,
    targetUrl,
  }
}

async function fetchPullRequestStatusCheckRollup(input: {
  owner: string
  repo: string
  pullNumber: number
  requiredCheckState: GitHubCommitStatusSummary['requiredCheckState']
  headers: Record<string, string>
}): Promise<GitHubCommitStatusSummary> {
  const response = await fetch(`${getGitHubApiBaseUrl()}/graphql`, {
    method: 'POST',
    headers: {
      ...input.headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        query OneShotPullRequestStatusCheckRollup($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              commits(last: 1) {
                nodes {
                  commit {
                    statusCheckRollup {
                      state
                      contexts(first: 100) {
                        nodes {
                          __typename
                          ... on CheckRun {
                            name
                            status
                            conclusion
                            detailsUrl
                          }
                          ... on StatusContext {
                            context
                            state
                            targetUrl
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        owner: input.owner,
        repo: input.repo,
        number: input.pullNumber,
      },
    }),
  })
  const payload = await response.json().catch(() => ({})) as GitHubGraphQlPayload
  if (!response.ok || Array.isArray(payload.errors)) {
    logger.warn( {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      status: response.status,
      payload,
    },'Failed to query OneShot pull request status check rollup')
    return {
      state: 'unavailable',
      description: `GitHub pull request check-rollup lookup failed with status ${response.status}.`,
      targetUrl: null,
      statusCount: 0,
      checkRunCount: 0,
      requiredCheckState: input.requiredCheckState,
      details: [`pull_request_check_rollup HTTP ${response.status}`],
    }
  }

  const data = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : null
  const repository = data?.repository && typeof data.repository === 'object'
    ? data.repository as Record<string, unknown>
    : null
  const pullRequest = repository?.pullRequest && typeof repository.pullRequest === 'object'
    ? repository.pullRequest as Record<string, unknown>
    : null
  const commits = pullRequest?.commits && typeof pullRequest.commits === 'object'
    ? pullRequest.commits as Record<string, unknown>
    : null
  const nodes = Array.isArray(commits?.nodes) ? commits.nodes : []
  const latestNode = nodes[nodes.length - 1]
  const commit = latestNode && typeof latestNode === 'object'
    ? (latestNode as Record<string, unknown>).commit
    : null
  const rollup = commit && typeof commit === 'object'
    ? (commit as Record<string, unknown>).statusCheckRollup
    : null
  if (!rollup || typeof rollup !== 'object') {
    const details = ['pull_request_check_rollup:none', `required_checks:${input.requiredCheckState}`]
    if (input.requiredCheckState === 'none') {
      return {
        state: 'success',
        description: 'No pull request check rollup was reported and branch protection confirms no required checks.',
        targetUrl: null,
        statusCount: 0,
        checkRunCount: 0,
        requiredCheckState: input.requiredCheckState,
        details,
      }
    }
    return {
      state: 'unavailable',
      description: 'No pull request check rollup was reported and required-check configuration could not confirm this is safe.',
      targetUrl: null,
      statusCount: 0,
      checkRunCount: 0,
      requiredCheckState: input.requiredCheckState,
      details,
    }
  }

  const rollupRecord = rollup as Record<string, unknown>
  const contexts = rollupRecord.contexts && typeof rollupRecord.contexts === 'object'
    ? (rollupRecord.contexts as Record<string, unknown>).nodes
    : []
  const parsed = parseStatusCheckRollupContexts(contexts)
  const rollupState = normalizeStatusState(rollupRecord.state)
  const state = parsed.statusCount > 0 || parsed.checkRunCount > 0
    ? aggregateContextState([rollupState, parsed.state])
    : rollupState === 'success' && input.requiredCheckState === 'none'
      ? 'success'
      : rollupState === 'success'
        ? 'unavailable'
        : rollupState
  const descriptionPrefix =
    state === 'success'
      ? 'GitHub pull request CI is success'
      : state === 'pending'
        ? 'GitHub pull request CI is pending'
        : state === 'failure' || state === 'error'
          ? 'GitHub pull request CI is failing'
          : 'GitHub pull request CI is unavailable'
  return {
    state,
    description: `${descriptionPrefix} across ${parsed.statusCount} status check(s) and ${parsed.checkRunCount} check run(s).`,
    targetUrl: parsed.targetUrl ?? null,
    statusCount: parsed.statusCount,
    checkRunCount: parsed.checkRunCount,
    requiredCheckState: input.requiredCheckState,
    details: [
      `pull_request_rollup:${String(rollupRecord.state ?? 'UNKNOWN')}`,
      ...parsed.details.slice(0, 8),
      `required_checks:${input.requiredCheckState}`,
    ],
  }
}

function combineRequiredCheckState(
  first: GitHubCommitStatusSummary['requiredCheckState'],
  second: GitHubCommitStatusSummary['requiredCheckState'],
): GitHubCommitStatusSummary['requiredCheckState'] {
  if (first === 'present' || second === 'present') {
    return 'present'
  }
  if (first === 'unavailable' || second === 'unavailable') {
    return 'unavailable'
  }
  return 'none'
}

function combineCiStatusSummaries(
  commitSummary: GitHubCommitStatusSummary,
  pullRequestSummary: GitHubCommitStatusSummary,
): GitHubCommitStatusSummary {
  const state = aggregateContextState([commitSummary.state, pullRequestSummary.state])
  const statusCount = (commitSummary.statusCount ?? 0) + (pullRequestSummary.statusCount ?? 0)
  const checkRunCount = (commitSummary.checkRunCount ?? 0) + (pullRequestSummary.checkRunCount ?? 0)
  const requiredCheckState = combineRequiredCheckState(
    commitSummary.requiredCheckState ?? 'unavailable',
    pullRequestSummary.requiredCheckState ?? 'unavailable',
  )
  const description =
    state === 'unconfigured'
      ? 'GitHub CI could not be checked because read credentials are not configured.'
      : state === 'success'
      ? `GitHub CI is success across commit and pull request checks (${statusCount} status check(s), ${checkRunCount} check run(s)).`
      : state === 'pending'
        ? `GitHub CI is pending across commit and pull request checks (${statusCount} status check(s), ${checkRunCount} check run(s)).`
        : state === 'failure' || state === 'error'
          ? `GitHub CI is failing across commit and pull request checks (${statusCount} status check(s), ${checkRunCount} check run(s)).`
          : `GitHub CI status is unavailable across commit and pull request checks (${statusCount} status check(s), ${checkRunCount} check run(s)).`
  return {
    state,
    description,
    targetUrl: commitSummary.targetUrl ?? pullRequestSummary.targetUrl ?? null,
    statusCount,
    checkRunCount,
    requiredCheckState,
    details: [
      ...(commitSummary.details ?? []),
      ...(pullRequestSummary.details ?? []),
    ],
  }
}

async function fetchRequiredCheckState(input: {
  owner: string
  repo: string
  base: string | null
  headers: Record<string, string>
}): Promise<'none' | 'present' | 'unavailable'> {
  if (!input.base) {
    return 'unavailable'
  }
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.base)}/protection/required_status_checks`,
    { headers: input.headers },
  )
  if (response.status === 404) {
    return 'none'
  }
  const payload = await response.json().catch(() => ({})) as GitHubBranchProtectionPayload
  if (!response.ok) {
    logger.warn( {
      owner: input.owner,
      repo: input.repo,
      base: input.base,
      status: response.status,
      payload,
    },'Failed to query OneShot branch required status checks')
    return 'unavailable'
  }
  const contexts = Array.isArray(payload.contexts) ? payload.contexts : []
  const checks = Array.isArray(payload.checks) ? payload.checks : []
  return contexts.length > 0 || checks.length > 0 ? 'present' : 'none'
}

export async function createDraftPullRequest(
  input: CreateDraftPullRequestInput,
): Promise<CreatedPullRequest> {
  const response = await fetch(`${getGitHubApiBaseUrl()}/repos/${input.owner}/${input.repo}/pulls`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await getRequiredGitHubWriteToken(input)}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft ?? true,
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    logger.error( {
      owner: input.owner,
      repo: input.repo,
      base: input.base,
      head: input.head,
      status: response.status,
      payload,
    },'Failed to create OneShot draft pull request')
    throw new Error(`GitHub pull request creation failed with status ${response.status}`)
  }

  return toCreatedPullRequest(payload as GitHubPullRequestPayload)
}

export async function findOpenPullRequest(
  input: Pick<CreateDraftPullRequestInput, 'owner' | 'repo' | 'head' | 'base'>,
): Promise<CreatedPullRequest | null> {
  const params = new URLSearchParams({
    state: 'open',
    head: `${input.owner}:${input.head}`,
    base: input.base,
  })

  const response = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${input.owner}/${input.repo}/pulls?${params.toString()}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await getRequiredGitHubWriteToken(input)}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )

  const payload = await response.json().catch(() => ([]))
  if (!response.ok) {
    logger.error( {
      owner: input.owner,
      repo: input.repo,
      base: input.base,
      head: input.head,
      status: response.status,
      payload,
    },'Failed to query OneShot pull requests')
    throw new Error(`GitHub pull request lookup failed with status ${response.status}`)
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return null
  }

  return toCreatedPullRequest(payload[0] as GitHubPullRequestPayload)
}

export async function updatePullRequest(
  input: Pick<CreateDraftPullRequestInput, 'owner' | 'repo' | 'title' | 'body'> & { pullNumber: number },
): Promise<CreatedPullRequest> {
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}`,
    {
      method: 'PATCH',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await getRequiredGitHubWriteToken(input)}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
      }),
    },
  )

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    logger.error( {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      status: response.status,
      payload,
    },'Failed to update OneShot pull request')
    throw new Error(`GitHub pull request update failed with status ${response.status}`)
  }

  return toCreatedPullRequest(payload as GitHubPullRequestPayload)
}

export async function syncPullRequestDraftState(input: {
  owner: string
  repo: string
  pullNumber: number
  nodeId: string | null
  draft: boolean
}): Promise<void> {
  if (!input.nodeId) {
    throw new Error(`Cannot sync draft state for PR #${input.pullNumber} without a GitHub node_id`)
  }
  const mutationName = input.draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview'
  const inputType = input.draft ? 'ConvertPullRequestToDraftInput!' : 'MarkPullRequestReadyForReviewInput!'
  const response = await fetch(`${getGitHubApiBaseUrl()}/graphql`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${await getRequiredGitHubWriteToken(input)}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      query: `mutation SyncOneShotPullRequestDraftState($input: ${inputType}) { ${mutationName}(input: $input) { pullRequest { number isDraft url } } }`,
      variables: {
        input: {
          pullRequestId: input.nodeId,
        },
      },
    }),
  })
  const payload = await response.json().catch(() => ({})) as GitHubGraphQlPayload
  if (!response.ok || Array.isArray(payload.errors)) {
    logger.warn( {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      desiredDraft: input.draft,
      status: response.status,
      payload,
    },'Failed to sync OneShot pull request draft state')
    throw new Error(`GitHub pull request draft-state sync failed with status ${response.status}`)
  }

  const data = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : null
  const mutationResult = data?.[mutationName]
  const pullRequest = mutationResult && typeof mutationResult === 'object'
    ? (mutationResult as Record<string, unknown>).pullRequest
    : null
  const actualDraft = pullRequest && typeof pullRequest === 'object'
    ? (pullRequest as Record<string, unknown>).isDraft
    : undefined
  if (actualDraft !== input.draft) {
    logger.warn( {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber,
      desiredDraft: input.draft,
      actualDraft,
      payload,
    },'GitHub pull request draft-state sync returned unexpected state')
    throw new Error(`GitHub pull request draft-state sync returned draft=${String(actualDraft)}`)
  }
}

export async function ensureDraftPullRequest(
  input: CreateDraftPullRequestInput,
): Promise<CreatedPullRequest & { reused: boolean }> {
  const existing = await findOpenPullRequest(input)
  if (existing) {
    let updated: CreatedPullRequest
    try {
      updated = await updatePullRequest({
        owner: input.owner,
        repo: input.repo,
        pullNumber: existing.number,
        title: input.title,
        body: input.body,
      })
    } catch (error) {
      const updateSyncError = error instanceof Error ? error.message : String(error)
      logger.warn(
        {
          owner: input.owner,
          repo: input.repo,
          pullNumber: existing.number,
          error: updateSyncError,
        },
        'Failed to update existing OneShot pull request title/body; reusing existing PR with readiness blocker',
      )
      return {
        ...existing,
        reused: true,
        draftSyncError: null,
        updateSyncError,
      }
    }
    const currentDraft = updated.draft ?? existing.draft
    const nodeId = updated.nodeId ?? existing.nodeId
    if (typeof input.draft === 'boolean' && currentDraft !== null && currentDraft !== input.draft) {
      try {
        await syncPullRequestDraftState({
          owner: input.owner,
          repo: input.repo,
          pullNumber: updated.number,
          nodeId,
          draft: input.draft,
        })
        return { ...updated, draft: input.draft, reused: true, updateSyncError: null }
      } catch (error) {
        const draftSyncError = error instanceof Error ? error.message : String(error)
        return { ...updated, reused: true, draftSyncError, updateSyncError: null }
      }
    }
    return { ...updated, reused: true, draftSyncError: null, updateSyncError: null }
  }

  const created = await createDraftPullRequest(input)
  return { ...created, reused: false, updateSyncError: null }
}
