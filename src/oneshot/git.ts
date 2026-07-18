import { exec, execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { CodeRepository } from '../orchestrator/database.js'
import { sanitizeErrorMessage } from './errors.js'
import { getGitHubRepoToken, getGitHubWriteToken } from './github-app-auth.js'

const execFileAsync = promisify(execFile)

const execAsync = promisify(exec)
const DEFAULT_GIT_OUTPUT_MAX_BUFFER_BYTES = 20 * 1024 * 1024
const DEFAULT_GIT_TRUNCATED_STDERR_BYTES = 256 * 1024

export interface TruncatedGitCommandResult {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface RemoteBranchHead {
  branchName: string
  headSha: string
}

export type RemoteBranchLookupFailureCategory =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'git'
  | 'unknown'

export type RemoteBranchLookupAttempt =
  | {
      branchName: string
      status: 'resolved'
      headSha: string
    }
  | {
      branchName: string
      status: 'not_found'
    }
  | {
      branchName: string
      status: 'lookup_failed'
      failureCategory: RemoteBranchLookupFailureCategory
      sanitizedError: string
    }

export type RemoteBranchLookupResult =
  | {
      status: 'resolved'
      branchName: string
      headSha: string
      branchCandidates: string[]
      attempts: RemoteBranchLookupAttempt[]
    }
  | {
      status: 'not_found'
      branchCandidates: string[]
      attempts: RemoteBranchLookupAttempt[]
    }
  | {
      status: 'lookup_failed'
      repoName: string
      githubOwner: string | null
      githubRepo: string | null
      failedBranchName: string
      failureCategory: RemoteBranchLookupFailureCategory
      sanitizedError: string
      branchCandidates: string[]
      attempts: RemoteBranchLookupAttempt[]
    }

export interface PushBranchOptions {
  expectedRemoteHeadSha?: string | null
}

export async function buildAuthenticatedRepoUrl(repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>): Promise<string> {
  const githubToken = await getGitHubRepoToken(parseGitHubRepoUrlForAuth(repo.repo_url) ?? {})
  return repo.repo_url.replace(
    'https://',
    `https://x-access-token:${encodeURIComponent(githubToken)}@`,
  )
}

function parseGitHubRepoUrlForAuth(repoUrl: string): { owner: string; repo: string } | null {
  const normalized = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i)
  if (!match) {
    return null
  }
  return {
    owner: match[1],
    repo: match[2],
  }
}

export async function buildWriteAuthenticatedRepoUrl(repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>): Promise<string> {
  const githubToken = await getGitHubWriteToken(parseGitHubRepoUrlForAuth(repo.repo_url) ?? {})
  return repo.repo_url.replace(
    'https://',
    `https://x-access-token:${encodeURIComponent(githubToken)}@`,
  )
}

export async function runGitCommand(
  command: string,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execAsync(command, {
      ...(cwd ? { cwd } : {}),
      maxBuffer: DEFAULT_GIT_OUTPUT_MAX_BUFFER_BYTES,
    })
  } catch (error) {
    throw sanitizeGitError(error)
  }
}

function sanitizeGitError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error
  }

  error.message = sanitizeErrorMessage(error.message)
  if (typeof error.stack === 'string') {
    error.stack = sanitizeErrorMessage(error.stack)
  }

  const mutable = error as Error & {
    cmd?: string
    command?: string
    stdout?: string | Buffer
    stderr?: string | Buffer
  }
  if (typeof mutable.cmd === 'string') {
    mutable.cmd = sanitizeErrorMessage(mutable.cmd)
  }
  if (typeof mutable.command === 'string') {
    mutable.command = sanitizeErrorMessage(mutable.command)
  }
  if (typeof mutable.stdout === 'string') {
    mutable.stdout = sanitizeErrorMessage(mutable.stdout)
  }
  if (typeof mutable.stderr === 'string') {
    mutable.stderr = sanitizeErrorMessage(mutable.stderr)
  }

  return error
}

function appendBoundedChunk(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): { bytes: number; truncated: boolean } {
  if (currentBytes >= maxBytes) {
    return { bytes: currentBytes, truncated: chunk.byteLength > 0 }
  }

  const remainingBytes = maxBytes - currentBytes
  if (chunk.byteLength <= remainingBytes) {
    chunks.push(chunk)
    return { bytes: currentBytes + chunk.byteLength, truncated: false }
  }

  chunks.push(chunk.subarray(0, remainingBytes))
  return { bytes: maxBytes, truncated: true }
}

