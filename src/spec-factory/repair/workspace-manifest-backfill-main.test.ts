import { describe, expect, it, vi } from "vitest";
import { runWorkspaceManifestBackfillCli } from "./workspace-manifest-backfill-main.js";

function writer() {
  return { write: vi.fn((_text: string) => true) };
}

describe("runWorkspaceManifestBackfillCli", () => {
  it("passes bounded rollout options and disconnects", async () => {
    const lifecycle: string[] = [];
    const run = vi.fn(async () => ({
      dryRun: false,
      inspected: 2,
      candidates: 2,
      migrated: 2,
      alreadyImmutable: 0,
      filesMigrated: 5,
      filesReused: 1,
      failed: 0,
      lastSessionId: 22,
      failures: [],
      reportSha256: "a".repeat(64),
    }));

    const code = await runWorkspaceManifestBackfillCli(
      ["--apply", "--after=20", "--batch=50"],
      {
        connect: async () => void lifecycle.push("connect"),
        disconnect: async () => void lifecycle.push("disconnect"),
        createBackfill: () => {
          lifecycle.push("create");
          return {
            run: async (options) => {
              lifecycle.push("run");
              return run(options);
            },
          };
        },
        stdout: writer(),
        stderr: writer(),
      },
    );

    expect(code).toBe(0);
    expect(lifecycle).toEqual(["connect", "create", "run", "disconnect"]);
    expect(run).toHaveBeenCalledWith({
      dryRun: false,
      afterSessionId: 20,
      batchSize: 50,
      includeArchived: false,
    });
  });

  it("returns 2 for per-session migration failures", async () => {
    const stdout = writer();
    const code = await runWorkspaceManifestBackfillCli([], {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      createBackfill: () => ({
        run: vi.fn(async () => ({
          dryRun: true,
          inspected: 1,
          candidates: 1,
          migrated: 0,
          alreadyImmutable: 0,
          filesMigrated: 0,
          filesReused: 0,
          failed: 1,
          lastSessionId: 7,
          failures: [{ sessionId: 7, error: "checksum mismatch" }],
          reportSha256: "b".repeat(64),
        })),
      }),
      stdout,
      stderr: writer(),
    });

    expect(code).toBe(2);
    expect(stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("checksum mismatch"),
    );
  });

  it("refuses to mutate archived sessions", async () => {
    const stderr = writer();
    const run = vi.fn();
    const code = await runWorkspaceManifestBackfillCli(
      ["--apply", "--include-archived"],
      {
        connect: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
        createBackfill: () => ({ run }),
        stdout: writer(),
        stderr,
      },
    );

    expect(code).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        "archived_workspace_manifest_backfill_is_inventory_only",
      ),
    );
  });
});
