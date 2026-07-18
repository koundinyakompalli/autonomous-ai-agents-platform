import { describe, expect, it } from 'vitest'
import type { OneShotRunEvent } from './database/events.js'
import { buildPostmortem, renderPostmortemMarkdown } from './postmortem.js'
import type { OneShotArtifact, OneShotRun } from './types.js'

function buildRun(overrides: Partial<OneShotRun> = {}): OneShotRun {
  return {
    id: 7,
    run_group_id: null,
    workspace_mode: 'v2',
    jira_key: 'CPDEV-7',
    source_task_management_id: 1,
    customer_id: 1,
    repo_id: 1,
    branch_name: 'master',
    base_commit_sha: 'abc123',
    run_branch_name: 'oneshot/cpdev-7-run-7',
    run_branch_base_sha: 'abc123',
    run_branch_created_at: new Date('2026-04-15T00:00:00.000Z'),
    state: 'failed',
    max_review_loops: 2,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: 1,
    current_implementation_branch: 'oneshot/cpdev-7-run-7',
    current_implementation_commit_sha: 'def456',
    current_code_review_version: 1,
    current_test_version: 1,
    current_pr_url: null,
    final_disposition: 'test_failed',
    last_error: '2 tests failed',
    max_total_tokens: 100000,
    total_tokens_used: 0,
    verification_loop_count: 0,
    max_verification_loops: 2,
    planning_attempt_count: 1,
    implementation_attempt_count: 1,
    code_review_attempt_count: 1,
    created_at: new Date('2026-04-15T00:00:00.000Z'),
    updated_at: new Date('2026-04-15T00:10:00.000Z'),
    ...overrides,
  }
}

function buildEvent(overrides: Partial<OneShotRunEvent> = {}): OneShotRunEvent {
  return {
    id: 1,
    oneshot_run_id: 7,
    event_type: 'state_transition',
    from_state: 'testing',
    to_state: 'failed',
    stage: 'testing',
    metadata_json: null,
    occurred_at: new Date('2026-04-15T00:09:00.000Z'),
    ...overrides,
  }
}

function buildArtifact(overrides: Partial<OneShotArtifact> = {}): OneShotArtifact {
  return {
    id: 1,
    oneshot_run_id: 7,
    stage: 'test_result',
    version: 1,
    status: 'completed',
    s3_bucket: 'bucket',
    s3_key: 'key',
    provider: 'none',
    model: 'none',
    metadata_json: {
      passed: false,
      stage_duration_ms: 5000,
    },
    started_at: new Date('2026-04-15T00:08:55.000Z'),
    completed_at: new Date('2026-04-15T00:09:00.000Z'),
    created_at: new Date('2026-04-15T00:09:00.000Z'),
    ...overrides,
  }
}

