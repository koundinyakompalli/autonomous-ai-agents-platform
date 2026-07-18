import { describe, expect, it } from 'vitest'
import { convertMarkdownToAdf, type AdfNode } from '../utils/markdown-to-adf.js'
import {
  buildImplementationCompletedComment,
  buildQualificationNotReadyComment,
  buildQualificationReadyComment,
  buildBranchDriftComment,
  buildImplementationPlanReadyComment,
  buildPlanningCompletedComment,
  buildReviewCompletedComment,
  buildVerificationOnlyCompletedComment,
  buildCodeReviewCompletedComment,
  buildReplanQueuedComment,
  buildHandoffExhaustedComment,
  extractOneShotQualifierComment,
  wrapOneShotQualifierComment,
} from './jira-comments.js'
import { renderOneShotPlanMarkdown } from './renderers.js'

function hasExternalMediaUrl(nodes: AdfNode[] | undefined, expectedUrl: string): boolean {
  if (!nodes) {
    return false
  }

  return nodes.some((node) => {
    if (node.attrs?.url === expectedUrl) {
      return true
    }

    return hasExternalMediaUrl(node.content, expectedUrl)
  })
}

function hasLinkHref(nodes: AdfNode[] | undefined, expectedHref: string): boolean {
  if (!nodes) {
    return false
  }

  return nodes.some((node) => {
    if (node.attrs?.href === expectedHref) {
      return true
    }

    if (node.marks?.some(mark => mark.type === 'link' && mark.attrs?.href === expectedHref)) {
      return true
    }

    return hasLinkHref(node.content, expectedHref)
  })
}

function buildPlan() {
  return {
    jiraKey: 'CPDEV-21090',
    repoName: 'core-app',
    branchName: 'master',
    baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    summary: 'Style the cancel button red.',
    specs: [
      {
        id: 'SPEC-1',
        objective: 'Style the cancel button red.',
        acceptanceCriteria: ['Cancel button is red.'],
        targetFiles: ['MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java'],
        implementationNotes: ['Follow existing CSS wiring.'],
        validationSteps: ['grep -n cancelButtonRed MedicalMgmt/src/main/webapp/Medhok3.css'],
      },
    ],
    assumptions: ['CSS-only change.'],
    openQuestions: [],
    outOfScope: [],
    risks: ['Selector drift could require a broader UI check.'],
  }
}

