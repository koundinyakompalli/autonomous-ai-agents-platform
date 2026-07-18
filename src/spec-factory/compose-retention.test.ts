import type { Dirent, Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ComposeRetentionCleaner } from "./compose-retention.js";

function dirent(name: string, directory = false): Dirent {
  return {
    name,
    isDirectory: () => directory,
    isFile: () => !directory,
  } as Dirent;
}

function stats(size = 0, directory = false): Stats {
  return {
    size,
    isDirectory: () => directory,
    isFile: () => !directory,
  } as Stats;
}

function buildCleaner(options: { uploads?: unknown } = {}) {
  const repository = {
    listArchivedSessionsForWorkspaceCleanup: vi.fn().mockResolvedValue([
      {
        id: 3,
        name: "Billing export",
        s3Prefix: "compose/3/",
        workspacePath: "/tmp/compose/3",
        archivedAt: "2026-05-01T00:00:00.000Z",
      },
    ]),
    markWorkspaceCleaned: vi.fn().mockResolvedValue(undefined),
    markWorkspaceCleanupFailed: vi.fn().mockResolvedValue(undefined),
    purgeExpiredStreamTokens: vi.fn().mockResolvedValue(0),
    purgeStaleWorkerHeartbeats: vi.fn().mockResolvedValue(0),
  };
  const fs = {
    rm: vi.fn().mockResolvedValue(undefined),
    lstat: vi.fn(async (target: string) => {
      if (target === "/tmp/compose/3") return stats(0, true);
      if (target === "/tmp/compose/3/source.md") return stats(10);
      if (target === "/tmp/compose/3/nested/out.md") return stats(20);
      return stats(0, true);
    }),
    readdir: vi.fn(async (target: string) => {
      if (target === "/tmp/compose/3") {
        return [dirent("source.md"), dirent("nested", true)];
      }
      if (target === "/tmp/compose/3/nested") {
        return [dirent("out.md")];
      }
      return [];
    }),
  };
  const uploads =
    (options.uploads as { deletePrefix: ReturnType<typeof vi.fn> }) ??
    ({ deletePrefix: vi.fn().mockResolvedValue(0) } as never);
  const cleaner = new ComposeRetentionCleaner(repository, fs, uploads as never);
  return { cleaner, repository, fs, uploads };
}

