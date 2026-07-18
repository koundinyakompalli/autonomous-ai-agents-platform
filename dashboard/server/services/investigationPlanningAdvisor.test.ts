import { describe, expect, it } from 'vitest'
import {
  InvestigationProbeRecipeRegistry,
  type InvestigationPlanningInput,
  type InvestigationRunRecord,
} from '../../../src/investigation/index.js'
import type { InvestigationLlmResponse } from './investigationLlmProvider.js'
import { SafeLlmInvestigationPlanningAdvisor } from './investigationPlanningAdvisor.js'

const run: InvestigationRunRecord = {
  id: 'inv-planner-test',
  jiraKey: 'SUP-123',
  title: 'Workflow action fails',
  scope: {
    clientId: 'CLIENT_A',
    environment: 'PROD_REPLICA',
    serviceIds: ['core-app'],
    releaseVersion: '1.2',
    keywords: ['workflow action failure'],
  },
  status: 'running',
  currentStage: 'correlation',
  confidence: null,
  summary: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
}

function planningInput(): InvestigationPlanningInput {
  return {
    run,
    findings: [],
    evidence: [],
    assessment: {
      complete: false,
      diagnosisReady: false,
      operationallyClosed: false,
      score: 0.25,
      missingDimensions: ['trigger', 'mechanism', 'proof'],
      missingDiagnosisDimensions: ['trigger', 'mechanism', 'proof'],
      missingClosureDimensions: ['recovery', 'prevention'],
      selectedHypotheses: [],
      hypotheses: [],
      symptomClusters: [],
      unexplainedSymptomClusterIds: [],
      ambiguousSymptomClusterIds: [],
      summary: 'Causal gaps remain.',
      dimensions: [
        { dimension: 'trigger', label: 'Trigger', complete: false, summary: '', evidenceRefs: [] },
        { dimension: 'mechanism', label: 'Mechanism', complete: false, summary: '', evidenceRefs: [] },
        { dimension: 'proof', label: 'Proof', complete: false, summary: '', evidenceRefs: [] },
      ],
    },
    recipes: new InvestigationProbeRecipeRegistry().list(),
    executionCounts: {},
    iteration: 1,
  }
}

describe('SafeLlmInvestigationPlanningAdvisor', () => {
  it('filters model output to the deterministic workflow, dimension, and probe allowlists', async () => {
    const invoke = async <T>(): Promise<InvestigationLlmResponse<T>> => ({
      providerKey: 'claude_agent_sdk',
      modelId: 'test-model',
      text: '{}',
      parsed: {
        workflowType: 'support_investigation',
        causeHypotheses: ['code', 'not-real'],
        missingDimensions: ['mechanism', 'prevention'],
        proposedProbeIds: ['code-release-correlation', 'run-arbitrary-sql'],
        evidenceGoals: ['Trace the failing operation to its implementation.'],
        searchHints: ['WorkflowProcessor'],
        expectedComparison: ['Compare affected and successful requests.'],
        acceptanceCriteria: ['The mapping is supported by repository evidence.'],
        rationale: 'Compare release-family code with runtime evidence.',
      } as T,
      metrics: { durationMs: 1, toolCalls: 0 },
    })
    const advisor = new SafeLlmInvestigationPlanningAdvisor(true, 1, invoke)

    const advice = await advisor.advise(planningInput())

    expect(advice).toMatchObject({
      source: 'llm',
      workflowType: 'support_investigation',
      causeHypotheses: ['code'],
      missingDimensions: ['mechanism'],
      proposedProbeIds: ['code-release-correlation'],
      searchHints: ['WorkflowProcessor'],
    })
  })

  it('falls back to deterministic planning when the model provider fails', async () => {
    const advisor = new SafeLlmInvestigationPlanningAdvisor(true, 1, async () => {
      throw new Error('provider unavailable')
    })

    const advice = await advisor.advise(planningInput())

    expect(advice.source).toBe('llm_fallback')
    expect(advice.proposedProbeIds.length).toBeGreaterThan(0)
    expect(advice.rationale).toContain('deterministic fallback')
  })

  it('does not call the model again until the causal evidence changes', async () => {
    let calls = 0
    const advisor = new SafeLlmInvestigationPlanningAdvisor(true, 4, async <T>() => {
      calls += 1
      throw new Error('provider unavailable')
    })

    const first = await advisor.advise(planningInput())
    const repeated = await advisor.advise({ ...planningInput(), iteration: 2 })
    const changedInput = planningInput()
    changedInput.findings = [{
      id: 'runtime-failure',
      adapter: 'host',
      type: 'runtime_failure',
      severity: 'high',
      confidence: 0.9,
      title: 'Runtime write failed',
      summary: 'A bounded runtime failure was observed.',
      evidenceRefs: ['runtime-log'],
    }]
    const changed = await advisor.advise(changedInput)

    expect(first.source).toBe('llm_fallback')
    expect(repeated.source).toBe('deterministic')
    expect(changed.source).toBe('llm_fallback')
    expect(calls).toBe(2)
  })
})