describe('jira-comments', () => {
  it('includes the OneShot logo at the top of the markdown comment', () => {
    const markdown = buildPlanningCompletedComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-21090',
      plan: {
        jiraKey: 'CPDEV-21090',
        repoName: 'core-app',
        branchName: 'master',
        baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
        summary: 'Style the cancel button red.',
        specs: [
          {
            id: 'SPEC-1',
            objective: 'Style the cancel button red.',
            acceptanceCriteria: ['Cancel button is red.'],
            targetFiles: ['MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java'],
            implementationNotes: [],
            validationSteps: ['grep -n cancelButtonRed MedicalMgmt/src/main/webapp/Medhok3.css'],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
    })

    expect(markdown.startsWith('![OneShot](https://productFactory.mhkdevsandbox.com/oneshot/oneshot-logo-jira.png)')).toBe(true)
  })

  it('produces external media content in ADF for the logo image', () => {
    const markdown = buildPlanningCompletedComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-21090',
      plan: {
        jiraKey: 'CPDEV-21090',
        repoName: 'core-app',
        branchName: 'master',
        baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
        summary: 'Style the cancel button red.',
        specs: [
          {
            id: 'SPEC-1',
            objective: 'Style the cancel button red.',
            acceptanceCriteria: ['Cancel button is red.'],
            targetFiles: ['MedicalMgmt/src/main/webapp/Medhok3.css'],
            implementationNotes: [],
            validationSteps: ['grep -n cancelButtonRed MedicalMgmt/src/main/webapp/Medhok3.css'],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
    })

    const adf = convertMarkdownToAdf(markdown)
    expect(hasExternalMediaUrl(adf.content, 'https://productFactory.mhkdevsandbox.com/oneshot/oneshot-logo-jira.png')).toBe(true)
  })

  it('includes the dashboard run URL only on qualification-ready comments when provided', () => {
    const markdown = buildQualificationReadyComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-21090',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      pipelineUrl: 'https://productFactory.mhkdevsandbox.com/oneshot?view=runs&run=run-74',
    })

    expect(markdown).toContain('[Open this run in OneShot Dashboard](https://productFactory.mhkdevsandbox.com/oneshot?view=runs&run=run-74)')

    const adf = convertMarkdownToAdf(markdown)
    expect(hasLinkHref(adf.content, 'https://productFactory.mhkdevsandbox.com/oneshot?view=runs&run=run-74')).toBe(true)
  })

  it('does not include a dashboard run URL when a qualification-ready comment has no run link', () => {
    const markdown = buildQualificationReadyComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-21090',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    })

    expect(markdown).not.toContain('Open this run in OneShot Dashboard')
  })

  it('builds a compact implementation-ready comment that points to the plan attachment', () => {
    const plan = buildPlan()
    const renderedPlan = renderOneShotPlanMarkdown(plan)

    const markdown = buildImplementationPlanReadyComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-21090',
      plan,
      planVersion: 3,
      reviewRound: 2,
      implementationVersion: 1,
      planAttachment: {
        filename: 'implementation-plan-CPDEV-21090-v3-r2.md',
        status: 'attached',
      },
    } as Parameters<typeof buildImplementationPlanReadyComment>[0] & {
      planAttachment: {
        filename: string
        status: 'attached'
      }
    })

    expect(markdown).toContain('## OneShot | Implementation Plan Ready')
    expect(markdown).toContain('Handoff status: VALIDATE approved')
    expect(markdown).toContain('Plan version: 3')
    expect(markdown).toContain('Review round: 2')
    expect(markdown).toContain('Implementation version: 1')
    expect(markdown).toContain('Full plan attachment: `implementation-plan-CPDEV-21090-v3-r2.md`')
    expect(markdown).toContain('Plan attachment status: attached')
    expect(markdown).not.toContain(renderedPlan)
    expect(markdown).toContain('### Next Step')
    expect(markdown).toContain('Implementation has been queued with this plan.')
  })

  it('labels bypassed and soft-gated implementation plan handoffs explicitly', () => {
    const bypassed = buildImplementationPlanReadyComment({
      jiraKey: 'CPDEV-21090',
      plan: buildPlan(),
      planVersion: 3,
      reviewRound: 2,
      implementationVersion: 1,
      bypassedReview: { reason: 'ONESHOT_REVIEWER_ENABLED=false' },
    })
    const softGated = buildImplementationPlanReadyComment({
      jiraKey: 'CPDEV-21090',
      plan: buildPlan(),
      planVersion: 3,
      reviewRound: 2,
      implementationVersion: 1,
      softGate: { reason: 'review_loop_exhausted' },
    })

    expect(bypassed).toContain('Handoff status: review bypassed')
    expect(bypassed).toContain('Bypass reason: ONESHOT_REVIEWER_ENABLED=false')
    expect(bypassed).not.toContain('Handoff status: VALIDATE approved')
    expect(softGated).toContain('Handoff status: soft-gated to implementation')
    expect(softGated).toContain('Soft gate reason: review_loop_exhausted')
    expect(softGated).not.toContain('Handoff status: VALIDATE approved')
  })

  it('builds a verification-only completion comment with no-PR evidence', () => {
    const markdown = buildVerificationOnlyCompletedComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-23568',
      reason: 'Plan declares implementationMode=verification_only.',
      plan: {
        jiraKey: 'CPDEV-23568',
        repoName: 'core-app',
        branchName: 'medhok-monorepo-3.19',
        baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
        summary: 'Verify the log4j remediation is already applied.',
        implementationMode: 'verification_only',
        specs: [
          {
            id: 'SPEC-1',
            objective: 'Confirm no repository changes are required.',
            acceptanceCriteria: ['No code changes are required.'],
            targetFiles: ['pom.xml'],
            implementationNotes: ['Inspect dependency remediation evidence.'],
            validationSteps: ['mvn -q -DskipTests dependency:tree'],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      review: {
        decision: 'APPROVED',
        score: 95,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: ['Owner can close the ticket after review.'],
        confidence: 'high',
        coverageAssessment: 'The inspected dependency evidence covers the ticket.',
      },
    })

    expect(markdown).toContain('OneShot | Completed - No PR Required')
    expect(markdown).toContain('PR opened: No')
    expect(markdown).toContain('pom.xml')
    expect(markdown).toContain('mvn -q -DskipTests dependency:tree')
  })

  it('renders qualification assessment details on ready comments', () => {
    const markdown = buildQualificationReadyComment({
      jiraKey: 'CPDEV-21090',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      qualification: {
        qualified: true,
        repoId: 1,
        branchName: 'master',
        baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
        requirementsSummary: ['Style the cancel button red.', 'Add focused validation.'],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: ['Planner should use the core-app route card.'],
        repoInspectionPerformed: true,
        inspectedFiles: ['MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java'],
        inspectionSummary: 'Inspected MemberSearchForm and the SmartGWT style path.',
      },
    })

    expect(markdown).toContain('### Requirements Summary')
    expect(markdown).toContain('Style the cancel button red.')
    expect(markdown).toContain('Acceptance criteria were identified on the ticket.')
    expect(markdown).toContain('Inspected MemberSearchForm and the SmartGWT style path.')
    expect(markdown).toContain('Planner should use the core-app route card.')
  })

  it('does not include a dashboard run URL on qualification-failure comments', () => {
    const markdown = buildQualificationNotReadyComment({
      assetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
      jiraKey: 'CPDEV-21090',
      qualification: {
        qualified: false,
        repoId: undefined,
        branchName: undefined,
        baseCommitSha: undefined,
        requirementsSummary: [],
        acceptanceCriteriaPresent: false,
        blockingReasons: ['Acceptance criteria missing'],
        nonBlockingWarnings: [],
        repoInspectionPerformed: false,
        inspectedFiles: [],
        inspectionSummary: '',
      },
    })

    expect(markdown).not.toContain('Open this run in OneShot Dashboard')
  })

  it('wraps and extracts the OneShot QUALIFIER sentinel without changing the body', () => {
    const markdown = '## OneShot | Qualification Ready\n\nReady for planning.'

    const wrapped = wrapOneShotQualifierComment(markdown)
    const extracted = extractOneShotQualifierComment(wrapped)

    expect(extracted.isOneShotComment).toBe(true)
    expect(extracted.body).toBe(markdown)
    expect(extractOneShotQualifierComment(markdown)).toEqual({
      isOneShotComment: false,
      body: markdown,
    })
  })

  it('renders branch drift classification and conflict evidence', () => {
    const markdown = buildBranchDriftComment({
      jiraKey: 'CPDEV-21090',
      previousBaseCommitSha: 'oldbase',
      currentHeadSha: 'newhead',
      driftStatus: 'conflicting_fast_forward',
      overlappingFiles: ['src/member/MemberSearchForm.java'],
      riskyFiles: ['pom.xml'],
      evidence: ['Changed files overlap planned files: src/member/MemberSearchForm.java.'],
    })

    expect(markdown).toContain('Drift classification: `conflicting_fast_forward`')
    expect(markdown).toContain('### Conflict Evidence')
    expect(markdown).toContain('src/member/MemberSearchForm.java')
    expect(markdown).toContain('pom.xml')
    expect(markdown).toContain('PFOS-REPLAN')
  })

  it('labels disabled reviewer output as bypassed instead of normal approval', () => {
    const markdown = buildReviewCompletedComment({
      jiraKey: 'CPDEV-21090',
      review: {
        decision: 'APPROVED',
        score: 0,
        sageDimensions: [],
        confidence: 'low',
        coverageAssessment: 'Plan review was bypassed by configuration; no automated plan validation was performed.',
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: ['Reviewer bypassed by ONESHOT_REVIEWER_ENABLED=false.'],
      },
      bypassedReview: {
        reason: 'ONESHOT_REVIEWER_ENABLED=false',
      },
    })

    expect(markdown).toContain('## OneShot | Review Bypassed')
    expect(markdown).toContain('Review status: BYPASSED')
    expect(markdown).not.toContain('The plan review approved this run for implementation.')
  })

  it('does not render null code-review finding lines as file:null', () => {
    const markdown = buildCodeReviewCompletedComment({
      jiraKey: 'CPDEV-21090',
      codeReview: {
        decision: 'APPROVED',
        score: 92,
        sageDimensions: [],
        findings: [{
          severity: 'low',
          category: 'maintainability',
          file: 'src/example.ts',
          line: undefined,
          description: 'No line-specific issue.',
          suggestion: undefined,
        }],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        summary: 'Code review passed.',
        implementationVersion: 1,
      },
    })

    expect(markdown).toContain('src/example.ts: No line-specific issue.')
    expect(markdown).not.toContain('src/example.ts:null')
  })
})

