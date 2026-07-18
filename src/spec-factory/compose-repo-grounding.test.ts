import { describe, expect, it, vi } from "vitest";
import { ComposeRepoGrounding } from "./compose-repo-grounding.js";

function repo(id: number, name: string) {
  return {
    id,
    repo_name: name,
    repo_url: `https://github.com/org/${name}.git`,
    default_branch: "main",
    description: `${name} desc`,
  };
}

function buildGrounding(options = {}) {
  const lookupRepositories = vi
    .fn()
    .mockResolvedValue([repo(1, "core-app"), repo(2, "provider-portal"), repo(3, "billing")]);
  const prepareMasterWorkspace = vi.fn(async ({ repo }) => ({
    repoName: repo.repo_name,
    headSha: "abc1234",
    workspacePath: `/cache/${repo.repo_name}`,
    repoId: `rid-${repo.repo_name}`,
    cleanup: async () => undefined,
  }));
  const scanRepo = vi.fn(async (workspacePath: string) => ({
    scannedAt: "t",
    workspacePath,
    techStack: { primaryLanguage: "TypeScript", buildTool: "npm", testFramework: "vitest", frameworks: ["express"] },
    projectStructure: { rootFiles: [], topLevelDirs: ["src"], estimatedFileCount: 10, extensionBreakdown: {} },
    keyFiles: [{ path: "src/appeals.ts", role: "service", description: "x" }],
    projectGuidanceFiles: [],
  }));
  const grounding = new ComposeRepoGrounding({
    lookupRepositories,
    workspaceManager: { prepareMasterWorkspace },
    scanRepo: scanRepo as never,
    formatScanForPrompt: ((s: { workspacePath: string }) => `SCAN(${s.workspacePath})`) as never,
    buildRouteCardContext: (() => "") as never,
    maxGroundedRepos: 3,
    enabled: true,
    ...options,
  });
  return { grounding, lookupRepositories, prepareMasterWorkspace, scanRepo };
}

describe("ComposeRepoGrounding", () => {
  it("grounds the selected repos: clones, scans, returns codeRepoIds + manifest + markdown", async () => {
    const { grounding, prepareMasterWorkspace } = buildGrounding();
    const out = await grounding.groundRepos({ selectedRepositoryIds: [1], sources: [] });

    expect(prepareMasterWorkspace).toHaveBeenCalledTimes(1);
    expect(out.codeRepoIds).toEqual(["rid-core-app"]);
    expect(out.repositoriesMarkdown).toContain("SCAN(/cache/core-app)");
    expect(out.manifest).toHaveLength(1);
    expect(out.manifest[0]).toMatchObject({ repoName: "core-app", headSha: "abc1234" });
    expect(out.manifest[0].inspectedPaths).toContain("src/appeals.ts");
    expect(out.manifest[0].warnings).toEqual([]);
  });

  it("auto-identifies an unselected repo mentioned in the sources", async () => {
    const { grounding } = buildGrounding();
    const out = await grounding.groundRepos({
      selectedRepositoryIds: [1],
      sources: [{ filename: "notes.md", content: "we must change the provider-portal appeals flow" }],
    });
    const names = out.manifest.map((m) => m.repoName).sort();
    expect(names).toContain("core-app");
    expect(names).toContain("provider-portal");
  });

  it("selected repos win and the total is capped", async () => {
    const { grounding } = buildGrounding({ maxGroundedRepos: 2 });
    const out = await grounding.groundRepos({
      selectedRepositoryIds: [1, 2],
      sources: [{ filename: "n.md", content: "billing billing billing" }],
    });
    expect(out.manifest).toHaveLength(2);
    expect(out.manifest.map((m) => m.repoName).sort()).toEqual(["core-app", "provider-portal"]);
  });

  it("degrades to metadata-only for a repo whose clone/scan fails, turn still produces output", async () => {
    const { grounding, prepareMasterWorkspace } = buildGrounding();
    prepareMasterWorkspace.mockRejectedValueOnce(new Error("auth failed"));
    const out = await grounding.groundRepos({ selectedRepositoryIds: [1], sources: [] });

    expect(out.codeRepoIds).toEqual([]); // failed repo dropped from repoIds
    expect(out.manifest[0].warnings.join(" ")).toMatch(/metadata only|auth failed/i);
    expect(out.repositoriesMarkdown).toContain("core-app"); // metadata fallback still present
  });

  it("returns legacy metadata-only (no clone) when grounding is disabled", async () => {
    const { grounding, prepareMasterWorkspace } = buildGrounding({ enabled: false });
    const out = await grounding.groundRepos({ selectedRepositoryIds: [1], sources: [] });

    expect(prepareMasterWorkspace).not.toHaveBeenCalled();
    expect(out.codeRepoIds).toEqual([]);
    expect(out.repositoriesMarkdown).toContain("core-app");
  });

  it("returns empty (no markdown) when no repos selected or identified", async () => {
    const { grounding, prepareMasterWorkspace } = buildGrounding();
    const out = await grounding.groundRepos({ selectedRepositoryIds: [], sources: [] });
    expect(prepareMasterWorkspace).not.toHaveBeenCalled();
    expect(out.codeRepoIds).toEqual([]);
    expect(out.manifest).toEqual([]);
  });

  it("recovers the language from key-file extensions when the scan reports unknown", async () => {
    const { grounding, scanRepo } = buildGrounding();
    // Multi-module repo: no root build marker, but key files are clearly Java.
    scanRepo.mockResolvedValueOnce({
      scannedAt: "t",
      workspacePath: "/cache/core-app",
      techStack: { primaryLanguage: null, buildTool: null, testFramework: null, frameworks: [] },
      projectStructure: { rootFiles: [], topLevelDirs: ["ws-doc-api"], estimatedFileCount: 50, extensionBreakdown: {} },
      keyFiles: [{ path: "ws-doc-api/src/main/java/com/x/App.java", role: "entry_point", description: "x" }],
      projectGuidanceFiles: [],
    } as never);

    const out = await grounding.groundRepos({ selectedRepositoryIds: [1], sources: [] });
    expect(out.manifest[0].techStack).toBe("Java");
  });
});
