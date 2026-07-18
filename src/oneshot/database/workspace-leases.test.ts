import { describe, expect, it, vi } from 'vitest'
import { OneShotWorkspaceLeasesDB } from './workspace-leases.js'

describe('OneShotWorkspaceLeasesDB', () => {
  it('acquires leases with server-side timestamps and monotonic fencing tokens', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ owner_task_arn: null, expired: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ token: 7 }]])
    const db = new OneShotWorkspaceLeasesDB({ query } as never)

    const lease = await db.acquireLease({
      scope: 'run-worktree:133',
      ownerTaskArn: 'task-arn',
      ownerStage: 'implementation',
      ttlSeconds: 2700,
      metadata: { runId: 133 },
    })

    expect(lease).toEqual({
      scope: 'run-worktree:133',
      fencingToken: 7,
      ownerTaskArn: 'task-arn',
      ownerStage: 'implementation',
    })
    expect(String(query.mock.calls[2][0])).toContain(
      'fencing_token = LAST_INSERT_ID(fencing_token + 1)',
    )
    expect(String(query.mock.calls[2][0])).toContain('heartbeat_at = NOW(6)')
    expect(String(query.mock.calls[2][0])).toContain(
      'expires_at = DATE_ADD(NOW(6), INTERVAL ? SECOND)',
    )
    expect(query.mock.calls[2][1]).toEqual([
      'task-arn',
      'implementation',
      2700,
      JSON.stringify({ runId: 133 }),
      'run-worktree:133',
    ])
  })

  it('heartbeats only the current unexpired fencing token', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const db = new OneShotWorkspaceLeasesDB({ query } as never)

    await expect(
      db.heartbeatLease('repo-cache:core-app', 9, 2700),
    ).resolves.toBe(true)

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE scope = ?\n         AND fencing_token = ?\n         AND expires_at > NOW(6)'),
      [2700, 'repo-cache:core-app', 9],
    )
  })
})
