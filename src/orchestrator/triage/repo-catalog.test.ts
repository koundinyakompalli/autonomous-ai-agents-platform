import { describe, expect, it } from "vitest";
import {
  resolveRepoFromProjectCatalog,
  type GitHubProjectCatalogEntry,
} from "./repo-catalog.js";

const catalog: GitHubProjectCatalogEntry[] = [
  {
    repo: "cp-batch-monorepo",
    repoFullName: "mhk-repos/cp-batch-monorepo",
    projectName: "CaseUpdateBatchProcessor",
    projectPath: "CaseUpdateBatchProcessor",
    projectType: "maven",
    defaultBranch: "master",
  },
  {
    repo: "cp-hedis-monorepo",
    repoFullName: "mhk-repos/cp-hedis-monorepo",
    projectName: "Hybrid",
    projectPath: "Hybrid",
    projectType: "maven",
    defaultBranch: "master",
  },
];

describe("resolveRepoFromProjectCatalog", () => {
  it("maps /opt/software/medhok runtime projects to GitHub catalog entries", () => {
    const result = resolveRepoFromProjectCatalog(
      "/opt/software/medhok/CaseUpdateBatchProcessor/lib/commons-vfs2-2.2.jar",
      catalog,
    );

    expect(result).toMatchObject({
      repoName: "cp-batch-monorepo",
      repoFullName: "mhk-repos/cp-batch-monorepo",
      projectName: "CaseUpdateBatchProcessor",
      projectPath: "CaseUpdateBatchProcessor",
      confidence: "high",
    });
    expect(result?.evidence.join("\n")).toContain(
      "/opt/software/medhok runtime project",
    );
  });

  it("maps /opt/repo project roots to catalog entries", () => {
    const result = resolveRepoFromProjectCatalog(
      "/opt/repo/Hybrid/lib/log4j-1.2.16.jar",
      catalog,
    );

    expect(result).toMatchObject({
      repoName: "cp-hedis-monorepo",
      projectName: "Hybrid",
      confidence: "high",
    });
  });

  it("does not guess when multiple catalog projects tie", () => {
    const result = resolveRepoFromProjectCatalog("/opt/repo/Hybrid/lib/x.jar", [
      ...catalog,
      {
        repo: "other-repo",
        repoFullName: "mhk-repos/other-repo",
        projectName: "Hybrid",
        projectPath: "Hybrid",
        projectType: "maven",
        defaultBranch: "main",
      },
    ]);

    expect(result).toBeUndefined();
  });
});
