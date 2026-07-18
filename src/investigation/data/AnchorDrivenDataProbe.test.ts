import { describe, expect, it } from 'vitest'
import {
  buildAnchorProbeQueries,
  buildColumnInventoryQuery,
  getAnchorDiagnosticTables,
  getCodeFlowTables,
} from './AnchorDrivenDataProbe.js'
import { PhiGuard } from './PhiGuard.js'
import type { InvestigationScope } from '../types/investigation.js'

describe('AnchorDrivenDataProbe', () => {
  it('builds bounded MySQL probes from code-flow tables and labeled anchors', () => {
    const scope: InvestigationScope = {
      clientId: 'PERFORMRX',
      environment: 'UAT',
      serviceIds: ['epa-service'],
      evidenceAnchors: [
        {
          kind: 'case_number',
          source: 'description',
          value: '123456789',
          label: 'Case Number',
          sensitive: true,
        },
      ],
      diagnosticContext: {
        dataFlowHints: [
          {
            sourceRepo: 'core-app',
            sourcePath: 'MedicalMgmt/src/Der.hbm.xml',
            artifactType: 'hibernate_mapping',
            tableName: 'der',
            columns: [
              { name: 'id', propertyName: 'id' },
              { name: 'case_id', propertyName: 'caseId' },
              { name: 'member_id', propertyName: 'memberId' },
              { name: 'status', propertyName: 'status' },
            ],
          },
        ],
      },
    }

    expect(getCodeFlowTables(scope)).toEqual(['der'])
    expect(buildColumnInventoryQuery(getCodeFlowTables(scope))).toMatchObject({
      parameters: ['der'],
    })

    const probes = buildAnchorProbeQueries(scope, [
      { table_name: 'der', column_name: 'id' },
      { table_name: 'der', column_name: 'case_id' },
      { table_name: 'der', column_name: 'member_id' },
      { table_name: 'der', column_name: 'status' },
    ])

    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({
      tableName: 'der',
      anchorKind: 'case_number',
      anchorColumn: 'case_id',
      parameters: ['123456789'],
    })
    expect(probes[0]?.sql).toContain('WHERE `case_id` IN (?)')
    expect(probes[0]?.sql).not.toContain('123456789')
    expect(probes[0]?.sql).not.toContain('member_id_sample')
  })

  it('uses fuzzy config matching for code-derived config tables without binding config text as a row value', () => {
    const scope: InvestigationScope = {
      clientId: 'PERFORMRX',
      environment: 'UAT',
      serviceIds: ['epa-service'],
      evidenceAnchors: [
        {
          kind: 'config_key',
          source: 'description',
          value: 'E Appeal Allowed',
          label: 'config key',
          sensitive: false,
        },
      ],
      diagnosticContext: {
        dataFlowHints: [
          {
            sourceRepo: 'core-app',
            sourcePath: 'MedicalMgmt/src/EpaConfig.hbm.xml',
            artifactType: 'hibernate_mapping',
            tableName: 'der_defaults_epa_config',
            columns: [
              { name: 'id', propertyName: 'id' },
              { name: 'e_appeal_allowed', propertyName: 'eAppealAllowed' },
              { name: 'is_eappeal_supported', propertyName: 'isEAppealSupported' },
              { name: 'member_id', propertyName: 'memberId' },
            ],
          },
        ],
      },
    }

    const probes = buildAnchorProbeQueries(scope, [
      { table_name: 'der_defaults_epa_config', column_name: 'id' },
      { table_name: 'der_defaults_epa_config', column_name: 'e_appeal_allowed' },
      { table_name: 'der_defaults_epa_config', column_name: 'is_eappeal_supported' },
      { table_name: 'der_defaults_epa_config', column_name: 'member_id' },
    ])

    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatchObject({
      tableName: 'der_defaults_epa_config',
      anchorKind: 'config_key',
      anchorColumn: 'config_sample',
      parameters: [],
    })
    expect(probes[0]?.sql).toContain('e_appeal_allowed_sample')
    expect(probes[0]?.sql).toContain('is_eappeal_supported_truthy_rows')
    expect(probes[0]?.sql).not.toContain('E Appeal Allowed')
    expect(probes[0]?.sql).not.toContain('member_id_sample')
  })

  it('redacts Meridian PHI columns from diagnostic rows', () => {
    const guard = new PhiGuard()
    expect(guard.redactRow({
      requester_firstname_sample: 'Jane',
      status_sample: 'OPEN',
    })).toEqual({
      requester_firstname_sample: '[REDACTED]',
      status_sample: 'OPEN',
    })
  })

  it('adds configured foundational tables when an anchor exists before code mapping', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      evidenceAnchors: [{
        kind: 'member_identifier',
        source: 'description',
        value: '123456789/00',
        label: 'member identifier',
        sensitive: true,
      }],
    }

    expect(getAnchorDiagnosticTables(scope)).toEqual(expect.arrayContaining([
      'member',
      'member_eligibility',
      'member_current_link',
      'auth',
    ]))
  })

  it('uses a PHI-classified identifier column as a bound lookup key without sampling it', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      evidenceAnchors: [{
        kind: 'member_identifier',
        source: 'description',
        value: '123456789/00',
        label: 'member identifier',
        sensitive: true,
      }],
    }

    const probes = buildAnchorProbeQueries(scope, [
      { table_name: 'member', column_name: 'id' },
      { table_name: 'member', column_name: 'member_id' },
      { table_name: 'member', column_name: 'case_head_id' },
      { table_name: 'member', column_name: 'status' },
    ])

    expect(probes[0]).toMatchObject({
      tableName: 'member',
      anchorKind: 'member_identifier',
      anchorColumn: 'member_id',
      parameters: ['123456789/00', '123456789-00', '123456789'],
    })
    expect(probes[0]?.sql).toContain('WHERE `member_id` IN (?, ?, ?)')
    expect(probes[0]?.sql).not.toContain('member_id_sample')
    expect(probes[0]?.sql).not.toContain('123456789/00')
  })

  it('prefers configured external subscriber identifiers over generic member numbers', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      evidenceAnchors: [{
        kind: 'member_identifier',
        source: 'description',
        value: '123456789/00',
        sensitive: true,
      }],
    }

    const memberProbe = buildAnchorProbeQueries(scope, [
      { table_name: 'member', column_name: 'id' },
      { table_name: 'member', column_name: 'member_no' },
      { table_name: 'member', column_name: 'subscriber_id' },
    ]).find(probe => probe.tableName === 'member')

    expect(memberProbe).toMatchObject({
      anchorColumn: 'subscriber_id',
      parameters: ['123456789/00', '123456789-00', '123456789'],
    })
  })

  it('does not treat member-related foreign keys as direct member identifiers', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      evidenceAnchors: [{
        kind: 'member_identifier',
        source: 'description',
        value: '123456789/00',
        sensitive: true,
      }],
    }

    expect(buildAnchorProbeQueries(scope, [
      { table_name: 'member', column_name: 'member_matching_id' },
      { table_name: 'member', column_name: 'member_requested_id' },
      { table_name: 'member', column_name: 'case_head_id' },
    ])).toEqual([])
  })

  it('resolves external anchors through a root key before probing relational tables', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      evidenceAnchors: [{
        kind: 'member_identifier',
        source: 'description',
        value: '123456789/00',
        sensitive: true,
      }],
    }

    const probes = buildAnchorProbeQueries(scope, [
      { table_name: 'member', column_name: 'id' },
      { table_name: 'member', column_name: 'member_no' },
      { table_name: 'member_current_link', column_name: 'id' },
      { table_name: 'member_current_link', column_name: 'member_id' },
      { table_name: 'member_current_link', column_name: 'in_active' },
      { table_name: 'member_eligibility', column_name: 'id' },
      { table_name: 'member_eligibility', column_name: 'memberid' },
      { table_name: 'member_eligibility', column_name: 'in_active' },
    ])

    expect(probes.find(probe => probe.tableName === 'member')?.sql)
      .toContain('WHERE `member_no` IN (?, ?, ?)')
    expect(probes.find(probe => probe.tableName === 'member')?.parameters)
      .toEqual(['123456789/00', '123456789-00', '123456789'])
    expect(probes.find(probe => probe.tableName === 'member_current_link')).toMatchObject({
      relationship: {
        rootTable: 'member',
        rootAnchorColumn: 'member_no',
        rootKeyColumn: 'id',
      },
    })
    expect(probes.find(probe => probe.tableName === 'member_current_link')?.sql)
      .toContain('WHERE `member_id` IN (SELECT `id` FROM `member` WHERE `member_no` IN (?, ?, ?))')
    expect(probes.find(probe => probe.tableName === 'member_eligibility')?.sql)
      .toContain('WHERE `memberid` IN (SELECT `id` FROM `member` WHERE `member_no` IN (?, ?, ?))')
  })
})
