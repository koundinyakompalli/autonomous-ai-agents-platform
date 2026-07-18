import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSpecFactoryRepoCacheReady,
  DEFAULT_SPEC_FACTORY_REPO_CACHE_BASE,
  DEFAULT_SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS,
  DEFAULT_SPEC_FACTORY_WORKSPACE_BASE,
  DEFAULT_SPEC_FACTORY_WORKTREE_BASE,
  SpecFactoryRepoWorkspaceManager,
  type SpecFactoryBranchWorkspaceProvider,
} from "./repo-workspace.js";
import type { PreparedBranchWorkspace } from "../oneshot/workspaces.js";

function preparedWorkspace(
  overrides: Partial<PreparedBranchWorkspace> = {},
): PreparedBranchWorkspace {
  return {
    repoRoot: "/cache/core-app.git",
    runPath: "/workspaces/core-app/42",
    workspacePath: "/workspaces/core-app/42/workspace",
    statePath: "/workspaces/core-app/42/state",
    cleanup: vi.fn(),
    branchName: "master",
    headSha: "abc123def456",
    repoFetchReason: "fresh_cache",
    reused: true,
    ...overrides,
  };
}

function provider(
  handler: SpecFactoryBranchWorkspaceProvider["prepareBranchWorkspace"],
): SpecFactoryBranchWorkspaceProvider {
  return {
    prepareBranchWorkspace: vi.fn(handler),
  };
}