describe('buildPostmortem', () => {
  it('maps testing failures onto test_result artifacts and marks them failed when metadata says passed=false', () => {
    const postmortem = buildPostmortem(
      buildRun(),
      [buildEvent()],
      [buildArtifact()],
    )

    expect(postmortem.failedAtStage).toBe('testing')
    expect(postmortem.timeline).toEqual([
      expect.objectContaining({
        stage: 'test_result',
        outcome: 'failed',
      }),
    ])
  })

  it('respects an explicit failed stage when the failure transition event is not yet persisted', () => {
    const postmortem = buildPostmortem(
      buildRun({
        current_plan_version: null,
        current_review_version: null,
        current_implementation_version: null,
        current_code_review_version: null,
        current_test_version: null,
      }),
      [],
      [],
      'planning',
    )

    expect(postmortem.failedAtStage).toBe('planning')
  })

  it('includes failed planning attempt metrics from stage_attempt_metrics events', () => {
    const postmortem = buildPostmortem(
      buildRun({
        current_plan_version: null,
        current_review_version: null,
        current_implementation_version: null,
        current_code_review_version: null,
        current_test_version: null,
        last_error: 'SDK timeout after 900000ms',
      }),
      [
        buildEvent({
          event_type: 'stage_attempt_metrics',
          stage: 'planning',
          metadata_json: {
            reason: 'planner_failed_attempt',
            version: 1,
            stage_tokens_used: 1200,
            stage_cost_usd: 0.42,
            stage_duration_ms: 900000,
          },
          occurred_at: new Date('2026-04-15T00:05:00.000Z'),
        }),
        buildEvent({
          event_type: 'stage_attempt_metrics',
          stage: 'planning',
          metadata_json: {
            reason: 'planner_failed_attempt',
            version: 2,
            stage_tokens_used: 800,
            stage_cost_usd: 0.21,
            stage_duration_ms: 300000,
          },
          occurred_at: new Date('2026-04-15T00:10:00.000Z'),
        }),
      ],
      [],
      'planning',
    )

    expect(postmortem.timeline).toEqual([
      expect.objectContaining({
        stage: 'planning',
        version: 1,
        outcome: 'failed',
        tokensUsed: 1200,
        costUsd: 0.42,
        durationMs: 900000,
      }),
      expect.objectContaining({
        stage: 'planning',
        version: 2,
        outcome: 'failed',
        tokensUsed: 800,
        costUsd: 0.21,
        durationMs: 300000,
      }),
    ])
    expect(postmortem.totalTokensUsed).toBe(2000)
    expect(postmortem.totalCostUsd).toBeCloseTo(0.63)
    expect(postmortem.totalDurationMs).toBe(1_200_000)
  })

  it('does not double-count failed attempt metrics when a matching artifact exists', () => {
    const postmortem = buildPostmortem(
      buildRun(),
      [
        buildEvent({
          event_type: 'stage_attempt_metrics',
          stage: 'testing',
          metadata_json: {
            reason: 'tester_failed_attempt',
            version: 1,
            stage_tokens_used: 999,
            stage_cost_usd: 9.99,
            stage_duration_ms: 9999,
          },
          occurred_at: new Date('2026-04-15T00:09:01.000Z'),
        }),
      ],
      [buildArtifact()],
    )

    expect(postmortem.timeline).toHaveLength(1)
    expect(postmortem.totalCostUsd).toBe(0)
    expect(postmortem.totalDurationMs).toBe(5000)
    expect(postmortem.totalTokensUsed).toBe(0)
  })

  it('renders model-level planner cost breakdown when artifact metadata includes it', () => {
    const postmortem = buildPostmortem(
      buildRun(),
      [buildEvent()],
      [
        buildArtifact({
          stage: 'plan',
          status: 'completed',
          metadata_json: {
            stage_tokens_used: 73,
            stage_cost_usd: 0.095,
            stage_duration_ms: 2500,
            model_cost_usage: {
              total_cost_usd: 0.095,
              exact_total_cost_usd: true,
              unallocated_cost_usd: 0,
              notes: [],
              models: {
                'us.anthropic.claude-opus-4-8': {
                  input_tokens: 12,
                  output_tokens: 18,
                  cache_read_tokens: 3,
                  cache_write_tokens: 4,
                  cost_usd: 0.08,
                  exact_cost_usd: true,
                  source: 'planner_main',
                },
                'us.anthropic.claude-haiku-4-5-20251001-v1:0': {
                  input_tokens: 16,
                  output_tokens: 27,
                  cache_read_tokens: 0,
                  cache_write_tokens: 0,
                  cost_usd: 0.015,
                  exact_cost_usd: false,
                  source: 'planner_scout_workplan+planner_scouts',
                },
              },
            },
          },
        }),
      ],
      'planning',
    )

    const markdown = renderPostmortemMarkdown(postmortem)

    expect(markdown).toContain('## Model Cost Breakdown')
    expect(markdown).toContain(
      '| plan | us.anthropic.claude-opus-4-8 | planner_main | 12 | 18 | 3 | 4 | $0.0800 | exact |',
    )
    expect(markdown).toContain(
      '| plan | us.anthropic.claude-haiku-4-5-20251001-v1:0 | planner_scout_workplan+planner_scouts | 16 | 27 | - | - | $0.0150 | estimated |',
    )
  })
})
