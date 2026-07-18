import type mysql from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'
import type { OneShotWorkspaceMode } from '../types.js'

export interface UpsertWorkspaceStateInput {
  oneshotRunId: number
  workspaceMode: OneShotWorkspaceMode
  workspacePath?: string | null
  statePath?: string | null
  workspacePhase?: string | null
  workspaceHeadSha?: string | null
  baseCommitSha?: string | null
  currentCandidateVersion?: number | null
  currentCandidateSha?: string | null
  lastRepoFetchAt?: Date | null
  lastRemoteHeadSha?: string | null
  metadata?: Record<string, unknown> | null
}

export interface UpsertWorkspaceStateWithLeaseInput extends UpsertWorkspaceStateInput {
  leaseScope: string
  fencingToken: number
}

export class OneShotWorkspaceStateDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  async upsertStateWithLease(input: UpsertWorkspaceStateWithLeaseInput): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_workspace_state (
         oneshot_run_id,
         workspace_mode,
         workspace_path,
         state_path,
         workspace_phase,
         workspace_head_sha,
         base_commit_sha,
         current_candidate_version,
         current_candidate_sha,
         last_repo_fetch_at,
         last_remote_head_sha,
         metadata_json,
         created_at,
         updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(6), NOW(6)
       FROM oneshot_workspace_leases
       WHERE scope = ?
         AND fencing_token = ?
         AND expires_at > NOW(6)
       ON DUPLICATE KEY UPDATE
         workspace_mode = VALUES(workspace_mode),
         workspace_path = VALUES(workspace_path),
         state_path = VALUES(state_path),
         workspace_phase = VALUES(workspace_phase),
         workspace_head_sha = VALUES(workspace_head_sha),
         base_commit_sha = COALESCE(VALUES(base_commit_sha), base_commit_sha),
         current_candidate_version = COALESCE(VALUES(current_candidate_version), current_candidate_version),
         current_candidate_sha = COALESCE(VALUES(current_candidate_sha), current_candidate_sha),
         last_repo_fetch_at = COALESCE(VALUES(last_repo_fetch_at), last_repo_fetch_at),
         last_remote_head_sha = COALESCE(VALUES(last_remote_head_sha), last_remote_head_sha),
         metadata_json = VALUES(metadata_json),
         updated_at = NOW(6)`,
      [
        input.oneshotRunId,
        input.workspaceMode,
        input.workspacePath ?? null,
        input.statePath ?? null,
        input.workspacePhase ?? null,
        input.workspaceHeadSha ?? null,
        input.baseCommitSha ?? null,
        input.currentCandidateVersion ?? null,
        input.currentCandidateSha ?? null,
        input.lastRepoFetchAt ?? null,
        input.lastRemoteHeadSha ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.leaseScope,
        input.fencingToken,
      ],
    )
    // INSERT returns 1 and duplicate-key UPDATE can return 2, so any positive
    // affected-row count means the lease-gated state write happened.
    return result.affectedRows > 0
  }

  async conditionalUpdateWithLease(input: {
    oneshotRunId: number
    leaseScope: string
    fencingToken: number
    workspacePhase?: string | null
    workspaceHeadSha?: string | null
    currentCandidateVersion?: number | null
    currentCandidateSha?: string | null
    metadata?: Record<string, unknown> | null
  }): Promise<boolean> {
    const setClauses: string[] = []
    const values: unknown[] = []

    if (Object.prototype.hasOwnProperty.call(input, 'workspacePhase')) {
      setClauses.push('workspace_phase = ?')
      values.push(input.workspacePhase ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(input, 'workspaceHeadSha')) {
      setClauses.push('workspace_head_sha = ?')
      values.push(input.workspaceHeadSha ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(input, 'currentCandidateVersion')) {
      setClauses.push('current_candidate_version = ?')
      values.push(input.currentCandidateVersion ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(input, 'currentCandidateSha')) {
      setClauses.push('current_candidate_sha = ?')
      values.push(input.currentCandidateSha ?? null)
    }
    if (Object.prototype.hasOwnProperty.call(input, 'metadata')) {
      setClauses.push('metadata_json = ?')
      values.push(input.metadata ? JSON.stringify(input.metadata) : null)
    }

    setClauses.push('updated_at = NOW(6)')

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_workspace_state
       SET ${setClauses.join(',\n           ')}
       WHERE oneshot_run_id = ?
         AND EXISTS (
           SELECT 1
           FROM oneshot_workspace_leases
           WHERE scope = ?
             AND fencing_token = ?
             AND expires_at > NOW(6)
         )`,
      [
        ...values,
        input.oneshotRunId,
        input.leaseScope,
        input.fencingToken,
      ],
    )
    return result.affectedRows === 1
  }
}
