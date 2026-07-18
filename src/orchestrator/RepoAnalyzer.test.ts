import { describe, expect, it, vi } from 'vitest';
import { RepoAnalyzer } from './RepoAnalyzer.js';
import type { CodeRepository } from './database.js';

const AVAILABLE_REPOS: CodeRepository[] = [
  {
    id: 1,
    repo_name: 'core-app',
    repo_url: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
    description: 'core application',
    default_branch: 'master',
    created_at: new Date(),
  },
  {
    id: 2,
    repo_name: 'client-services',
    repo_url: 'https://github.com/mhk-repos/cp-client-services-monorepo.git',
    description: 'client-specific services',
    default_branch: 'master',
    created_at: new Date(),
  },
  {
    id: 8,
    repo_name: 'mp-web',
    repo_url: 'https://github.com/mhk-repos/mp-web.git',
    description: 'MP web application',
    default_branch: 'master',
    created_at: new Date(),
  },
  {
    id: 9,
    repo_name: 'mp-product-client-configs',
    repo_url: 'https://github.com/mhk-repos/mp-product-client-configs.git',
    description: 'MP client and product configs',
    default_branch: 'main',
    created_at: new Date(),
  },
];

describe('RepoAnalyzer', () => {
  it('routes MP config tickets directly to mp-product-client-configs', async () => {
    const analyzer = new RepoAnalyzer();
    const callBedrock = vi.fn();
    (analyzer as any).callBedrock = callBedrock;

    const result = await analyzer.analyzeTicketForRepos(
      {
        key: 'MPDEV-1234',
        fields: {
          summary: 'Update client config yaml for MedPlanner rollout',
          description: 'Need to update YAML tenant configuration for the new client.',
        },
      },
      AVAILABLE_REPOS,
    );

    expect(result.selectedRepoIds).toEqual([9]);
    expect(result.reasoning).toContain('mp-product-client-configs');
    expect(callBedrock).not.toHaveBeenCalled();
  });

  it('routes generic MP tickets to MP-specific repos only', async () => {
    const analyzer = new RepoAnalyzer();
    const callBedrock = vi.fn();
    (analyzer as any).callBedrock = callBedrock;

    const result = await analyzer.analyzeTicketForRepos(
      {
        key: 'MPSUP-88',
        fields: {
          summary: 'Investigate MedPlanner release notes mismatch',
          description: 'Client notes are showing the wrong release version in MP.',
        },
      },
      AVAILABLE_REPOS,
    );

    expect(result.selectedRepoIds).toEqual([8]);
    expect(callBedrock).not.toHaveBeenCalled();
  });

  it('filters MP repos out of CP ticket LLM results', async () => {
    const analyzer = new RepoAnalyzer();
    (analyzer as any).callBedrock = vi.fn().mockResolvedValue(JSON.stringify({
      selectedRepoIds: [1, 8, 2],
      reasoning: 'core-app and client-services are relevant',
    }));

    const result = await analyzer.analyzeTicketForRepos(
      {
        key: 'CPCLIENT-9351',
        fields: {
          summary: 'Customer issue in CP application flow',
          description: 'Investigate customer-specific behavior in the CP app.',
        },
      },
      AVAILABLE_REPOS,
    );

    expect(result.selectedRepoIds).toEqual([1, 2]);
  });

  it('detects MP ticket family from ticket references in Harvey text', async () => {
    const analyzer = new RepoAnalyzer();
    const callBedrock = vi.fn();
    (analyzer as any).callBedrock = callBedrock;

    const result = await analyzer.analyzeTicketForRepos(
      {
        key: 'HARVEY-intake',
        fields: {
          summary: 'Please investigate MPDEV-443 config drift',
          description: 'The MPDEV-443 request is asking for tenant config updates.',
        },
      },
      AVAILABLE_REPOS,
    );

    expect(result.selectedRepoIds).toEqual([9]);
    expect(callBedrock).not.toHaveBeenCalled();
  });
});
