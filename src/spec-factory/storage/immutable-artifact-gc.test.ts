import { describe, expect, it, vi } from "vitest";
import {
  ImmutableArtifactReachabilityGc,
  immutableArtifactRootPrefix,
} from "./immutable-artifact-gc.js";

describe("ImmutableArtifactReachabilityGc", () => {
  it("deletes only old unreferenced objects and keeps crash-window writes", async () => {
    const repository = {
      listReferencedArtifactKeys: vi.fn().mockResolvedValue({
        keys: ["spec-factory/workspaces/referenced.json"],
        truncated: false,
      }),
    };
    const objectStore = {
      listKeys: vi.fn().mockResolvedValue({
        keys: [
          "spec-factory/workspaces/referenced.json",
          "spec-factory/workspaces/recent.json",
          "spec-factory/workspaces/orphan.json",
        ],
        objects: [
          {
            key: "spec-factory/workspaces/referenced.json",
            lastModified: new Date("2026-07-01T00:00:00.000Z"),
          },
          {
            key: "spec-factory/workspaces/recent.json",
            lastModified: new Date("2026-07-10T05:00:00.000Z"),
          },
          {
            key: "spec-factory/workspaces/orphan.json",
            lastModified: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
        nextContinuationToken: null,
      }),
      deleteKeys: vi.fn().mockResolvedValue(1),
    };
    const result = await new ImmutableArtifactReachabilityGc(
      repository,
      objectStore,
    ).cleanup({
      dryRun: false,
      olderThanHours: 24,
      now: new Date("2026-07-10T06:00:00.000Z"),
    });

    expect(result).toMatchObject({
      inspected: 3,
      referenced: 1,
      gracePeriodSkipped: 1,
      referenceScanTruncated: false,
      orphaned: 1,
      deleted: 1,
    });
    expect(repository.listReferencedArtifactKeys).toHaveBeenCalledWith({
      rootPrefix: "spec-factory/workspaces/",
      limit: 5_000,
    });
    expect(objectStore.deleteKeys).toHaveBeenCalledWith([
      "spec-factory/workspaces/orphan.json",
    ]);
  });

  it("fails closed when the durable reference scan is incomplete", async () => {
    const repository = {
      listReferencedArtifactKeys: vi.fn().mockResolvedValue({
        keys: ["spec-factory/workspaces/referenced.json"],
        truncated: true,
      }),
    };
    const objectStore = {
      listKeys: vi.fn(),
      deleteKeys: vi.fn(),
    };

    await expect(
      new ImmutableArtifactReachabilityGc(repository, objectStore).cleanup({
        dryRun: false,
      }),
    ).resolves.toMatchObject({
      referenceScanTruncated: true,
      inspected: 0,
      orphaned: 0,
      deleted: 0,
      truncated: true,
    });
    expect(objectStore.listKeys).not.toHaveBeenCalled();
    expect(objectStore.deleteKeys).not.toHaveBeenCalled();
  });

  it("refuses to scan outside the immutable workspace subtree", async () => {
    const repository = { listReferencedArtifactKeys: vi.fn() };
    const objectStore = { listKeys: vi.fn(), deleteKeys: vi.fn() };
    const gc = new ImmutableArtifactReachabilityGc(repository, objectStore);

    for (const rootPrefix of [
      "spec-factory",
      "spec-factory/attachments",
      "/",
      "*",
    ]) {
      await expect(gc.cleanup({ rootPrefix })).rejects.toThrow(
        "immutable_artifact_gc_unsafe_prefix",
      );
    }
    expect(repository.listReferencedArtifactKeys).not.toHaveBeenCalled();
    expect(objectStore.listKeys).not.toHaveBeenCalled();
    expect(objectStore.deleteKeys).not.toHaveBeenCalled();
  });

  it("derives the managed workspace subtree from the configured base prefix", () => {
    expect(immutableArtifactRootPrefix()).toBe("spec-factory/workspaces/");
    expect(immutableArtifactRootPrefix("tenant/artifacts/")).toBe(
      "tenant/artifacts/workspaces/",
    );
    expect(immutableArtifactRootPrefix("tenant/workspaces/")).toBe(
      "tenant/workspaces/",
    );
  });
});
