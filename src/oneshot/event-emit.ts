import type { Logger } from 'pino'

export function logEventEmitFailure(input: {
  logger: Logger
  runId: number
  eventType: string
  stage?: string | null
  error: unknown
}): void {
  input.logger.warn(
    {
      runId: input.runId,
      eventType: input.eventType,
      stage: input.stage ?? null,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    },
    '[EVENT_EMIT_FAILED] Failed to persist OneShot audit event',
  )
}

export function eventEmitFailureLogger(input: {
  logger: Logger
  runId: number
  eventType: string
  stage?: string | null
}): (error: unknown) => void {
  return (error: unknown) => logEventEmitFailure({ ...input, error })
}
