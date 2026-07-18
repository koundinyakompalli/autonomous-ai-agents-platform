import {
  getPlanImpactedFiles,
  getPlanValidationSteps,
  type OneShotPlan,
} from './schema/plan.js'
import type { OneShotReview } from './schema/review.js'
import type { OneShotImplementation } from './schema/implementation.js'
import type { OneShotCodeReview } from './schema/code-review.js'
import type { OneShotTestResult } from './schema/test-result.js'
import type { QualificationAssessment } from './schema/qualification.js'
import type { OneShotReadinessClassification } from './readiness.js'
import { readinessLabel } from './readiness.js'

export const ONESHOT_JIRA_COMMENT_SENTINEL = '<!-- ONESHOT_JIRA_COMMENT -->'

const LOGO_PATH = '/oneshot/oneshot-logo-jira.png'
const MAX_LIST_ITEMS = 6

interface OneShotCommentSection {
  title: string
  bullets?: Array<string | null | undefined>
  paragraphs?: Array<string | null | undefined>
}

interface OneShotCommentInput {
  assetBaseUrl?: string
  heading: string
  jiraKey: string
  summary?: string
  details?: Array<string | null | undefined>
  sections?: OneShotCommentSection[]
  pipelineUrl?: string
  nextStep?: string | Array<string | null | undefined>
}

interface QualificationCommentInput {
  assetBaseUrl?: string
  jiraKey: string
  repoName?: string
  branchName?: string
  baseCommitSha?: string
  qualification?: QualificationAssessment
  warnings?: string[]
  pipelineUrl?: string
  nextStep?: string
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeList(values: Array<string | null | undefined>, limit = MAX_LIST_ITEMS): string[] {
  const normalized = values
    .flatMap(value => {
      if (!value) {
        return []
      }

      const trimmed = normalizeWhitespace(value)
      return trimmed ? [trimmed] : []
    })

  return normalized.slice(0, limit)
}

function buildLogoMarkdown(assetBaseUrl?: string): string | null {
  const normalizedBaseUrl = assetBaseUrl?.trim().replace(/\/+$/, '')
  if (!normalizedBaseUrl) {
    return null
  }

  return `![OneShot](${normalizedBaseUrl}${LOGO_PATH})`
}

function buildSection(section: OneShotCommentSection): string[] {
  const bullets = normalizeList(section.bullets ?? [])
  const paragraphs = normalizeList(section.paragraphs ?? [], Number.MAX_SAFE_INTEGER)
  if (bullets.length === 0 && paragraphs.length === 0) {
    return []
  }

  return [
    `### ${section.title}`,
    ...paragraphs,
    ...bullets.map(item => `- ${item}`),
  ]
}

function buildNextStep(nextStep: string | Array<string | null | undefined> | undefined): string[] {
  if (!nextStep) {
    return []
  }

  const bullets = normalizeList(Array.isArray(nextStep) ? nextStep : [nextStep], Number.MAX_SAFE_INTEGER)
  if (bullets.length === 0) {
    return []
  }

  return [
    '### Next Step',
    ...bullets.map(item => `- ${item}`),
  ]
}

function buildPipelineSection(pipelineUrl: string | undefined): string[] {
  const normalizedUrl = pipelineUrl?.trim()
  if (!normalizedUrl) {
    return []
  }

  return [
    '### Pipeline',
    `- [Open this run in OneShot Dashboard](${normalizedUrl})`,
  ]
}

function buildOneShotComment(input: OneShotCommentInput): string {
  const logoMarkdown = buildLogoMarkdown(input.assetBaseUrl)
  const details = normalizeList(input.details ?? [], Number.MAX_SAFE_INTEGER)
  const sections = (input.sections ?? []).flatMap(buildSection)
  const pipelineSection = buildPipelineSection(input.pipelineUrl)
  const summary = input.summary ? normalizeWhitespace(input.summary) : ''

  return [
    logoMarkdown,
    `## ${input.heading}`,
    '',
    `**Ticket:** \`${input.jiraKey}\``,
    summary ? '' : null,
    summary || null,
    details.length > 0 ? '' : null,
    ...(details.length > 0 ? ['### Details', ...details.map(item => `- ${item}`)] : []),
    pipelineSection.length > 0 ? '' : null,
    ...pipelineSection,
    sections.length > 0 ? '' : null,
    ...sections,
    ...(
      buildNextStep(input.nextStep).length > 0
        ? ['', ...buildNextStep(input.nextStep)]
        : []
    ),
  ].filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n')
}

export function wrapOneShotQualifierComment(markdown: string): string {
  return `${ONESHOT_JIRA_COMMENT_SENTINEL}\n${markdown}`
}

export function extractOneShotQualifierComment(markdown: string): {
  isOneShotComment: boolean
  body: string
} {
  const trimmed = markdown.trimStart()
  if (!trimmed.startsWith(ONESHOT_JIRA_COMMENT_SENTINEL)) {
    return {
      isOneShotComment: false,
      body: markdown,
    }
  }

  const withoutSentinel = trimmed.slice(ONESHOT_JIRA_COMMENT_SENTINEL.length).trimStart()
  return {
    isOneShotComment: true,
    body: withoutSentinel,
  }
}

export function buildQualificationReadyComment(input: QualificationCommentInput): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Qualification Ready',
    jiraKey: input.jiraKey,
    summary: 'OneShot qualification completed successfully and the run is ready to enter planning.',
    details: [
        input.repoName ? `Repo: \`${input.repoName}\`` : null,
        input.branchName ? `Branch: \`${input.branchName}\`` : null,
        input.baseCommitSha ? `Base commit SHA: \`${input.baseCommitSha}\`` : null,
    ],
    pipelineUrl: input.pipelineUrl,
    sections: [
      {
        title: 'Requirements Summary',
        bullets: input.qualification?.requirementsSummary,
      },
      {
        title: 'Qualification Notes',
        bullets: [
          input.qualification?.acceptanceCriteriaPresent
            ? 'Acceptance criteria were identified on the ticket.'
            : 'Acceptance criteria were not explicit on the ticket.',
          input.qualification?.inspectionSummary ?? null,
        ],
      },
      {
        title: 'Warnings',
        bullets: input.warnings ?? input.qualification?.nonBlockingWarnings ?? [],
      },
    ],
    nextStep: input.nextStep ?? 'Planning has been queued.',
  })
}

