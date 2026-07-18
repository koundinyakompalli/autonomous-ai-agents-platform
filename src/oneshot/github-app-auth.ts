import { sign } from 'crypto'

export interface GitHubWriteTokenScope {
  owner?: string
  repo?: string
}

interface GitHubAppCredentials {
  appId: string
  installationId: string
  privateKey: string
}

interface CachedInstallationToken {
  token: string
  expiresAtMs: number
}

interface GitHubInstallationTokenPayload {
  token?: unknown
  expires_at?: unknown
  permissions?: unknown
  repository_selection?: unknown
  message?: unknown
}

type GitHubInstallationTokenPermission = 'read' | 'write'
type GitHubInstallationTokenPermissions = Record<string, GitHubInstallationTokenPermission>

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000
const installationTokenCache = new Map<string, CachedInstallationToken>()
const GITHUB_APP_READ_PERMISSIONS: GitHubInstallationTokenPermissions = {
  contents: 'read',
}
const GITHUB_APP_WRITE_PERMISSIONS: GitHubInstallationTokenPermissions = {
  contents: 'write',
  pull_requests: 'write',
}
const GITHUB_APP_COMMAND_PERMISSIONS: GitHubInstallationTokenPermissions = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'write',
  pull_requests: 'write',
  statuses: 'read',
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n').trim()
}

function escapeControlCharactersInJsonStrings(value: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (const char of value) {
    if (escaped) {
      result += char
      escaped = false
      continue
    }

    if (inString && char === '\\') {
      result += char
      escaped = true
      continue
    }

    if (char === '"') {
      result += char
      inString = !inString
      continue
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n'
        continue
      }
      if (char === '\r') {
        result += '\\r'
        continue
      }
      if (char === '\t') {
        result += '\\t'
        continue
      }
      if (char.charCodeAt(0) < 0x20) {
        result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        continue
      }
    }

    result += char
  }

  return result
}

function parseCredentialsJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch (error) {
    const normalized = escapeControlCharactersInJsonStrings(value)
    if (normalized !== value) {
      try {
        return JSON.parse(normalized) as Record<string, unknown>
      } catch {
        // Preserve the original parser error so malformed JSON reports the
        // actual bad input instead of the recovery attempt.
      }
    }
    throw error
  }
}

function parseCredentialsFromJson(value: string): GitHubAppCredentials | null {
  const parsed = parseCredentialsJson(value)
  const appId = String(parsed.appId ?? parsed.app_id ?? parsed.githubAppId ?? '').trim()
  const installationId = String(
    parsed.installationId ?? parsed.installation_id ?? parsed.githubAppInstallationId ?? '',
  ).trim()
  const privateKey = normalizePrivateKey(String(
    parsed.privateKey ?? parsed.private_key ?? parsed.githubAppPrivateKey ?? '',
  ))

  if (!appId || !installationId || !privateKey) {
    throw new Error('GITHUB_APP_CREDENTIALS must include appId, installationId, and privateKey')
  }

  return { appId, installationId, privateKey }
}

