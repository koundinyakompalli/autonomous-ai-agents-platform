import { describe, expect, it, vi } from "vitest";
import { ComposeS3ReachabilityGc } from "./compose-s3-reachability-gc.js";

describe("ComposeS3ReachabilityGc", () => {
  it("dry-runs orphaned objects outside known session prefixes", async () => {
    const repository = {
      listComposeS3Prefixes: vi
        .fn()
        .mockResolvedValueOnce(["compose/7/", "compose/8/"]),
    };
    const objectStore = {
      listKeys: vi.fn().mockResolvedValueOnce({
        keys: [
          "compose/7/raw/a.pdf",
          "compose/8/context/v1.md",
          "compose/999/raw/orphan.pdf",
        ],
        nextContinuationToken: null,
      }),
      deleteKeys: vi.fn(),
    };
    const gc = new ComposeS3ReachabilityGc(repository, objectStore);

    const result = await gc.cleanupOrphanedObjects({
      rootPrefix: "compose/",
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      inspectedObjects: 3,
      reachableObjects: 2,
      orphanObjects: 1,
      deletedObjects: 0,
      orphanKeys: ["compose/999/raw/orphan.pdf"],
    });
    expect(objectStore.deleteKeys).not.toHaveBeenCalled();
  });

  it("deletes only orphaned objects when dryRun is false", async () => {
    const repository = {
      listComposeS3Prefixes: vi.fn().mockResolvedValueOnce(["compose/7/"]),
    };
    const objectStore = {
      listKeys: vi.fn().mockResolvedValueOnce({
        keys: ["compose/7/raw/a.pdf", "compose/999/raw/orphan.pdf"],
        nextContinuationToken: null,
      }),
      deleteKeys: vi.fn().mockResolvedValueOnce(1),
    };
    const gc = new ComposeS3ReachabilityGc(repository, objectStore);

    const result = await gc.cleanupOrphanedObjects({
      rootPrefix: "compose/",
      dryRun: false,
    });

    expect(objectStore.deleteKeys).toHaveBeenCalledWith([
      "compose/999/raw/orphan.pdf",
    ]);
    expect(result.deletedObjects).toBe(1);
  });

  it("refuses unsafe root prefixes", async () => {
    const gc = new ComposeS3ReachabilityGc(
      { listComposeS3Prefixes: vi.fn() },
      { listKeys: vi.fn(), deleteKeys: vi.fn() },
    );

    await expect(
      gc.cleanupOrphanedObjects({ rootPrefix: "", dryRun: true }),
    ).rejects.toThrow("compose_s3_reachability_gc_unsafe_prefix");
    await expect(
      gc.cleanupOrphanedObjects({ rootPrefix: "/", dryRun: true }),
    ).rejects.toThrow("compose_s3_reachability_gc_unsafe_prefix");
  });
});