export async function runGitCommandWithTruncatedOutput(
  command: string,
  cwd: string | undefined,
  maxStdoutBytes: number,
): Promise<TruncatedGitCommandResult> {
  if (!Number.isFinite(maxStdoutBytes) || maxStdoutBytes <= 0) {
    throw new Error(
      `maxStdoutBytes must be a positive finite number, got ${maxStdoutBytes}`,
    )
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      ...(cwd ? { cwd } : {}),
      shell: true,
      windowsHide: true,
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (chunk: Buffer) => {
      const result = appendBoundedChunk(
        stdoutChunks,
        chunk,
        stdoutBytes,
        maxStdoutBytes,
      )
      stdoutBytes = result.bytes
      stdoutTruncated = stdoutTruncated || result.truncated
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const result = appendBoundedChunk(
        stderrChunks,
        chunk,
        stderrBytes,
        DEFAULT_GIT_TRUNCATED_STDERR_BYTES,
      )
      stderrBytes = result.bytes
      stderrTruncated = stderrTruncated || result.truncated
    })

    child.on('error', reject)
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      if (code === 0) {
        resolve({
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        })
        return
      }

      const error = new Error(
        sanitizeErrorMessage(
          `Git command failed with ${signal ? `signal ${signal}` : `exit code ${code}`}: ${command}${stderr ? `\n${stderr}` : ''}`,
        ),
      )
      Object.assign(error, {
        code,
        signal,
        stdout: sanitizeErrorMessage(stdout),
        stderr: sanitizeErrorMessage(stderr),
        stdoutTruncated,
        stderrTruncated,
      })
      reject(error)
    })
  })
}

export async function getRemoteBranchHead(
  repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
  branchName: string,
): Promise<RemoteBranchHead | null> {
  const authUrl = await buildAuthenticatedRepoUrl(repo)
  const { stdout } = await runGitCommand(
    `git ls-remote --heads "${authUrl}" "refs/heads/${branchName}"`,
  )

  const output = stdout.trim()
  if (!output) {
    return null
  }

  const [headSha, ref] = output.split(/\s+/, 2)
  if (!headSha || !ref?.endsWith(`refs/heads/${branchName}`)) {
    return null
  }

  return {
    branchName,
    headSha,
  }
}

export function classifyRemoteBranchLookupFailure(
  message: string,
): RemoteBranchLookupFailureCategory {
  if (/auth|permission|denied|forbidden|unauthorized|not authorized|403/i.test(message)) {
    return 'auth'
  }
  if (/rate limit|secondary rate|abuse/i.test(message)) {
    return 'rate_limit'
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return 'timeout'
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|Could not resolve host/i.test(message)) {
    return 'network'
  }
  if (/git|ls-remote|fatal:/i.test(message)) {
    return 'git'
  }
  return 'unknown'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export async function resolveFirstRemoteBranchHeadClassified(
  repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
  branchCandidates: string[],
  dependencies: {
    resolveBranchHead?: (
      repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
      branchName: string,
    ) => Promise<RemoteBranchHead | null>
  } = {},
): Promise<RemoteBranchLookupResult> {
  const attempts: RemoteBranchLookupAttempt[] = []
  const resolveBranchHead = dependencies.resolveBranchHead ?? getRemoteBranchHead
  const githubRepo = parseGitHubRepoUrlForAuth(repo.repo_url)

  for (const branchCandidate of branchCandidates) {
    try {
      const resolved = await resolveBranchHead(repo, branchCandidate)
      if (resolved) {
        attempts.push({
          branchName: branchCandidate,
          status: 'resolved',
          headSha: resolved.headSha,
        })
        return {
          status: 'resolved',
          branchName: resolved.branchName,
          headSha: resolved.headSha,
          branchCandidates,
          attempts,
        }
      }
      attempts.push({ branchName: branchCandidate, status: 'not_found' })
    } catch (error) {
      const sanitizedError = sanitizeErrorMessage(errorMessage(error))
      const failureCategory = classifyRemoteBranchLookupFailure(sanitizedError)
      attempts.push({
        branchName: branchCandidate,
        status: 'lookup_failed',
        failureCategory,
        sanitizedError,
      })
      return {
        status: 'lookup_failed',
        repoName: repo.repo_name,
        githubOwner: githubRepo?.owner ?? null,
        githubRepo: githubRepo?.repo ?? null,
        failedBranchName: branchCandidate,
        failureCategory,
        sanitizedError,
        branchCandidates,
        attempts,
      }
    }
  }

  return {
    status: 'not_found',
    branchCandidates,
    attempts,
  }
}

export async function resolveFirstRemoteBranchHead(
  repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
  branchCandidates: string[],
): Promise<RemoteBranchHead | null> {
  for (const branchCandidate of branchCandidates) {
    try {
      const resolved = await getRemoteBranchHead(repo, branchCandidate)
      if (resolved) {
        return resolved
      }
    } catch {
      continue
    }
  }

  return null
}

export async function getCurrentHeadSha(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand('git rev-parse HEAD', cwd)
  return stdout.trim()
}

export async function isAncestor(
  cwd: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  try {
    await runGitCommand(
      `git merge-base --is-ancestor ${JSON.stringify(ancestorSha)} ${JSON.stringify(descendantSha)}`,
      cwd,
    )
    return true
  } catch {
    return false
  }
}

function dedupeAndSortPaths(paths: string[]): string[] {
  return Array.from(
    new Set(
      paths
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right))
}

export function parseGitStatusPorcelainPaths(output: string): string[] {
  const entries = output.split('\0').filter(Boolean)
  const paths: string[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) {
      continue
    }

    const status = entry.slice(0, 2)
    const currentPath = entry.slice(3)
    if (currentPath) {
      paths.push(currentPath)
    }

    const indicatesRenameOrCopy = status.includes('R') || status.includes('C')
    if (indicatesRenameOrCopy) {
      const originalPath = entries[index + 1]
      if (originalPath) {
        paths.push(originalPath)
        index += 1
      }
    }
  }

  return dedupeAndSortPaths(paths)
}

