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

describe('PhiGuard', () => {
  it('loads Meridian-compatible PHI columns from YAML for evidence-only diagnostics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'phi-guard-'))
    temporaryRoots.push(root)
    const configPath = path.join(root, 'phi_columns.yaml')
    await writeFile(configPath, [
      'member:',
      '  - custom_phi_column',
      '  - medicare_no',
      'case_table:',
      '  - requester_firstname',
      '',
    ].join('\n'))
    vi.stubEnv('INVESTIGATION_PHI_COLUMNS_CONFIG', configPath)
    vi.resetModules()

    const { PhiGuard } = await import('./PhiGuard.js')
    const guard = new PhiGuard()

    expect(guard.redactRow({
      custom_phi_column: 'member-specific-value',
      requester_firstname: 'Jane',
      safe_status: 'OPEN',
      member_id: '123456',
    })).toEqual({
      custom_phi_column: '[REDACTED]',
      requester_firstname: '[REDACTED]',
      safe_status: 'OPEN',
      member_id: '[REDACTED]',
    })
  })

  it('does not maintain a separate curated PHI column list outside YAML', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'phi-guard-'))
    temporaryRoots.push(root)
    const configPath = path.join(root, 'phi_columns.yaml')
    await writeFile(configPath, [
      'member:',
      '  - custom_phi_column',
      '',
    ].join('\n'))
    vi.stubEnv('INVESTIGATION_PHI_COLUMNS_CONFIG', configPath)
    vi.resetModules()

    const { PhiGuard } = await import('./PhiGuard.js')
    const guard = new PhiGuard()

    expect(guard.redactRow({
      custom_phi_column: 'member-specific-value',
      diagnosis_code: 'A123',
      safe_status: 'OPEN',
    })).toEqual({
      custom_phi_column: '[REDACTED]',
      diagnosis_code: 'A123',
      safe_status: 'OPEN',
    })
  })

  it('fails closed when PHI column YAML is unavailable', async () => {
    vi.stubEnv('INVESTIGATION_PHI_COLUMNS_CONFIG', path.join(tmpdir(), 'missing-phi-columns.yaml'))
    vi.resetModules()

    const { PhiGuard } = await import('./PhiGuard.js')
    const guard = new PhiGuard()

    expect(guard.redactRow({
      safe_status: 'OPEN',
      safe_count: 2,
    })).toEqual({
      safe_status: '[REDACTED]',
      safe_count: '[REDACTED]',
    })
  })
})
