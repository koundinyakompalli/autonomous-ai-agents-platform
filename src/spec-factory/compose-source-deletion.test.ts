import { describe, expect, it, vi } from "vitest";
import { ComposeSourceDeletionCleaner } from "./compose-source-deletion.js";

function candidate(overrides = {}) {
  return {
    deletionId: 801,
    sessionId: 7,
    sourceId: 21,
    workspacePath: "/workspace/compose/7",
    sourceIds: [21, 22],
    s3Keys: ["compose/7/raw/requirements.md"],
    artifactUris: [
      "file:///workspace/compose/7/sources/source-21.md",
      "s3://artifacts/compose/7/source-22.json",
    ],
    localPaths: ["sources/source-22.md"],
    ...overrides,
  };
}

describe("ComposeSourceDeletionCleaner", () => {
  it("deletes source artifacts before committing the purge", async () => {
    const repository = {
      claimNextSourceDeletionPurge: vi
        .fn()
        .mockResolvedValueOnce(candidate())
        .mockResolvedValueOnce(null),
      markSourceDeletionPurged: vi.fn().mockResolvedValue(true),
      markSourceDeletionPurgeFailed: vi.fn(),
    };
    const objectStore = {
      deleteKeys: vi.fn().mockResolvedValue(1),
      deleteArtifactUris: vi.fn().mockResolvedValue(1),
    };
    const fs = { rm: vi.fn().mockResolvedValue(undefined) };
    const cleaner = new ComposeSourceDeletionCleaner(
      repository,
      objectStore,
      fs,
    );

    await expect(
      cleaner.cleanupExpiredSourceDeletions({ limit: 5 }),
    ).resolves.toEqual({
      inspected: 1,
      purged: 1,
      failed: 0,
      deletedFiles: 2,
      deletedObjects: 2,
      failures: [],
    });
    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(fs.rm).toHaveBeenCalledWith(
      "/workspace/compose/7/sources/source-21.md",
      { recursive: false, force: true },
    );
    expect(objectStore.deleteKeys).toHaveBeenCalledWith([
      "compose/7/raw/requirements.md",
    ]);
    expect(objectStore.deleteArtifactUris).toHaveBeenCalledWith([
      "s3://artifacts/compose/7/source-22.json",
    ]);
    expect(repository.markSourceDeletionPurged).toHaveBeenCalledWith({
      deletionId: 801,
      deletedFileCount: 2,
      deletedObjectCount: 2,
    });
    expect(repository.markSourceDeletionPurgeFailed).not.toHaveBeenCalled();
  });

  it("fails closed when an artifact path escapes the session workspace", async () => {
    const repository = {
      claimNextSourceDeletionPurge: vi
        .fn()
        .mockResolvedValueOnce(
          candidate({ localPaths: ["/workspace/compose/8/other.md"] }),
        )
        .mockResolvedValueOnce(null),
      markSourceDeletionPurged: vi.fn(),
      markSourceDeletionPurgeFailed: vi.fn().mockResolvedValue(undefined),
    };
    const objectStore = {
      deleteKeys: vi.fn(),
      deleteArtifactUris: vi.fn(),
    };
    const cleaner = new ComposeSourceDeletionCleaner(repository, objectStore, {
      rm: vi.fn(),
    });

    const result = await cleaner.cleanupExpiredSourceDeletions({ limit: 1 });

    expect(result).toEqual(
      expect.objectContaining({ inspected: 1, purged: 0, failed: 1 }),
    );
    expect(result.failures[0]?.errorMessage).toContain("outside workspace");
    expect(repository.markSourceDeletionPurgeFailed).toHaveBeenCalledWith(
      expect.objectContaining({ deletionId: 801 }),
    );
    expect(repository.markSourceDeletionPurged).not.toHaveBeenCalled();
    expect(objectStore.deleteKeys).not.toHaveBeenCalled();
  });

  it("fails closed for unsupported artifact URI schemes", async () => {
    const repository = {
      claimNextSourceDeletionPurge: vi
        .fn()
        .mockResolvedValueOnce(
          candidate({ artifactUris: ["https://artifacts.example/source.md"] }),
        ),
      markSourceDeletionPurged: vi.fn(),
      markSourceDeletionPurgeFailed: vi.fn().mockResolvedValue(undefined),
    };
    const objectStore = {
      deleteKeys: vi.fn(),
      deleteArtifactUris: vi.fn(),
    };
    const cleaner = new ComposeSourceDeletionCleaner(repository, objectStore, {
      rm: vi.fn(),
    });

    const result = await cleaner.cleanupExpiredSourceDeletions({ limit: 1 });

    expect(result).toEqual(
      expect.objectContaining({ inspected: 1, purged: 0, failed: 1 }),
    );
    expect(result.failures[0]?.errorMessage).toContain(
      "unsupported artifact URI",
    );
    expect(repository.markSourceDeletionPurged).not.toHaveBeenCalled();
    expect(objectStore.deleteKeys).not.toHaveBeenCalled();
  });

  it("rejects unsafe workspace roots", async () => {
    const repository = {
      claimNextSourceDeletionPurge: vi
        .fn()
        .mockResolvedValueOnce(candidate({ workspacePath: "/" })),
      markSourceDeletionPurged: vi.fn(),
      markSourceDeletionPurgeFailed: vi.fn().mockResolvedValue(undefined),
    };
    const cleaner = new ComposeSourceDeletionCleaner(
      repository,
      { deleteKeys: vi.fn(), deleteArtifactUris: vi.fn() },
      { rm: vi.fn() },
    );

    const result = await cleaner.cleanupExpiredSourceDeletions({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(result.failures[0]?.errorMessage).toContain("safe workspace path");
  });

  it("rejects relative workspace roots", async () => {
    const repository = {
      claimNextSourceDeletionPurge: vi
        .fn()
        .mockResolvedValueOnce(candidate({ workspacePath: "compose/7" })),
      markSourceDeletionPurged: vi.fn(),
      markSourceDeletionPurgeFailed: vi.fn().mockResolvedValue(undefined),
    };
    const cleaner = new ComposeSourceDeletionCleaner(
      repository,
      { deleteKeys: vi.fn(), deleteArtifactUris: vi.fn() },
      { rm: vi.fn() },
    );

    const result = await cleaner.cleanupExpiredSourceDeletions({ limit: 1 });

    expect(result.failed).toBe(1);
    expect(result.failures[0]?.errorMessage).toContain("safe workspace path");
    expect(repository.markSourceDeletionPurged).not.toHaveBeenCalled();
  });
});