export function buildQualificationNotReadyComment(input: QualificationCommentInput): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Qualification Not Ready',
    jiraKey: input.jiraKey,
    summary: 'This ticket is not ready to enter the OneShot pipeline yet.',
    details: [
      input.repoName ? `Repo: \`${input.repoName}\`` : null,
      input.branchName ? `Branch: \`${input.branchName}\`` : null,
      input.baseCommitSha ? `Base commit SHA: \`${input.baseCommitSha}\`` : null,
    ],
    sections: [
      {
        title: 'Blocking Reasons',
        bullets: input.qualification?.blockingReasons ?? ['Resolve the blocking items before retrying qualification.'],
      },
      {
        title: 'Warnings',
        bullets: input.warnings ?? input.qualification?.nonBlockingWarnings ?? [],
      },
    ],
    nextStep: input.nextStep ?? 'Address the blocking items, then rerun QUALIFIER.',
  })
}

export function buildForceApproveComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  repoId: number
  branchName: string
  baseCommitSha: string
  nextStageLabel: string
  publishError?: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Qualification Force Approved',
    jiraKey: input.jiraKey,
    summary: `The escalated OneShot run was force-approved and queued for ${input.nextStageLabel}.`,
    details: [
      `Repo ID: ${input.repoId}`,
      `Branch: \`${input.branchName}\``,
      `Base commit SHA: \`${input.baseCommitSha}\``,
    ],
    sections: [
      {
        title: 'Warnings',
        bullets: input.publishError
          ? [`${input.nextStageLabel} queue publish failed and will rely on reconciliation: ${input.publishError}`]
          : [],
      },
    ],
    nextStep: `OneShot ${input.nextStageLabel} has been queued.`,
  })
}

