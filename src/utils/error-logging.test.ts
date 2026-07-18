import { describe, expect, it } from 'vitest'
import { buildErrorLogFields } from './error-logging.js'

describe('buildErrorLogFields', () => {
  it('preserves rich Error metadata for pino logs', () => {
    const error = new Error('startup failed')

    const fields = buildErrorLogFields(error)

    expect(fields.err).toBe(error)
    expect(fields.errorMessage).toBe('startup failed')
    expect(fields.errorName).toBe('Error')
    expect(fields.errorStack).toContain('startup failed')
  })

  it('serializes non-Error values without throwing', () => {
    expect(buildErrorLogFields('bad config')).toEqual({
      error: 'bad config',
      errorMessage: 'bad config',
    })

    expect(buildErrorLogFields({ step: 'schema' })).toEqual({
      error: { step: 'schema' },
      errorMessage: '{"step":"schema"}',
    })
  })
})
