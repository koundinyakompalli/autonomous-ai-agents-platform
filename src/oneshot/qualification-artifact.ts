import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { OneShotDatabase } from './database/index.js'
import type { OneShotProcessingMode } from './processing-mode.js'

type ArtifactDatabase = Pick<OneShotDatabase, 'artifacts'>

export interface RunQualificationSummary {
  ticketSummary?: string
  jiraLabels?: string[]
  processingMode?: OneShotProcessingMode
  repoSelectionMetadata?: Record<string, unknown> | null
}

const PROCESSING_MODES = new Set<OneShotProcessingMode>([
  'security_wiz',
  'sonar_autofix',
  'standard',
])

function isProcessingMode(value: unknown): value is OneShotProcessingMode {
  return (
    typeof value === 'string' &&
    PROCESSING_MODES.has(value as OneShotProcessingMode)
  )
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

export async function loadRunTicketSummary(
  oneShotDb: ArtifactDatabase,
  s3Client: Pick<S3Client, 'send'>,
  runId: number,
): Promise<string | null> {
  const summary = await loadRunQualificationSummary(oneShotDb, s3Client, runId)
  return summary?.ticketSummary ?? null
}

export async function loadRunQualificationSummary(
  oneShotDb: ArtifactDatabase,
  s3Client: Pick<S3Client, 'send'>,
  runId: number,
): Promise<RunQualificationSummary | null> {
  try {
    const artifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'qualification')
    if (!artifact) {
      return null
    }

    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: artifact.s3_bucket,
        Key: artifact.s3_key,
      }),
    )

    if (!response.Body) {
      return null
    }

    const raw = await response.Body.transformToString()
    const parsed = JSON.parse(raw) as {
      ticketSummary?: unknown
      jiraLabels?: unknown
      processingMode?: unknown
      repoSelectionMetadata?: unknown
    }
    return {
      ticketSummary:
        typeof parsed.ticketSummary === 'string' && parsed.ticketSummary.trim().length > 0
          ? parsed.ticketSummary.trim()
          : undefined,
      jiraLabels: stringArray(parsed.jiraLabels),
      processingMode: isProcessingMode(parsed.processingMode)
        ? parsed.processingMode
        : undefined,
      repoSelectionMetadata:
        parsed.repoSelectionMetadata &&
        typeof parsed.repoSelectionMetadata === 'object' &&
        !Array.isArray(parsed.repoSelectionMetadata)
          ? (parsed.repoSelectionMetadata as Record<string, unknown>)
          : null,
    }
  } catch {
    return null
  }
}
