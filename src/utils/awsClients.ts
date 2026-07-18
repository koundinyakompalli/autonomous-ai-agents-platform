import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function getOptionalBooleanEnv(name: string): boolean | undefined {
  const value = getOptionalEnv(name)?.toLowerCase()
  if (value === undefined) {
    return undefined
  }

  return value === '1' || value === 'true' || value === 'yes'
}

export function createS3Client(config: S3ClientConfig = {}): S3Client {
  const endpoint = getOptionalEnv('AWS_ENDPOINT_URL_S3') ?? getOptionalEnv('AWS_ENDPOINT_URL')
  const forcePathStyle =
    getOptionalBooleanEnv('AWS_S3_FORCE_PATH_STYLE')
    ?? getOptionalBooleanEnv('S3_FORCE_PATH_STYLE')
    ?? (endpoint ? true : undefined)

  return new S3Client({
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
    ...config,
  })
}
