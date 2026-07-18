import { describe, expect, it, vi } from 'vitest'
import { OneShotRunEventsDB } from './events.js'

describe('OneShotRunEventsDB', () => {
  it('serializes and parses run event metadata', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([undefined, undefined])
      .mockResolvedValueOnce([[
        { id: 1 },
      ], undefined])
      .mockResolvedValueOnce([[
        {
          id: 1,
          oneshot_run_id: 99,
          event_type: 'run_claimed',
          from_state: 'queued_for_review',
          to_state: 'reviewing',
          stage: 'review',
          metadata_json: '{"version":2}',
          occurred_at: '2026-04-15T12:00:00.000Z',
        },
      ], undefined])

    const eventsDb = new OneShotRunEventsDB({
      query: queryMock,
    } as any)

    await eventsDb.createEvent({
      oneshot_run_id: 99,
      event_type: 'run_claimed',
      from_state: 'queued_for_review',
      to_state: 'reviewing',
      stage: 'review',
      metadata_json: { version: 2 },
    })

    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO oneshot_run_events'),
      [99, 'run_claimed', 'queued_for_review', 'reviewing', 'review', '{"version":2}'],
    )

    const events = await eventsDb.getEventsForRun(99)

    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT id'),
      [99],
    )
    expect(queryMock.mock.calls[1][0]).toContain(
      'ORDER BY occurred_at ASC, id ASC',
    )
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WHERE id IN (?)'),
      [[1]],
    )
    expect(events).toEqual([
      expect.objectContaining({
        oneshot_run_id: 99,
        event_type: 'run_claimed',
        from_state: 'queued_for_review',
        to_state: 'reviewing',
        stage: 'review',
        metadata_json: { version: 2 },
      }),
    ])
  })

  it('accepts mysql2-parsed JSON metadata objects', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[
        { id: 2 },
      ], undefined])
      .mockResolvedValueOnce([[
        {
          id: 2,
          oneshot_run_id: 100,
          event_type: 'stage_attempt_metrics',
          from_state: null,
          to_state: null,
          stage: 'planning',
          metadata_json: { version: 2, failureKind: 'other' },
          occurred_at: '2026-04-15T12:01:00.000Z',
        },
      ], undefined])

    const eventsDb = new OneShotRunEventsDB({
      query: queryMock,
    } as any)

    const events = await eventsDb.getEventsForRun(100)

    expect(events).toEqual([
      expect.objectContaining({
        oneshot_run_id: 100,
        event_type: 'stage_attempt_metrics',
        stage: 'planning',
        metadata_json: { version: 2, failureKind: 'other' },
      }),
    ])
  })

  it('loads events by ordered IDs and preserves timeline ordering in memory', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce([[
        { id: 10 },
        { id: 8 },
      ], undefined])
      .mockResolvedValueOnce([[
        {
          id: 8,
          oneshot_run_id: 133,
          event_type: 'state_transition',
          from_state: 'planning',
          to_state: 'queued_for_review',
          stage: 'planning',
          metadata_json: '{"order":"second"}',
          occurred_at: '2026-04-15T12:02:00.000Z',
        },
        {
          id: 10,
          oneshot_run_id: 133,
          event_type: 'run_claimed',
          from_state: 'queued_for_planning',
          to_state: 'planning',
          stage: 'planning',
          metadata_json: '{"order":"first"}',
          occurred_at: '2026-04-15T12:01:00.000Z',
        },
      ], undefined])

    const eventsDb = new OneShotRunEventsDB({
      query: queryMock,
    } as any)

    const events = await eventsDb.getEventsForRun(133)

    expect(queryMock.mock.calls[0][0]).toContain(
      'ORDER BY occurred_at ASC, id ASC',
    )
    expect(queryMock.mock.calls[1][0]).not.toContain('SELECT *')
    expect(events.map((event) => event.id)).toEqual([10, 8])
    expect(events.map((event) => event.metadata_json?.order)).toEqual([
      'first',
      'second',
    ])
  })

  it('loads only stage-attempt metric fields for budget checks', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce([[
      {
        event_type: 'stage_attempt_metrics',
        stage: 'code_review',
        metadata_json: '{"version":1,"stage_tokens_used":1200}',
      },
    ], undefined])

    const eventsDb = new OneShotRunEventsDB({
      query: queryMock,
    } as any)

    const events = await eventsDb.getStageAttemptMetricEventsForBudget(
      133,
      'code_review',
    )

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "event_type = 'stage_attempt_metrics'",
      ),
      [133, 'code_review'],
    )
    expect(queryMock.mock.calls[0][0]).not.toContain('SELECT *')
    expect(events).toEqual([
      {
        event_type: 'stage_attempt_metrics',
        stage: 'code_review',
        metadata_json: { version: 1, stage_tokens_used: 1200 },
      },
    ])
  })

  it('loads the latest manual stage restart timestamp using occurred_at and id tie-breaks', async () => {
    const restartAt = new Date('2026-05-08T05:20:18.000Z')
    const queryMock = vi.fn().mockResolvedValueOnce([[
      {
        occurred_at: restartAt,
      },
    ], undefined])

    const eventsDb = new OneShotRunEventsDB({
      query: queryMock,
    } as any)

    await expect(eventsDb.getLatestManualStageRestartAt(106)).resolves.toEqual(
      restartAt,
    )
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("event_type = 'state_transition'"),
      [106],
    )
    expect(queryMock.mock.calls[0][0]).toContain(
      "JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_restart'",
    )
    expect(queryMock.mock.calls[0][0]).toContain(
      'ORDER BY occurred_at DESC, id DESC',
    )
    expect(queryMock.mock.calls[0][0]).toContain('LIMIT 1')
  })

  it('returns null when metadata is null, missing reason, or no valid manual restart exists', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce([[], undefined])
    const eventsDb = new OneShotRunEventsDB({
      query: queryMock,
    } as any)

    await expect(eventsDb.getLatestManualStageRestartAt(106)).resolves.toBeNull()
    expect(queryMock.mock.calls[0][0]).toContain(
      "JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_restart'",
    )
  })
})
