import type { OneShotSharedConfig } from './config.js'
import type { OneShotQueueStage } from './contracts.js'
import type { OneShotRunEvent } from './database/events.js'
import type { ArtifactStage, OneShotArtifact, OneShotRun } from './types.js'

export type OneShotBudgetFailureReason = 'stage_budget_exceeded' | 'total_budget_exceeded'

export interface OneShotBudgetCheck {
  withinBudget: boolean
  failureReason?: OneShotBudgetFailureReason
  stage: OneShotQueueStage
  artifactStage: ArtifactStage
  stageVersion?: number
  stageTokensUsed: number
  stageMaxTokens: number
  totalTokensUsed: number
  totalMaxTokens: number
  projectedTokens: number
}

interface CheckOneShotTokenBudgetInput {
  run: Pick<OneShotRun, 'max_total_tokens' | 'total_tokens_used'>
  config: Pick<OneShotSharedConfig, 'maxTotalTokens' | 'maxStageTokens'>
  stage: OneShotQueueStage
  stageVersion?: number
  artifacts: Pick<OneShotArtifact, 'stage' | 'version' | 'metadata_json'>[]
  events?: Pick<OneShotRunEvent, 'event_type' | 'stage' | 'metadata_json'>[]
  projectedTokens: number
}

export function artifactStageForQueueStage(stage: OneShotQueueStage): ArtifactStage {
  switch (stage) {
    case 'planning':
      return 'plan'
    case 'review':
      return 'review'
    case 'implementation':
      return 'implementation'
    case 'code_review':
      return 'code_review'
    case 'testing':
      return 'test_result'
  }
}

function numberFromMetadata(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0
}

function versionFromMetadata(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}

export function getStageTokensUsed(
  artifacts: Pick<OneShotArtifact, 'stage' | 'version' | 'metadata_json'>[],
  stage: OneShotQueueStage,
  events: Pick<OneShotRunEvent, 'event_type' | 'stage' | 'metadata_json'>[] = [],
  stageVersion?: number,
): number {
  const artifactStage = artifactStageForQueueStage(stage)
  const artifactTokens = artifacts
    .filter(artifact =>
      artifact.stage === artifactStage &&
      (stageVersion == null || artifact.version === stageVersion),
    )
    .reduce((total, artifact) => {
      const metadata = artifact.metadata_json ?? {}
      return total + numberFromMetadata(metadata.stage_tokens_used)
    }, 0)
  const failedAttemptTokens = events
    .filter(event => event.event_type === 'stage_attempt_metrics' && event.stage === stage)
    .filter(event => {
      if (stageVersion == null) return true
      const eventVersion = versionFromMetadata(event.metadata_json?.version)
      return eventVersion == null || eventVersion === stageVersion
    })
    .reduce((total, event) => {
      const metadata = event.metadata_json ?? {}
      return total + numberFromMetadata(metadata.stage_tokens_used)
    }, 0)
  return artifactTokens + failedAttemptTokens
}

export function checkOneShotTokenBudget(input: CheckOneShotTokenBudgetInput): OneShotBudgetCheck {
  const artifactStage = artifactStageForQueueStage(input.stage)
  const stageTokensUsed = getStageTokensUsed(
    input.artifacts,
    input.stage,
    input.events ?? [],
    input.stageVersion,
  )
  const stageMaxTokens = input.config.maxStageTokens[input.stage]
  const totalTokensUsed = input.run.total_tokens_used
  // Legacy active rows may store an older run cap. Treat config as a floor so
  // in-flight runs get the currently configured cumulative cap.
  const totalMaxTokens = Math.max(input.run.max_total_tokens, input.config.maxTotalTokens)
  const projectedTokens = input.projectedTokens

  if (totalTokensUsed + projectedTokens > totalMaxTokens) {
    return {
      withinBudget: false,
      failureReason: 'total_budget_exceeded',
      stage: input.stage,
      artifactStage,
      stageVersion: input.stageVersion,
      stageTokensUsed,
      stageMaxTokens,
      totalTokensUsed,
      totalMaxTokens,
      projectedTokens,
    }
  }

  if (stageTokensUsed + projectedTokens > stageMaxTokens) {
    return {
      withinBudget: false,
      failureReason: 'stage_budget_exceeded',
      stage: input.stage,
      artifactStage,
      stageVersion: input.stageVersion,
      stageTokensUsed,
      stageMaxTokens,
      totalTokensUsed,
      totalMaxTokens,
      projectedTokens,
    }
  }

  return {
    withinBudget: true,
    stage: input.stage,
    artifactStage,
    stageVersion: input.stageVersion,
    stageTokensUsed,
    stageMaxTokens,
    totalTokensUsed,
    totalMaxTokens,
    projectedTokens,
  }
}

export function tokenBudgetEventMetadata(
  check: OneShotBudgetCheck,
  revision?: boolean,
): Record<string, unknown> {
  const reason = check.failureReason ? 'budget_exceeded' : 'within_budget'
  return {
    reason,
    budgetFailureReason: check.failureReason ?? null,
    version: check.stageVersion ?? null,
    revision: revision ?? null,
    stageTokensUsed: check.stageTokensUsed,
    stageMaxTokens: check.stageMaxTokens,
    totalTokensUsed: check.totalTokensUsed,
    totalMaxTokens: check.totalMaxTokens,
    projectedTokens: check.projectedTokens,
  }
}

export function formatTokenBudgetFailure(stageName: string, check: OneShotBudgetCheck): string {
  if (check.failureReason === 'stage_budget_exceeded') {
    return `OneShot ${stageName} stage_budget_exceeded: ${check.stage} used ` +
      `${check.stageTokensUsed}/${check.stageMaxTokens}, projected +${check.projectedTokens}. ` +
      `Run used ${check.totalTokensUsed}/${check.totalMaxTokens}.`
  }

  return `OneShot ${stageName} total_budget_exceeded: run used ` +
    `${check.totalTokensUsed}/${check.totalMaxTokens}, projected +${check.projectedTokens}. ` +
    `${check.stage} used ${check.stageTokensUsed}/${check.stageMaxTokens}.`
}
