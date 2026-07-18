import type { CodeRepository } from "../orchestrator/database.js";
import { isOneShotRepoEnabled } from "./repo-metadata.js";
import { loadRepoProfiles } from "./repo-router/profile-loader.js";

export interface QualifierProfiledRepoSummary {
  repoId: number;
  repoName: string;
  summary: string;
  aliases: string[];
  domains: string[];
  packages: string[];
}

export async function getProfiledRepoSummariesForLlm(
  repos: CodeRepository[],
  options: { profileDir?: string; requireProfiles?: boolean } = {},
): Promise<QualifierProfiledRepoSummary[]> {
  const enabled = repos.filter(isOneShotRepoEnabled);
  if (enabled.length === 0) {
    return [];
  }

  const profiles = await loadRepoProfiles(enabled, options);
  return enabled.map((repo) => {
    const profile = profiles.get(repo.repo_name.toLowerCase());
    return {
      repoId: repo.id,
      repoName: repo.repo_name,
      summary: profile?.summary ?? "",
      aliases: profile?.merged.aliases ?? [],
      domains: profile?.merged.domains ?? [],
      packages: profile?.merged.packages ?? [],
    };
  });
}

export function formatProfiledRepoSummariesForPrompt(
  summaries: QualifierProfiledRepoSummary[],
): string {
  if (summaries.length === 0) {
    return "(no profiled repositories available)";
  }
  return summaries
    .map((entry) => {
      const lines: string[] = [`### ${entry.repoName} (id=${entry.repoId})`];
      if (entry.summary) {
        lines.push(`Summary: ${entry.summary}`);
      } else {
        lines.push("Summary: (no curated summary available)");
      }
      if (entry.aliases.length > 0) {
        lines.push(`Aliases: ${entry.aliases.join(", ")}`);
      }
      if (entry.domains.length > 0) {
        lines.push(`Domains: ${entry.domains.join(", ")}`);
      }
      if (entry.packages.length > 0) {
        lines.push(`Packages: ${entry.packages.slice(0, 25).join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
