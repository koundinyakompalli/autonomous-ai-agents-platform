import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('SensitiveTextRedactor', () => {
  it('uses Meridian-compatible PHI columns plus secret/property rules for free-text redaction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sensitive-text-redactor-'))
    temporaryRoots.push(root)
    const configPath = path.join(root, 'phi_columns.yaml')
    await writeFile(configPath, [
      'case_table:',
      '  - custom_phi_column',
      '  - requester_firstname',
      '',
    ].join('\n'))
    vi.stubEnv('INVESTIGATION_PHI_COLUMNS_CONFIG', configPath)
    vi.resetModules()

    const { redactSensitiveText, sanitizeAuditText } = await import('./SensitiveTextRedactor.js')
    const redacted = redactSensitiveText([
      'client.secret=secretValue123,',
      'api.key=apiValue456,',
      'jdbc.url=jdbc:mysql://secure-db-host.example.internal/medhok?password=jdbcSecret,',
      'custom_phi_column=member-specific-value,',
      'requester firstname=Jane,',
      'email john.doe@example.test,',
      'affected 42 members',
    ].join(' '))

    for (const rawValue of [
      'secretValue123',
      'apiValue456',
      'secure-db-host.example.internal',
      'jdbcSecret',
      'member-specific-value',
      'Jane',
      'john.doe@example.test',
      '42 members',
    ]) {
      expect(redacted).not.toContain(rawValue)
    }
    expect(redacted).toContain('client.secret=[REDACTED]')
    expect(redacted).toContain('custom_phi_column=[REDACTED]')
    expect(redacted).toContain('requester firstname=[REDACTED]')
    expect(redacted).toContain('[REDACTED_COUNT] members')
    expect(sanitizeAuditText('CLIENT:PROD_REPLICA:db01 query completed')).toContain('[TARGET_KEY_REDACTED]')
  })
})
