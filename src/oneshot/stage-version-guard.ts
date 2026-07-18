import type { Logger } from 'pino'
import type { OneShotQueueMessage, OneShotQueueStage } from './contracts.js'
import type { OneShotRun } from './types.js'
import type { OneShotDatabase } from './database/index.js'
import type { OneShotStageVersionClaimGuard } from './database/runs.js'
import type { OneShotPublisher } from './publisher.js'

type VersionedRunFields = Pick<
  OneShotRun,
  | 'id'
  | 'jira_key'
  | 'state'
  | 'final_disposition'
  | 'current_plan_version'
  | 'current_implementation_version'
  | 'current_implementation_branch'
  | 'current_implementation_commit_sha'
  | 'current_code_review_version'
  | 'current_test_version'
>

export function claimGuardForQueueStage(
  stage: OneShotQueueStage,
  expectedVersion: number,
): OneShotStageVersionClaimGuard {
  switch (stage) {
    case 'planning':
      return {
        column: 'current_plan_version',
        expectedVersion,
        mode: 'next',
      }
    case 'review':
      return {
        column: 'current_plan_version',
        expectedVersion,
      }
    case 'implementation':
      return {
        column: 'current_implementation_version',
        expectedVersion,
      }
    case 'code_review':
      return {
        column: 'current_code_review_version',
        expectedVersion,
      }
    case 'testing':
      return {
        column: 'current_test_version',
        expectedVersion,
      }
  }
}

export function expectedVersionForQueuedStage(
  run: VersionedRunFields,
  stage: OneShotQueueStage,
): number | null {
  switch (stage) {
    case 'planning':
      return (run.current_plan_version ?? 0) + 1
    case 'review':
      return run.current_plan_version
    case 'implementation':
      return run.current_implementation_version
    case 'code_review':
      return run.current_code_review_version
    case 'testing':
      return run.current_test_version
  }
}

export function revisionForQueuedStage(
  run: VersionedRunFields,
  stage: OneShotQueueStage,
): boolean {
  switch (stage) {
    case 'planning':
      return run.current_plan_version !== null && run.final_disposition !== 'replan_requested'
    case 'implementation':
      return Boolean(run.current_implementation_branch && run.current_implementation_commit_sha)
    case 'review':
    case 'code_review':
    case 'testing':
      return false
  }
}

