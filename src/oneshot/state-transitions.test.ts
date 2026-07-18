import { describe, expect, it, vi } from 'vitest'

const {
  loggerErrorMock,
  runOutcomeCounterAddMock,
} = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  runOutcomeCounterAddMock: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    error: loggerErrorMock,
    info: vi.fn(),
    warn: vi.fn(),
  })),
}))

vi.mock('./telemetry/metrics.js', () => ({
  runOutcomeCounter: {
    add: runOutcomeCounterAddMock,
  },
}))

import type { Database } from '../orchestrator/database.js'
import { recordPostmortemFailure } from './state-transitions.js'

describe('recordPostmortemFailure', () => {
  it('logs and records a postmortem generation failure event', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([[], undefined]),
    }
    const db = {
      getPool: vi.fn(() => pool),
    } as unknown as Database

    const error = new Error('s3 write failed')
    error.stack = 'boom-stack'

    await recordPostmortemFailure(db, 84, error, 'testing')

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 84,
        error: 's3 write failed',
        stack: 'boom-stack',
      }),
      'Failed to generate postmortem artifact',
    )
    expect(runOutcomeCounterAddMock).toHaveBeenCalledWith(1, {
      stage: 'postmortem',
      outcome: 'failed',
    })
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oneshot_run_events'),
      expect.arrayContaining([
        84,
        'artifact_generation_failed',
        null,
        null,
        'postmortem',
      ]),
    )
    const metadata = JSON.parse(pool.query.mock.calls[0][1][5])
    expect(metadata).toMatchObject({
      failedStage: 'testing',
      error: 's3 write failed',
      stack: 'boom-stack',
      stackPreview: 'boom-stack',
    })
  })
})
