import { describe, expect, it } from 'vitest'
import { planCodeDerivedDiagnostic } from './CodeDerivedDiagnosticPlanner.js'
import type { InvestigationScope } from '../types/investigation.js'

describe('CodeDerivedDiagnosticPlanner', () => {
  it('keeps schema-width diagnostics independent from unverified application table existence', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      keywords: ["Data too long for column 'first_name'"],
      evidenceAnchors: [{
        kind: 'member_identifier',
        source: 'description',
        value: '123456789/00',
        sensitive: true,
      }],
      ticketContext: {
        source: 'jira',
        jiraKey: 'SUP-1',
        fetchStatus: 'fetched',
        attachments: [{
          id: 'payload',
          filename: 'response.json',
          extractionStatus: 'text_extracted',
          observedFieldLengths: [{
            fieldName: 'firstName',
            path: 'AOR.firstName',
            length: 47,
            sourceRef: 'payload',
          }, {
            fieldName: 'releaseTypeDesc',
            path: 'AOR.releaseTypeDesc',
            length: 48,
            sourceRef: 'payload',
          }],
        }],
      },
      diagnosticContext: {
        runtimeFailureColumns: ['first_name'],
        dataFlowHints: [{
          sourceRepo: 'application',
          sourcePath: 'MemberDocumentMapper.java',
          sourceTerm: 'first_name',
          provenance: 'runtime_context',
          artifactType: 'unknown',
          tableName: 'member_documents',
          columns: [{
            name: 'first_name',
            propertyName: 'firstName',
            linkedFields: ['firstName', 'aor.firstName'],
          }, {
            name: 'description',
            propertyName: 'description',
            linkedFields: ['releaseTypeDesc', 'aor.releaseTypeDesc'],
          }],
          linkedFields: ['firstName', 'aor.firstName', 'releaseTypeDesc', 'aor.releaseTypeDesc'],
        }, {
          sourceRepo: 'application',
          sourcePath: 'MemberMapper.java',
          sourceTerm: 'first_name',
          provenance: 'runtime_context',
          artifactType: 'unknown',
          tableName: 'member',
          columns: [{ name: 'first_name', propertyName: 'firstName' }],
          linkedFields: ['firstName'],
        }],
      },
    }

    const pack = planCodeDerivedDiagnostic(scope)

    expect(pack?.id).toBe('appcode_schema_column_constraint_check')
    expect(pack?.sql).toContain('FROM information_schema.columns')
    expect(pack?.sql).toContain("table_name = 'member_documents'")
    expect(pack?.sql).toContain("table_name = 'member_documents' AND column_name = 'first_name' THEN 47")
    expect(pack?.sql).not.toContain("table_name = 'member' AND column_name = 'first_name'")
    expect(pack?.sql).not.toContain('FROM member_documents')
    expect(pack?.parameterNames).not.toContain('ticket_member_identifiers')
  })

  it('does not assign a model-level payload field to an unlinked schema column', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
      serviceIds: ['application'],
      ticketContext: {
        source: 'jira',
        jiraKey: 'SUP-2',
        fetchStatus: 'fetched',
        attachments: [{
          id: 'payload',
          filename: 'response.json',
          extractionStatus: 'text_extracted',
          observedFieldLengths: [{
            fieldName: 'firstName',
            path: 'memberEligibility.[].AOR.firstName',
            length: 47,
            sourceRef: 'payload',
          }],
        }],
      },
      diagnosticContext: {
        dataFlowHints: [{
          sourceRepo: 'application',
          sourcePath: 'Member.hbm.xml',
          sourceTerm: 'Member',
          modelName: 'Member',
          provenance: 'derived_reference',
          artifactType: 'hibernate_mapping',
          tableName: 'member',
          columns: [{ name: 'middle_name', propertyName: 'middleName' }],
          linkedFields: ['firstName'],
        }],
      },
    }

    expect(planCodeDerivedDiagnostic(scope)).toBeNull()
  })

  it('uses only direct member identity fields for aggregate anchor diagnostics', () => {
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
      diagnosticContext: {
        dataFlowHints: [{
          sourceRepo: 'application',
          sourcePath: 'Member.hbm.xml',
          artifactType: 'hibernate_mapping',
          tableName: 'member',
          columns: [
            { name: 'member_id', propertyName: 'memberId' },
            { name: 'member_requested_id', propertyName: 'memberRequestedId' },
            { name: 'member_self_direction_id', propertyName: 'memberSelfDirectionId' },
          ],
        }],
      },
    }

    const pack = planCodeDerivedDiagnostic(scope)

    expect(pack?.sql).toContain('WHERE member_id IN')
    expect(pack?.sql).not.toContain('member_requested_id')
    expect(pack?.sql).not.toContain('member_self_direction_id')
  })

  it('plans a bounded workflow queue-routing diagnostic from code-derived table hints and ticket process names', () => {
    const scope: InvestigationScope = {
      clientId: 'HUMANA',
      environment: 'PROD_REPLICA',
      serviceIds: ['core-app'],
      repoNames: ['core-app'],
      ticketContext: {
        source: 'jira',
        jiraKey: 'CPSUP-46150',
        fetchStatus: 'fetched',
        title: 'AOR Review and VMD subtask visible in Nurse Review Unassigned portlet',
      },
      diagnosticContext: {
        codeEvidenceTerms: ['QueueAuthorization', 'getAppGroupByTaskName', 'process_flow', 'adhok_business_task'],
        dataFlowHints: [
          {
            sourceRepo: 'core-app',
            sourcePath: 'mm-shared-services/src/main/java/com/medhok/mm/shared/service/BPMSharedService.java',
            artifactType: 'hql_literal',
            tableName: 'queue_authorization',
          },
          {
            sourceRepo: 'core-app',
            sourcePath: 'MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/ProcessFlow.hbm.xml',
            artifactType: 'hibernate_mapping',
            tableName: 'process_flow',
            columns: [{ name: 'active_group', propertyName: 'activeGroup' }],
          },
        ],
      },
    }

    const pack = planCodeDerivedDiagnostic(scope)

    expect(pack).toMatchObject({
      id: 'appcode_workflow_queue_routing',
      environments: ['PROD_REPLICA'],
      maxRows: 100,
    })
    expect(pack?.sql).toContain('FROM adhok_business_process abp')
    expect(pack?.sql).toContain('FROM adhok_business_task abt')
    expect(pack?.sql).toContain("'AOR Review'")
    expect(pack?.sql).toContain("'VMD'")
    expect(pack?.sql).toContain("'Nurse Review'")
    expect(pack?.sql).toContain('LIMIT 100')
    expect(pack?.sql).not.toContain('Careplus')
  })

  it('does not plan workflow SQL from ticket prose alone without code-derived routing signals', () => {
    const scope: InvestigationScope = {
      clientId: 'HUMANA',
      environment: 'PROD_REPLICA',
      serviceIds: ['core-app'],
      ticketContext: {
        source: 'jira',
        jiraKey: 'CPSUP-46150',
        fetchStatus: 'fetched',
        title: 'AOR Review and VMD subtask visible in Nurse Review Unassigned portlet',
      },
    }

    expect(planCodeDerivedDiagnostic(scope)).toBeNull()
  })
})
