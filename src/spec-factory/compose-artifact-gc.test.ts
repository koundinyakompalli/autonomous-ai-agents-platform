import type { Dirent, Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ComposeArtifactGc } from "./compose-artifact-gc.js";

function dirent(
  name: string,
  options: { directory?: boolean; symlink?: boolean } = {},
): Dirent {
  return {
    name,
    isDirectory: () => Boolean(options.directory),
    isFile: () => !options.directory && !options.symlink,
    isSymbolicLink: () => Boolean(options.symlink),
  } as Dirent;
}

function stats(input: {
  size?: number;
  mtime: string;
  directory?: boolean;
}): Stats {
  return {
    size: input.size ?? 0,
    mtimeMs: new Date(input.mtime).getTime(),
    isDirectory: () => Boolean(input.directory),
    isFile: () => !input.directory,
  } as Stats;
}

function buildFs(input: {
  readdir: Record<string, Dirent[]>;
  lstat?: Record<string, Stats>;
  rmError?: Error;
}) {
  return {
    readdir: vi.fn(async (target: string) => {
      if (target in input.readdir) return input.readdir[target];
      throw Object.assign(new Error(`ENOENT ${target}`), { code: "ENOENT" });
    }),
    lstat: vi.fn(async (target: string) => {
      const found = input.lstat?.[target];
      if (found) return found;
      throw Object.assign(new Error(`ENOENT ${target}`), { code: "ENOENT" });
    }),
    rm: vi.fn(async () => {
      if (input.rmError) throw input.rmError;
    }),
  };
}

describe("ComposeArtifactGc", () => {
  it("dry-runs stale entries under .tmp directories only", async () => {
    const fs = buildFs({
      readdir: {
        "/workspaces": [dirent("7", { directory: true }), dirent("old.md")],
        "/workspaces/7": [
          dirent(".tmp", { directory: true }),
          dirent("generated", { directory: true }),
        ],
        "/workspaces/7/.tmp": [dirent("old.tmp"), dirent("fresh.tmp")],
        "/workspaces/7/generated": [dirent("research", { directory: true })],
        "/workspaces/7/generated/research": [dirent("artifact.md")],
      },
      lstat: {
        "/workspaces/7/.tmp/old.tmp": stats({
          size: 12,
          mtime: "2026-06-06T00:00:00.000Z",
        }),
        "/workspaces/7/.tmp/fresh.tmp": stats({
          size: 18,
          mtime: "2026-06-07T12:00:00.000Z",
        }),
      },
    });
    const gc = new ComposeArtifactGc("/workspaces", fs);

    const result = await gc.cleanupTemporaryArtifacts({
      dryRun: true,
      olderThanHours: 24,
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.lstat).toHaveBeenCalledWith("/workspaces/7/.tmp/old.tmp");
    expect(fs.lstat).not.toHaveBeenCalledWith(
      "/workspaces/7/generated/research/artifact.md",
    );
    expect(result).toMatchObject({
      dryRun: true,
      inspectedTmpDirs: 1,
      deletedArtifacts: 0,
      wouldDeleteArtifacts: 1,
      wouldDeleteBytes: 12,
      failed: 0,
    });
  });

  it("deletes stale files and directories inside .tmp directories", async () => {
    const fs = buildFs({
      readdir: {
        "/workspaces": [dirent("7", { directory: true })],
        "/workspaces/7": [dirent(".tmp", { directory: true })],
        "/workspaces/7/.tmp": [
          dirent("old.tmp"),
          dirent("old-dir", { directory: true }),
        ],
        "/workspaces/7/.tmp/old-dir": [dirent("nested.tmp")],
      },
      lstat: {
        "/workspaces/7/.tmp/old.tmp": stats({
          size: 10,
          mtime: "2026-06-06T00:00:00.000Z",
        }),
        "/workspaces/7/.tmp/old-dir": stats({
          directory: true,
          mtime: "2026-06-06T00:00:00.000Z",
        }),
        "/workspaces/7/.tmp/old-dir/nested.tmp": stats({
          size: 20,
          mtime: "2026-06-06T00:00:00.000Z",
        }),
      },
    });
    const gc = new ComposeArtifactGc("/workspaces", fs);

    const result = await gc.cleanupTemporaryArtifacts({
      olderThanHours: 24,
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(fs.rm).toHaveBeenCalledWith("/workspaces/7/.tmp/old.tmp", {
      recursive: true,
      force: true,
    });
    expect(fs.rm).toHaveBeenCalledWith("/workspaces/7/.tmp/old-dir", {
      recursive: true,
      force: true,
    });
    expect(result).toMatchObject({
      deletedArtifacts: 2,
      deletedBytes: 30,
      failed: 0,
    });
  });

  it("records delete failures and continues", async () => {
    const fs = buildFs({
      readdir: {
        "/workspaces": [dirent("7", { directory: true })],
        "/workspaces/7": [dirent(".tmp", { directory: true })],
        "/workspaces/7/.tmp": [dirent("old.tmp")],
      },
      lstat: {
        "/workspaces/7/.tmp/old.tmp": stats({
          size: 10,
          mtime: "2026-06-06T00:00:00.000Z",
        }),
      },
      rmError: new Error("permission denied"),
    });
    const gc = new ComposeArtifactGc("/workspaces", fs);

    const result = await gc.cleanupTemporaryArtifacts({
      olderThanHours: 24,
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(result.deletedArtifacts).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0]).toEqual({
      path: "/workspaces/7/.tmp/old.tmp",
      errorMessage: "permission denied",
    });
  });

  it("rejects unsafe workspace roots", async () => {
    const fs = buildFs({ readdir: {} });

    await expect(
      new ComposeArtifactGc("/", fs).cleanupTemporaryArtifacts(),
    ).rejects.toThrow(/filesystem root/);
    await expect(
      new ComposeArtifactGc("relative", fs).cleanupTemporaryArtifacts(),
    ).rejects.toThrow(/absolute path/);
  });
});
