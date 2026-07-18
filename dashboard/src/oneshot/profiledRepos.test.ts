import { describe, expect, it } from "vitest";
import { ONE_SHOT_REPO_METADATA } from "../../../src/oneshot/repo-metadata.js";
import { PROFILED_REPOS } from "./aboutData.js";

// PROFILED_REPOS is derived from ONE_SHOT_REPO_METADATA at module load time.
// These assertions guard against accidental shape drift in the dashboard
// derivation (e.g. someone hand-edits PROFILED_REPOS or changes the filter).
describe("PROFILED_REPOS dashboard surface", () => {
  it("exposes only OneShot-enabled repos", () => {
    const enabledNames = ONE_SHOT_REPO_METADATA.filter(
      (entry) => entry.oneshotEnabled,
    ).map((entry) => entry.repoName);
    expect(PROFILED_REPOS.map((repo) => repo.repoName)).toEqual(enabledNames);
  });

  it("preserves repo identity, slug, and product family from the source", () => {
    const expected = ONE_SHOT_REPO_METADATA.filter(
      (entry) => entry.oneshotEnabled,
    ).map((entry) => ({
      repoName: entry.repoName,
      githubSlug: entry.githubSlug,
      family: entry.productFamily,
    }));
    expect(PROFILED_REPOS).toEqual(expected);
  });

  it("excludes disabled MP repos", () => {
    expect(PROFILED_REPOS.some((repo) => repo.repoName === "mp-web")).toBe(
      false,
    );
    expect(
      PROFILED_REPOS.some(
        (repo) => repo.repoName === "mp-product-client-configs",
      ),
    ).toBe(false);
  });
});
