import { describe, expect, it, vi } from "vitest";
import { WorkspaceManifestBackfill } from "./workspace-manifest-backfill.js";

function completeManifest() {
  return {
    manifestVersion: 2,
    files: [
      {
        path: "chat.md",
        artifactUri: "s3://artifacts/chat.md",
      },
    ],
    sourceInventory: [],
  };
}

describe("WorkspaceManifestBackfill", () => {
  it("plans only active sessions with incomplete immutable manifests", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            status: "active",
            workspace_path: "/workspace/7",
            manifest_json: completeManifest(),
          },
          {
            id: 8,
            status: "active",
            workspace_path: "/workspace/8",
            manifest_json: {
              manifestVersion: 1,
              files: [],
              sourceInventory: [],
            },
          },
          {
            id: 9,
            status: "active",
            workspace_path: "/workspace/9",
            manifest_json: null,
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);
    const target = { backfillImmutableManifest: vi.fn() };

    const report = await new WorkspaceManifestBackfill(
      { query } as never,
      target,
    ).run({ dryRun: true, batchSize: 3 });

    expect(report).toMatchObject({
      dryRun: true,
      inspected: 3,
      candidates: 2,
      migrated: 0,
      alreadyImmutable: 1,
      failed: 0,
      lastSessionId: 9,
      reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(target.backfillImmutableManifest).not.toHaveBeenCalled();
    expect(String(query.mock.calls[0][0])).toContain(
      "session.status <> 'archived'",
    );
  });

  it("migrates candidates and reports per-session failures without stopping", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 11,
            status: "active",
            workspace_path: "/workspace/11",
            manifest_json: null,
          },
          {
            id: 12,
            status: "active",
            workspace_path: "/workspace/12",
            manifest_json: null,
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);
    const target = {
      backfillImmutableManifest: vi
        .fn()
        .mockResolvedValueOnce({
          fileCount: 3,
          migratedFileCount: 2,
          reusedFileCount: 1,
        })
        .mockRejectedValueOnce(new Error("workspace file missing")),
    };

    const report = await new WorkspaceManifestBackfill(
      { query } as never,
      target,
    ).run({ dryRun: false, batchSize: 2 });

    expect(report).toMatchObject({
      dryRun: false,
      inspected: 2,
      candidates: 2,
      migrated: 1,
      filesMigrated: 2,
      filesReused: 1,
      failed: 1,
      failures: [{ sessionId: 12, error: "workspace file missing" }],
    });
    expect(target.backfillImmutableManifest).toHaveBeenNthCalledWith(1, {
      sessionId: 11,
      workspacePath: "/workspace/11",
    });
  });

  it("can include archived sessions for a pre-EFS-removal inventory", async () => {
    const query = vi.fn().mockResolvedValueOnce([[]]);
    await new WorkspaceManifestBackfill({ query } as never, {
      backfillImmutableManifest: vi.fn(),
    }).run({ includeArchived: true });

    expect(String(query.mock.calls[0][0])).not.toContain(
      "session.status <> 'archived'",
    );
  });
});
