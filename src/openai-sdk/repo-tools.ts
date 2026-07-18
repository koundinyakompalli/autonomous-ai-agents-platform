import { exec } from 'child_process'
import * as fs from 'fs/promises'
import { glob } from 'glob'
import * as path from 'path'
import { promisify } from 'util'
import { createLogger } from '../utils/logger.js'

const execAsync = promisify(exec)
const logger = createLogger('openai-repo-tools')

const MAX_DIRECTORY_RESULTS = 200
const MAX_GLOB_RESULTS = 200
const MAX_GREP_RESULTS = 100
const MAX_FILE_BYTES = 32 * 1024
const MAX_DIFF_BYTES = 64 * 1024

export interface OpenAiFunctionCall {
  callId: string
  name: string
  arguments: string
}

export interface RepoToolHandlerSet {
  tools: Array<Record<string, unknown>>
  execute: (call: OpenAiFunctionCall) => Promise<unknown>
}

interface DirectoryEntry {
  path: string
  type: 'file' | 'directory'
}

function normalizeRelativePath(inputPath = '.'): string {
  const normalized = inputPath.replaceAll('\\', '/').replace(/^\/+/, '')
  return normalized.length > 0 ? normalized : '.'
}

function resolveWorkspacePath(rootPath: string, relativePath = '.'): string {
  const normalized = normalizeRelativePath(relativePath)
  const resolvedRoot = path.resolve(rootPath)
  const candidate = path.resolve(resolvedRoot, normalized)

  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path resolves outside the workspace: ${relativePath}`)
  }

  return candidate
}

function truncateText(value: string, maxBytes: number): { content: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (byteLength <= maxBytes) {
    return { content: value, truncated: false }
  }

  return {
    content: Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  }
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  return !sample.includes(0)
}

async function collectDirectoryEntries(
  rootPath: string,
  currentPath: string,
  maxDepth: number,
  results: DirectoryEntry[],
  prefix = '.',
): Promise<void> {
  if (results.length >= MAX_DIRECTORY_RESULTS) {
    return
  }

  const dirents = await fs.readdir(currentPath, { withFileTypes: true })
  dirents.sort((a, b) => a.name.localeCompare(b.name))

  for (const dirent of dirents) {
    if (results.length >= MAX_DIRECTORY_RESULTS) {
      return
    }

    const relativePath = prefix === '.'
      ? dirent.name
      : `${prefix}/${dirent.name}`
    results.push({
      path: relativePath,
      type: dirent.isDirectory() ? 'directory' : 'file',
    })

    if (dirent.isDirectory() && maxDepth > 0) {
      await collectDirectoryEntries(
        rootPath,
        path.join(currentPath, dirent.name),
        maxDepth - 1,
        results,
        relativePath,
      )
    }
  }
}

async function listDirectory(rootPath: string, args: Record<string, unknown>): Promise<unknown> {
  const relativePath = typeof args.path === 'string' ? args.path : '.'
  const maxDepth = typeof args.maxDepth === 'number' && args.maxDepth >= 0
    ? Math.min(args.maxDepth, 6)
    : 2
  const normalizedPath = normalizeRelativePath(relativePath)
  const targetPath = resolveWorkspacePath(rootPath, relativePath)
  const stats = await fs.stat(targetPath)
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${relativePath}`)
  }

  const entries: DirectoryEntry[] = []
  await collectDirectoryEntries(
    rootPath,
    targetPath,
    maxDepth,
    entries,
    normalizedPath === '.' ? '.' : normalizedPath,
  )

  return {
    path: normalizedPath,
    maxDepth,
    truncated: entries.length >= MAX_DIRECTORY_RESULTS,
    entries,
  }
}