describe("ComposeRetentionCleaner", () => {
  it("dry-runs archived workspace cleanup without deleting", async () => {
    const { cleaner, repository, fs } = buildCleaner();

    const result = await cleaner.cleanupArchivedWorkspaces({
      olderThanDays: 14,
      limit: 10,
      dryRun: true,
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(
      repository.listArchivedSessionsForWorkspaceCleanup,
    ).toHaveBeenCalledWith({
      archivedBefore: new Date("2026-05-25T00:00:00.000Z"),
      limit: 10,
    });
    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(repository.markWorkspaceCleaned).not.toHaveBeenCalled();
    expect(repository.purgeExpiredStreamTokens).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      inspected: 1,
      cleaned: 0,
      wouldClean: 1,
      failed: 0,
      deletedFiles: 0,
      deletedBytes: 0,
      purgedStreamTokens: 0,
      purgedWorkerHeartbeats: 0,
      successes: [],
      failures: [],
    });
  });

  it("removes archived workspaces and marks them cleaned", async () => {
    const { cleaner, repository, fs } = buildCleaner();

    const result = await cleaner.cleanupArchivedWorkspaces({
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(fs.rm).toHaveBeenCalledWith("/tmp/compose/3", {
      recursive: true,
      force: true,
    });
    expect(fs.readdir).toHaveBeenCalledWith("/tmp/compose/3", {
      withFileTypes: true,
    });
    expect(fs.readdir).toHaveBeenCalledWith("/tmp/compose/3/nested", {
      withFileTypes: true,
    });
    expect(repository.purgeExpiredStreamTokens).toHaveBeenCalledWith({
      expiredBefore: new Date("2026-06-08T00:00:00.000Z"),
      limit: 50,
    });
    expect(repository.purgeStaleWorkerHeartbeats).toHaveBeenCalledWith({
      heartbeatBefore: new Date("2026-06-01T00:00:00.000Z"),
      limit: 500,
    });
    expect(repository.markWorkspaceCleaned).toHaveBeenCalledWith(3);
    expect(result.cleaned).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deletedFiles).toBe(2);
    expect(result.deletedBytes).toBe(30);
    expect(result.successes).toEqual([
      {
        sessionId: 3,
        workspacePath: "/tmp/compose/3",
        filesDeleted: 2,
        bytesDeleted: 30,
        objectsDeleted: 0,
        missing: false,
      },
    ]);
  });

  it("reports purged expired stream tokens from normal cleanup sweeps", async () => {
    const { cleaner, repository } = buildCleaner();
    repository.purgeExpiredStreamTokens.mockResolvedValueOnce(9);

    const result = await cleaner.cleanupArchivedWorkspaces({
      limit: 12,
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(repository.purgeExpiredStreamTokens).toHaveBeenCalledWith({
      expiredBefore: new Date("2026-06-08T00:00:00.000Z"),
      limit: 12,
    });
    expect(result.purgedStreamTokens).toBe(9);
  });

  it("reports purged stale worker heartbeats from normal cleanup sweeps", async () => {
    const { cleaner, repository } = buildCleaner();
    repository.purgeStaleWorkerHeartbeats.mockResolvedValueOnce(6);

    const result = await cleaner.cleanupArchivedWorkspaces({
      limit: 12,
      workerHeartbeatRetentionDays: 2,
      workerHeartbeatLimit: 9,
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(repository.purgeStaleWorkerHeartbeats).toHaveBeenCalledWith({
      heartbeatBefore: new Date("2026-06-06T00:00:00.000Z"),
      limit: 9,
    });
    expect(result.purgedWorkerHeartbeats).toBe(6);
  });

  it("deletes the session's S3 prefix alongside the EFS workspace", async () => {
    const deletePrefix = vi.fn().mockResolvedValue(4);
    const { cleaner, repository, uploads } = buildCleaner({
      uploads: { deletePrefix },
    });

    const result = await cleaner.cleanupArchivedWorkspaces({
      now: new Date("2026-06-08T00:00:00.000Z"),
    });

    expect(uploads.deletePrefix).toHaveBeenCalledWith("compose/3/");
    expect(repository.markWorkspaceCleaned).toHaveBeenCalledWith(3);
    expect(result.cleaned).toBe(1);
    expect(result.successes[0]).toMatchObject({ objectsDeleted: 4 });
  });

  it("does not touch S3 on a dry run", async () => {
    const deletePrefix = vi.fn().mockResolvedValue(0);
    const { cleaner, uploads } = buildCleaner({ uploads: { deletePrefix } });

    await cleaner.cleanupArchivedWorkspaces({ dryRun: true });

    expect(uploads.deletePrefix).not.toHaveBeenCalled();
  });

  it("fails the candidate (and skips marking cleaned) when S3 deletion throws", async () => {
    const deletePrefix = vi
      .fn()
      .mockRejectedValue(new Error("S3 AccessDenied"));
    const { cleaner, repository } = buildCleaner({ uploads: { deletePrefix } });

    const result = await cleaner.cleanupArchivedWorkspaces();

    expect(repository.markWorkspaceCleaned).not.toHaveBeenCalled();
    expect(repository.markWorkspaceCleanupFailed).toHaveBeenCalledWith({
      sessionId: 3,
      errorMessage: expect.stringContaining("S3 AccessDenied"),
    });
    expect(result.cleaned).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("records cleanup failures and continues", async () => {
    const { cleaner, repository, fs } = buildCleaner();
    fs.rm.mockRejectedValueOnce(new Error("permission denied"));

    const result = await cleaner.cleanupArchivedWorkspaces();

    expect(repository.markWorkspaceCleanupFailed).toHaveBeenCalledWith({
      sessionId: 3,
      errorMessage: "permission denied",
    });
    expect(result.cleaned).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.deletedFiles).toBe(0);
    expect(result.deletedBytes).toBe(0);
    expect(result.successes).toEqual([]);
    expect(result.failures[0]).toMatchObject({
      sessionId: 3,
      workspacePath: "/tmp/compose/3",
      errorMessage: "permission denied",
    });
  });

  it("treats missing archived workspaces as already cleaned", async () => {
    const { cleaner, repository, fs } = buildCleaner();
    fs.lstat.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { code: "ENOENT" }),
    );

    const result = await cleaner.cleanupArchivedWorkspaces();

    expect(fs.rm).toHaveBeenCalledWith("/tmp/compose/3", {
      recursive: true,
      force: true,
    });
    expect(repository.markWorkspaceCleaned).toHaveBeenCalledWith(3);
    expect(repository.markWorkspaceCleanupFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      cleaned: 1,
      failed: 0,
      deletedFiles: 0,
      deletedBytes: 0,
      successes: [
        {
          sessionId: 3,
          workspacePath: "/tmp/compose/3",
          filesDeleted: 0,
          bytesDeleted: 0,
          missing: true,
        },
      ],
    });
  });
});