describe("SpecFactoryRepoWorkspaceManager", () => {
  beforeEach(() => {
    delete process.env.SPEC_FACTORY_REPO_CACHE_BASE;
    delete process.env.SPEC_FACTORY_WORKSPACE_BASE;
    delete process.env.SPEC_FACTORY_WORKTREE_BASE;
    delete process.env.SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS;
    delete process.env.ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS;
  });

  it("uses dedicated default cache/state paths, local worktrees, and OneShot cache freshness", () => {
    const manager = new SpecFactoryRepoWorkspaceManager({
      registerRepoFromPath: vi.fn(),
      workspaceProviderFactory: () => provider(async () => preparedWorkspace()),
    });

    expect(manager.repoCacheBase).toBe(DEFAULT_SPEC_FACTORY_REPO_CACHE_BASE);
    expect(manager.workspaceBase).toBe(DEFAULT_SPEC_FACTORY_WORKSPACE_BASE);
    expect(manager.worktreeBase).toBe(DEFAULT_SPEC_FACTORY_WORKTREE_BASE);
    expect(manager.repoCacheFreshnessTtlMs).toBe(
      DEFAULT_SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS,
    );
  });

  it("creates and verifies a dedicated writable repo cache", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "spec-factory-cache-"));
    const cache = path.join(root, "nested", "repo-cache");
    try {
      expect(() => assertSpecFactoryRepoCacheReady(cache)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses Spec Factory path and TTL environment overrides", () => {
    process.env.SPEC_FACTORY_REPO_CACHE_BASE = "/tmp/spec-cache";
    process.env.SPEC_FACTORY_WORKSPACE_BASE = "/tmp/spec-workspaces";
    process.env.SPEC_FACTORY_WORKTREE_BASE = "/tmp/spec-worktrees";
    process.env.SPEC_FACTORY_REPO_CACHE_FRESHNESS_TTL_MS = "120000";

    const manager = new SpecFactoryRepoWorkspaceManager({
      registerRepoFromPath: vi.fn(),
      workspaceProviderFactory: () => provider(async () => preparedWorkspace()),
    });

    expect(manager.repoCacheBase).toBe("/tmp/spec-cache");
    expect(manager.workspaceBase).toBe("/tmp/spec-workspaces");
    expect(manager.worktreeBase).toBe("/tmp/spec-worktrees");
    expect(manager.repoCacheFreshnessTtlMs).toBe(120_000);
  });

  it("prepares master through the OneShot branch workspace manager and registers it", async () => {
    const branchProvider = provider(async () => preparedWorkspace());
    const workspaceProviderFactory = vi.fn(() => branchProvider);
    const registerRepoFromPath = vi.fn(() => "spec-factory-source-42-core-app");
    const manager = new SpecFactoryRepoWorkspaceManager({
      repoCacheBase: "/cache",
      workspaceBase: "/workspaces",
      registerRepoFromPath,
      workspaceProviderFactory,
    });

    const workspace = await manager.prepareMasterWorkspace({
      sourceId: 42,
      repo: {
        repo_name: "core-app",
        repo_url: "https://github.com/org/core.git",
      },
    });

    expect(workspaceProviderFactory).toHaveBeenCalledWith({
      sourceId: 42,
      repoName: "core-app",
    });
    expect(branchProvider.prepareBranchWorkspace).toHaveBeenCalledWith({
      runId: 42,
      repo: {
        repo_name: "core-app",
        repo_url: "https://github.com/org/core.git",
      },
      branchName: "master",
      stage: "planner",
      branchFetchPolicy: "freshness_required",
    });
    expect(registerRepoFromPath).toHaveBeenCalledWith(
      "/workspaces/core-app/42/workspace",
      "spec-factory-source-42-core-app",
    );
    expect(workspace).toEqual({
      repoName: "core-app",
      branch: "master",
      headSha: "abc123def456",
      repoRoot: "/cache/core-app.git",
      workspacePath: "/workspaces/core-app/42/workspace",
      repoId: "spec-factory-source-42-core-app",
      cleanup: expect.any(Function),
    });
  });

  it("cleans up the prepared OneShot workspace", async () => {
    const cleanup = vi.fn();
    const branchProvider = provider(async () => preparedWorkspace({ cleanup }));
    const manager = new SpecFactoryRepoWorkspaceManager({
      repoCacheBase: "/cache",
      workspaceBase: "/workspaces",
      registerRepoFromPath: vi.fn(() => "spec-factory-source-42-core-app"),
      workspaceProviderFactory: () => branchProvider,
    });

    const workspace = await manager.prepareMasterWorkspace({
      sourceId: 42,
      repo: {
        repo_name: "core-app",
        repo_url: "https://github.com/org/core.git",
      },
    });

    await workspace.cleanup?.();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("falls back to main when master is missing", async () => {
    const branchProvider = provider(async (input) => {
      if (input.branchName === "master") {
        throw new Error("fatal: couldn't find remote ref master");
      }
      return preparedWorkspace({
        branchName: "main",
        headSha: "mainsha123",
        runPath: "/workspaces/core-app/7",
        workspacePath: "/workspaces/core-app/7/workspace",
        statePath: "/workspaces/core-app/7/state",
      });
    });
    const registerRepoFromPath = vi.fn(() => "spec-factory-source-7-core-app");
    const manager = new SpecFactoryRepoWorkspaceManager({
      repoCacheBase: "/cache",
      workspaceBase: "/workspaces",
      registerRepoFromPath,
      workspaceProviderFactory: () => branchProvider,
    });

    const workspace = await manager.prepareMasterWorkspace({
      sourceId: 7,
      repo: {
        repo_name: "core-app",
        repo_url: "https://github.com/org/core.git",
      },
    });

    expect(branchProvider.prepareBranchWorkspace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ branchName: "master" }),
    );
    expect(branchProvider.prepareBranchWorkspace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ branchName: "main" }),
    );
    expect(workspace.branch).toBe("main");
    expect(workspace.headSha).toBe("mainsha123");
    expect(registerRepoFromPath).toHaveBeenCalledWith(
      "/workspaces/core-app/7/workspace",
      "spec-factory-source-7-core-app",
    );
  });

  it("rejects clearly when neither master nor main exists", async () => {
    const branchProvider = provider(async (input) => {
      throw new Error(`fatal: couldn't find remote ref ${input.branchName}`);
    });
    const registerRepoFromPath = vi.fn();
    const manager = new SpecFactoryRepoWorkspaceManager({
      repoCacheBase: "/cache",
      workspaceBase: "/workspaces",
      registerRepoFromPath,
      workspaceProviderFactory: () => branchProvider,
    });

    await expect(
      manager.prepareMasterWorkspace({
        sourceId: 7,
        repo: {
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
        },
      }),
    ).rejects.toThrow(
      "Neither origin/master nor origin/main exists for core-app; Spec Factory only uses master or main",
    );

    expect(branchProvider.prepareBranchWorkspace).toHaveBeenCalledTimes(2);
    expect(registerRepoFromPath).not.toHaveBeenCalled();
  });

  it("does not fall back to main when master fails for a non-missing-ref reason", async () => {
    const branchProvider = provider(async () => {
      throw new Error("fatal: Authentication failed for repository");
    });
    const manager = new SpecFactoryRepoWorkspaceManager({
      repoCacheBase: "/cache",
      workspaceBase: "/workspaces",
      registerRepoFromPath: vi.fn(),
      workspaceProviderFactory: () => branchProvider,
    });

    await expect(
      manager.prepareMasterWorkspace({
        sourceId: 7,
        repo: {
          repo_name: "core-app",
          repo_url: "https://github.com/org/core.git",
        },
      }),
    ).rejects.toThrow("Authentication failed");

    expect(branchProvider.prepareBranchWorkspace).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe repo names", async () => {
    const manager = new SpecFactoryRepoWorkspaceManager({
      registerRepoFromPath: vi.fn(),
      workspaceProviderFactory: () => provider(async () => preparedWorkspace()),
    });

    await expect(
      manager.prepareMasterWorkspace({
        sourceId: 7,
        repo: { repo_name: ". ", repo_url: "https://github.com/org/core.git" },
      }),
    ).rejects.toThrow("Invalid Spec Factory repo_name");
    await expect(
      manager.prepareMasterWorkspace({
        sourceId: 7,
        repo: {
          repo_name: "core\\app",
          repo_url: "https://github.com/org/core.git",
        },
      }),
    ).rejects.toThrow("Invalid Spec Factory repo_name");
  });
});