export function parseGitNameStatusPaths(output: string): string[] {
  const paths = output
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim()
      if (!trimmed) {
        return []
      }

      const parts = line.split('\t').slice(1)
      return parts.filter(Boolean)
    })

  return dedupeAndSortPaths(paths)
}

export async function listChangedFiles(
  cwd: string,
  fromRef?: string,
  toRef = 'HEAD',
): Promise<string[]> {
  if (!fromRef) {
    const { stdout } = await runGitCommand(
      'git status --porcelain=v1 --untracked-files=all -z',
      cwd,
    )
    return parseGitStatusPorcelainPaths(stdout)
  }

  if (fromRef === toRef) {
    return []
  }

  const { stdout } = await runGitCommand(
    `git diff --name-status --find-renames ${JSON.stringify(fromRef)} ${JSON.stringify(toRef)}`,
    cwd,
  )
  return parseGitNameStatusPaths(stdout)
}

export async function createOrResetLocalBranch(cwd: string, branchName: string): Promise<void> {
  await runGitCommand(`git switch -C "${branchName}"`, cwd)
}

export async function commitAllChanges(
  cwd: string,
  message: string,
): Promise<void> {
  await runGitCommand('git add -A', cwd)
  await runGitCommand('git config user.name "Specter OneShot"', cwd)
  await runGitCommand('git config user.email "specter-oneshot@mhkdevsandbox.com"', cwd)
  await runGitCommand(`git commit -m ${JSON.stringify(message)}`, cwd)
}

export async function pushBranch(
  cwd: string,
  repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
  branchName: string,
  options: PushBranchOptions = {},
): Promise<void> {
  const remoteHead = await getRemoteBranchHead(repo, branchName)
  if (Object.prototype.hasOwnProperty.call(options, 'expectedRemoteHeadSha')) {
    const actualRemoteHeadSha = remoteHead?.headSha ?? null
    if (actualRemoteHeadSha !== options.expectedRemoteHeadSha) {
      throw new Error(
        `Remote branch ${branchName} changed before push: expected ${options.expectedRemoteHeadSha ?? 'absent'}, got ${actualRemoteHeadSha ?? 'absent'}`,
      )
    }
  }
  // Empty expected SHA is deliberate only when ls-remote succeeds with no
  // matching branch: git then requires the remote ref to remain absent.
  const leaseSpec = `refs/heads/${branchName}:${remoteHead?.headSha ?? ''}`
  const authUrl = await buildWriteAuthenticatedRepoUrl(repo)
  await runGitCommand(
    `git push --force-with-lease=${JSON.stringify(leaseSpec)} ${JSON.stringify(authUrl)} ${JSON.stringify(`${branchName}:${branchName}`)}`,
    cwd,
  )
}

