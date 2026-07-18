import type { CodeRepository, CustomerBranch, Database } from '../orchestrator/database.js'
import type { RemoteBranchHead, RemoteBranchLookupResult } from './git.js'
import {
  classifyRemoteBranchLookupFailure,
  resolveFirstRemoteBranchHeadClassified,
} from './git.js'
import { sanitizeErrorMessage } from './errors.js'
import {
  parseTicketIntent,
  type TicketIntentHint,
  type TicketIntentBranchHintKind,
  type TicketIntentIgnoredHint,
  type TicketIntentRetrofitContext,
  type TicketIntentBranchConflict,
} from './ticket-intent.js'

export interface BranchResolutionResult {
  branchName: string | null
  baseCommitSha: string | null
  resolutionSource: 'explicit' | 'default_branch' | 'none'
  branchCandidates: string[]
  blockingReasons: string[]
  nonBlockingWarnings: string[]
  failureKind?: 'branch_not_found' | 'branch_lookup_failed' | null
  failureDiagnostics?: RemoteBranchLookupResult | null
  selectedBranchHint?: TicketIntentHint<TicketIntentBranchHintKind> | null
  fallbackBranchHint?: TicketIntentHint<TicketIntentBranchHintKind> | null
  positiveBranchHints?: Array<TicketIntentHint<TicketIntentBranchHintKind>>
  ignoredNegatedBranchHints?: TicketIntentIgnoredHint[]
  branchConflicts?: TicketIntentBranchConflict[]
  retrofitContext?: TicketIntentRetrofitContext | null
}

export interface BranchResolverDependencies {
  resolveRemoteBranchHead?: (
    repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
    branchCandidates: string[],
  ) => Promise<RemoteBranchHead | null>
  resolveRemoteBranchHeadClassified?: (
    repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
    branchCandidates: string[],
  ) => Promise<RemoteBranchLookupResult>
}

function buildVersionedBranchCandidates(
  db: Database,
  repo: CodeRepository,
  customerBranch: CustomerBranch,
  branchHint: string | null,
  defaultBranch: string,
): { candidates: string[]; source: BranchResolutionResult['resolutionSource'] } {
  if (branchHint) {
    const explicitCandidates = new Set<string>([branchHint])
    const explicitCustomer = {
      ...customerBranch,
      branch: branchHint,
    }
    for (const candidate of db.getRepoBranchCandidates(repo, explicitCustomer)) {
      explicitCandidates.add(candidate)
    }
    explicitCandidates.add(defaultBranch)

    return {
      candidates: Array.from(explicitCandidates),
      source: 'explicit',
    }
  }

  return {
    candidates: [defaultBranch],
    source: 'default_branch',
  }
}

function buildBranchResolutionFailureReason(
  repo: CodeRepository,
  branchHint: string | null,
  branchCandidates: string[],
  isVersionedRepo: boolean,
  defaultBranch: string,
): string {
  if (isVersionedRepo && branchHint) {
    if (/^\d+\.\d+(?:\.\d+)?$/.test(branchHint)) {
      return (
        `No release branch found for FixVersion ${branchHint} on ${repo.repo_name}, and default branch ${defaultBranch} could not be resolved. ` +
        `Tried: ${branchCandidates.join(', ')}. ` +
        `Either cut the ${branchHint} release branch, update the ticket's FixVersion to a branch that exists, ` +
        `or verify the repository default branch ${defaultBranch}.`
      )
    }
  }

  return `No qualifying branch was found on ${repo.repo_name}. Tried: ${branchCandidates.join(', ')}.`
}

