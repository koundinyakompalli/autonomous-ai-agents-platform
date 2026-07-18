import type mysql from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'
import type {
  CreateOneShotRunInput,
  OneShotRun,
  OneShotState,
  UpdateOneShotRunFields,
} from '../types.js'
import { normalizeOneShotTicketType } from '../ticket-type.js'

export type OneShotStageVersionColumn =
  | 'current_plan_version'
  | 'current_implementation_version'
  | 'current_code_review_version'
  | 'current_test_version'

export interface OneShotStageVersionClaimGuard {
  column: OneShotStageVersionColumn
  expectedVersion: number
  mode?: 'exact' | 'next'
}

type OneShotRunRow = mysql.RowDataPacket & {
  id: number
  run_group_id: number | null
  workspace_mode: OneShotRun['workspace_mode'] | string | null
  jira_key: string
  epic_key: string | null
  jira_issue_type: string | null
  ticket_type: string | null
  ticket_type_source: string | null
  ticket_type_updated_by: string | null
  ticket_type_updated_at: Date | string | null
  source_task_management_id: number
  customer_id: number
  repo_id: number
  branch_name: string
  base_commit_sha: string
  run_branch_name: string | null
  run_branch_base_sha: string | null
  run_branch_created_at: Date | string | null
  state: OneShotState
  max_review_loops: number
  review_loop_count: number
  current_plan_version: number | null
  current_review_version: number | null
  current_implementation_version: number | null
  current_implementation_branch: string | null
  current_implementation_commit_sha: string | null
  current_code_review_version: number | null
  current_test_version: number | null
  current_pr_url: string | null
  final_disposition: string | null
  last_error: string | null
  max_total_tokens: number
  total_tokens_used: number
  verification_loop_count: number
  max_verification_loops: number
  planning_attempt_count: number
  implementation_attempt_count: number
  code_review_attempt_count: number
  created_at: Date | string
  updated_at: Date | string
}

const RUN_UPDATE_COLUMNS = [
  'current_plan_version',
  'current_review_version',
  'current_implementation_version',
  'current_implementation_branch',
  'current_implementation_commit_sha',
  'current_code_review_version',
  'current_test_version',
  'current_pr_url',
  'final_disposition',
  'last_error',
  'jira_issue_type',
  'ticket_type',
  'ticket_type_source',
  'ticket_type_updated_by',
  'ticket_type_updated_at',
  'base_commit_sha',
  'branch_name',
  'run_branch_name',
  'run_branch_base_sha',
  'run_branch_created_at',
  'max_review_loops',
  'review_loop_count',
  'max_total_tokens',
  'total_tokens_used',
  'verification_loop_count',
  'max_verification_loops',
  'implementation_attempt_count',
  'code_review_attempt_count',
  'planning_attempt_count',
] as const

const CLAIM_VERSION_COLUMNS = new Set<OneShotStageVersionColumn>([
  'current_plan_version',
  'current_implementation_version',
  'current_code_review_version',
  'current_test_version',
])

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toNullableDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null
  }
  return toDate(value)
}

export function normalizeRunWorkspaceMode(
  _value: unknown,
): OneShotRun['workspace_mode'] {
  return 'v2'
}

function mapRun(row: OneShotRunRow): OneShotRun {
  return {
    id: row.id,
    run_group_id: row.run_group_id ?? null,
    workspace_mode: normalizeRunWorkspaceMode(row.workspace_mode),
    jira_key: row.jira_key,
    epic_key: row.epic_key ?? null,
    jira_issue_type: row.jira_issue_type ?? null,
    ticket_type: normalizeOneShotTicketType(row.ticket_type) ?? 'unknown',
    ticket_type_source: row.ticket_type_source ?? 'unknown',
    ticket_type_updated_by: row.ticket_type_updated_by ?? null,
    ticket_type_updated_at: toNullableDate(row.ticket_type_updated_at),
    source_task_management_id: row.source_task_management_id,
    customer_id: row.customer_id,
    repo_id: row.repo_id,
    branch_name: row.branch_name,
    base_commit_sha: row.base_commit_sha,
    run_branch_name: row.run_branch_name ?? null,
    run_branch_base_sha: row.run_branch_base_sha ?? null,
    run_branch_created_at: toNullableDate(row.run_branch_created_at),
    state: row.state,
    max_review_loops: row.max_review_loops,
    review_loop_count: row.review_loop_count,
    current_plan_version: row.current_plan_version,
    current_review_version: row.current_review_version,
    current_implementation_version: row.current_implementation_version,
    current_implementation_branch: row.current_implementation_branch,
    current_implementation_commit_sha: row.current_implementation_commit_sha,
    current_code_review_version: row.current_code_review_version,
    current_test_version: row.current_test_version,
    current_pr_url: row.current_pr_url,
    final_disposition: row.final_disposition,
    last_error: row.last_error,
    max_total_tokens: row.max_total_tokens,
    total_tokens_used: row.total_tokens_used,
    verification_loop_count: row.verification_loop_count,
    max_verification_loops: row.max_verification_loops,
    planning_attempt_count: row.planning_attempt_count,
    implementation_attempt_count: row.implementation_attempt_count,
    code_review_attempt_count: row.code_review_attempt_count,
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  }
}

