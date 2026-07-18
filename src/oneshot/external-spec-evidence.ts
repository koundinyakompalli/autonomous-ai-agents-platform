import { createHash } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { createLogger } from '../utils/logger.js'
import type { ExternalSpecEvidence, ExternalSpecEvidenceSummary } from './readiness.js'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_BYTES = 512_000
const DEFAULT_MAX_URLS = 5
const logger = createLogger('oneshot-external-spec-evidence')

type ExternalSpecErrorCode =
  | 'cache_parse_failed'
  | 'cache_read_failed'
  | 'fetch_timeout'
  | 'fetch_http_error'
  | 'fetch_failed'
  | 'insufficient_external_spec_evidence'
  | 'cache_write_failed'

class ExternalSpecEvidenceError extends Error {
  constructor(
    readonly code: ExternalSpecErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ExternalSpecEvidenceError'
  }
}

function errorCode(error: unknown): ExternalSpecErrorCode | null {
  return error instanceof ExternalSpecEvidenceError ? error.code : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type S3Like = Pick<S3Client, 'send'>

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
}>

interface ExternalSpecCacheDocument {
  schemaVersion: 1
  url: string
  cachedAt: string
  expiresAt: string
  evidence: ExternalSpecEvidenceSummary
}

function nowIso(now: Date): string {
  return now.toISOString()
}

function plusMsIso(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString()
}

function isCacheFresh(doc: ExternalSpecCacheDocument, now: Date): boolean {
  return new Date(doc.expiresAt).getTime() > now.getTime()
}

function isNoSuchKey(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const maybe = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } }
  return maybe.name === 'NoSuchKey' ||
    maybe.Code === 'NoSuchKey' ||
    maybe.code === 'NoSuchKey' ||
    maybe.$metadata?.httpStatusCode === 404
}

async function readCachedSpecEvidence(input: {
  s3Client: S3Like
  bucket: string
  key: string
  now: Date
}): Promise<ExternalSpecCacheDocument | null> {
  try {
    const response = await input.s3Client.send(new GetObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
    }))
    const raw = await response.Body?.transformToString()
    if (!raw) {
      return null
    }
    let parsed: ExternalSpecCacheDocument
    try {
      parsed = JSON.parse(raw) as ExternalSpecCacheDocument
    } catch (error) {
      logger.warn(
        {
          bucket: input.bucket,
          key: input.key,
          error: errorMessage(error),
        },
        'Failed to parse cached external spec evidence',
      )
      throw new ExternalSpecEvidenceError(
        'cache_parse_failed',
        `cache_parse_failed: ${errorMessage(error)}`,
      )
    }
    if (parsed.schemaVersion !== 1 || !parsed.evidence || !isCacheFresh(parsed, input.now)) {
      return null
    }
    return parsed
  } catch (error) {
    if (error instanceof ExternalSpecEvidenceError) {
      throw error
    }
    if (isNoSuchKey(error)) {
      return null
    }
    logger.warn(
      {
        bucket: input.bucket,
        key: input.key,
        error: errorMessage(error),
      },
      'Failed to read cached external spec evidence',
    )
    throw new ExternalSpecEvidenceError(
      'cache_read_failed',
      `cache_read_failed: ${errorMessage(error)}`,
    )
  }
}

async function writeCachedSpecEvidence(input: {
  s3Client: S3Like
  bucket: string
  key: string
  document: ExternalSpecCacheDocument
}): Promise<void> {
  await input.s3Client.send(new PutObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    Body: JSON.stringify(input.document, null, 2),
    ContentType: 'application/json',
  }))
}

function uniqueMatches(lines: string[], matcher: RegExp, limit: number): string[] {
  const matches: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!matcher.test(line)) {
      continue
    }
    const normalized = line.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    matches.push(normalized.slice(0, 500))
    if (matches.length >= limit) {
      break
    }
  }
  return matches
}