export function buildReplanQueuedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  repoId: number
  branchName: string
  baseCommitSha: string
  nextPlanVersion: number
  publishError?: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Replan Queued',
    jiraKey: input.jiraKey,
    summary: 'A fresh planning pass has been queued for this OneShot run.',
    details: [
      `Repo ID: ${input.repoId}`,
      `Branch: \`${input.branchName}\``,
      `New base commit SHA: \`${input.baseCommitSha}\``,
      `Next plan version: ${input.nextPlanVersion}`,
    ],
    sections: [
      {
        title: 'Warnings',
        bullets: input.publishError
          ? [`Planning queue publish failed and operator recovery is required: ${input.publishError}`]
          : [],
      },
    ],
    nextStep: input.publishError
      ? 'Planning handoff failed after automatic retries; operator recovery is required.'
      : 'Planning has been queued.',
  })
}

export function buildPlanningCompletedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  plan: OneShotPlan
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Planning Completed',
    jiraKey: input.jiraKey,
    summary: input.plan.summary,
    details: [
      `Repo: \`${input.plan.repoName}\``,
      `Branch: \`${input.plan.branchName}\``,
      `Base commit SHA: \`${input.plan.baseCommitSha}\``,
      `Specs planned: ${input.plan.specs.length}`,
    ],
    sections: [
      {
        title: 'Top Specs',
        bullets: input.plan.specs.map(spec => spec.objective),
      },
      {
        title: 'Planned Validation',
        bullets: getPlanValidationSteps(input.plan),
      },
      {
        title: 'Top Risks',
        bullets: input.plan.risks,
      },
    ],
    nextStep: 'Automated review has been queued.',
  })
}

export function buildReviewCompletedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  review: OneShotReview
  softGate?: {
    reason: string
  }
  bypassedReview?: {
    reason: string
  }
}): string {
  const softGate = input.softGate
  const bypassedReview = input.bypassedReview
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: bypassedReview ? 'OneShot | Review Bypassed' : 'OneShot | Review Completed',
    jiraKey: input.jiraKey,
    summary: bypassedReview
      ? 'Plan review was bypassed by configuration; implementation was queued without automated plan validation.'
      : softGate
      ? 'The plan review requested changes or could not complete, but soft-gate mode continued this run for implementation.'
      : 'The plan review approved this run for implementation.',
    details: [
      `Review status: ${bypassedReview ? 'BYPASSED' : input.review.decision}`,
      `Confidence: ${input.review.confidence}`,
      input.review.score !== undefined ? `Review score: ${input.review.score}` : null,
      softGate ? 'Soft gate: continued' : null,
      softGate ? `Reason: ${softGate.reason}` : null,
      bypassedReview ? `Bypass reason: ${bypassedReview.reason}` : null,
    ],
    sections: [
      {
        title: 'Coverage Assessment',
        paragraphs: [input.review.coverageAssessment],
      },
      {
        title: 'Required Changes',
        bullets: input.review.requiredChanges,
      },
      {
        title: 'Blocking Findings',
        bullets: input.review.blockingFindings,
      },
      {
        title: 'Notes',
        bullets: input.review.nonBlockingSuggestions,
      },
    ],
    nextStep: 'Implementation has been queued.',
  })
}

export function buildImplementationPlanReadyComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  plan: OneShotPlan
  planVersion: number
  reviewRound: number
  implementationVersion: number
  planAttachment?: {
    filename: string
    status: 'attached' | 'skipped' | 'failed'
    error?: string
  }
  softGate?: {
    reason: string
  }
  bypassedReview?: {
    reason: string
  }
}): string {
  const handoffStatus = input.bypassedReview
    ? 'review bypassed'
    : input.softGate
      ? 'soft-gated to implementation'
      : 'VALIDATE approved'
  const summary = input.bypassedReview
    ? 'OneShot queued implementation with this plan after plan review was bypassed by configuration.'
    : input.softGate
      ? 'OneShot queued implementation with this plan after a non-blocking review soft gate.'
      : 'OneShot VALIDATE approved this plan and queued implementation.'

  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Implementation Plan Ready',
    jiraKey: input.jiraKey,
    summary,
    details: [
      `Repo: \`${input.plan.repoName}\``,
      `Branch: \`${input.plan.branchName}\``,
      `Base commit SHA: \`${input.plan.baseCommitSha}\``,
      `Plan version: ${input.planVersion}`,
      `Review round: ${input.reviewRound}`,
      `Implementation version: ${input.implementationVersion}`,
      `Handoff status: ${handoffStatus}`,
      input.planAttachment
        ? `Full plan attachment: \`${input.planAttachment.filename}\``
        : null,
      input.planAttachment
        ? `Plan attachment status: ${input.planAttachment.status}`
        : null,
      input.planAttachment?.error
        ? `Plan attachment issue: ${input.planAttachment.error}`
        : null,
      input.bypassedReview
        ? `Bypass reason: ${input.bypassedReview.reason}`
        : null,
      input.softGate ? `Soft gate reason: ${input.softGate.reason}` : null,
    ],
    sections: [
      {
        title: 'Plan Summary',
        paragraphs: [input.plan.summary],
      },
    ],
    nextStep: 'Implementation has been queued with this plan.',
  })
}

export function buildVerificationOnlyCompletedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  plan: OneShotPlan
  review: OneShotReview
  reason: string
  completionArtifactUrl?: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Completed - No PR Required',
    jiraKey: input.jiraKey,
    summary:
      'Automated planning and review verified that this ticket does not require repository changes, so OneShot completed without opening a PR.',
    details: [
      'PR opened: No',
      `Repo: \`${input.plan.repoName}\``,
      `Branch: \`${input.plan.branchName}\``,
      `Implementation mode: ${input.plan.implementationMode ?? 'code_change'}`,
      `Reason: ${input.reason}`,
      `Review status: ${input.review.decision}`,
      `Confidence: ${input.review.confidence}`,
      input.completionArtifactUrl
        ? `Evidence artifact: [completion.json](${input.completionArtifactUrl})`
        : null,
    ],
    sections: [
      {
        title: 'Inspected Files',
        bullets: getPlanImpactedFiles(input.plan),
      },
      {
        title: 'Validation Evidence',
        bullets: getPlanValidationSteps(input.plan),
      },
      {
        title: 'Review Assessment',
        paragraphs: [input.review.coverageAssessment],
      },
      {
        title: 'Notes',
        bullets: input.review.nonBlockingSuggestions,
      },
    ],
    nextStep:
      'Ticket owner can close the ticket or continue manually if new requirements appear.',
  })
}

export function buildReviewEscalatedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  maxReviewLoops: number
  requiredChanges: string[]
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Review Escalated',
    jiraKey: input.jiraKey,
    summary: `Automated review requested additional plan changes after ${input.maxReviewLoops} loop(s).`,
    sections: [
      {
        title: 'Required Changes',
        bullets: input.requiredChanges,
      },
    ],
    nextStep: 'Update the plan manually or rerun through a new OneShot cycle after triage.',
  })
}

export function buildReviewBlockedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  blockingFindings: string[]
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Review Blocked',
    jiraKey: input.jiraKey,
    summary: 'Automated review blocked the plan from moving into implementation.',
    sections: [
      {
        title: 'Blocking Findings',
        bullets: input.blockingFindings,
      },
    ],
    nextStep: 'Resolve the blocking findings before rerunning OneShot.',
  })
}

