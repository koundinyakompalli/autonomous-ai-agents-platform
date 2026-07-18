import { describe, expect, it } from 'vitest'
import {
  checkOneShotTokenBudget,
  getStageTokensUsed,
  tokenBudgetEventMetadata,
} from './token-budget.js'
import type { OneShotSharedConfig } from './config.js'
import type { OneShotRunEvent } from './database/events.js'
import type { OneShotArtifact, OneShotRun } from './types.js'

const config: Pick<OneShotSharedConfig, 'maxTotalTokens' | 'maxStageTokens'> = {
  maxTotalTokens: 50_000_000,
  maxStageTokens: {
    planning: 4_000_000,
    review: 2_000_000,
    implementation: 4_000_000,
    code_review: 2_000_000,
    testing: 2_000_000,
  },
}

function run(
  overrides: Partial<Pick<OneShotRun, 'max_total_tokens' | 'total_tokens_used'>> = {},
): Pick<OneShotRun, 'max_total_tokens' | 'total_tokens_used'> {
  return {
    max_total_tokens: 50_000_000,
    total_tokens_used: 0,
    ...overrides,
  }
}

function artifact(
  stage: OneShotArtifact['stage'],
  tokens: number,
  version = 1,
): Pick<OneShotArtifact, 'stage' | 'version' | 'metadata_json'> {
  return {
    stage,
    version,
    metadata_json: { stage_tokens_used: tokens },
  }
}

function event(
  stage: string,
  tokens: number,
  version = 1,
): Pick<OneShotRunEvent, 'event_type' | 'stage' | 'metadata_json'> {
  return {
    event_type: 'stage_attempt_metrics',
    stage,
    metadata_json: { stage_tokens_used: tokens, version },
  }
}

function legacyEvent(
  stage: string,
  tokens: number,
  version?: unknown,
): Pick<OneShotRunEvent, 'event_type' | 'stage' | 'metadata_json'> {
  return {
    event_type: 'stage_attempt_metrics',
    stage,
    metadata_json: version === undefined
      ? { stage_tokens_used: tokens }
      : { stage_tokens_used: tokens, version },
  }
}