export async function createRemoteBranchIfMissing(
  cwd: string,
  repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
  branchName: string,
  commitSha: string,
): Promise<{ created: boolean; headSha: string }> {
  const remoteHead = await getRemoteBranchHead(repo, branchName)
  if (remoteHead) {
    if (remoteHead.headSha === commitSha) {
      return { created: false, headSha: remoteHead.headSha }
    }
    throw new Error(
      `Remote branch ${branchName} already exists at ${remoteHead.headSha}; expected ${commitSha}`,
    )
  }

  const authUrl = await buildWriteAuthenticatedRepoUrl(repo)
  const leaseSpec = `refs/heads/${branchName}:`
  await runGitCommand(
    `git push --force-with-lease=${JSON.stringify(leaseSpec)} ${JSON.stringify(authUrl)} ${JSON.stringify(`${commitSha}:refs/heads/${branchName}`)}`,
    cwd,
  )

  const verifiedHead = await getRemoteBranchHead(repo, branchName)
  if (!verifiedHead || verifiedHead.headSha !== commitSha) {
    throw new Error(
      `Remote branch ${branchName} was not created at ${commitSha}`,
    )
  }

  return { created: true, headSha: verifiedHead.headSha }
}

export async function branchExistsOnRemote(
  repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
  branchName: string,
): Promise<boolean> {
  return (await getRemoteBranchHead(repo, branchName)) !== null
}

// ---------------------------------------------------------------------------
// Retrofit patch primitives — injection-safe, using execFile argument arrays
// ---------------------------------------------------------------------------

/**
 * Exports the full (untruncated) patch for a single source commit using
 * `git format-patch -1 <sha> --stdout`. The SHA is passed as a discrete
 * argument — never shell-interpolated — so no command injection is possible.
 */
export async function exportSourceCommitPatch(
  cwd: string,
  sha: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['format-patch', '-1', sha, '--stdout'],
      { cwd, maxBuffer: DEFAULT_GIT_OUTPUT_MAX_BUFFER_BYTES },
    )
    return stdout
  } catch (error) {
    throw sanitizeGitError(error)
  }
}

/**
 * Runs `git apply` with the given args and patch data piped to stdin.
 * Returns { exitCode, stderr }. Uses spawn so we can write to stdin safely
 * without shell interpolation of arguments.
 */
function runGitApplyWithStdin(
  cwd: string,
  args: string[],
  patch: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'ignore', 'pipe'],
    })

    const stderrChunks: Buffer[] = []

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      resolve({ exitCode: code ?? 1, stderr })
    })

    // Write the patch to stdin then close it
    child.stdin?.end(patch, 'utf8')
  })
}

/**
 * Checks whether a patch (provided as a string on stdin) can be applied
 * cleanly to the current workspace using `git apply --check`. Returns true
 * if the patch applies cleanly, false otherwise. Does NOT mutate the worktree.
 */
export async function isPatchApplicable(
  cwd: string,
  patch: string,
): Promise<boolean> {
  const { exitCode } = await runGitApplyWithStdin(cwd, ['apply', '--check'], patch)
  return exitCode === 0
}

/**
 * Detects whether a patch is already applied / patch-equivalent on the target
 * branch using `git apply --reverse --check`. Returns true when the patch is
 * already present (the reverse applies cleanly), false otherwise.
 */
export async function isPatchAlreadyApplied(
  cwd: string,
  patch: string,
): Promise<boolean> {
  const { exitCode } = await runGitApplyWithStdin(cwd, ['apply', '--reverse', '--check'], patch)
  return exitCode === 0
}

/**
 * Mechanically applies a patch (provided as a string on stdin) to the current
 * workspace using `git apply`. Returns `{ ok: true }` on success or
 * `{ ok: false, conflictDiagnostics }` on failure. The worktree is mutated
 * only on success.
 */
export async function applyPatch(
  cwd: string,
  patch: string,
): Promise<{ ok: boolean; conflictDiagnostics?: string }> {
  const { exitCode, stderr } = await runGitApplyWithStdin(cwd, ['apply'], patch)
  if (exitCode === 0) {
    return { ok: true }
  }
  return {
    ok: false,
    conflictDiagnostics: sanitizeErrorMessage(stderr) || `git apply exited with code ${exitCode}`,
  }
}