export interface RetrofitTraceabilityComment {
  sourceJiraKey: string
  sourceBranch: string
  targetBranch: string
  selectedShas: string[]
  commitCount: number
  perCommitStatus: Array<{ sha: string; status: string }>
}

export function buildImplementationCompletedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  implementation: OneShotImplementation
  retrofitTraceability?: RetrofitTraceabilityComment
}): string {
  const retrofitSection = input.retrofitTraceability
    ? [
        {
          title: 'Retrofit Traceability',
          bullets: [
            `Source Jira: ${input.retrofitTraceability.sourceJiraKey}`,
            `Source branch: ${input.retrofitTraceability.sourceBranch} → ${input.retrofitTraceability.targetBranch}`,
            `Commit count: ${input.retrofitTraceability.commitCount}`,
            `Selected SHAs: ${input.retrofitTraceability.selectedShas.join(', ')}`,
            ...input.retrofitTraceability.perCommitStatus.map(
              (c) => `${c.sha}: ${c.status}`,
            ),
          ],
        },
      ]
    : []

  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Implementation Completed',
    jiraKey: input.jiraKey,
    summary: input.implementation.summary,
    details: [
      `Branch: \`${input.implementation.implementationBranch}\``,
      `Commit SHA: \`${input.implementation.implementationCommitSha}\``,
      `Changed files: ${input.implementation.changedFiles.length}`,
    ],
    sections: [
      {
        title: 'Changed Files',
        bullets: input.implementation.changedFiles,
      },
      {
        title: 'Deviations From Plan',
        bullets: input.implementation.deviationsFromPlan,
      },
      {
        title: 'Residual Risks',
        bullets: input.implementation.residualRisks,
      },
      ...retrofitSection,
    ],
    nextStep: 'Automated code review has been queued.',
  })
}

export function buildBranchDriftComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  previousBaseCommitSha: string
  currentHeadSha: string
  driftStatus?: string
  overlappingFiles?: string[]
  riskyFiles?: string[]
  evidence?: string[]
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Replan Required',
    jiraKey: input.jiraKey,
    summary: 'The target branch moved before implementation could safely start.',
    details: [
      `Previous base commit SHA: \`${input.previousBaseCommitSha}\``,
      `Current branch head SHA: \`${input.currentHeadSha}\``,
      input.driftStatus ? `Drift classification: \`${input.driftStatus}\`` : null,
    ],
    sections: [
      {
        title: 'Conflict Evidence',
        bullets: [
          ...(input.evidence ?? []),
          ...((input.overlappingFiles ?? []).map(file => `Overlapping planned file: \`${file}\``)),
          ...((input.riskyFiles ?? []).map(file => `Risky changed file: \`${file}\``)),
        ],
      },
    ],
    nextStep: 'Review the branch drift and add `PFOS-REPLAN` to queue same-run planning against the latest branch head.',
  })
}

export function buildCodeReviewCompletedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  codeReview: OneShotCodeReview
  softGate?: {
    reason: string
  }
}): string {
  const softGate = input.softGate
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Code Review Completed',
    jiraKey: input.jiraKey,
    summary: softGate
      ? 'The code review requested changes or could not complete, but soft-gate mode continued this run for automated testing.'
      : input.codeReview.summary,
    details: [
      `Decision: ${input.codeReview.decision}`,
      `Confidence: ${input.codeReview.confidence}`,
      `Implementation version: ${input.codeReview.implementationVersion}`,
      `Review score: ${input.codeReview.score}`,
      softGate ? 'Soft gate: continued' : null,
      softGate ? `Reason: ${softGate.reason}` : null,
    ],
    sections: [
      {
        title: 'Resolved Findings',
        bullets: input.codeReview.findings.map(finding => {
          const location = finding.line != null
            ? `${finding.file}:${finding.line}`
            : finding.file
          return `${finding.severity.toUpperCase()} ${finding.category} — ${location}: ${finding.description}`
        }),
      },
      {
        title: 'Required Changes',
        bullets: input.codeReview.requiredChanges,
      },
      {
        title: 'Blocking Findings',
        bullets: input.codeReview.blockingFindings,
      },
      {
        title: 'Notes',
        bullets: input.codeReview.nonBlockingSuggestions,
      },
    ],
    nextStep: 'Automated testing has been queued.',
  })
}

export function buildCodeReviewEscalatedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  requiredChanges: string[]
  wipPrUrl?: string | null
  implementerDisagreementReason?: string | null
  maxVerificationLoops?: number
}): string {
  const summary = input.implementerDisagreementReason
    ? 'The implementer disagrees with the code review decision and human intervention is required.'
    : `The code reviewer requested changes after ${input.maxVerificationLoops ?? 'the configured'} verification loop(s).`

  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Code Review Escalated',
    jiraKey: input.jiraKey,
    summary,
    sections: [
      {
        title: 'Required Changes',
        bullets: input.requiredChanges,
      },
      {
        title: 'Escalation Notes',
        bullets: [
          input.implementerDisagreementReason
            ? `Implementer disagreement: ${input.implementerDisagreementReason}`
            : null,
          input.wipPrUrl ? `WIP draft PR: [View changes](${input.wipPrUrl})` : null,
        ],
      },
    ],
    nextStep: 'Review the draft PR and either fix the findings manually or explicitly force approval to continue.',
  })
}

export function buildCodeReviewBlockedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  blockingFindings: string[]
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Code Review Blocked',
    jiraKey: input.jiraKey,
    summary: 'Automated code review blocked this implementation from moving into testing.',
    sections: [
      {
        title: 'Blocking Findings',
        bullets: input.blockingFindings,
      },
    ],
    nextStep: 'Resolve the blocking findings before rerunning OneShot.',
  })
}

function formatExecutionKind(executionKind: OneShotTestResult['executionKind']): string {
  switch (executionKind) {
    case 'automated_tests':
      return 'Automated tests'
    case 'validation_only':
      return 'Validation-only checks'
    case 'invalid_command':
      return 'Invalid command'
    case 'no_runnable_command':
      return 'No runnable command'
  }
}

export function buildValidationFailedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  testResult: OneShotTestResult
  attemptsSummary: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Validation Failed',
    jiraKey: input.jiraKey,
    summary: input.attemptsSummary,
    details: [
      `Execution mode: ${formatExecutionKind(input.testResult.executionKind)}`,
      `Executed commands: ${input.testResult.executedCommands.length}`,
    ],
    sections: [
      {
        title: 'Failed Validations',
        bullets: input.testResult.failedTests.map(test => `${test.testName}: ${test.message}`),
      },
      {
        title: 'Commands Run',
        bullets: input.testResult.executedCommands,
      },
    ],
    nextStep: 'Inspect the failed validations and either fix the implementation or close the loop manually.',
  })
}

export function buildTestsFailedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  testResult: OneShotTestResult
  summary: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Tests Failed',
    jiraKey: input.jiraKey,
    summary: input.summary,
    details: [
      `Execution mode: ${formatExecutionKind(input.testResult.executionKind)}`,
      `Pass / Fail / Skip: ${input.testResult.passCount} / ${input.testResult.failCount} / ${input.testResult.skipCount}`,
      input.testResult.coverage
        ? `Coverage passed: ${input.testResult.coverage.passed ? 'yes' : 'no'}`
        : null,
    ],
    sections: [
      {
        title: 'Commands Run',
        bullets: input.testResult.executedCommands,
      },
      {
        title: 'Failing Tests',
        bullets: input.testResult.failedTests.map(test => `${test.testName}: ${test.message}`),
      },
      {
        title: 'Parser Notes',
        bullets: input.testResult.parserNotes,
      },
    ],
    nextStep: 'Review the failed commands and decide whether to revise the implementation or intervene manually.',
  })
}