describe('OneShot token budget', () => {
  it('allows implementation revision when only total tokens exceed an old stored run cap', () => {
    const check = checkOneShotTokenBudget({
      run: run({ max_total_tokens: 2_000_000, total_tokens_used: 2_453_095 }),
      config,
      stage: 'implementation',
      stageVersion: 2,
      artifacts: [
        artifact('plan', 905_623),
        artifact('implementation', 919_622),
        artifact('code_review', 627_850),
      ],
      events: [],
      projectedTokens: 500_000,
    })

    expect(check.withinBudget).toBe(true)
    expect(check.stageTokensUsed).toBe(0)
    expect(check.totalMaxTokens).toBe(50_000_000)
  })

  it('blocks when projected usage exceeds the stage budget', () => {
    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 3_000_000 }),
      config,
      stage: 'implementation',
      stageVersion: 1,
      artifacts: [artifact('implementation', 1_700_000)],
      events: [],
      projectedTokens: 2_500_000,
    })

    expect(check.withinBudget).toBe(false)
    expect(check.failureReason).toBe('stage_budget_exceeded')
    expect(check.stageTokensUsed).toBe(1_700_000)
    expect(check.stageMaxTokens).toBe(4_000_000)
  })

  it('blocks when projected usage exceeds the total cumulative 50M budget', () => {
    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 49_800_000 }),
      config,
      stage: 'code_review',
      stageVersion: 3,
      artifacts: [artifact('code_review', 100_000)],
      events: [],
      projectedTokens: 300_000,
    })

    expect(check.withinBudget).toBe(false)
    expect(check.failureReason).toBe('total_budget_exceeded')
    expect(check.totalTokensUsed).toBe(49_800_000)
    expect(check.totalMaxTokens).toBe(50_000_000)
  })

  it('sums stage tokens from matching artifact metadata only', () => {
    expect(getStageTokensUsed([
      artifact('implementation', 100),
      artifact('implementation', 250),
      artifact('code_review', 999),
      { stage: 'implementation', version: 1, metadata_json: {} },
    ], 'implementation', [])).toBe(350)
  })

  it('sums failed attempt metrics with completed artifact stage tokens', () => {
    expect(getStageTokensUsed([
      artifact('plan', 100),
    ], 'planning', [
      event('planning', 200),
      event('implementation', 999),
      { event_type: 'state_transition', stage: 'planning', metadata_json: { stage_tokens_used: 999 } },
    ])).toBe(300)
  })

  it('scopes stage tokens to the requested stage version when provided', () => {
    expect(getStageTokensUsed([
      artifact('implementation', 1_900_000, 1),
      artifact('implementation', 1_900_000, 2),
      artifact('implementation', 600_000, 3),
    ], 'implementation', [
      event('implementation', 500_000, 2),
      event('implementation', 250_000, 3),
    ], 3)).toBe(850_000)
  })

  it('includes legacy unversioned failed attempt metrics in version-scoped stage budgets', () => {
    expect(getStageTokensUsed([
      artifact('implementation', 600_000, 3),
    ], 'implementation', [
      legacyEvent('implementation', 300_000),
      legacyEvent('implementation', 200_000, 'legacy-v3'),
      event('implementation', 500_000, 2),
      event('implementation', 250_000, 3),
    ], 3)).toBe(1_350_000)
  })

  it('still excludes explicitly different failed attempt metric versions', () => {
    expect(getStageTokensUsed([], 'review', [
      event('review', 400_000, 1),
      event('review', 250_000, 2),
      legacyEvent('review', 150_000),
    ], 2)).toBe(400_000)
  })

  it('blocks when failed attempt events push a stage over budget', () => {
    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 1_950_000 }),
      config,
      stage: 'planning',
      stageVersion: 1,
      artifacts: [],
      events: [event('planning', 3_900_000)],
      projectedTokens: 200_000,
    })

    expect(check.withinBudget).toBe(false)
    expect(check.failureReason).toBe('stage_budget_exceeded')
    expect(check.stageTokensUsed).toBe(3_900_000)
  })

  it('blocks when legacy failed attempt metrics push a version-scoped stage over budget', () => {
    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 3_950_000 }),
      config,
      stage: 'implementation',
      stageVersion: 2,
      artifacts: [artifact('implementation', 500_000, 2)],
      events: [
        legacyEvent('implementation', 3_400_000),
        event('implementation', 1_000_000, 1),
      ],
      projectedTokens: 200_000,
    })

    expect(check.withinBudget).toBe(false)
    expect(check.failureReason).toBe('stage_budget_exceeded')
    expect(check.stageTokensUsed).toBe(3_900_000)
  })

  it('allows three full Plan/Validate/Build/Review passes under current stage caps', () => {
    const artifacts: Pick<OneShotArtifact, 'stage' | 'version' | 'metadata_json'>[] = []
    for (const version of [1, 2, 3]) {
      artifacts.push(
        artifact('plan', 3_900_000, version),
        artifact('review', 1_900_000, version),
        artifact('implementation', 3_900_000, version),
        artifact('code_review', 1_900_000, version),
      )
    }

    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 34_800_000 }),
      config,
      stage: 'implementation',
      stageVersion: 3,
      artifacts,
      events: [],
      projectedTokens: 50_000,
    })

    expect(check.withinBudget).toBe(true)
    expect(check.stageTokensUsed).toBe(3_900_000)
  })

  it('blocks the total cap even when each stage version stays within its cap', () => {
    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 49_900_000 }),
      config,
      stage: 'review',
      stageVersion: 3,
      artifacts: [artifact('review', 1_000_000, 3)],
      events: [],
      projectedTokens: 200_000,
    })

    expect(check.withinBudget).toBe(false)
    expect(check.failureReason).toBe('total_budget_exceeded')
  })

  it('keeps budget_exceeded event reason while exposing the precise failure cause', () => {
    const check = checkOneShotTokenBudget({
      run: run({ total_tokens_used: 3_000_000 }),
      config,
      stage: 'implementation',
      stageVersion: 2,
      artifacts: [artifact('implementation', 1_900_000, 2)],
      events: [],
      projectedTokens: 2_200_000,
    })

    expect(tokenBudgetEventMetadata(check, true)).toMatchObject({
      reason: 'budget_exceeded',
      budgetFailureReason: 'stage_budget_exceeded',
      version: 2,
      revision: true,
      stageTokensUsed: 1_900_000,
      projectedTokens: 2_200_000,
    })
  })
})
