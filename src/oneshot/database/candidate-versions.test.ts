import { describe, expect, it, vi } from 'vitest'
import { OneShotCandidateVersionsDB } from './candidate-versions.js'

const input = {
  oneshotRunId: 133,
  candidateVersion: 2,
  candidateCommitSha: '2222222222222222222222222222222222222222',
  previousCandidateCommitSha: '1111111111111111111111111111111111111111',
  targetFiles: ['src/AuthService.java'],
  metadata: { changedFiles: ['src/AuthService.java'] },
  leaseScope: 'run-worktree:133',
  fencingToken: 12,
}

function buildDb(query = vi.fn()) {
  const connection = {
    query,
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  }
  const pool = {
    getConnection: vi.fn().mockResolvedValue(connection),
    query,
  }
  return {
    db: new OneShotCandidateVersionsDB(pool as never),
    connection,
    pool,
    query,
  }
}

describe('OneShotCandidateVersionsDB', () => {
  it('reads the current candidate-version row', async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          oneshot_run_id: input.oneshotRunId,
          candidate_version: input.candidateVersion,
          candidate_commit_sha: input.candidateCommitSha,
          previous_candidate_commit_sha: input.previousCandidateCommitSha,
          status: 'current',
          superseded_by_candidate_version: null,
          target_files_json: JSON.stringify(input.targetFiles),
          metadata_json: JSON.stringify(input.metadata),
          finalized_at: new Date('2026-05-05T12:00:00.000Z'),
        },
      ],
    ])
    const { db } = buildDb(query)

    await expect(db.getCurrentCandidate(input.oneshotRunId)).resolves.toMatchObject({
      oneshotRunId: input.oneshotRunId,
      candidateVersion: input.candidateVersion,
      candidateCommitSha: input.candidateCommitSha,
      status: 'current',
      targetFiles: input.targetFiles,
      metadata: input.metadata,
    })
    expect(String(query.mock.calls[0][0])).toContain("status = 'current'")
  })

  it('reads a specific candidate-version row', async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          oneshot_run_id: input.oneshotRunId,
          candidate_version: input.candidateVersion,
          candidate_commit_sha: input.candidateCommitSha,
          previous_candidate_commit_sha: input.previousCandidateCommitSha,
          status: 'superseded',
          superseded_by_candidate_version: 3,
          target_files_json: input.targetFiles,
          metadata_json: input.metadata,
          finalized_at: null,
        },
      ],
    ])
    const { db } = buildDb(query)

    await expect(db.getCandidate(input.oneshotRunId, input.candidateVersion)).resolves.toMatchObject({
      candidateVersion: input.candidateVersion,
      candidateCommitSha: input.candidateCommitSha,
      status: 'superseded',
      supersededByCandidateVersion: 3,
    })
    expect(query.mock.calls[0][1]).toEqual([input.oneshotRunId, input.candidateVersion])
  })

  it('finalizes a candidate only while the matching lease token is current', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: input.oneshotRunId }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ 1: 1 }]])
    const { db, connection } = buildDb(query)

    await expect(db.finalizeCandidate(input)).resolves.toBe(true)

    expect(connection.beginTransaction).toHaveBeenCalledOnce()
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
    expect(String(query.mock.calls[0][0])).toContain('FOR UPDATE')
    expect(String(query.mock.calls[1][0])).toContain('expires_at > NOW(6)')
    expect(String(query.mock.calls[4][0])).toContain(
      'FROM oneshot_workspace_leases',
    )
    expect(query.mock.calls[4][1]).toEqual([
      input.oneshotRunId,
      input.candidateVersion,
      input.candidateCommitSha,
      input.previousCandidateCommitSha,
      JSON.stringify(input.targetFiles),
      JSON.stringify(input.metadata),
      input.leaseScope,
      input.fencingToken,
    ])
    expect(String(query.mock.calls[5][0])).toContain('expires_at > NOW(6)')
    expect(String(query.mock.calls[6][0])).toContain('FOR UPDATE')
  })

  it('returns false when the lease token is no longer current', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: input.oneshotRunId }]])
      .mockResolvedValueOnce([[]])
    const { db, connection } = buildDb(query)

    await expect(db.finalizeCandidate(input)).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('does not make an older candidate current after a newer current candidate exists', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: input.oneshotRunId }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ candidate_version: 3 }]])
    const { db } = buildDb(query)

    await expect(db.finalizeCandidate(input)).resolves.toBe(false)
    expect(query).toHaveBeenCalledTimes(3)
    expect(String(query.mock.calls[0][0])).toContain('FOR UPDATE')
    expect(String(query.mock.calls[2][0])).toContain('FOR UPDATE')
  })

  it('refuses to replace an existing candidate version with a different SHA', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: input.oneshotRunId }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [{ candidate_commit_sha: '3333333333333333333333333333333333333333' }],
      ])
    const { db, connection } = buildDb(query)

    await expect(db.finalizeCandidate(input)).rejects.toThrow(
      /already points to 3333333333333333333333333333333333333333/,
    )
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
  })

  it('rolls back and returns false if the lease is lost after candidate writes', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ id: input.oneshotRunId }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])
      .mockResolvedValueOnce([[{ candidate_version: 1 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]])
    const { db, connection } = buildDb(query)

    await expect(db.finalizeCandidate(input)).resolves.toBe(false)
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
    expect(String(query.mock.calls[6][0])).toContain('expires_at > NOW(6)')
  })

  it('backfills a missing current candidate row from active run state', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const { db, connection } = buildDb(query)

    await expect(
      db.backfillCurrentCandidate({
        oneshotRunId: input.oneshotRunId,
        candidateVersion: input.candidateVersion,
        candidateCommitSha: input.candidateCommitSha,
        targetFiles: input.targetFiles,
        metadata: { source: 'test_backfill' },
      }),
    ).resolves.toBe(true)

    expect(connection.commit).toHaveBeenCalledOnce()
    expect(String(query.mock.calls[0][0])).toContain("status = 'current'")
    expect(String(query.mock.calls[2][0])).toContain(
      'ON DUPLICATE KEY UPDATE',
    )
    expect(query.mock.calls[2][1]).toEqual([
      input.oneshotRunId,
      input.candidateVersion,
      input.candidateCommitSha,
      JSON.stringify(input.targetFiles),
      JSON.stringify({ source: 'test_backfill' }),
    ])
  })

  it('accepts an existing matching current candidate row during backfill', async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          candidate_version: input.candidateVersion,
          candidate_commit_sha: input.candidateCommitSha,
        },
      ],
    ])
    const { db, connection } = buildDb(query)

    await expect(
      db.backfillCurrentCandidate({
        oneshotRunId: input.oneshotRunId,
        candidateVersion: input.candidateVersion,
        candidateCommitSha: input.candidateCommitSha,
      }),
    ).resolves.toBe(true)

    expect(query).toHaveBeenCalledTimes(1)
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('rejects a candidate backfill when the version exists at a different SHA', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [{ candidate_commit_sha: '3333333333333333333333333333333333333333' }],
      ])
    const { db, connection } = buildDb(query)

    await expect(
      db.backfillCurrentCandidate({
        oneshotRunId: input.oneshotRunId,
        candidateVersion: input.candidateVersion,
        candidateCommitSha: input.candidateCommitSha,
      }),
    ).resolves.toBe(false)

    expect(query).toHaveBeenCalledTimes(2)
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('adopts a newer PR head as the current candidate without leaving stale current rows', async () => {
    const prHeadSha = '4444444444444444444444444444444444444444'
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            current_implementation_version: 2,
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            candidate_version: 2,
            candidate_commit_sha: input.candidateCommitSha,
            target_files_json: JSON.stringify(input.targetFiles),
          },
        ],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const { db, connection } = buildDb(query)

    await expect(
      db.adoptCurrentCandidate({
        oneshotRunId: input.oneshotRunId,
        candidateCommitSha: prHeadSha,
        metadata: {
          source: 'github_slash_command_replan',
          pullNumber: 2454,
        },
      }),
    ).resolves.toEqual({
      adopted: true,
      candidateVersion: 3,
      candidateCommitSha: prHeadSha,
      previousCandidateCommitSha: input.candidateCommitSha,
      targetFiles: input.targetFiles,
    })

    expect(connection.commit).toHaveBeenCalledOnce()
    expect(String(query.mock.calls[0][0])).toContain('FOR UPDATE')
    expect(String(query.mock.calls[1][0])).toContain("status = 'current'")
    expect(String(query.mock.calls[2][0])).toContain("status = 'superseded'")
    expect(query.mock.calls[2][1]).toEqual([
      3,
      input.oneshotRunId,
      3,
    ])
    expect(String(query.mock.calls[3][0])).toContain(
      'ON DUPLICATE KEY UPDATE',
    )
    expect(query.mock.calls[3][1]).toEqual([
      input.oneshotRunId,
      3,
      prHeadSha,
      input.candidateCommitSha,
      JSON.stringify(input.targetFiles),
      JSON.stringify({
        source: 'github_slash_command_replan',
        pullNumber: 2454,
      }),
    ])
  })
})