function getGitHubAppCredentials(): GitHubAppCredentials | null {
  const credentialsJson = process.env.GITHUB_APP_CREDENTIALS?.trim()
  if (credentialsJson) {
    try {
      return parseCredentialsFromJson(credentialsJson)
    } catch (error) {
      throw new Error(`GITHUB_APP_CREDENTIALS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const appId = process.env.GITHUB_APP_ID?.trim()
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim()
  const privateKey = normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY ?? '')
  if (!appId && !installationId && !privateKey) {
    return null
  }
  if (!appId || !installationId || !privateKey) {
    throw new Error('GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY must all be set when using GitHub App auth')
  }

  return { appId, installationId, privateKey }
}

export function hasGitHubWriteCredentials(): boolean {
  if (process.env.GITHUB_APP_CREDENTIALS?.trim()) {
    getGitHubAppCredentials()
    return true
  }

  if (
    process.env.GITHUB_APP_ID?.trim() ||
    process.env.GITHUB_APP_INSTALLATION_ID?.trim() ||
    process.env.GITHUB_APP_PRIVATE_KEY?.trim()
  ) {
    getGitHubAppCredentials()
    return true
  }

  return Boolean(process.env.GITHUB_WRITE_TOKEN?.trim())
}

export function hasGitHubReadCredentials(): boolean {
  if (process.env.GITHUB_APP_CREDENTIALS?.trim()) {
    getGitHubAppCredentials()
    return true
  }

  if (
    process.env.GITHUB_APP_ID?.trim() ||
    process.env.GITHUB_APP_INSTALLATION_ID?.trim() ||
    process.env.GITHUB_APP_PRIVATE_KEY?.trim()
  ) {
    getGitHubAppCredentials()
    return true
  }

  return Boolean(process.env.GITHUB_REPO_TOKEN?.trim())
}

function getGitHubApiBaseUrl(): string {
  return process.env.GITHUB_API_BASE_URL?.trim() || 'https://api.github.com'
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function createAppJwt(credentials: GitHubAppCredentials): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: now - 60,
    exp: now + (9 * 60),
    iss: credentials.appId,
  }
  const body = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  const signature = sign('RSA-SHA256', Buffer.from(body), credentials.privateKey).toString('base64url')
  return `${body}.${signature}`
}

function tokenCacheKey(
  scope: GitHubWriteTokenScope,
  permissions: GitHubInstallationTokenPermissions,
): string {
  const repoKey = scope.owner && scope.repo ? `${scope.owner}/${scope.repo}` : '*'
  const permissionKey = Object.entries(permissions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join(',')
  return `${repoKey}|${permissionKey}`
}

async function mintInstallationToken(
  credentials: GitHubAppCredentials,
  scope: GitHubWriteTokenScope,
  permissions: GitHubInstallationTokenPermissions,
): Promise<CachedInstallationToken> {
  const body: Record<string, unknown> = {
    permissions,
  }
  if (scope.repo) {
    body.repositories = [scope.repo]
  }

  const response = await fetch(
    `${getGitHubApiBaseUrl()}/app/installations/${encodeURIComponent(credentials.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createAppJwt(credentials)}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    },
  )
  const payload = await response.json().catch(() => ({})) as GitHubInstallationTokenPayload
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? `: ${payload.message}` : ''
    throw new Error(`GitHub App installation token request failed with status ${response.status}${message}`)
  }
  if (typeof payload.token !== 'string' || !payload.token.trim()) {
    throw new Error('GitHub App installation token response did not include a token')
  }

  const expiresAtMs = typeof payload.expires_at === 'string'
    ? Date.parse(payload.expires_at)
    : Number.NaN
  return {
    token: payload.token,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + (55 * 60 * 1000),
  }
}

async function getGitHubAppInstallationToken(
  scope: GitHubWriteTokenScope,
  permissions: GitHubInstallationTokenPermissions,
): Promise<string | null> {
  const credentials = getGitHubAppCredentials()
  if (!credentials) {
    return null
  }

  const key = tokenCacheKey(scope, permissions)
  const cached = installationTokenCache.get(key)
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return cached.token
  }

  const token = await mintInstallationToken(credentials, scope, permissions)
  installationTokenCache.set(key, token)
  return token.token
}

export async function getGitHubRepoToken(scope: GitHubWriteTokenScope = {}): Promise<string> {
  const appToken = await getGitHubAppInstallationToken(scope, GITHUB_APP_READ_PERMISSIONS)
  if (appToken) {
    return appToken
  }

  const token = process.env.GITHUB_REPO_TOKEN?.trim()
  if (!token) {
    throw new Error('GITHUB_REPO_TOKEN or GITHUB_APP_CREDENTIALS is required for OneShot GitHub read operations')
  }

  return token
}

export async function getGitHubWriteToken(scope: GitHubWriteTokenScope = {}): Promise<string> {
  const appToken = await getGitHubAppInstallationToken(scope, GITHUB_APP_WRITE_PERMISSIONS)
  if (appToken) {
    return appToken
  }

  const token = process.env.GITHUB_WRITE_TOKEN?.trim()
  if (!token) {
    throw new Error('GITHUB_WRITE_TOKEN or GITHUB_APP_CREDENTIALS is required for OneShot GitHub write operations')
  }

  return token
}

export async function getGitHubCommandToken(scope: GitHubWriteTokenScope = {}): Promise<string> {
  const appToken = await getGitHubAppInstallationToken(scope, GITHUB_APP_COMMAND_PERMISSIONS)
  if (appToken) {
    return appToken
  }

  const token = process.env.GITHUB_WRITE_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
  if (!token) {
    throw new Error('GITHUB_WRITE_TOKEN, GITHUB_TOKEN, or GITHUB_APP_CREDENTIALS is required for OneShot GitHub command operations')
  }

  return token
}

export function clearGitHubAppTokenCacheForTests(): void {
  installationTokenCache.clear()
}
