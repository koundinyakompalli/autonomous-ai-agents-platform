import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  discoverLedgerWorkspaceRepos,
  selectLedgerWorkspaceRepos,
} from './LEDGERAgent.js'

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

function createTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-agent-test-'))
  tempRoots.push(root)
  return root
}

describe('discoverLedgerWorkspaceRepos', () => {
  it('discovers branch-aware workspace repos from task symlinks', () => {
    const root = createTempWorkspace()
    const workspace = path.join(root, 'repositories', 'tasks', 'task-123')
    const targetsRoot = path.join(root, 'targets')

    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(path.join(targetsRoot, 'core-app'), { recursive: true })
    fs.mkdirSync(path.join(targetsRoot, 'batch-jobs'), { recursive: true })
    fs.mkdirSync(path.join(targetsRoot, 'config'), { recursive: true })

    fs.symlinkSync(path.join(targetsRoot, 'core-app'), path.join(workspace, 'core-app'))
    fs.symlinkSync(path.join(targetsRoot, 'batch-jobs'), path.join(workspace, 'batch-jobs'))
    fs.symlinkSync(path.join(targetsRoot, 'config'), path.join(workspace, 'config'))
    fs.mkdirSync(path.join(workspace, '.ignored'))

    expect(discoverLedgerWorkspaceRepos(workspace)).toEqual([
      'batch-jobs',
      'core-app',
    ])
  })

  it('infers the canonical repo name from a direct branch worktree path', () => {
    expect(
      discoverLedgerWorkspaceRepos('/mnt/efs/specter-repo/repositories/core-app/3.20'),
    ).toEqual(['core-app'])
  })
})

describe('selectLedgerWorkspaceRepos', () => {
  it('keeps analysis constrained to repos actually provisioned in the workspace', () => {
    const selection = selectLedgerWorkspaceRepos(
      'Need a queue routing update and API integration changes with a new extract feed.',
      ['core-app', 'batch-jobs', 'client-services'],
    )

    expect(selection.selectedRepos).toEqual([
      'core-app',
      'batch-jobs',
      'client-services',
    ])
    expect(selection.unavailableExpectedRepos).toEqual([
      'cp-medhok-data-extract-monorepo',
    ])
  })

  it('supports legacy repo aliases but reports missing optional repos instead of assuming them', () => {
    const selection = selectLedgerWorkspaceRepos(
      'Data load change with downstream datamart impact.',
      ['cp-medhok-monorepo'],
    )

    expect(selection.selectedRepos).toEqual(['cp-medhok-monorepo'])
    expect(selection.unavailableExpectedRepos).toEqual([
      'cp-medhok-data-import-monorepo',
      'cp-medhok-bi-datamart-monorepo',
    ])
  })
})
