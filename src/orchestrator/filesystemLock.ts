import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FilesystemLockOptions {
  heartbeatIntervalMs?: number;
  retryDelayMs?: number;
  staleAfterMs?: number;
  timeoutMs?: number;
  owner?: string;
}

interface FilesystemLockOwner {
  owner: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
  token: string;
}

interface AcquiredFilesystemLock {
  token: string;
  stopHeartbeat: () => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockOwner(
  lockPath: string,
): Promise<FilesystemLockOwner | null> {
  try {
    const raw = await readFile(join(lockPath, "owner.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.owner !== "string" ||
      typeof parsed?.token !== "string"
    ) {
      return null;
    }
    return {
      owner: parsed.owner,
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
      heartbeatAt:
        typeof parsed.heartbeatAt === "string"
          ? parsed.heartbeatAt
          : typeof parsed.acquiredAt === "string"
            ? parsed.acquiredAt
            : "",
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

async function getLockLastSeenMs(
  lockPath: string,
  owner: FilesystemLockOwner | null,
): Promise<number> {
  const ownerTime = Date.parse(owner?.heartbeatAt || owner?.acquiredAt || "");
  if (Number.isFinite(ownerTime)) {
    return ownerTime;
  }

  try {
    return (await stat(lockPath)).mtimeMs;
  } catch {
    return Date.now();
  }
}

async function writeLockOwner(
  lockPath: string,
  owner: FilesystemLockOwner,
): Promise<void> {
  await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner, null, 2));
}

function startLockHeartbeat(
  lockPath: string,
  owner: FilesystemLockOwner,
  heartbeatIntervalMs: number,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) {
        return;
      }
      const current = await readLockOwner(lockPath);
      if (current?.token !== owner.token) {
        return;
      }
      await writeLockOwner(lockPath, {
        ...owner,
        heartbeatAt: new Date().toISOString(),
      });
    })().catch(() => {
      // Best-effort heartbeat. Acquisition timeout/stale recovery handles
      // missing heartbeats if the process dies or EFS briefly rejects writes.
    });
  }, heartbeatIntervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function tryReclaimStaleLock(
  lockPath: string,
  options: Required<FilesystemLockOptions>,
): Promise<boolean> {
  if (options.staleAfterMs <= 0) {
    return false;
  }

  const owner = await readLockOwner(lockPath);
  const lastSeenMs = await getLockLastSeenMs(lockPath, owner);
  if (Date.now() - lastSeenMs < options.staleAfterMs) {
    return false;
  }

  await rm(lockPath, { recursive: true, force: true });
  return true;
}

async function acquireFilesystemLock(
  lockPath: string,
  options: Required<FilesystemLockOptions>,
): Promise<AcquiredFilesystemLock> {
  const deadline = Date.now() + options.timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      const now = new Date().toISOString();
      const owner = {
        owner: options.owner,
        pid: process.pid,
        acquiredAt: now,
        heartbeatAt: now,
        token: randomUUID(),
      };
      await writeLockOwner(lockPath, owner);
      return {
        token: owner.token,
        stopHeartbeat: startLockHeartbeat(
          lockPath,
          owner,
          options.heartbeatIntervalMs,
        ),
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await tryReclaimStaleLock(lockPath, options)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring filesystem lock ${lockPath} after ${options.timeoutMs}ms`,
        );
      }
      await delay(options.retryDelayMs);
    }
  }
}

async function releaseFilesystemLock(
  lockPath: string,
  lock: AcquiredFilesystemLock,
): Promise<void> {
  lock.stopHeartbeat();
  const owner = await readLockOwner(lockPath);
  if (owner?.token === lock.token) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function withFilesystemLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FilesystemLockOptions = {},
): Promise<T> {
  const resolvedOptions: Required<FilesystemLockOptions> = {
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    retryDelayMs: options.retryDelayMs ?? 1_000,
    staleAfterMs: options.staleAfterMs ?? 0,
    timeoutMs: options.timeoutMs ?? 10 * 60 * 1_000,
    owner: options.owner ?? "specter-worker",
  };

  const lock = await acquireFilesystemLock(lockPath, resolvedOptions);
  try {
    return await work();
  } finally {
    await releaseFilesystemLock(lockPath, lock);
  }
}