async function globSearch(rootPath: string, args: Record<string, unknown>): Promise<unknown> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : null
  if (!pattern) {
    throw new Error('glob_search requires a pattern')
  }

  const cwd = typeof args.cwd === 'string' ? args.cwd : '.'
  const resolvedCwd = resolveWorkspacePath(rootPath, cwd)
  const matches = await glob(pattern, {
    cwd: resolvedCwd,
    nodir: false,
    dot: true,
    absolute: false,
    withFileTypes: false,
  })

  const formatted = await Promise.all(matches.slice(0, MAX_GLOB_RESULTS).map(async (entry) => {
    const absolutePath = resolveWorkspacePath(resolvedCwd, entry)
    const stats = await fs.stat(absolutePath)
    return {
      path: normalizeRelativePath(path.join(cwd, entry)),
      type: stats.isDirectory() ? 'directory' : 'file',
    }
  }))

  return {
    pattern,
    cwd: normalizeRelativePath(cwd),
    truncated: matches.length > MAX_GLOB_RESULTS,
    matches: formatted,
  }
}

async function grepSearch(rootPath: string, args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query : null
  if (!query) {
    throw new Error('grep_search requires a query')
  }

  const relativePath = typeof args.path === 'string' ? args.path : '.'
  const filePattern = typeof args.filePattern === 'string' ? args.filePattern : '**/*'
  const caseSensitive = args.caseSensitive === true
  const maxResults = typeof args.maxResults === 'number' && args.maxResults > 0
    ? Math.min(args.maxResults, MAX_GREP_RESULTS)
    : 20
  const basePath = resolveWorkspacePath(rootPath, relativePath)

  const matches = await glob(filePattern, {
    cwd: basePath,
    nodir: true,
    dot: true,
    absolute: false,
  })

  const needle = caseSensitive ? query : query.toLowerCase()
  const results: Array<{ path: string; line: number; excerpt: string }> = []

  for (const match of matches) {
    if (results.length >= maxResults) {
      break
    }

    const absolutePath = resolveWorkspacePath(basePath, match)
    let buffer: Buffer
    try {
      buffer = await fs.readFile(absolutePath)
    } catch {
      continue
    }

    if (!isProbablyText(buffer)) {
      continue
    }

    const content = buffer.toString('utf8')
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const haystack = caseSensitive ? line : line.toLowerCase()
      if (!haystack.includes(needle)) {
        continue
      }

      results.push({
        path: normalizeRelativePath(path.join(relativePath, match)),
        line: index + 1,
        excerpt: line.slice(0, 400),
      })

      if (results.length >= maxResults) {
        break
      }
    }
  }

  return {
    query,
    path: normalizeRelativePath(relativePath),
    filePattern,
    truncated: results.length >= maxResults,
    matches: results,
  }
}

async function readFile(rootPath: string, args: Record<string, unknown>): Promise<unknown> {
  const relativePath = typeof args.path === 'string' ? args.path : null
  if (!relativePath) {
    throw new Error('read_file requires a path')
  }

  const startLine = typeof args.startLine === 'number' && args.startLine > 0
    ? Math.floor(args.startLine)
    : 1
  const endLine = typeof args.endLine === 'number' && args.endLine >= startLine
    ? Math.floor(args.endLine)
    : startLine + 199

  const absolutePath = resolveWorkspacePath(rootPath, relativePath)
  const buffer = await fs.readFile(absolutePath)
  if (!isProbablyText(buffer)) {
    throw new Error(`File appears to be binary: ${relativePath}`)
  }

  const rawContent = buffer.toString('utf8')
  const lines = rawContent.split(/\r?\n/)
  const selectedLines = lines.slice(startLine - 1, endLine)
  const numberedContent = selectedLines
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n')
  const { content, truncated } = truncateText(numberedContent, MAX_FILE_BYTES)

  return {
    path: normalizeRelativePath(relativePath),
    startLine,
    endLine: Math.min(endLine, lines.length),
    totalLines: lines.length,
    truncated,
    content,
  }
}

