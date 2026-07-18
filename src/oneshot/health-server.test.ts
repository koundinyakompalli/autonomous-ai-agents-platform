import { describe, expect, it } from 'vitest'
import { buildHealthResponse } from './health-server.js'
import type { QueueConsumerHealthSnapshot } from './consumer-base.js'

function createSnapshot(overrides: Partial<QueueConsumerHealthSnapshot> = {}): QueueConsumerHealthSnapshot {
  return {
    stage: 'planning',
    isRunning: true,
    activeHandler: false,
    healthy: true,
    queueUrl: 'https://example.com/planning.fifo',
    lastActivityAt: new Date().toISOString(),
    staleAfterMs: 60_000,
    lastMessageId: 'msg-1',
    lastReceiveCount: 1,
    lastError: null,
    ...overrides,
  }
}

describe('buildHealthResponse', () => {
  it('reports healthy consumers on /health', () => {
    const response = buildHealthResponse('/health', 'PLANNER', true, createSnapshot())

    expect(response?.statusCode).toBe(200)
    expect(response?.body.status).toBe('healthy')
    expect(response?.body.ready).toBe(true)
  })

  it('returns 503 for unhealthy consumers', () => {
    const response = buildHealthResponse(
      '/health',
      'IMPLEMENTER',
      true,
      createSnapshot({
        healthy: false,
        lastError: 'stale consumer loop',
      }),
    )

    expect(response?.statusCode).toBe(503)
    expect(response?.body.status).toBe('unhealthy')
    expect((response?.body.consumer as { lastError: string | null }).lastError).toContain('stale')
  })

  it('returns null for unknown paths', () => {
    expect(buildHealthResponse('/unknown', 'PLANNER', true, createSnapshot())).toBeNull()
  })
})
