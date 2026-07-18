import { describe, expect, it, vi } from 'vitest'
import {
  expectedVersionForQueuedStage,
  handleClaimMissAfterVersionGuard,
  handleStaleStageVersionMessage,
  revisionForQueuedStage,
} from './stage-version-guard.js'
import type { OneShotRun } from './types.js'
import type { OneShotQueueMessage } from './contracts.js'

function run(overrides: Partial<OneShotRun> = {}): OneShotRun {
  return {
    id: 87,
    run_group_id: null,
    jira_key: 'CPDEV-21561',
    source_task_management_id: 1,
    customer_id: 1,
    repo_id: 1,
    branch_name: 'main',
    base_commit_sha: 'abc123',
    state: 'queued_for_implementation',
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: 3,
    current_implementation_branch: 'oneshot/cpdev-21561-run-87',
    current_implementation_commit_sha: 'a'.repeat(40),
    current_code_review_version: 2,
    current_test_version: null,
    current_pr_url: null,
    final_disposition: null,
    last_error: null,
    max_total_tokens: 50_000_000,
    total_tokens_used: 0,
    verification_loop_count: 0,
    max_verification_loops: 3,
    planning_attempt_count: 0,
    implementation_attempt_count: 0,
    code_review_attempt_count: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function payload(overrides: Partial<OneShotQueueMessage> = {}): OneShotQueueMessage {
  return {
    run_id: 87,
    stage: 'implementation',
    version: 2,
    expected_state: 'queued_for_implementation',
    revision: true,
    emitted_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('stage version guard helpers', () => {
  it('derives planning as the next DB-current plan version', () => {
    expect(expectedVersionForQueuedStage(run({
      state: 'queued_for_planning',
      current_plan_version: null,
    }), 'planning')).toBe(1)
    expect(expectedVersionForQueuedStage(run({
      state: 'queued_for_planning',
      current_plan_version: 3,
    }), 'planning')).toBe(4)
  })

  it('marks implementation revision true only when prior implementation output exists', () => {
    expect(revisionForQueuedStage(run({
      current_implementation_branch: null,
      current_implementation_commit_sha: null,
    }), 'implementation')).toBe(false)
    expect(revisionForQueuedStage(run(), 'implementation')).toBe(true)
  })

  it('drops stale same-state messages and republishes the current version', async () => {
    const createEvent = vi.fn().mockResolvedValue(undefined)
    const publishStageMessage = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    const handled = await handleStaleStageVersionMessage({
      run: run(),
      payload: payload(),
      oneShotDb: { events: { createEvent } } as never,
      publisher: { publishStageMessage } as never,
      logger: logger as never,
      messageId: '6820c85a',
      receiveCount: 2,
    })

    expect(handled).toBe(true)
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'stale_stage_message_dropped',
      metadata_json: expect.objectContaining({
        payloadVersion: 2,
        currentVersion: 3,
        requestedRepublish: true,
      }),
    }))
    expect(publishStageMessage).toHaveBeenCalledWith(
      87,
      'implementation',
      3,
      'queued_for_implementation',
      true,
      {
        dedupeToken: 'stale-republish:2:6820c85a',
      },
    )
  })

  it('still drops and republishes when audit event writes fail', async () => {
    const createEvent = vi.fn().mockRejectedValue(new Error('events unavailable'))
    const publishStageMessage = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    const handled = await handleStaleStageVersionMessage({
      run: run(),
      payload: payload(),
      oneShotDb: { events: { createEvent } } as never,
      publisher: { publishStageMessage } as never,
      logger: logger as never,
      messageId: '6820c85a',
      receiveCount: 2,
    })

    expect(handled).toBe(true)
    expect(publishStageMessage).toHaveBeenCalledWith(
      87,
      'implementation',
      3,
      'queued_for_implementation',
      true,
      {
        dedupeToken: 'stale-republish:2:6820c85a',
      },
    )
    expect(logger.warn).toHaveBeenCalled()
  })

  it('re-evaluates and republishes current version after a claim miss moves the version', async () => {
    const createEvent = vi.fn().mockResolvedValue(undefined)
    const publishStageMessage = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), warn: vi.fn() }

    const handled = await handleClaimMissAfterVersionGuard({
      run: run({ current_implementation_version: 2 }),
      payload: payload({ version: 2 }),
      oneShotDb: {
        runs: {
          getRunById: vi.fn().mockResolvedValue(run({ current_implementation_version: 3 })),
        },
        events: { createEvent },
      } as never,
      publisher: { publishStageMessage } as never,
      logger: logger as never,
      messageId: '6820c85a',
      receiveCount: 2,
    })

    expect(handled).toBe(true)
    expect(publishStageMessage).toHaveBeenCalledWith(
      87,
      'implementation',
      3,
      'queued_for_implementation',
      true,
      {
        dedupeToken: 'stale-republish:2:6820c85a',
      },
    )
  })
})
