import { describe, expect, it, vi } from 'vitest'
import { OneShotWorkspaceStateDB } from './workspace-state.js'

describe('OneShotWorkspaceStateDB', () => {
  it('preserves base and current candidate metadata when prepare upserts omit them', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 2 }])
    const db = new OneShotWorkspaceStateDB({ query } as never)

    await expect(
      db.upsertStateWithLease({
        oneshotRunId: 133,
        workspaceMode: 'v2',
        workspacePath: '/mnt/efs/oneshot/133/worktree',
        statePath: '/mnt/efs/oneshot/133/state',
        workspacePhase: 'code-reviewer',
        workspaceHeadSha: '2222222222222222222222222222222222222222',
        leaseScope: 'run-worktree:133',
        fencingToken: 12,
      }),
    ).resolves.toBe(true)

    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('base_commit_sha = COALESCE(VALUES(base_commit_sha), base_commit_sha)')
    expect(sql).toContain(
      'current_candidate_version = COALESCE(VALUES(current_candidate_version), current_candidate_version)',
    )
    expect(sql).toContain(
      'current_candidate_sha = COALESCE(VALUES(current_candidate_sha), current_candidate_sha)',
    )
  })

  it('updates only provided fields while preserving omitted workspace state', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const db = new OneShotWorkspaceStateDB({ query } as never)

    await expect(
      db.conditionalUpdateWithLease({
        oneshotRunId: 133,
        leaseScope: 'run-worktree:133',
        fencingToken: 12,
        workspacePhase: 'candidate_finalized',
      }),
    ).resolves.toBe(true)

    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('workspace_phase = ?')
    expect(sql).not.toContain('workspace_head_sha = ?')
    expect(sql).not.toContain('current_candidate_version = ?')
    expect(sql).not.toContain('current_candidate_sha = ?')
    expect(query.mock.calls[0][1]).toEqual([
      'candidate_finalized',
      133,
      'run-worktree:133',
      12,
    ])
  })

  it('allows explicit nulls for provided fields under the lease guard', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const db = new OneShotWorkspaceStateDB({ query } as never)

    await expect(
      db.conditionalUpdateWithLease({
        oneshotRunId: 133,
        leaseScope: 'run-worktree:133',
        fencingToken: 12,
        currentCandidateSha: null,
        metadata: null,
      }),
    ).resolves.toBe(true)

    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('current_candidate_sha = ?')
    expect(sql).toContain('metadata_json = ?')
    expect(query.mock.calls[0][1]).toEqual([
      null,
      null,
      133,
      'run-worktree:133',
      12,
    ])
  })
})