describe('buildHandoffExhaustedComment', () => {
  it('includes heading OneShot | Handoff Failed', () => {
    const markdown = buildHandoffExhaustedComment({
      jiraKey: 'CPDEV-999',
      runId: 42,
      failureType: 'workspace_setup_failed',
      error: 'ETIMEDOUT',
    })
    expect(markdown).toContain('OneShot | Handoff Failed')
  })

  it('includes the jira key', () => {
    const markdown = buildHandoffExhaustedComment({
      jiraKey: 'CPDEV-999',
      runId: 42,
      failureType: 'workspace_setup_failed',
      error: 'ETIMEDOUT',
    })
    expect(markdown).toContain('CPDEV-999')
  })

  it('mentions operator recovery is required for workspace_setup_failed', () => {
    const markdown = buildHandoffExhaustedComment({
      jiraKey: 'CPDEV-999',
      runId: 42,
      failureType: 'workspace_setup_failed',
      error: 'workspace lease timeout',
    })
    expect(markdown).toContain('Operator recovery is required')
    expect(markdown).toContain('workspace setup')
  })

  it('mentions operator recovery is required for planning_publish_failed', () => {
    const markdown = buildHandoffExhaustedComment({
      jiraKey: 'CPDEV-999',
      runId: 42,
      failureType: 'planning_publish_failed',
      error: 'SQS send failed',
    })
    expect(markdown).toContain('Operator recovery is required')
    expect(markdown).toContain('planning publish')
  })

  it('includes the run ID in output', () => {
    const markdown = buildHandoffExhaustedComment({
      jiraKey: 'CPDEV-999',
      runId: 42,
      failureType: 'planning_publish_failed',
      error: 'SQS send failed',
    })
    expect(markdown).toContain('42')
  })
})

