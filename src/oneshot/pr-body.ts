import type { OneShotImplementation } from './schema/implementation.js'
import type { OneShotPlan } from './schema/plan.js'
import { getPlanValidationSteps } from './schema/plan.js'
import type { OneShotReadinessClassification } from './readiness.js'
import { readinessLabel } from './readiness.js'

export interface MultiRepoContext {
  repoRef: string
  mergeOrder: number
  totalRepos: number
  siblingRepos: string[]
}

export interface RetrofitTraceability {
  sourceJiraKey: string
  sourceBranch: string
  targetBranch: string
  selectedShas: string[]
  commitCount: number
  perCommitStatus: Array<{ sha: string; status: string }>
}

export function buildOneShotPullRequestBody(args: {
  jiraKey: string
  ticketSummary: string
  plan: Pick<OneShotPlan, 'summary' | 'specs' | 'risks'>
  implementation: Pick<
    OneShotImplementation,
    | 'summary'
    | 'completedSpecIds'
    | 'changedFiles'
    | 'testResults'
    | 'deviationsFromPlan'
    | 'residualRisks'
    | 'openFollowUps'
  >
  readiness?: OneShotReadinessClassification
  multiRepoContext?: MultiRepoContext
  retrofitTraceability?: RetrofitTraceability
}): string {
  const completedSpecs = args.plan.specs.filter((spec) =>
    args.implementation.completedSpecIds.includes(spec.id),
  )
  const validationSteps = getPlanValidationSteps(args.plan)

  const testResults = args.implementation.testResults.length > 0
    ? args.implementation.testResults
      .map(result => `- \`${result.command}\` - ${result.status}: ${result.summary}`)
      .join('\n')
    : '- No explicit validation commands were reported.'

  const deviations = args.implementation.deviationsFromPlan.length > 0
    ? args.implementation.deviationsFromPlan.map(item => `- ${item}`).join('\n')
    : '- None'

  const residualRisks = args.implementation.residualRisks.length > 0
    ? args.implementation.residualRisks.map(item => `- ${item}`).join('\n')
    : (args.plan.risks.length > 0 ? args.plan.risks.map(item => `- ${item}`).join('\n') : '- None')

  const followUps = args.implementation.openFollowUps.length > 0
    ? args.implementation.openFollowUps.map(item => `- ${item}`).join('\n')
    : '- None'
  const readiness = args.readiness
  const readinessSection = readiness
    ? [
        '## Autonomous Readiness',
        `- Classification: ${readinessLabel(readiness.readiness)}`,
        `- Completion status: \`${readiness.completionStatus}\``,
        ...(readiness.reasons.length > 0
          ? readiness.reasons.map((reason) =>
              `- ${reason.severity.toUpperCase()} ${reason.category}: ${reason.message}`,
            )
          : ['- No unresolved autonomous readiness risks were detected.']),
        ...((readiness.observedRisks?.length ?? 0) > 0
          ? [
              '',
              '**Observed risks (not readiness-impacting in current rollout):**',
              ...readiness.observedRisks!.map((reason) =>
                `- ${reason.severity.toUpperCase()} ${reason.category}: ${reason.message}`,
              ),
            ]
          : []),
        '',
      ]
    : []

  const multiRepoSection = args.multiRepoContext
    ? [
        '## Multi-Repo Context',
        'This PR is part of a multi-repo feature group.',
        `- Merge order: ${args.multiRepoContext.mergeOrder} of ${args.multiRepoContext.totalRepos}`,
        `- Sibling repos: ${args.multiRepoContext.siblingRepos.join(', ')}`,
        '',
      ]
    : []

  const retrofitTraceSection = args.retrofitTraceability
    ? [
        '## Retrofit Traceability',
        `- Source Jira: ${args.retrofitTraceability.sourceJiraKey}`,
        `- Source branch: \`${args.retrofitTraceability.sourceBranch}\``,
        `- Target branch: \`${args.retrofitTraceability.targetBranch}\``,
        `- Source commit count: ${args.retrofitTraceability.commitCount}`,
        `- Selected SHAs: ${args.retrofitTraceability.selectedShas.join(', ')}`,
        '',
        '**Per-commit apply status:**',
        ...args.retrofitTraceability.perCommitStatus.map(
          (c) => `- \`${c.sha}\`: ${c.status}`,
        ),
        '',
      ]
    : []

  return [
    '## OneShot Ticket',
    `- Jira: ${args.jiraKey}`,
    `- Summary: ${args.ticketSummary}`,
    '',
    '## Plan Summary',
    args.plan.summary,
    '',
    '## Implemented Specs',
    ...(completedSpecs.length > 0
      ? completedSpecs.map((spec) => `- ${spec.id}: ${spec.objective}`)
      : ['- No specific spec IDs were reported.']),
    '',
    '## Implementation Summary',
    args.implementation.summary,
    '',
    '## Changed Files',
    ...(args.implementation.changedFiles.length > 0
      ? args.implementation.changedFiles.map(file => `- \`${file}\``)
      : ['- No tracked file changes were detected.']),
    '',
    '## Validation',
    testResults,
    '',
    ...readinessSection,
    '## Plan Validation Steps',
    ...(validationSteps.length > 0
      ? validationSteps.map(item => `- ${item}`)
      : ['- No explicit validation steps were provided in the plan.']),
    '',
    '## Deviations From Plan',
    deviations,
    '',
    '## Residual Risks',
    residualRisks,
    '',
    '## Follow-ups',
    followUps,
    '',
    ...multiRepoSection,
    ...retrofitTraceSection,
  ].join('\n')
}
