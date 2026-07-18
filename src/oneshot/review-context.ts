import * as fs from 'fs/promises'
import * as path from 'path'
import {
  getPlanImpactedFiles,
  type OneShotPlan,
} from './schema/plan.js'

const MAX_REVIEW_CONTEXT_FILES = 20
const MAX_REVIEW_CONTEXT_BYTES = 150 * 1024

export interface ReviewContextFile {
  path: string
  exists: boolean
  included: boolean
  truncated: boolean
  sizeBytes: number
  content?: string
  note?: string
}

export interface ReviewContext {
  impactedFiles: ReviewContextFile[]
  totalBytesIncluded: number
  truncated: boolean
  truncationNote?: string
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replaceAll('\\', '/')
}

export async function buildReviewContext(
  workspacePath: string,
  plan: Pick<OneShotPlan, 'specs'>,
): Promise<ReviewContext> {
  const impactedFilePaths = getPlanImpactedFiles(plan)
  const selectedFiles = impactedFilePaths.slice(0, MAX_REVIEW_CONTEXT_FILES)
  const omittedCount = Math.max(impactedFilePaths.length - selectedFiles.length, 0)
  const impactedFiles: ReviewContextFile[] = []
  let totalBytesIncluded = 0
  let truncated = omittedCount > 0

  for (const rawFilePath of selectedFiles) {
    const relativePath = normalizeRelativePath(rawFilePath)
    const absolutePath = path.resolve(workspacePath, relativePath)
    if (!absolutePath.startsWith(path.resolve(workspacePath))) {
      impactedFiles.push({
        path: relativePath,
        exists: false,
        included: false,
        truncated: false,
        sizeBytes: 0,
        note: 'Skipped because the path resolved outside the OneShot workspace.',
      })
      truncated = true
      continue
    }

    try {
      const buffer = await fs.readFile(absolutePath)
      const remainingBytes = MAX_REVIEW_CONTEXT_BYTES - totalBytesIncluded

      if (remainingBytes <= 0) {
        impactedFiles.push({
          path: relativePath,
          exists: true,
          included: false,
          truncated: true,
          sizeBytes: buffer.byteLength,
          note: 'Skipped because the review context byte budget was exhausted.',
        })
        truncated = true
        continue
      }

      const slice = buffer.subarray(0, remainingBytes)
      const included = slice.byteLength > 0
      const fileTruncated = slice.byteLength < buffer.byteLength

      impactedFiles.push({
        path: relativePath,
        exists: true,
        included,
        truncated: fileTruncated,
        sizeBytes: buffer.byteLength,
        content: included ? slice.toString('utf8') : undefined,
        note: fileTruncated
          ? 'File content was truncated to fit the review context byte budget.'
          : undefined,
      })

      totalBytesIncluded += slice.byteLength
      truncated = truncated || fileTruncated
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code ?? '')
        : ''

      impactedFiles.push({
        path: relativePath,
        exists: false,
        included: false,
        truncated: false,
        sizeBytes: 0,
        note: code === 'ENOENT'
          ? 'Referenced file does not exist at the frozen base commit.'
          : 'Failed to load the referenced file from the frozen workspace.',
      })
    }
  }

  const truncationDetails: string[] = []
  if (omittedCount > 0) {
    truncationDetails.push(
      `${omittedCount} impacted file(s) were omitted after the first ${MAX_REVIEW_CONTEXT_FILES}.`,
    )
  }
  if (totalBytesIncluded >= MAX_REVIEW_CONTEXT_BYTES) {
    truncationDetails.push(
      `Included file content hit the ${MAX_REVIEW_CONTEXT_BYTES} byte budget.`,
    )
  }

  return {
    impactedFiles,
    totalBytesIncluded,
    truncated,
    truncationNote: truncationDetails.length > 0 ? truncationDetails.join(' ') : undefined,
  }
}
