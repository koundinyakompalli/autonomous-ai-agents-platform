import { describe, expect, it } from 'vitest'
import {
  assessOneShotPlanRisk,
  assessOneShotQualificationRisk,
  buildOneShotReadinessClassification,
  detectExternalSpecEvidence,
} from './readiness.js'
import type { OneShotPlan } from './schema/plan.js'
import type { OneShotTestResult } from './schema/test-result.js'

function plan(overrides: Partial<OneShotPlan> = {}): OneShotPlan {
  return {
    jiraKey: 'CPDEV-20626',
    repoName: 'cp-interoperability-monorepo',
    branchName: 'master',
    baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    summary: 'Implement DTR questionnaire package',
    specs: [{
      id: 'spec-1',
      objective: 'Build package bundle',
      acceptanceCriteria: ['PackageBundle contains required resources'],
      targetFiles: ['src/main/java/Client.java'],
      targetFileRationales: [],
      implementationNotes: ['Follow existing patterns'],
      validationSteps: ['mvn test'],
    }],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
    ...overrides,
  }
}

function passingTest(overrides: Partial<OneShotTestResult> = {}): OneShotTestResult {
  return {
    resolvedCommand: 'mvn test',
    commandSource: 'implementation',
    executionKind: 'automated_tests',
    executedCommands: ['mvn test'],
    executedValidationChecks: [],
    skippedTestCommands: [],
    unverified: false,
    exitCode: 0,
    passed: true,
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    failedTests: [],
    truncatedOutput: '',
    parserNotes: [],
    implementationVersion: 1,
    codeReviewVersion: 1,
    durationMs: 100,
    ...overrides,
  }
}

describe('OneShot readiness and risk assessment', () => {
  it('classifies PR #16 style assumptions as readiness risks', () => {
    const assessment = assessOneShotPlanRisk(plan({
      assumptions: [
        'Using requestedUnits=1.0f is semantically neutral for this flow.',
        'The closest match is getQuestionSetDefn because getUMQuestionSet does not exist.',
      ],
    }))

    expect(assessment.wouldAffectReadiness).toBe(true)
    expect(assessment.findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining([
        'domain_value_or_business_default',
        'endpoint_or_api_surface',
      ]),
    )
  })

  it('classifies PR #19 and run-88 style FHIR fixture/spec risks', () => {
    const assessment = assessOneShotPlanRisk(plan({
      specs: [{
        id: 'spec-1',
        objective: 'Create PackageBundle with QuestionnaireResponse',
        acceptanceCriteria: ['Bundle.meta.profile and Questionnaire.meta.profile are set'],
        targetFiles: ['src/test/java/UmPriorAuthorizationServiceTest.java'],
        targetFileRationales: [{
          targetFile: 'src/test/java/UmPriorAuthorizationServiceTest.java',
          rationale: 'New processBundle tests',
          supportingFiles: [],
          uncertainty: 'Patient and Coverage bundle resources may be required for processBundle fixtures.',
          rejectedAlternatives: [],
        }],
        implementationNotes: ['Follow Da Vinci DTR PackageBundle requirements'],
        validationSteps: ['mvn -Dtest=UmPriorAuthorizationServiceTest test'],
      }],
    }))

    expect(assessment.findings.map((finding) => finding.category)).toEqual(
      expect.arrayContaining([
        'external_spec_contract',
        'test_fixture_invariant',
      ]),
    )
  })

  it('promotes qualifier endpoint warnings into observe-mode risk', () => {
    const assessment = assessOneShotQualificationRisk({
      blockingReasons: [],
      nonBlockingWarnings: [
        'Ticket mentions getUmQuestionSet but no such endpoint was found; planner may need closest match.',
      ],
    })

    expect(assessment.promotedWarningCount).toBeGreaterThan(0)
    expect(assessment.findings[0]?.category).toBe('endpoint_or_api_surface')
  })

  it('does not treat deterministic retrofit qualification as readiness risk', () => {
    const assessment = assessOneShotQualificationRisk({
      blockingReasons: [],
      nonBlockingWarnings: [],
    })
    const informationalLine = assessOneShotQualificationRisk({
      blockingReasons: [],
      nonBlockingWarnings: [
        'Retrofit contract qualified deterministically. Planner will derive source commits and detect already-applied changes.',
      ],
    })

    expect(assessment.findings).toEqual([])
    expect(assessment.wouldAffectReadiness).toBe(false)
    expect(informationalLine.findings).toEqual([])
    expect(informationalLine.wouldAffectReadiness).toBe(false)
  })

  it('preserves exact healthcare spec URLs for external evidence', () => {
    const evidence = detectExternalSpecEvidence({
      plan: plan({
        risks: ['See https://build.fhir.org/ig/HL7/davinci-dtr/StructureDefinition-dtr-questionnaire-package.html'],
      }),
    })

    expect(evidence.urls).toEqual([expect.objectContaining({
      url: 'https://build.fhir.org/ig/HL7/davinci-dtr/StructureDefinition-dtr-questionnaire-package.html',
      status: 'not_fetched_observe_mode',
    })])
  })

  it('marks skipped tests as needs review instead of ready', () => {
    const readiness = buildOneShotReadinessClassification({
      testResult: passingTest({
        passed: false,
        exitCode: 1,
        failCount: 1,
        unverified: true,
        skippedTestCommands: ['mvn test'],
      }),
    })

    expect(readiness.completionStatus).toBe('completed_needs_review')
    expect(readiness.reasons.map((reason) => reason.code)).toContain('unverified_tests')
  })

  it('marks red CI as needs review, not ready', () => {
    const readiness = buildOneShotReadinessClassification({
      testResult: passingTest(),
      ciStatus: {
        state: 'failure',
        description: 'GitHub combined status is failure across 1 status check(s).',
      },
    })

    expect(readiness.completionStatus).toBe('completed_needs_review')
    expect(readiness.reasons.map((reason) => reason.code)).toContain('ci_failed')
  })

  it('marks missing CI credentials as needs review with a configuration reason', () => {
    const readiness = buildOneShotReadinessClassification({
      testResult: passingTest(),
      ciStatus: {
        state: 'unconfigured',
        description: 'GitHub read token is not configured; CI status was not checked.',
      },
    })

    expect(readiness.completionStatus).toBe('completed_needs_review')
    expect(readiness.reasons.map((reason) => reason.code)).toContain('ci_configuration_missing')
  })

  it('does not mark skipped implementation metadata unverified when trusted fallback tests passed', () => {
    const readiness = buildOneShotReadinessClassification({
      testResult: passingTest({
        commandSource: 'planner',
        skippedTestCommands: ['mvn test'],
        unverified: false,
      }),
    })

    expect(readiness.completionStatus).toBe('completed_ready')
    expect(readiness.reasons.map((reason) => reason.code)).not.toContain('unverified_tests')
  })

  it('keeps plan risks in observe mode until their category is activated', () => {
    const assessment = assessOneShotPlanRisk(plan({
      assumptions: ['Using requestedUnits=1.0f is semantically neutral for this flow.'],
    }))

    const observedOnly = buildOneShotReadinessClassification({
      testResult: passingTest(),
      planRiskAssessment: assessment,
      activeRiskCategories: new Set(),
    })
    expect(observedOnly.completionStatus).toBe('completed_ready')

    const active = buildOneShotReadinessClassification({
      testResult: passingTest(),
      planRiskAssessment: assessment,
      activeRiskCategories: new Set(['domain_value_or_business_default']),
    })
    expect(active.completionStatus).toBe('completed_needs_review')
    expect(active.reasons.map((reason) => reason.category)).toContain('domain_value_or_business_default')
  })
})