async function gitDiff(rootPath: string, args: Record<string, unknown>): Promise<unknown> {
  const baseRef = typeof args.baseRef === 'string' ? args.baseRef : null
  if (!baseRef) {
    throw new Error('git_diff requires a baseRef')
  }

  const targetRef = typeof args.targetRef === 'string' ? args.targetRef : 'HEAD'
  const relativePath = typeof args.path === 'string' ? normalizeRelativePath(args.path) : null
  const pathClause = relativePath ? ` -- ${JSON.stringify(relativePath)}` : ''
  const command = `git diff --no-ext-diff ${JSON.stringify(baseRef)} ${JSON.stringify(targetRef)}${pathClause}`
  const { stdout } = await execAsync(command, {
    cwd: rootPath,
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
  })
  const { content, truncated } = truncateText(stdout, MAX_DIFF_BYTES)

  return {
    baseRef,
    targetRef,
    path: relativePath,
    truncated,
    diff: content,
  }
}

async function gitShowFile(rootPath: string, args: Record<string, unknown>): Promise<unknown> {
  const ref = typeof args.ref === 'string' ? args.ref : null
  const relativePath = typeof args.path === 'string' ? args.path : null
  if (!ref || !relativePath) {
    throw new Error('git_show_file requires ref and path')
  }

  const normalizedPath = normalizeRelativePath(relativePath)
  resolveWorkspacePath(rootPath, normalizedPath)

  const command = `git show ${JSON.stringify(`${ref}:${normalizedPath}`)}`
  const { stdout } = await execAsync(command, {
    cwd: rootPath,
    timeout: 60_000,
    maxBuffer: 5 * 1024 * 1024,
  })

  const { content, truncated } = truncateText(stdout, MAX_FILE_BYTES)
  return {
    ref,
    path: normalizedPath,
    truncated,
    content,
  }
}

export function createReadOnlyRepoTools(workspacePath: string): RepoToolHandlerSet {
  const rootPath = path.resolve(workspacePath)

  const tools: Array<Record<string, unknown>> = [
    {
      type: 'function',
      name: 'list_directory',
      description: 'List files and directories under the workspace. Use this before reading unfamiliar areas of the repository.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          maxDepth: { type: 'integer', minimum: 0, maximum: 6 },
        },
      },
    },
    {
      type: 'function',
      name: 'glob_search',
      description: 'Find files and directories matching a glob pattern relative to the workspace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
    {
      type: 'function',
      name: 'grep_search',
      description: 'Search text within repository files and return matching file paths and line numbers.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          path: { type: 'string' },
          filePattern: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          maxResults: { type: 'integer', minimum: 1, maximum: MAX_GREP_RESULTS },
        },
        required: ['query'],
      },
    },
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a text file from the workspace, optionally limited to a line range.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
      },
    },
    {
      type: 'function',
      name: 'git_diff',
      description: 'Inspect a git diff between two refs inside the current workspace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          baseRef: { type: 'string' },
          targetRef: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['baseRef'],
      },
    },
    {
      type: 'function',
      name: 'git_show_file',
      description: 'Read a file from a specific git ref without changing the workspace checkout.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['ref', 'path'],
      },
    },
  ]

  return {
    tools,
    execute: async (call) => {
      const args = call.arguments ? JSON.parse(call.arguments) as Record<string, unknown> : {}
      logger.debug( {
        tool: call.name,
        workspacePath: rootPath,
      },'Executing OpenAI repo tool')

      switch (call.name) {
        case 'list_directory':
          return listDirectory(rootPath, args)
        case 'glob_search':
          return globSearch(rootPath, args)
        case 'grep_search':
          return grepSearch(rootPath, args)
        case 'read_file':
          return readFile(rootPath, args)
        case 'git_diff':
          return gitDiff(rootPath, args)
        case 'git_show_file':
          return gitShowFile(rootPath, args)
        default:
          throw new Error(`Unknown OpenAI repo tool: ${call.name}`)
      }
    },
  }
}
