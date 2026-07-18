import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { withFilesystemLock } from "./filesystemLock.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "specter-lock-test-"));
  tempRoots.push(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withFilesystemLock", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("serializes concurrent work on the same lock path", async () => {
    const root = await makeTempRoot();
    const lockPath = join(root, "repo.lock");
    const events: string[] = [];

    const first = withFilesystemLock(
      lockPath,
      async () => {
        events.push("first-start");
        await delay(40);
        events.push("first-end");
        return "first";
      },
      { retryDelayMs: 5, timeoutMs: 1_000 },
    );

    await delay(5);

    const second = withFilesystemLock(
      lockPath,
      async () => {
        events.push("second-start");
        events.push("second-end");
        return "second";
      },
      { retryDelayMs: 5, timeoutMs: 1_000 },
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(events).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  it("times out instead of waiting forever for a stale held lock", async () => {
    const root = await makeTempRoot();
    const lockPath = join(root, "repo.lock");

    await expect(
      withFilesystemLock(
        lockPath,
        async () =>
          withFilesystemLock(lockPath, async () => "never", {
            retryDelayMs: 5,
            timeoutMs: 25,
          }),
        { retryDelayMs: 5, timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/Timed out acquiring filesystem lock/);
  });

  it("reclaims a lock whose heartbeat is older than the stale threshold", async () => {
    const root = await makeTempRoot();
    const lockPath = join(root, "repo.lock");
    const staleTime = new Date(Date.now() - 60_000).toISOString();

    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        owner: "dead-worker",
        pid: 123,
        acquiredAt: staleTime,
        heartbeatAt: staleTime,
        token: "old-token",
      }),
    );

    await expect(
      withFilesystemLock(
        lockPath,
        async () => {
          const owner = JSON.parse(
            await readFile(join(lockPath, "owner.json"), "utf8"),
          );
          expect(owner.owner).toBe("replacement-worker");
          expect(owner.token).not.toBe("old-token");
          expect(Date.parse(owner.heartbeatAt)).toBeGreaterThan(
            Date.parse(staleTime),
          );
          return "ok";
        },
        {
          owner: "replacement-worker",
          retryDelayMs: 5,
          staleAfterMs: 10,
          timeoutMs: 100,
        },
      ),
    ).resolves.toBe("ok");
  });
});
