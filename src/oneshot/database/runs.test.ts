import { describe, expect, it, vi } from 'vitest'
import { normalizeRunWorkspaceMode, OneShotRunsDB } from './runs.js'

describe('OneShotRunsDB createRun', () => {
  it('persists Jira issue type and normalized ticket type metadata', async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 123 }])
    const db = new OneShotRunsDB({ query } as never)

    const id = await db.createRun({
      jira_key: 'CPDEV-123',
      epic_key: 'CPDEV-100',
      jira_issue_type: 'Story',
      ticket_type: 'sonar',
      ticket_type_source: 'inferred_sonar',
      source_task_management_id: 10,
      customer_id: 20,
      repo_id: 30,
      branch_name: 'main',
      base_commit_sha: 'abc123',
    })

    expect(id).toBe(123)
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('jira_issue_type'),
      expect.arrayContaining(['CPDEV-100', 'Story', 'sonar', 'inferred_sonar']),
    )
  })
})

describe('OneShotRunsDB claimQueuedRun', () => {
  it('adds an exact stage-version CAS predicate when a version guard is provided', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const db = new OneShotRunsDB({ query } as never)

    await db.claimQueuedRun(
      87,
      'queued_for_implementation',
      'implementing',
      {
        column: 'current_implementation_version',
        expectedVersion: 3,
      },
    )

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND current_implementation_version = ?'),
      ['implementing', 87, 'queued_for_implementation', 3],
    )
  })

  it('claims planning by comparing the next DB-current version atomically', async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const db = new OneShotRunsDB({ query } as never)

    await db.claimQueuedRun(
      88,
      'queued_for_planning',
      'planning',
      {
        column: 'current_plan_version',
        expectedVersion: 1,
        mode: 'next',
      },
    )

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('AND COALESCE(current_plan_version, 0) + 1 = ?'),
      ['planning', 88, 'queued_for_planning', 1],
    )
  })
})

describe('OneShotRunsDB getLatestRunWithPrByJiraKey', () => {
  it('selects the newest run that has a PR URL', async () => {
    const now = new Date('2026-07-06T12:00:00Z')
    const query = vi.fn().mockResolvedValue([
      [
        {
          id: 562,
          run_group_id: null,
          workspace_mode: 'v2',
          jira_key: 'CPDEV-25448',
          epic_key: null,
          jira_issue_type: 'Story',
          ticket_type: 'retrofit',
          ticket_type_source: 'inferred',
          ticket_type_updated_by: null,
          ticket_type_updated_at: null,
          source_task_management_id: 10,
          customer_id: 20,
          repo_id: 30,
          branch_name: 'master',
          base_commit_sha: 'abc123',
          run_branch_name: null,
          run_branch_base_sha: null,
          run_branch_created_at: null,
          state: 'pr_open',
          max_review_loops: 2,
          review_loop_count: 0,
          current_plan_version: 1,
          current_review_version: 1,
          current_implementation_version: 1,
          current_implementation_branch: 'oneshot/cpdev-25448-run-562',
          current_implementation_commit_sha: 'def456',
          current_code_review_version: 1,
          current_test_version: 1,
          current_pr_url:
            'https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575',
          final_disposition: null,
          last_error: null,
          max_total_tokens: 500000,
          total_tokens_used: 1000,
          verification_loop_count: 0,
          max_verification_loops: 2,
          planning_attempt_count: 0,
          implementation_attempt_count: 0,
          code_review_attempt_count: 0,
          created_at: now,
          updated_at: now,
        },
      ],
    ])
    const db = new OneShotRunsDB({ query } as never)

    const run = await db.getLatestRunWithPrByJiraKey('CPDEV-25448')

    expect(run?.id).toBe(562)
    expect(run?.current_pr_url).toContain('/pull/2575')
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('current_pr_url <>'),
      ['CPDEV-25448'],
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY id DESC'),
      ['CPDEV-25448'],
    )
  })
})

describe('normalizeRunWorkspaceMode', () => {
  it('normalizes dirty persisted workspace mode values to v2', () => {
    expect(normalizeRunWorkspaceMode('v2')).toBe('v2')
    expect(normalizeRunWorkspaceMode(null)).toBe('v2')
    expect(normalizeRunWorkspaceMode('')).toBe('v2')
    expect(normalizeRunWorkspaceMode('v1')).toBe('v2')
    expect(normalizeRunWorkspaceMode('branch')).toBe('v2')
  })
})
