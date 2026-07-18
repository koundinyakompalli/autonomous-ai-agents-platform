import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REPOSITORY_PATH, resolveRepositoryPath } from './index.js'

const ORIGINAL_ENV = { ...process.env }

describe('config repository path resolution', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key]
      }
    }

    Object.assign(process.env, ORIGINAL_ENV)
    vi.unstubAllEnvs()
  })

  it('falls back to SHARED_REPOSITORY_PATH when REPOSITORY_PATH is unset', async () => {
    delete process.env.REPOSITORY_PATH
    process.env.SHARED_REPOSITORY_PATH = '/mnt/efs/specter-repo/repositories'
    delete process.env.EFS_MOUNT_PATH

    expect(resolveRepositoryPath()).toBe('/mnt/efs/specter-repo/repositories')
  })

  it('derives the repository path from EFS_MOUNT_PATH when explicit repo env vars are unset', async () => {
    delete process.env.REPOSITORY_PATH
    delete process.env.SHARED_REPOSITORY_PATH
    process.env.EFS_MOUNT_PATH = '/mnt/efs/specter-repo'

    expect(resolveRepositoryPath()).toBe('/mnt/efs/specter-repo/repositories')
  })

  it('keeps the legacy default when no repository env vars are set', async () => {
    delete process.env.REPOSITORY_PATH
    delete process.env.SHARED_REPOSITORY_PATH
    delete process.env.EFS_MOUNT_PATH

    expect(resolveRepositoryPath() ?? DEFAULT_REPOSITORY_PATH).toBe(DEFAULT_REPOSITORY_PATH)
  })
})