export function buildRunFailedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  stageLabel: string
  errorMessage: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: `OneShot | ${input.stageLabel} Failed`,
    jiraKey: input.jiraKey,
    summary: input.errorMessage,
    nextStep: 'Review the failure details and decide whether to retry, replan, or complete the work manually.',
  })
}

export function buildBudgetExceededComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  stageLabel: string
  errorMessage: string
}): string {
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Budget Exceeded',
    jiraKey: input.jiraKey,
    summary: input.errorMessage,
    details: [`Stage: ${input.stageLabel}`],
    nextStep: 'Adjust the ticket scope or raise the budget before rerunning OneShot.',
  })
}

export function buildPrReadyComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  prNumber: number
  prUrl: string
  testResult: OneShotTestResult
  readiness?: OneShotReadinessClassification
  previewReady?: boolean
}): string {
  const readiness = input.readiness
  const isReady = !readiness || readiness.readiness === 'ready'
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: isReady ? 'OneShot | PR Ready' : 'OneShot | PR Created - Needs Review',
    jiraKey: input.jiraKey,
    summary: isReady
      ? 'All automated quality gates passed and the PR is ready for human review.'
      : 'OneShot produced a useful draft PR, but autonomous readiness gates found unresolved risks that need review.',
    details: [
      `${isReady ? 'PR' : 'Draft PR'}: [#${input.prNumber}](${input.prUrl})`,
      readiness ? `Autonomous readiness: ${readinessLabel(readiness.readiness)}` : null,
      `Execution mode: ${formatExecutionKind(input.testResult.executionKind)}`,
      `Pass / Fail / Skip: ${input.testResult.passCount} / ${input.testResult.failCount} / ${input.testResult.skipCount}`,
      input.previewReady ? 'Preview deployment is eligible from the dashboard.' : null,
    ],
    sections: [
      {
        title: 'Commands Run',
        bullets: input.testResult.executedCommands,
      },
      {
        title: 'Autonomous Readiness',
        bullets: readiness
          ? [
              `Completion status: ${readiness.completionStatus}`,
              ...(readiness.reasons.length > 0
                ? readiness.reasons.map((reason) =>
                    `${reason.severity.toUpperCase()} ${reason.category}: ${reason.message}`,
                  )
                : ['No unresolved autonomous readiness risks were detected.']),
              ...((readiness.observedRisks?.length ?? 0) > 0
                ? [
                    'Observed risks, not readiness-impacting in current rollout:',
                    ...readiness.observedRisks!.map((reason) =>
                      `${reason.severity.toUpperCase()} ${reason.category}: ${reason.message}`,
                    ),
                  ]
                : []),
            ]
          : ['Completion status: completed_ready'],
      },
    ],
    nextStep: input.previewReady
      ? [`Review the ${isReady ? 'PR' : 'draft PR'}.`, 'Request a preview deploy from the dashboard if needed.']
      : `Review the ${isReady ? 'PR' : 'draft PR'}.`,
  })
}

export function buildHandoffExhaustedComment(input: {
  assetBaseUrl?: string
  jiraKey: string
  runId: number
  failureType: 'workspace_setup_failed' | 'planning_publish_failed'
  error: string
}): string {
  const failureLabel =
    input.failureType === 'workspace_setup_failed'
      ? 'workspace setup'
      : 'planning publish'
  const summary =
    input.failureType === 'workspace_setup_failed'
      ? 'OneShot failed to set up the initial run workspace after exhausting all retry attempts. Operator recovery is required.'
      : 'OneShot failed to publish the planning queue message after exhausting all retry attempts. Operator recovery is required.'
  return buildOneShotComment({
    assetBaseUrl: input.assetBaseUrl,
    heading: 'OneShot | Handoff Failed',
    jiraKey: input.jiraKey,
    summary,
    details: [
      `Run ID: ${input.runId}`,
      `Failure type: ${failureLabel}`,
      `Error: ${input.error}`,
    ],
    nextStep: 'Operator recovery is required. Investigate the error above and use the recovery CLI or dashboard to retry or manually advance the run.',
  })
}
