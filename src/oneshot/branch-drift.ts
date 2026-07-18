import { listChangedFiles, runGitCommand } from './git.js'

export type BaseDriftStatus =
  | 'no_drift'
  | 'safe_fast_forward'
  | 'conflicting_fast_forward'
  | 'non_fast_forward'

export interface BaseDriftClassification {
  status: BaseDriftStatus
  previousBaseCommitSha: string
  currentHeadSha: string
  changedFiles: string[]
  overlappingFiles: string[]
  riskyFiles: string[]
  evidence: string[]
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\.\/+/, '').replace(/\\/g, '/')
}

function isRiskyDriftFile(filePath: string, plannedFiles: Set<string>): boolean {
  const normalized = normalizePath(filePath).toLowerCase()
  const basename = normalized.split('/').pop() ?? normalized

  if (
    basename === 'pom.xml' ||
    basename === 'package.json' ||
    basename === 'package-lock.json' ||
    basename === 'yarn.lock' ||
    basename === 'pnpm-lock.yaml' ||
    basename === 'build.gradle' ||
    basename === 'build.gradle.kts'
  ) {
    return true
  }

  if (!normalized.includes('/themes/')) {
    return false
  }

  for (const plannedFile of plannedFiles) {
    const planned = plannedFile.toLowerCase()
    if (!planned.includes('/themes/')) {
      continue
    }
    const plannedDir = planned.slice(0, planned.lastIndexOf('/') + 1)
    if (plannedDir && normalized.startsWith(plannedDir)) {
      return true
    }
  }

  return false
}

async function isAncestor(cwd: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  try {
    await runGitCommand(
      `git merge-base --is-ancestor ${JSON.stringify(ancestorSha)} ${JSON.stringify(descendantSha)}`,
      cwd,
    )
    return true
  } catch {
    return false
  }
}

export async function classifyBaseDrift(
  cwd: string,
  previousBaseCommitSha: string,
  currentHeadSha: string,
  plannedFiles: string[],
): Promise<BaseDriftClassification> {
  if (previousBaseCommitSha === currentHeadSha) {
    return {
      status: 'no_drift',
      previousBaseCommitSha,
      currentHeadSha,
      changedFiles: [],
      overlappingFiles: [],
      riskyFiles: [],
      evidence: ['Branch head still matches the planned base commit.'],
    }
  }

  const fastForward = await isAncestor(cwd, previousBaseCommitSha, currentHeadSha)
  if (!fastForward) {
    return {
      status: 'non_fast_forward',
      previousBaseCommitSha,
      currentHeadSha,
      changedFiles: [],
      overlappingFiles: [],
      riskyFiles: [],
      evidence: ['Planned base is not an ancestor of the current branch head.'],
    }
  }

  const changedFiles = await listChangedFiles(cwd, previousBaseCommitSha, currentHeadSha)
  const plannedFileSet = new Set(plannedFiles.map(normalizePath).filter(Boolean))
  const changedFileSet = new Set(changedFiles.map(normalizePath))
  const overlappingFiles = [...plannedFileSet]
    .filter(filePath => changedFileSet.has(filePath))
    .sort((left, right) => left.localeCompare(right))
  const riskyFiles = changedFiles
    .map(normalizePath)
    .filter(filePath => isRiskyDriftFile(filePath, plannedFileSet))
    .filter(filePath => !overlappingFiles.includes(filePath))
    .sort((left, right) => left.localeCompare(right))

  if (overlappingFiles.length > 0 || riskyFiles.length > 0) {
    return {
      status: 'conflicting_fast_forward',
      previousBaseCommitSha,
      currentHeadSha,
      changedFiles,
      overlappingFiles,
      riskyFiles,
      evidence: [
        `Branch moved forward with ${changedFiles.length} changed file(s).`,
        ...(overlappingFiles.length > 0
          ? [`Changed files overlap planned files: ${overlappingFiles.join(', ')}.`]
          : []),
        ...(riskyFiles.length > 0
          ? [`Changed files include risky shared/build/theme files: ${riskyFiles.join(', ')}.`]
          : []),
      ],
    }
  }

  return {
    status: 'safe_fast_forward',
    previousBaseCommitSha,
    currentHeadSha,
    changedFiles,
    overlappingFiles: [],
    riskyFiles: [],
    evidence: [`Branch moved forward with ${changedFiles.length} unrelated changed file(s).`],
  }
}
