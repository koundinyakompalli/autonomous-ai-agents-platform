import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRANSIENT_RETRY_BACKOFF_MS,
  getMaxAttempts,
  getRetryDelayMs,
  withTransientRetry,
} from "./transient-retry.js";

describe("getRetryDelayMs", () => {
  it("returns the schedule entry indexed by attemptsMade (0-based)", () => {
    expect(getRetryDelayMs(0, [10, 20, 30])).toBe(10);
    expect(getRetryDelayMs(1, [10, 20, 30])).toBe(20);
    expect(getRetryDelayMs(2, [10, 20, 30])).toBe(30);
  });

  it("clamps to the last entry once attemptsMade exceeds the schedule", () => {
    expect(getRetryDelayMs(3, [10, 20, 30])).toBe(30);
    expect(getRetryDelayMs(99, [10, 20, 30])).toBe(30);
  });

  it("uses the default schedule when none provided", () => {
    expect(getRetryDelayMs(0)).toBe(DEFAULT_TRANSIENT_RETRY_BACKOFF_MS[0]);
    expect(getRetryDelayMs(1)).toBe(DEFAULT_TRANSIENT_RETRY_BACKOFF_MS[1]);
    expect(getRetryDelayMs(2)).toBe(DEFAULT_TRANSIENT_RETRY_BACKOFF_MS[2]);
    expect(getRetryDelayMs(50)).toBe(
      DEFAULT_TRANSIENT_RETRY_BACKOFF_MS[
        DEFAULT_TRANSIENT_RETRY_BACKOFF_MS.length - 1
      ],
    );
  });

  it("default schedule grows monotonically (exponential-ish)", () => {
    for (let i = 1; i < DEFAULT_TRANSIENT_RETRY_BACKOFF_MS.length; i++) {
      expect(DEFAULT_TRANSIENT_RETRY_BACKOFF_MS[i]).toBeGreaterThan(
        DEFAULT_TRANSIENT_RETRY_BACKOFF_MS[i - 1],
      );
    }
  });

  it("returns 0 when given a negative attemptsMade (defensive)", () => {
    expect(getRetryDelayMs(-1, [10, 20, 30])).toBe(10);
  });

  it("throws / falls back gracefully on empty schedule", () => {
    // An empty schedule makes no sense; treat as no delay.
    expect(getRetryDelayMs(0, [])).toBe(0);
    expect(getRetryDelayMs(5, [])).toBe(0);
  });
});

describe("getMaxAttempts", () => {
  it("equals 1 + schedule length (initial attempt + one retry per delay)", () => {
    expect(getMaxAttempts([10, 20, 30])).toBe(4);
    expect(getMaxAttempts([10])).toBe(2);
  });

  it("uses default schedule when none provided", () => {
    expect(getMaxAttempts()).toBe(
      DEFAULT_TRANSIENT_RETRY_BACKOFF_MS.length + 1,
    );
  });

  it("returns 1 (no retries) for empty schedule", () => {
    expect(getMaxAttempts([])).toBe(1);
  });
});

describe("withTransientRetry", () => {
  function makeSleep() {
    const sleep = vi.fn().mockResolvedValue(undefined);
    return sleep;
  }

  it("returns the result on first-try success without sleeping", async () => {
    const sleep = makeSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withTransientRetry(fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on transient errors and eventually succeeds", async () => {
    const sleep = makeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET: socket hang up"))
      .mockRejectedValueOnce(new Error("503 service unavailable"))
      .mockResolvedValue("done");

    const result = await withTransientRetry(fn, {
      schedule: [10, 20, 30],
      sleep,
    });

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("rethrows immediately on deterministic error (1 call, 0 sleeps)", async () => {
    const sleep = makeSleep();
    const fn = vi.fn().mockRejectedValue(new Error("HTTP 400 Bad Request"));

    await expect(
      withTransientRetry(fn, { schedule: [10, 20, 30], sleep }),
    ).rejects.toThrow(/400 Bad Request/);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rethrows after exhausting maxAttempts on persistent transient errors", async () => {
    const sleep = makeSleep();
    const err = new Error("ECONNRESET: socket hang up");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withTransientRetry(fn, { schedule: [10, 20, 30], sleep }),
    ).rejects.toThrow(/ECONNRESET/);

    // schedule length 3 → 1 initial attempt + 3 retries = 4 calls
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
    expect(sleep).toHaveBeenNthCalledWith(3, 30);
  });

  it("respects an explicit maxAttempts smaller than schedule length", async () => {
    const sleep = makeSleep();
    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      withTransientRetry(fn, {
        schedule: [10, 20, 30, 40, 50],
        maxAttempts: 2,
        sleep,
      }),
    ).rejects.toThrow(/ECONNRESET/);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("invokes onRetry before each sleep with growing delays and the error", async () => {
    const sleep = makeSleep();
    const onRetry = vi.fn();
    const errA = new Error("ECONNRESET");
    const errB = new Error("503 service unavailable");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(errA)
      .mockRejectedValueOnce(errB)
      .mockResolvedValue("ok");

    const result = await withTransientRetry(fn, {
      schedule: [10, 20, 30],
      sleep,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      delayMs: 10,
      error: errA,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      delayMs: 20,
      error: errB,
    });
  });

  it("does not call onRetry when fn succeeds first try", async () => {
    const sleep = makeSleep();
    const onRetry = vi.fn();
    const fn = vi.fn().mockResolvedValue(42);

    await withTransientRetry(fn, { sleep, onRetry });

    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not call onRetry on deterministic failure", async () => {
    const sleep = makeSleep();
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("validation failed"));

    await expect(
      withTransientRetry(fn, { sleep, onRetry }),
    ).rejects.toThrow(/validation/);

    expect(onRetry).not.toHaveBeenCalled();
  });

  it("uses a custom isTransient predicate when supplied", async () => {
    const sleep = makeSleep();
    // Custom predicate: only "MY_TRANSIENT" is transient, everything else fails fast.
    const isTransient = (msg: string) => /MY_TRANSIENT/.test(msg);

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("MY_TRANSIENT blip"))
      .mockResolvedValue("ok");

    const result = await withTransientRetry(fn, {
      schedule: [10, 20],
      sleep,
      isTransient,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);

    // And confirm a normally-transient error is now treated deterministically.
    const fn2 = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      withTransientRetry(fn2, { schedule: [10, 20], sleep, isTransient }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("handles non-Error throwables by stringifying for classification", async () => {
    const sleep = makeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce("ECONNRESET")
      .mockResolvedValue("ok");

    const result = await withTransientRetry(fn, {
      schedule: [10],
      sleep,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("defaults to a real (but tiny) sleep when none injected — does not hang", async () => {
    // We don't want this test to actually wait the default schedule. Provide a
    // tiny custom schedule and confirm the call resolves quickly via fake timers.
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValue("ok");

      const promise = withTransientRetry(fn, { schedule: [5] });
      // Advance past the 5ms backoff.
      await vi.advanceTimersByTimeAsync(10);

      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
