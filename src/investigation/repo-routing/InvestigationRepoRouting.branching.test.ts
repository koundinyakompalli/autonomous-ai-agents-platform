import { describe, expect, it } from 'vitest'
import {
  getInvestigationRepoBranchCandidatesForVersion,
  getInvestigationRepoBranchFamilyPatternsForVersion,
} from './InvestigationRepoRouting.js'

describe('investigation release-family routing', () => {
  it('routes release 3.20 to both canonical and arbitrary 3.20 branch names', () => {
    expect(getInvestigationRepoBranchCandidatesForVersion({
      repoName: 'core-app',
      repoUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
      versionOrBranch: '3.20',
    })).toEqual(expect.arrayContaining([
      'medhok-monorepo-3.20',
      'cp-medhok-monorepo-3.20',
      '3.20',
    ]))

    expect(getInvestigationRepoBranchFamilyPatternsForVersion({
      repoName: 'core-app',
      repoUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
      versionOrBranch: '3.20',
    })).toEqual(expect.arrayContaining([
      'medhok-monorepo-3.20*',
      'cp-medhok-monorepo-3.20*',
      '*3.20*',
    ]))
  })
})
