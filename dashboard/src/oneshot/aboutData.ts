import { ONE_SHOT_REPO_METADATA } from "../../../src/oneshot/repo-metadata.js";

export type AboutPanel = "features" | "how-to" | "tech-spec" | "changelog";

export function aboutPanelHref(panel: AboutPanel): string {
  return panel === "features" ? "?view=about" : `?view=about&panel=${panel}`;
}

export type ProfiledRepo = {
  repoName: string;
  githubSlug: string;
  family: string;
};

export const PROFILED_REPOS: ReadonlyArray<ProfiledRepo> =
  ONE_SHOT_REPO_METADATA.filter((entry) => entry.oneshotEnabled).map(
    (entry) => ({
      repoName: entry.repoName,
      githubSlug: entry.githubSlug,
      family: entry.productFamily,
    }),
  );
