import { describe, expect, it } from 'vitest'
import { DeterministicInvestigationPlanningAdvisor, InvestigationProbeRecipeRegistry } from './InvestigationPlanning.js'

describe('InvestigationProbeRecipeRegistry', () => {
  it('accepts future investigation recipes without changing the causal evaluator', () => {
    const registry = new InvestigationProbeRecipeRegistry([{
      id: 'external-api-contract-comparison',
      adapter: 'host',
      intent: 'compare_affected_to_unaffected_scope',
      description: 'Compare bounded vendor API response evidence.',
      addresses: ['trigger', 'mechanism', 'proof', 'recovery'],
      maxExecutions: 1,
    }])

    expect(registry.recommend(['mechanism', 'proof']).map(recipe => recipe.id)).toEqual([
      'external-api-contract-comparison',
    ])
  })
})

describe('DeterministicInvestigationPlanningAdvisor', () => {
  it('expands API and batch symptoms into generic session, TTL, retry, and page-size search concepts', async () => {
    const registry = new InvestigationProbeRecipeRegistry()
    const advice = await new DeterministicInvestigationPlanningAdvisor().advise({
      run: {
        id: 'inv-generic-planning',
        jiraKey: 'SUP-1',
        title: 'Batch queues receive HTTP 500 and 504 responses',
        scope: {
          clientId: 'CLIENT',
          environment: 'PROD_REPLICA',
          serviceIds: ['batch-service'],
          keywords: ['queue backlog', 'repeated jobs'],
        },
        status: 'running',
        currentStage: 'correlation',
        confidence: null,
        summary: null,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
      findings: [],
      evidence: [],
      assessment: {
        complete: false,
        diagnosisReady: false,
        operationallyClosed: false,
        score: 0,
        dimensions: [],
        missingDimensions: ['trigger', 'mechanism', 'proof'],
        missingDiagnosisDimensions: ['trigger', 'mechanism', 'proof'],
        missingClosureDimensions: ['recovery', 'prevention'],
        selectedHypotheses: [],
        hypotheses: [],
        symptomClusters: [],
        unexplainedSymptomClusterIds: [],
        ambiguousSymptomClusterIds: [],
        summary: 'Causal evidence is incomplete.',
      },
      recipes: registry.list(),
      executionCounts: {},
      iteration: 1,
    })

    expect(advice.causeHypotheses).toEqual(expect.arrayContaining(['integration', 'workflow']))
    expect(advice.searchHints).toEqual(expect.arrayContaining(['session', 'ttl', 'retry', 'pageSize']))
  })

  it('traces a focused code consumer before data when the first code pass found no structured relationship', async () => {
    const registry = new InvestigationProbeRecipeRegistry()
    const advice = await new DeterministicInvestigationPlanningAdvisor().advise({
      run: {
        id: 'inv-code-follow-up',
        jiraKey: 'SUP-2',
        title: 'Application save fails after an integration response',
        scope: {
          clientId: 'CLIENT',
          environment: 'PROD_REPLICA',
          serviceIds: ['application'],
          repoNames: ['client-services', 'core-app'],
        },
        status: 'running',
        currentStage: 'correlation',
        confidence: null,
        summary: null,
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      },
      findings: [],
      evidence: [],
      assessment: {
        complete: false,
        diagnosisReady: false,
        operationallyClosed: false,
        score: 0,
        dimensions: [],
        missingDimensions: ['trigger', 'mechanism', 'proof'],
        missingDiagnosisDimensions: ['trigger', 'mechanism', 'proof'],
        missingClosureDimensions: ['recovery', 'prevention'],
        selectedHypotheses: [],
        hypotheses: [],
        symptomClusters: [],
        unexplainedSymptomClusterIds: [],
        ambiguousSymptomClusterIds: [],
        summary: 'Causal evidence is incomplete.',
      },
      recipes: registry.list(),
      executionCounts: { code: 1 },
      probeExecutionCounts: { 'code-release-correlation': 1 },
      iteration: 2,
    })

    expect(advice.proposedProbeIds[0]).toBe('code-setting-consumer')
  })
})