async function recordStaleMessageEventBestEffort(
  input: Parameters<OneShotDatabase['events']['createEvent']>[0] & {
    oneShotDb: OneShotDatabase
    logger: Logger
    logFields: Record<string, unknown>
  },
): Promise<void> {
  const { oneShotDb, logger, logFields, ...eventInput } = input
  try {
    await oneShotDb.events.createEvent(eventInput)
  } catch (error) {
    logger.warn(
      {
        ...logFields,
        eventType: eventInput.event_type,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist stale-stage audit event; continuing queue handling',
    )
  }
}

export async function handleStaleStageVersionMessage(input: {
  run: VersionedRunFields
  payload: OneShotQueueMessage
  oneShotDb: OneShotDatabase
  publisher: OneShotPublisher
  logger: Logger
  messageId?: string
  receiveCount: number
}): Promise<boolean> {
  const currentVersion = expectedVersionForQueuedStage(input.run, input.payload.stage)
  if (currentVersion === input.payload.version) {
    return false
  }

  const baseLogFields = {
    runId: input.run.id,
    jiraKey: input.run.jira_key,
    stage: input.payload.stage,
    messageId: input.messageId,
    receiveCount: input.receiveCount,
    payloadVersion: input.payload.version,
    currentVersion,
    currentState: input.run.state,
    expectedState: input.payload.expected_state,
    revision: input.payload.revision,
  }

  input.logger.info(
    baseLogFields,
    'Dropping stale OneShot stage message because the queued version has moved on',
  )

  await recordStaleMessageEventBestEffort({
    oneShotDb: input.oneShotDb,
    logger: input.logger,
    logFields: baseLogFields,
    oneshot_run_id: input.run.id,
    event_type: 'stale_stage_message_dropped',
    from_state: input.payload.expected_state,
    to_state: input.run.state,
    stage: input.payload.stage,
    metadata_json: {
      reason: 'stale_stage_version',
      messageId: input.messageId ?? null,
      receiveCount: input.receiveCount,
      payloadVersion: input.payload.version,
      currentVersion,
      revision: input.payload.revision,
      requestedRepublish: input.run.state === input.payload.expected_state && currentVersion !== null,
    },
  })

  if (input.run.state !== input.payload.expected_state || currentVersion === null) {
    return true
  }

  const currentRevision = revisionForQueuedStage(input.run, input.payload.stage)
  await input.publisher.publishStageMessage(
    input.run.id,
    input.payload.stage,
    currentVersion,
    input.payload.expected_state,
    currentRevision,
    {
      dedupeToken: `stale-republish:${input.payload.version}:${input.messageId ?? Date.now()}`,
      expectedImplementationCommitSha:
        input.payload.stage === 'code_review' || input.payload.stage === 'testing'
          ? input.run.current_implementation_commit_sha
          : undefined,
      expectedImplementationVersion:
        input.payload.stage === 'code_review' || input.payload.stage === 'testing'
          ? input.run.current_implementation_version
          : undefined,
    },
  )

  await recordStaleMessageEventBestEffort({
    oneShotDb: input.oneShotDb,
    logger: input.logger,
    logFields: {
      ...baseLogFields,
      republishedVersion: currentVersion,
      republishedRevision: currentRevision,
    },
    oneshot_run_id: input.run.id,
    event_type: 'reconciliation_republished',
    from_state: input.run.state,
    to_state: input.run.state,
    stage: input.payload.stage,
    metadata_json: {
      reason: 'stale_stage_version_message_dropped',
      payloadVersion: input.payload.version,
      currentVersion,
      revision: currentRevision,
      messageId: input.messageId ?? null,
      receiveCount: input.receiveCount,
    },
  })

  input.logger.info(
    {
      ...baseLogFields,
      republishedVersion: currentVersion,
      republishedRevision: currentRevision,
    },
    'Republished current OneShot stage message after stale message drop',
  )

  return true
}

export async function handleClaimMissAfterVersionGuard(input: {
  run: VersionedRunFields
  payload: OneShotQueueMessage
  oneShotDb: OneShotDatabase
  publisher: OneShotPublisher
  logger: Logger
  messageId?: string
  receiveCount: number
}): Promise<boolean> {
  const latestRun = await input.oneShotDb.runs.getRunById(input.run.id)
  if (!latestRun) {
    input.logger.warn(
      {
        runId: input.run.id,
        stage: input.payload.stage,
        messageId: input.messageId,
        receiveCount: input.receiveCount,
      },
      'Dropping OneShot stage message after claim miss because run no longer exists',
    )
    return true
  }

  if (latestRun.state === input.payload.expected_state) {
    const currentVersion = expectedVersionForQueuedStage(latestRun, input.payload.stage)
    if (currentVersion !== input.payload.version) {
      return handleStaleStageVersionMessage({
        ...input,
        run: latestRun,
      })
    }
  }

  input.logger.info(
    {
      runId: latestRun.id,
      jiraKey: latestRun.jira_key,
      stage: input.payload.stage,
      messageId: input.messageId,
      receiveCount: input.receiveCount,
      payloadVersion: input.payload.version,
      currentVersion: expectedVersionForQueuedStage(latestRun, input.payload.stage),
      currentState: latestRun.state,
      expectedState: input.payload.expected_state,
      revision: input.payload.revision,
    },
    'Dropping OneShot stage message after claim miss because the queued run moved or was claimed concurrently',
  )
  return true
}
