import { describe, expect, it } from 'vitest'
import { QueryPackRegistry } from './QueryPackRegistry.js'

describe('QueryPackRegistry', () => {
  it('does not expose application-code-derived diagnostics as query packs', () => {
    const registry = new QueryPackRegistry()

    expect(registry.getById('appcode_epa_eappeal_config_validation')).toBeNull()
    expect(registry.getForEnvironment('UAT').map(pack => pack.id)).not.toContain('appcode_epa_eappeal_config_validation')
  })

  it('returns explicitly registered custom packs by environment', () => {
    const registry = new QueryPackRegistry([
      {
        id: 'custom_metadata_probe',
        description: 'Custom metadata probe.',
        environments: ['UAT'],
        allowedTables: ['information_schema.tables'],
        parameterNames: [],
        sql: 'SELECT table_schema FROM information_schema.tables LIMIT 1',
        maxRows: 1,
        timeoutMs: 1_000,
        redactionTags: ['metadata_only'],
      },
    ])

    expect(registry.getById('custom_metadata_probe')).toMatchObject({
      id: 'custom_metadata_probe',
    })
    expect(registry.getForEnvironment('UAT').map(pack => pack.id)).toContain('custom_metadata_probe')
  })
})
