import type { InvestigationEnvironment } from '../types/investigation.js'

export interface InvestigationCodeTarget {
  id: string
  clientId: string
  environment?: InvestigationEnvironment
  repoName: string
  repoPath: string
  repoUrl?: string
  branch?: string
  branchCandidates?: string[]
  branchFamilyPatterns?: string[]
  defaultBranch?: string
  refreshFromRemote?: boolean
  enabled: boolean
  notes?: string
}

export interface InvestigationCodeTargetRegistry {
  resolveTargets(
    clientId: string,
    environment: InvestigationEnvironment,
    repoNames?: string[],
  ): Promise<InvestigationCodeTarget[]>
  listTargets(): Promise<InvestigationCodeTarget[]>
}

export class InMemoryCodeTargetRegistry implements InvestigationCodeTargetRegistry {
  constructor(private readonly targets: InvestigationCodeTarget[] = []) {}

  async resolveTargets(
    clientId: string,
    environment: InvestigationEnvironment,
    repoNames: string[] = [],
  ): Promise<InvestigationCodeTarget[]> {
    const requestedRepos = new Set(repoNames.map(repo => repo.trim().toLowerCase()).filter(Boolean))

    return this.targets.filter(target => {
      if (!target.enabled || target.clientId !== clientId) {
        return false
      }
      if (target.environment && target.environment !== environment) {
        return false
      }
      if (requestedRepos.size > 0 && !requestedRepos.has(target.repoName.toLowerCase())) {
        return false
      }
      return true
    })
  }

  async listTargets(): Promise<InvestigationCodeTarget[]> {
    return [...this.targets]
  }
}