function summarizeSpecText(input: {
  url: string
  text: string
  fetchedAt: string
}): ExternalSpecEvidenceSummary {
  const limited = input.text.slice(0, DEFAULT_MAX_BYTES)
  const lines = limited
    .split(/\r?\n/)
    .map((line) => line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  return {
    schemaVersion: 1,
    url: input.url,
    fetchedAt: input.fetchedAt,
    sourceBytes: Buffer.byteLength(limited, 'utf8'),
    contentHash: createHash('sha256').update(limited).digest('hex'),
    profileRequirements: uniqueMatches(lines, /\b(profile|StructureDefinition|canonical|meta\.profile)\b/i, 12),
    bundleStructure: uniqueMatches(lines, /\b(Bundle|entry|resource|PackageBundle|Parameters)\b/i, 12),
    parameterContracts: uniqueMatches(lines, /\b(parameter|input|output|coverage|order|questionnaire-package)\b/i, 12),
    questionnaireRequirements: uniqueMatches(lines, /\b(Questionnaire|QuestionnaireResponse|answer|item|question)\b/i, 12),
    operationContracts: uniqueMatches(lines, /\b(operation|endpoint|\$[a-z-]+|POST|GET)\b/i, 12),
    notes: uniqueMatches(lines, /\b(MUST|SHALL|required|required\ binding|cardinality|invariant)\b/i, 16),
  }
}

function hasMeaningfulSpecEvidence(evidence: ExternalSpecEvidenceSummary): boolean {
  const buckets = [
    evidence.profileRequirements,
    evidence.bundleStructure,
    evidence.parameterContracts,
    evidence.questionnaireRequirements,
    evidence.operationContracts,
  ]
  const nonEmptyBuckets = buckets.filter((bucket) => bucket.length > 0).length
  const hasContractOrProfile =
    evidence.profileRequirements.length > 0 ||
    evidence.parameterContracts.length > 0 ||
    evidence.operationContracts.length > 0
  return nonEmptyBuckets >= 2 || (hasContractOrProfile && evidence.notes.length > 0)
}

async function fetchSpecText(input: {
  url: string
  fetchImpl: FetchLike
  timeoutMs: number
  maxBytes: number
}): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    try {
      const response = await input.fetchImpl(input.url, {
        signal: controller.signal,
        headers: {
          accept: 'application/fhir+json, application/json, text/html, text/plain;q=0.9, */*;q=0.8',
        },
      })
      if (!response.ok) {
        throw new ExternalSpecEvidenceError(
          'fetch_http_error',
          `fetch_http_error: HTTP ${response.status} ${response.statusText}`.trim(),
        )
      }
      const text = await response.text()
      return text.slice(0, input.maxBytes)
    } catch (error) {
      if (error instanceof ExternalSpecEvidenceError) {
        throw error
      }
      const isAbort = error instanceof Error && error.name === 'AbortError'
      throw new ExternalSpecEvidenceError(
        isAbort ? 'fetch_timeout' : 'fetch_failed',
        `${isAbort ? 'fetch_timeout' : 'fetch_failed'}: ${errorMessage(error)}`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveExternalSpecEvidence(input: {
  detected: ExternalSpecEvidence
  s3Client: S3Like
  bucket: string
  now?: Date
  ttlMs?: number
  timeoutMs?: number
  maxBytes?: number
  maxUrls?: number
  fetchActive?: boolean
  fetchImpl?: FetchLike
}): Promise<ExternalSpecEvidence> {
  if (input.detected.urls.length === 0) {
    return input.detected
  }
  if (!input.fetchActive) {
    return input.detected
  }

  const now = input.now ?? new Date()
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  const maxUrls = input.maxUrls ?? DEFAULT_MAX_URLS
  const fetchImpl = input.fetchImpl ?? fetch
  async function resolveEntry(
    entry: ExternalSpecEvidence['urls'][number],
    index: number,
  ): Promise<ExternalSpecEvidence['urls'][number]> {
    if (index >= maxUrls) {
      return {
        ...entry,
        status: 'unavailable' as const,
        error: `max_urls_exceeded: external spec evidence fetch capped at ${maxUrls} URL(s).`,
      }
    }

    let cacheReadError: unknown = null
    try {
      const cached = await readCachedSpecEvidence({
        s3Client: input.s3Client,
        bucket: input.bucket,
        key: entry.cacheKey,
        now,
      })
      if (cached) {
        if (hasMeaningfulSpecEvidence(cached.evidence)) {
          return {
            ...entry,
            status: 'cached' as const,
            fetchedAt: cached.evidence.fetchedAt,
            expiresAt: cached.expiresAt,
            evidence: cached.evidence,
          }
        }
      }
    } catch (error) {
      cacheReadError = error
    }

    try {
      const fetchedAt = nowIso(now)
      const text = await fetchSpecText({
        url: entry.url,
        fetchImpl,
        timeoutMs,
        maxBytes,
      })
      const evidence = summarizeSpecText({
        url: entry.url,
        text,
        fetchedAt,
      })
      if (!hasMeaningfulSpecEvidence(evidence)) {
        return {
          ...entry,
          status: 'unavailable' as const,
          error: 'insufficient_external_spec_evidence',
          fetchedAt,
          evidence,
        }
      }
      const expiresAt = plusMsIso(now, ttlMs)
      let cacheWriteError: string | null = null
      try {
        await writeCachedSpecEvidence({
          s3Client: input.s3Client,
          bucket: input.bucket,
          key: entry.cacheKey,
          document: {
            schemaVersion: 1,
            url: entry.url,
            cachedAt: fetchedAt,
            expiresAt,
            evidence,
          },
        })
      } catch (error) {
        cacheWriteError = `cache_write_failed: ${errorMessage(error)}`
        logger.warn(
          {
            bucket: input.bucket,
            key: entry.cacheKey,
            url: entry.url,
            error: errorMessage(error),
          },
          'Failed to write cached external spec evidence',
        )
      }
      return {
        ...entry,
        status: 'fetched' as const,
        fetchedAt,
        expiresAt,
        error: cacheWriteError ?? (cacheReadError ? `${errorCode(cacheReadError) ?? 'cache_read_failed'}: ${errorMessage(cacheReadError)}` : undefined),
        evidence,
      }
    } catch (error) {
      return {
        ...entry,
        status: 'unavailable' as const,
        error: error instanceof ExternalSpecEvidenceError
          ? error.message
          : `fetch_failed: ${errorMessage(error)}`,
      }
    }
  }

  const urls = await Promise.all(input.detected.urls.map(resolveEntry))
  const unavailable = urls.some((entry) => entry.status === 'unavailable')

  return {
    ...input.detected,
    urls,
    unavailable: input.detected.unavailable || unavailable,
  }
}
