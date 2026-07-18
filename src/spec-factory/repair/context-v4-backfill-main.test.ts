import { describe, expect, it, vi } from "vitest";
import { runContextV4BackfillCli } from "./context-v4-backfill-main.js";

function writer() {
  return { write: vi.fn((_text: string) => true) };
}

describe("runContextV4BackfillCli", () => {
  it("connects before constructing the backfill and disconnects afterward", async () => {
    const lifecycle: string[] = [];
    const run = vi.fn(async () => ({
      repairRunId: 7,
      dryRun: true,
      inspected: 2,
      queued: 0,
      failed: 0,
      lastSessionId: 12,
      failures: [],
      reportSha256: "a".repeat(64),
    }));

    const code = await runContextV4BackfillCli(["--batch=100"], {
      connect: async () => void lifecycle.push("connect"),
      disconnect: async () => void lifecycle.push("disconnect"),
      createBackfill: () => {
        lifecycle.push("create");
        return {
          run: async (input) => {
            lifecycle.push("run");
            return run(input);
          },
          reconcile: vi.fn(),
          acceptRun: vi.fn(),
        };
      },
      stdout: writer(),
      stderr: writer(),
      user: "rollout-operator",
    });

    expect(code).toBe(0);
    expect(lifecycle).toEqual(["connect", "create", "run", "disconnect"]);
    expect(run).toHaveBeenCalledWith({
      dryRun: true,
      requestedBy: "rollout-operator",
      afterSessionId: undefined,
      batchSize: 100,
    });
  });

  it("disconnects and returns failure when the repair throws", async () => {
    const disconnect = vi.fn(async () => undefined);
    const stderr = writer();

    const code = await runContextV4BackfillCli([], {
      connect: vi.fn(async () => undefined),
      disconnect,
      createBackfill: () => ({
        run: vi.fn(async () => {
          throw new Error("repair_failed");
        }),
        reconcile: vi.fn(),
        acceptRun: vi.fn(),
      }),
      stdout: writer(),
      stderr,
    });

    expect(code).toBe(1);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("repair_failed"),
    );
  });
});
