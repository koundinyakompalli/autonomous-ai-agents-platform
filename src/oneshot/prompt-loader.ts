import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createS3Client } from '../utils/awsClients.js'
import { createLogger } from '../utils/logger.js'
import type { OneShotSharedConfig } from './config.js'
import type { PromptManifest } from './prompt-types.js'

const logger = createLogger('oneshot-prompt-loader')

export interface IPromptLoader {
  loadPrompt(logicalName: string): Promise<string>
  loadGuardrail(logicalName: string): Promise<string>
  invalidateCache(): void
}

interface CacheEntry {
  content: string
  loadedAt: number
}

// ---------------------------------------------------------------------------
// S3 implementation — manifest-pinned, VersionId-exact, TTL cached
// ---------------------------------------------------------------------------

export class S3PromptLoader implements IPromptLoader {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly bucket: string
  private readonly manifestKey: string
  private readonly manifestVersionId: string
  private readonly cacheTtlMs: number
  private readonly s3Client: S3Client

  constructor(config: {
    bucket: string
    manifestKey: string
    manifestVersionId: string
    cacheTtlMs: number
    s3Client?: S3Client
    region?: string
  }) {
    this.bucket = config.bucket
    this.manifestKey = config.manifestKey
    this.manifestVersionId = config.manifestVersionId
    this.cacheTtlMs = config.cacheTtlMs
    this.s3Client = config.s3Client ?? createS3Client({ region: config.region ?? 'us-east-2' })
  }

  async loadPrompt(logicalName: string): Promise<string> {
    const assetKey = `prompt:${logicalName}`
    return this.loadAsset(assetKey, logicalName, 'prompts')
  }

  async loadGuardrail(logicalName: string): Promise<string> {
    const assetKey = `guardrail:${logicalName}`
    return this.loadAsset(assetKey, logicalName, 'guardrails')
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  private async loadAsset(cachePrefix: string, logicalName: string, assetType: 'prompts' | 'guardrails'): Promise<string> {
    const manifest = await this.loadManifest()
    const qualifiedName = `${assetType}/${logicalName}`
    const ref = manifest.assets[qualifiedName]
    if (!ref) {
      throw new Error(
        `Prompt asset "${qualifiedName}" not found in manifest (version=${this.manifestVersionId}). ` +
        `Available assets: ${Object.keys(manifest.assets).join(', ')}`,
      )
    }

    const cacheKey = `${cachePrefix}:${ref.versionId}`
    const cached = this.cacheGet(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    const content = await this.fetchS3Object(ref.key, ref.versionId)
    this.cache.set(cacheKey, { content, loadedAt: Date.now() })
    return content
  }

  private async loadManifest(): Promise<PromptManifest> {
    const cacheKey = `manifest:${this.manifestVersionId}`
    const cached = this.cacheGet(cacheKey)
    if (cached !== undefined) {
      return JSON.parse(cached) as PromptManifest
    }

    const raw = await this.fetchS3Object(this.manifestKey, this.manifestVersionId)
    this.cache.set(cacheKey, { content: raw, loadedAt: Date.now() })
    return JSON.parse(raw) as PromptManifest
  }

  private async fetchS3Object(key: string, versionId: string): Promise<string> {
    logger.debug( { bucket: this.bucket, key, versionId },'Fetching S3 prompt asset')

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
      }),
    )

    if (!response.Body) {
      throw new Error(`Empty body for S3 prompt asset ${this.bucket}/${key} (versionId=${versionId})`)
    }

    return response.Body.transformToString()
  }

  private cacheGet(key: string): string | undefined {
    const entry = this.cache.get(key)
    if (!entry) {
      return undefined
    }
    if (Date.now() - entry.loadedAt > this.cacheTtlMs) {
      this.cache.delete(key)
      return undefined
    }
    return entry.content
  }
}

// ---------------------------------------------------------------------------
// Local implementation — reads from repo-root directory, no caching needed
// ---------------------------------------------------------------------------

export class LocalPromptLoader implements IPromptLoader {
  private readonly basePath: string

  constructor(config: { localPath: string }) {
    this.basePath = config.localPath
  }

  async loadPrompt(logicalName: string): Promise<string> {
    const filePath = path.resolve(this.basePath, 'prompts', `${logicalName}.md`)
    return this.readFile(filePath)
  }

  async loadGuardrail(logicalName: string): Promise<string> {
    const filePath = path.resolve(this.basePath, 'guardrails', `${logicalName}.md`)
    return this.readFile(filePath)
  }

  invalidateCache(): void {
    // no-op: local reads don't cache
  }

  private async readFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new Error(`Prompt asset not found at ${filePath}`)
      }
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — selects implementation based on config.promptSource
// ---------------------------------------------------------------------------

export function createPromptLoader(
  config: OneShotSharedConfig,
  s3Client?: S3Client,
): IPromptLoader {
  if (config.promptSource === 's3') {
    if (!config.promptManifestVersionId) {
      throw new Error('promptManifestVersionId is required when promptSource is s3')
    }
    return new S3PromptLoader({
      bucket: config.promptBucket,
      manifestKey: config.promptManifestKey,
      manifestVersionId: config.promptManifestVersionId,
      cacheTtlMs: config.promptCacheTtlMs,
      s3Client,
      region: config.region,
    })
  }

  return new LocalPromptLoader({
    localPath: config.promptLocalPath,
  })
}
