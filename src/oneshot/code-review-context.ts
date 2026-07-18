import * as fs from 'fs/promises'
import * as path from 'path'
import { runGitCommandWithTruncatedOutput } from './git.js'

const MAX_CODE_REVIEW_CONTEXT_FILES = 30
const MAX_CODE_REVIEW_CONTEXT_BYTES = 200 * 1024
const MAX_DIFF_BYTES = 100 * 1024

export interface CodeReviewContextFile {
  path: string
  included: boolean
  truncated: boolean
  sizeBytes: number
  content?: string
  note?: string
}

export interface CodeReviewContext {
  diff: string
  diffTruncated: boolean
  changedFiles: CodeReviewContextFile[]
  totalBytesIncluded: number
  truncated: boolean
  truncationNote?: string
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replaceAll('\\', '/')
}

export async function buildCodeReviewContext(
  workspacePath: string,
  baseCommitSha: string,
  changedFilePaths: string[],
): Promise<CodeReviewContext> {
  const diffResult = await runGitCommandWithTruncatedOutput(
    `git diff ${JSON.stringify(baseCommitSha)} HEAD`,
    workspacePath,
    MAX_DIFF_BYTES,
  )

  let diff = diffResult.stdout
  let diffTruncated = diffResult.stdoutTruncated
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES)
    diffTruncated = true
  }

  const selectedFiles = changedFilePaths.slice(0, MAX_CODE_REVIEW_CONTEXT_FILES)
  const omittedCount = Math.max(changedFilePaths.length - selectedFiles.length, 0)
  const changedFiles: CodeReviewContextFile[] = []
  let totalBytesIncluded = 0
  let truncated = omittedCount > 0 || diffTruncated

  for (const rawFilePath of selectedFiles) {
    const relativePath = normalizeRelativePath(rawFilePath)
    const absolutePath = path.resolve(workspacePath, relativePath)
    if (!absolutePath.startsWith(path.resolve(workspacePath))) {
      changedFiles.push({
        path: relativePath,
        included: false,
        truncated: false,
        sizeBytes: 0,
        note: 'Skipped: path resolved outside the workspace.',
      })
      truncated = true
      continue
    }

    try {
      const buffer = await fs.readFile(absolutePath)
      const remainingBytes = MAX_CODE_REVIEW_CONTEXT_BYTES - totalBytesIncluded

      if (remainingBytes <= 0) {
        changedFiles.push({
          path: relativePath,
          included: false,
          truncated: true,
          sizeBytes: buffer.byteLength,
          note: 'Skipped: code review context byte budget exhausted.',
        })
        truncated = true
        continue
      }

      const slice = buffer.subarray(0, remainingBytes)
      const included = slice.byteLength > 0
      const fileTruncated = slice.byteLength < buffer.byteLength

      changedFiles.push({
        path: relativePath,
        included,
        truncated: fileTruncated,
        sizeBytes: buffer.byteLength,
        content: included ? slice.toString('utf8') : undefined,
        note: fileTruncated
          ? 'File content was truncated to fit the code review context byte budget.'
          : undefined,
      })

      totalBytesIncluded += slice.byteLength
      truncated = truncated || fileTruncated
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code ?? '')
        : ''

      changedFiles.push({
        path: relativePath,
        included: false,
        truncated: false,
        sizeBytes: 0,
        note: code === 'ENOENT'
          ? 'File was deleted in implementation.'
          : 'Failed to read file from workspace.',
      })
    }
  }

  const truncationDetails: string[] = []
  if (diffTruncated) {
    truncationDetails.push(
      `Diff was truncated to ${MAX_DIFF_BYTES} bytes.`,
    )
  }
  if (omittedCount > 0) {
    truncationDetails.push(
      `${omittedCount} changed file(s) omitted after the first ${MAX_CODE_REVIEW_CONTEXT_FILES}.`,
    )
  }
  if (totalBytesIncluded >= MAX_CODE_REVIEW_CONTEXT_BYTES) {
    truncationDetails.push(
      `File content hit the ${MAX_CODE_REVIEW_CONTEXT_BYTES} byte budget.`,
    )
  }

  return {
    diff,
    diffTruncated,
    changedFiles,
    totalBytesIncluded,
    truncated,
    truncationNote: truncationDetails.length > 0 ? truncationDetails.join(' ') : undefined,
  }
}