function buildBranchLookupFailureReason(
  repo: CodeRepository,
  lookup: Extract<RemoteBranchLookupResult, { status: 'lookup_failed' }>,
): string {
  const ownerRepo =
    lookup.githubOwner && lookup.githubRepo
      ? `${lookup.githubOwner}/${lookup.githubRepo}`
      : repo.repo_url
  const reasonDiagnostic = lookup.sanitizedError.replace(
    /https:\/\/x-access-token:[^@]+@/gi,
    'https://',
  )
  const diagnostic = reasonDiagnostic
    ? ` ${reasonDiagnostic}`
    : ''
  return (
    `GitHub branch lookup failed while resolving ${repo.repo_name} (${ownerRepo}). ` +
    `Failed candidate: ${lookup.failedBranchName}; category: ${lookup.failureCategory}. ` +
    `Tried: ${lookup.branchCandidates.join(', ')}.${diagnostic}`
  )
}

function buildFallbackWarning(input: {
  repo: CodeRepository
  branchHint: string
  resolvedDefaultBranch: string
  selectedBranchHint: TicketIntentHint<TicketIntentBranchHintKind>
  branchCandidates: string[]
}): string {
  const hintLabel = input.selectedBranchHint.label || input.selectedBranchHint.kind
  return (
    `Branch hint ${hintLabel}=${input.branchHint} did not resolve on ${input.repo.repo_name}; ` +
    `falling back to default branch ${input.resolvedDefaultBranch}. ` +
    `Tried: ${input.branchCandidates.join(', ')}.`
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export async function resolveBranchForQualification(
  db: Database,
  repo: CodeRepository,
  customerBranch: CustomerBranch,
  ticketText: string,
  dependencies: BranchResolverDependencies = {},
): Promise<BranchResolutionResult> {
  const ticketIntent = parseTicketIntent(ticketText)
  const branchDiagnostics = {
    positiveBranchHints: ticketIntent.positiveBranchHints,
    ignoredNegatedBranchHints: ticketIntent.ignoredNegatedBranchHints,
    branchConflicts: ticketIntent.branchConflicts,
    retrofitContext: ticketIntent.retrofit.context,
  }
  if (ticketIntent.retrofit.present && !ticketIntent.retrofit.complete) {
    return {
      branchName: null,
      baseCommitSha: null,
      resolutionSource: 'none',
      branchCandidates: [],
      blockingReasons: [
        `Malformed retrofit block: missing ${ticketIntent.retrofit.missingFields.join(', ')}.`,
      ],
      nonBlockingWarnings: [],
      selectedBranchHint: null,
      ...branchDiagnostics,
    }
  }

  if (ticketIntent.branchConflicts.length > 0) {
    return {
      branchName: null,
      baseCommitSha: null,
      resolutionSource: 'none',
      branchCandidates: [],
      blockingReasons: [
        `branch_conflict: Conflicting target branch hints found: ${ticketIntent.branchConflicts[0].values.join(', ')}.`,
      ],
      nonBlockingWarnings: [],
      selectedBranchHint: null,
      ...branchDiagnostics,
    }
  }

  const selectedBranchHint = selectBranchHint(ticketIntent.positiveBranchHints)
  const branchHint = selectedBranchHint?.value ?? null
  const defaultBranch = db.getRepositoryDefaultBranch(repo)
  const isVersionedRepo = db.isVersionedRepository(repo)
  const resolveHeadClassified =
    dependencies.resolveRemoteBranchHeadClassified ??
    (dependencies.resolveRemoteBranchHead
      ? async (
          repo: Pick<CodeRepository, 'repo_name' | 'repo_url'>,
        branchCandidates: string[],
      ): Promise<RemoteBranchLookupResult> => {
          let resolved: RemoteBranchHead | null
          try {
            resolved = await dependencies.resolveRemoteBranchHead!(
              repo,
              branchCandidates,
            )
          } catch (error) {
            const sanitizedError = sanitizeErrorMessage(errorMessage(error))
            const failureCategory =
              classifyRemoteBranchLookupFailure(sanitizedError)
            const failedBranchName = branchCandidates[0] ?? 'unknown'
            return {
              status: 'lookup_failed',
              repoName: repo.repo_name,
              githubOwner: null,
              githubRepo: null,
              failedBranchName,
              failureCategory,
              sanitizedError,
              branchCandidates,
              attempts: [
                {
                  branchName: failedBranchName,
                  status: 'lookup_failed',
                  failureCategory,
                  sanitizedError,
                },
              ],
            }
          }
          return resolved
            ? {
                status: 'resolved',
                branchName: resolved.branchName,
                headSha: resolved.headSha,
                branchCandidates,
                attempts: [
                  {
                    branchName: resolved.branchName,
                    status: 'resolved',
                    headSha: resolved.headSha,
                  },
                ],
              }
            : {
                status: 'not_found',
                branchCandidates,
                attempts: branchCandidates.map((branchName) => ({
                  branchName,
                  status: 'not_found' as const,
                })),
              }
        }
      : resolveFirstRemoteBranchHeadClassified)

  let branchCandidates: string[]
  let resolutionSource: BranchResolutionResult['resolutionSource']

  if (isVersionedRepo) {
    const versionedBranchCandidates = buildVersionedBranchCandidates(
      db,
      repo,
      customerBranch,
      branchHint,
      defaultBranch,
    )
    branchCandidates = versionedBranchCandidates.candidates
    resolutionSource = versionedBranchCandidates.source
  } else if (branchHint) {
    branchCandidates = [branchHint, defaultBranch]
    resolutionSource = 'explicit'
  } else {
    branchCandidates = [defaultBranch]
    resolutionSource = 'default_branch'
  }

  const dedupedCandidates = Array.from(new Set(branchCandidates.filter(Boolean)))
  const branchLookup = await resolveHeadClassified(repo, dedupedCandidates)

  if (branchLookup.status === 'lookup_failed') {
    const reason = buildBranchLookupFailureReason(repo, branchLookup)
    return {
      branchName: null,
      baseCommitSha: null,
      resolutionSource: 'none',
      branchCandidates: dedupedCandidates,
      blockingReasons: [reason],
      nonBlockingWarnings: [],
      failureKind: 'branch_lookup_failed',
      failureDiagnostics: branchLookup,
      selectedBranchHint,
      ...branchDiagnostics,
    }
  }

  if (branchLookup.status === 'not_found') {
    return {
      branchName: null,
      baseCommitSha: null,
      resolutionSource: 'none',
      branchCandidates: dedupedCandidates,
      blockingReasons: [
        buildBranchResolutionFailureReason(
          repo,
          branchHint,
          dedupedCandidates,
          isVersionedRepo,
          defaultBranch,
        ),
      ],
      nonBlockingWarnings: [],
      failureKind: 'branch_not_found',
      failureDiagnostics: branchLookup,
      selectedBranchHint,
      ...branchDiagnostics,
    }
  }

  const fellBackToDefault =
    Boolean(
      selectedBranchHint &&
        branchHint &&
        branchHint !== defaultBranch &&
        branchLookup.branchName === defaultBranch,
    )
  const nonBlockingWarnings = fellBackToDefault
    ? [
        buildFallbackWarning({
          repo,
          branchHint,
          resolvedDefaultBranch: branchLookup.branchName,
          selectedBranchHint,
          branchCandidates: dedupedCandidates,
        }),
      ]
    : []

  return {
    branchName: branchLookup.branchName,
    baseCommitSha: branchLookup.headSha,
    resolutionSource: fellBackToDefault ? 'default_branch' : resolutionSource,
    branchCandidates: dedupedCandidates,
    blockingReasons: [],
    nonBlockingWarnings,
    failureKind: null,
    failureDiagnostics: null,
    selectedBranchHint,
    fallbackBranchHint: fellBackToDefault ? selectedBranchHint : null,
    ...branchDiagnostics,
  }
}

function selectBranchHint(
  hints: Array<TicketIntentHint<TicketIntentBranchHintKind>>,
): TicketIntentHint<TicketIntentBranchHintKind> | null {
  const precedence: TicketIntentBranchHintKind[] = [
    'retrofit_target',
    'target_branch',
    'base_branch',
    'working_branch',
    'branch',
    'release',
    'version',
  ]

  for (const kind of precedence) {
    const hint = hints.find((candidate) => candidate.kind === kind)
    if (hint) {
      return hint
    }
  }

  return null
}