describe('buildReplanQueuedComment — updated wording', () => {
  it('uses "operator recovery is required" wording for publishError', () => {
    const markdown = buildReplanQueuedComment({
      jiraKey: 'CPDEV-123',
      repoId: 1,
      branchName: 'main',
      baseCommitSha: 'abc123',
      nextPlanVersion: 2,
      publishError: 'SQS error',
    })
    expect(markdown).toContain('operator recovery is required')
    expect(markdown).toContain('Planning handoff failed after automatic retries')
    expect(markdown).not.toContain('Planning has been queued')
    expect(markdown).not.toContain('will rely on reconciliation')
  })

  it('does not include warning section when there is no publishError', () => {
    const markdown = buildReplanQueuedComment({
      jiraKey: 'CPDEV-123',
      repoId: 1,
      branchName: 'main',
      baseCommitSha: 'abc123',
      nextPlanVersion: 2,
    })
    expect(markdown).not.toContain('operator recovery is required')
    expect(markdown).not.toContain('will rely on reconciliation')
    expect(markdown).toContain('Planning has been queued')
  })
})

describe('buildImplementationCompletedComment retrofit traceability', () => {
  function buildImplementation() {
    return {
      summary: 'Retrofit applied successfully.',
      implementationBranch: 'oneshot/cpdev-25333-run-546',
      implementationCommitSha: 'fedcba98',
      changedFiles: ['src/service.ts'],
      deviationsFromPlan: [],
      residualRisks: [],
    }
  }

  it('includes the retrofit traceability section when retrofitTraceability is provided', () => {
    const markdown = buildImplementationCompletedComment({
      jiraKey: 'CPDEV-25333',
      implementation: buildImplementation() as any,
      retrofitTraceability: {
        sourceJiraKey: 'CPDEV-24856',
        sourceBranch: 'medhok-monorepo-master',
        targetBranch: 'medhok-monorepo-3.17',
        selectedShas: ['abc1234', 'def5678'],
        commitCount: 2,
        perCommitStatus: [
          { sha: 'abc1234', status: 'clean_applied' },
          { sha: 'def5678', status: 'already_applied' },
        ],
      },
    })

    expect(markdown).toContain('Retrofit Traceability')
    expect(markdown).toContain('CPDEV-24856')
    expect(markdown).toContain('medhok-monorepo-master')
    expect(markdown).toContain('medhok-monorepo-3.17')
    expect(markdown).toContain('abc1234')
    expect(markdown).toContain('def5678')
    expect(markdown).toContain('clean_applied')
    expect(markdown).toContain('already_applied')
  })

  it('omits the retrofit traceability section for non-retrofit completion comments', () => {
    const markdown = buildImplementationCompletedComment({
      jiraKey: 'CPDEV-99999',
      implementation: buildImplementation() as any,
    })

    expect(markdown).not.toContain('Retrofit Traceability')
    expect(markdown).not.toContain('Source Jira:')
  })
})
