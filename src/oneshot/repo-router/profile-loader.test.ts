import { describe, expect, it } from "vitest";
import type { CodeRepository } from "../../orchestrator/database.js";
import { getProfiledRepoSummariesForLlm } from "../qualifier-repo-context.js";
import { ONE_SHOT_REPO_METADATA } from "../repo-metadata.js";
import { loadRepoProfiles } from "./profile-loader.js";

function enabledMetadataRepos(): CodeRepository[] {
  return ONE_SHOT_REPO_METADATA.filter(
    (metadata) => metadata.oneshotEnabled,
  ).map((metadata, index) => ({
    id: index + 1,
    repo_name: metadata.repoName,
    repo_url: `https://github.com/mhk-repos/${metadata.githubSlug}.git`,
    description: `${metadata.repoName} test repository`,
    default_branch: "main",
    created_at: new Date("2026-06-15T00:00:00Z"),
  }));
}

describe("RepoRouter profile loading", () => {
  it("loads required production profiles for every enabled OneShot repo", async () => {
    const repos = enabledMetadataRepos();

    const profiles = await loadRepoProfiles(repos, { requireProfiles: true });

    expect(Array.from(profiles.keys()).sort()).toEqual(
      repos.map((repo) => repo.repo_name.toLowerCase()).sort(),
    );
    expect(profiles.get("cp-autonomous-ai-agents-platform")).toMatchObject({
      repoName: "cp-autonomous-ai-agents-platform",
    });
  });

  it("includes self-platform routing context for the QUALIFIER prompt", async () => {
    const repo = enabledMetadataRepos().find(
      (candidate) => candidate.repo_name === "cp-autonomous-ai-agents-platform",
    );
    expect(repo).toBeDefined();

    const summaries = await getProfiledRepoSummariesForLlm([repo!], {
      requireProfiles: true,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      repoName: "cp-autonomous-ai-agents-platform",
      aliases: expect.arrayContaining(["repo router"]),
      domains: expect.arrayContaining(["oneshot", "qualifier"]),
    });
    expect(summaries[0].summary.toLowerCase()).toContain("qualifier");
  });
});