export class OneShotRunsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  private buildRunUpdateStatement(
    state: OneShotState,
    updates: UpdateOneShotRunFields,
  ): {
    setClauses: string[]
    values: Array<string | number | Date | null>
  } {
    const setClauses = ['state = ?', 'updated_at = NOW()']
    const values: Array<string | number | Date | null> = [state]

    for (const column of RUN_UPDATE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(updates, column)) {
        setClauses.push(`${column} = ?`)
        values.push(updates[column] ?? null)
      }
    }

    return { setClauses, values }
  }

  async createRun(data: CreateOneShotRunInput): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_runs (
         jira_key,
         epic_key,
         jira_issue_type,
         ticket_type,
         ticket_type_source,
         ticket_type_updated_by,
         ticket_type_updated_at,
         run_group_id,
         workspace_mode,
         source_task_management_id,
         customer_id,
         repo_id,
         branch_name,
         base_commit_sha,
         run_branch_name,
         run_branch_base_sha,
         run_branch_created_at,
         state,
         max_review_loops,
         review_loop_count,
         current_plan_version,
         current_review_version,
         current_implementation_version,
         current_implementation_branch,
         current_implementation_commit_sha,
         current_code_review_version,
         current_test_version,
         current_pr_url,
         final_disposition,
         last_error,
         max_total_tokens,
         total_tokens_used,
         verification_loop_count,
         max_verification_loops,
         planning_attempt_count,
         implementation_attempt_count,
         code_review_attempt_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.jira_key,
        data.epic_key ?? null,
        data.jira_issue_type ?? null,
        data.ticket_type ?? 'unknown',
        data.ticket_type_source ?? 'unknown',
        data.ticket_type_updated_by ?? null,
        data.ticket_type_updated_at ?? null,
        data.run_group_id ?? null,
        data.workspace_mode ?? 'v2',
        data.source_task_management_id,
        data.customer_id,
        data.repo_id,
        data.branch_name,
        data.base_commit_sha,
        data.run_branch_name ?? null,
        data.run_branch_base_sha ?? null,
        data.run_branch_created_at ?? null,
        data.state ?? 'queued_for_planning',
        data.max_review_loops ?? 3,
        data.review_loop_count ?? 0,
        data.current_plan_version ?? null,
        data.current_review_version ?? null,
        data.current_implementation_version ?? null,
        data.current_implementation_branch ?? null,
        data.current_implementation_commit_sha ?? null,
        data.current_code_review_version ?? null,
        data.current_test_version ?? null,
        data.current_pr_url ?? null,
        data.final_disposition ?? null,
        data.last_error ?? null,
        data.max_total_tokens ?? 50_000_000,
        data.total_tokens_used ?? 0,
        data.verification_loop_count ?? 0,
        data.max_verification_loops ?? 3,
        data.planning_attempt_count ?? 0,
        data.implementation_attempt_count ?? 0,
        data.code_review_attempt_count ?? 0,
      ],
    )

    return result.insertId
  }

  async ensureRunBranchContract(input: {
    runId: number
    branchName: string
    baseCommitSha: string
  }): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_runs
         SET run_branch_name = ?,
             run_branch_base_sha = ?,
             run_branch_created_at = COALESCE(run_branch_created_at, NOW(6)),
             current_implementation_branch = ?,
             updated_at = NOW()
       WHERE id = ?`,
      [input.branchName, input.baseCommitSha, input.branchName, input.runId],
    )
  }

  async getRunById(id: number): Promise<OneShotRun | null> {
    const [rows] = await this.pool.query<OneShotRunRow[]>(
      'SELECT * FROM oneshot_runs WHERE id = ?',
      [id],
    )

    return rows.length > 0 ? mapRun(rows[0]) : null
  }

  async getActiveRunByJiraKey(jiraKey: string): Promise<OneShotRun | null> {
    const [rows] = await this.pool.query<OneShotRunRow[]>(
      `SELECT * FROM oneshot_runs
       WHERE jira_key = ?
         AND state NOT IN ('completed', 'failed', 'blocked', 'pr_open')
       ORDER BY id DESC
       LIMIT 1`,
      [jiraKey],
    )

    return rows.length > 0 ? mapRun(rows[0]) : null
  }

  async getLatestRunByJiraKey(jiraKey: string): Promise<OneShotRun | null> {
    const [rows] = await this.pool.query<OneShotRunRow[]>(
      'SELECT * FROM oneshot_runs WHERE jira_key = ? ORDER BY id DESC LIMIT 1',
      [jiraKey],
    )

    return rows.length > 0 ? mapRun(rows[0]) : null
  }

  async getLatestRunWithPrByJiraKey(
    jiraKey: string,
  ): Promise<OneShotRun | null> {
    const [rows] = await this.pool.query<OneShotRunRow[]>(
      `SELECT * FROM oneshot_runs
       WHERE jira_key = ?
         AND current_pr_url IS NOT NULL
         AND current_pr_url <> ''
       ORDER BY id DESC
       LIMIT 1`,
      [jiraKey],
    )

    return rows.length > 0 ? mapRun(rows[0]) : null
  }

  async getPrOpenRunsForCiReconciliation(limit = 25): Promise<OneShotRun[]> {
    const [rows] = await this.pool.query<OneShotRunRow[]>(
      `SELECT r.*
       FROM oneshot_runs r
       WHERE r.state = 'pr_open'
         AND r.current_pr_url IS NOT NULL
         AND r.current_pr_url <> ''
         AND r.current_implementation_commit_sha IS NOT NULL
         AND r.current_implementation_commit_sha <> ''
       ORDER BY EXISTS (
         SELECT 1
         FROM oneshot_run_events e
         WHERE e.oneshot_run_id = r.id
           AND e.event_type = 'ci_refresh_requested'
           AND e.occurred_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
       ) DESC,
       r.updated_at ASC
       LIMIT ?`,
      [limit],
    )

    return rows.map(mapRun)
  }

  async getStuckRuns(minutesThreshold = 10, activeMinutesThreshold = 20): Promise<OneShotRun[]> {
    const [rows] = await this.pool.query<OneShotRunRow[]>(
      `SELECT * FROM oneshot_runs
       WHERE (
         (state IN (
           'queued_for_planning', 'queued_for_review', 'queued_for_implementation',
           'queued_for_code_review', 'queued_for_testing'
         ) AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
         OR
         (state IN (
           'planning', 'reviewing', 'implementing', 'code_reviewing', 'testing'
         ) AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
       )
       ORDER BY updated_at ASC`,
      [minutesThreshold, activeMinutesThreshold],
    )

    return rows.map(mapRun)
  }

  async claimQueuedRun(
    id: number,
    fromState: OneShotState,
    toState: OneShotState,
    versionGuard?: OneShotStageVersionClaimGuard,
  ): Promise<boolean> {
    const versionValues: number[] = []
    let versionPredicate = ''
    if (versionGuard) {
      const column = this.versionGuardColumn(versionGuard.column)
      versionPredicate = versionGuard.mode === 'next'
        ? ` AND COALESCE(${column}, 0) + 1 = ?`
        : ` AND ${column} = ?`
      versionValues.push(versionGuard.expectedVersion)
    }

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_runs
       SET state = ?, updated_at = NOW()
       WHERE id = ? AND state = ?${versionPredicate}`,
      [toState, id, fromState, ...versionValues],
    )

    return result.affectedRows === 1
  }

  private versionGuardColumn(column: OneShotStageVersionColumn): OneShotStageVersionColumn {
    if (!CLAIM_VERSION_COLUMNS.has(column)) {
      throw new Error(`Unsupported OneShot stage version column: ${column}`)
    }
    return column
  }

  async updateRunState(
    id: number,
    state: OneShotState,
    updates: UpdateOneShotRunFields = {},
  ): Promise<void> {
    const { setClauses, values } = this.buildRunUpdateStatement(state, updates)

    values.push(id)

    await this.pool.query(
      `UPDATE oneshot_runs
       SET ${setClauses.join(', ')}
       WHERE id = ?`,
      values,
    )
    // TODO: emit state_transition event via OneShotRunEventsDB.
    // Callers can do: await db.events.createEvent({ oneshot_run_id: id, event_type: 'state_transition', from_state, to_state: state })
  }

  async updateRunStateIfCurrentState(
    id: number,
    currentState: OneShotState,
    nextState: OneShotState,
    updates: UpdateOneShotRunFields = {},
  ): Promise<boolean> {
    const { setClauses, values } = this.buildRunUpdateStatement(nextState, updates)

    values.push(id, currentState)

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_runs
       SET ${setClauses.join(', ')}
       WHERE id = ? AND state = ?`,
      values,
    )

    return result.affectedRows === 1
  }

  async incrementReviewLoop(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_runs
       SET review_loop_count = review_loop_count + 1,
           updated_at = NOW()
       WHERE id = ?`,
      [id],
    )
  }

  async incrementVerificationLoop(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_runs
       SET verification_loop_count = verification_loop_count + 1,
           updated_at = NOW()
       WHERE id = ?`,
      [id],
    )
  }

  async checkVerificationBudget(id: number): Promise<boolean> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { max_verification_loops: number; verification_loop_count: number }>
    >(
      'SELECT max_verification_loops, verification_loop_count FROM oneshot_runs WHERE id = ?',
      [id],
    )

    if (rows.length === 0) {
      return false
    }

    return rows[0].verification_loop_count < rows[0].max_verification_loops
  }

  async addTokenUsage(id: number, tokensUsed: number): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_runs
       SET total_tokens_used = total_tokens_used + ?,
           updated_at = NOW()
       WHERE id = ?`,
      [tokensUsed, id],
    )
  }

  async touchRun(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_runs
       SET updated_at = NOW()
       WHERE id = ?`,
      [id],
    )
  }

  async checkTokenBudget(id: number): Promise<boolean> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { max_total_tokens: number; total_tokens_used: number }>
    >(
      'SELECT max_total_tokens, total_tokens_used FROM oneshot_runs WHERE id = ?',
      [id],
    )

    if (rows.length === 0) {
      return false
    }

    return rows[0].total_tokens_used < rows[0].max_total_tokens
  }

  /**
   * Check whether a run still has budget for a stage expected to consume ~expectedTokens.
   * Returns { withinBudget, tokensUsed, maxTokens } so callers can log context on failure.
   */
  async checkTokenBudgetWithProjection(
    id: number,
    expectedTokens: number,
  ): Promise<{ withinBudget: boolean; tokensUsed: number; maxTokens: number }> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { max_total_tokens: number; total_tokens_used: number }>
    >(
      'SELECT max_total_tokens, total_tokens_used FROM oneshot_runs WHERE id = ?',
      [id],
    )
    if (rows.length === 0) {
      return { withinBudget: false, tokensUsed: 0, maxTokens: 0 }
    }
    const { max_total_tokens, total_tokens_used } = rows[0]
    return {
      withinBudget: (total_tokens_used + expectedTokens) <= max_total_tokens,
      tokensUsed: total_tokens_used,
      maxTokens: max_total_tokens,
    }
  }

  async incrementStageAttempts(
    id: number,
    stage: 'planning' | 'implementation' | 'code_review',
  ): Promise<void> {
    const column = `${stage}_attempt_count`
    await this.pool.query(
      `UPDATE oneshot_runs SET ${column} = ${column} + 1, updated_at = NOW() WHERE id = ?`,
      [id],
    )
  }

  async checkStageAttemptBudget(
    id: number,
    stage: 'planning' | 'implementation' | 'code_review',
    maxAttempts: number,
  ): Promise<boolean> {
    const column = `${stage}_attempt_count`
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { attempt_count: number }>
    >(
      `SELECT ${column} AS attempt_count FROM oneshot_runs WHERE id = ?`,
      [id],
    )
    if (rows.length === 0) return false
    return rows[0].attempt_count < maxAttempts
  }
}
