import { describe, expect, it } from 'vitest'
import {
  buildRepoRouteCardContext,
  getRepoRouteCardMatches,
} from './repo-route-cards.js'

describe('buildRepoRouteCardContext', () => {
  it('returns core-app route-card guidance for member search tickets', () => {
    const context = buildRepoRouteCardContext(
      'core-app',
      'Update MemberSearchForm button styling for the member search flow.',
    )

    expect(context).toContain('## Repo Route Cards')
    expect(context).toContain('MemberSearchForm')
    expect(context).toContain('SmartGWT')
  })

  it('returns core-app web-service guidance for InterOP companion contract work', () => {
    const context = buildRepoRouteCardContext(
      'core-app',
      'Update AuthRestServices submitPreAuth and WSPreAuthInput for an InterOP PAS $submit story.',
    )

    expect(context).toContain('Core Web-Service Contracts')
    expect(context).toContain('medhok-web-services')
    expect(context).toContain('ws-doc-api')
    expect(context).toContain('CoreRestClient')
    expect(context).toContain('multi-repo run group')
  })

  it('returns InterOP baseline route-card guidance for generic FHIR work', () => {
    const context = buildRepoRouteCardContext(
      'interop',
      'Fix a FHIR payload mapping.',
    )

    expect(context).toContain('InterOP Development Baseline')
    expect(context).toContain('Interop-IT-OPS-Reference.md')
    expect(context).toContain('CDS_Hooks_Implementation_Guide.md')
    expect(context).toContain('Build an acceptance matrix')
    expect(context).toContain('Do not hardcode demo payors')
    expect(context).toContain('companion core-app child run')
  })

  it('returns CRD and baseline InterOP route cards for MedPharm PA-list work', () => {
    const matches = getRepoRouteCardMatches(
      'cp-interoperability-monorepo',
      'MedPharm CRD order-sign PA-list should set pa-needed and doc-needed from JCode coverage.',
    )

    expect(matches.map((card) => card.id)).toEqual(
      expect.arrayContaining(['interop.baseline', 'interop.crd-medpharm']),
    )
  })

  it('keeps InterOP CRD guidance aware of Core eligibility companion work', () => {
    const context = buildRepoRouteCardContext(
      'interop',
      'MedPharm CRD PA-list should use Coverage class group and plan for fetchMember eligibility filtering.',
    )

    expect(context).toContain('CRD / MedPharm PA List')
    expect(context).toContain('companion Core child run')
  })

  it('returns DTR and PAS InterOP route cards for engine and submit work', () => {
    const matches = getRepoRouteCardMatches(
      'interop',
      'Implement DTR $next-question for MCG and update PAS $submit QuestionnaireResponse handling.',
    )

    expect(matches.map((card) => card.id)).toEqual(
      expect.arrayContaining([
        'interop.baseline',
        'interop.dtr-engines',
        'interop.pas-submit-inquire-cancel',
      ]),
    )
  })

  it('returns Ai-agents route-card guidance for controller agent hosting tickets', () => {
    const context = buildRepoRouteCardContext(
      'Ai-agents',
      'Need support to host a new controller agent in enterprise-ai-agent-platform on AWS.',
    )

    expect(context).toContain('Controller Agent Hosting')
    expect(context).toContain('CLAUDE.md')
    expect(context).toContain('docs/guides/BUILD-AND-DEPLOYMENT.md')
    expect(context).toContain('terraform/30-controller-agents')
    expect(context).toContain('Controller agents decide orchestration')
  })

  it('accepts the GitHub slug alias for enterprise-ai-agent-platform route cards', () => {
    const context = buildRepoRouteCardContext(
      'enterprise-ai-agent-platform',
      'Add an internal MCP server with ALB routing.',
    )

    expect(context).toContain('MCP Server / Tool Integration')
    expect(context).toContain('docs/reference/NEVER-RULES-DETAILED.md')
    expect(context).toContain('terraform/47-internal-mcp-alb')
    expect(context).toContain('HTTPS')
  })
})
