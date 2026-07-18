// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOneShotRuns } from "./useOneShotRuns.js";
import type {
  OneShotAnalyticsRange,
  OneShotRunsResponse,
} from "../oneshot/types.js";

function analyticsWindow(range: OneShotAnalyticsRange) {
  switch (range) {
    case "all":
      return {
        range,
        label: "All time",
        shortLabel: "All",
        bucketLabel: "9 equal all-time buckets",
        isAllTime: true,
      };
    case "30d":
      return {
        range,
        label: "Last 30d",
        shortLabel: "30d",
        bucketLabel: "30 x daily buckets",
        isAllTime: false,
      };
    case "7d":
      return {
        range,
        label: "Last 7d",
        shortLabel: "7d",
        bucketLabel: "28 x 6-hour buckets",
        isAllTime: false,
      };
    case "24h":
      return {
        range,
        label: "Last 24h",
        shortLabel: "24h",
        bucketLabel: "48 x 30-min buckets",
        isAllTime: false,
      };
  }
}

function buildRunsResponse(range: OneShotAnalyticsRange): OneShotRunsResponse {
  const window = analyticsWindow(range);
  return {
    runs: [],
    pagination: {
      limit: 100,
      offset: 0,
      hasMore: false,
      total: 0,
    },
    stats: {
      inProgress: 0,
      failed: 0,
      blocked: 0,
      deployReady: 0,
      byView: {
        running: 0,
        queued: 0,
        waiting: 0,
        history: 0,
      },
    },
    capabilities: {
      createRun: true,
      createRunMode: "mock",
      deployPreviewAvailable: false,
      deployPreview: false,
    },
    analytics: {
      overview24h: {
        runs24h: 0,
        completed: 0,
        failed: 0,
        running: 0,
        queued: 0,
        waiting: 0,
        passRate: 0,
        avgTimeToPrMs: 0,
        medianTimeToPrMs: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
        attemptFailures24h: 0,
        throughputBuckets: [],
      },
      agents: [],
      queue: {
        queued: 0,
        running: 0,
        waiting: 0,
        recentlyFinished: 0,
        workerCapacity: 0,
      },
      throughput: {
        window,
        buckets: [],
        totalRuns: range === "all" ? 77 : 0,
        trend: range === "all" ? null : { priorValue: 0, pctChange: 0 },
        p50TimeToPrMs: 0,
        p90TimeToPrMs: 0,
        stageCompletion: [],
      },
      costs: {
        window,
        totalUsd: range === "all" ? 11.59 : 0,
        totalTokens: range === "all" ? 9_540_000 : 0,
        costSource: range === "all" ? "mixed" : "estimated",
        trend: range === "all" ? null : { priorValue: 0, pctChange: 0 },
        byStage: [],
        byModel: [],
        topRuns: [],
      },
      failures: {
        window,
        totalFailures: range === "all" ? 75 : 0,
        clusters: [],
      },
    },
  };
}

function jsonResponse(range: OneShotAnalyticsRange, etag: string) {
  return new Response(JSON.stringify(buildRunsResponse(range)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: etag,
    },
  });
}

function requestRange(input: RequestInfo | URL): OneShotAnalyticsRange {
  const url = new URL(String(input), "http://localhost");
  return (url.searchParams.get("range") ?? "24h") as OneShotAnalyticsRange;
}

function requestIfNoneMatch(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    return headers.get("If-None-Match") ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "if-none-match")?.[1];
  }
  return (headers as Record<string, string>)["If-None-Match"];
}

const baseOptions = {
  limit: 100,
  offset: 0,
  search: "",
  state: "all",
  deployment: "all",
  view: "all",
  refreshToken: 0,
  snapshot: "dashboard" as const,
};

describe("useOneShotRuns", () => {
  beforeEach(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not reuse a stale all-time payload when switching back to 24h with a cached ETag", async () => {
    const requests: Array<{
      range: OneShotAnalyticsRange;
      ifNoneMatch: string | undefined;
    }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const range = requestRange(input);
        requests.push({ range, ifNoneMatch: requestIfNoneMatch(init) });

        if (requests.length === 1) return jsonResponse("24h", '"etag-24h"');
        if (requests.length === 2) return jsonResponse("all", '"etag-all"');
        if (requests.length === 3) return jsonResponse("24h", '"etag-24h-v2"');
        throw new Error(`Unexpected request #${requests.length}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ range }: { range: OneShotAnalyticsRange }) =>
        useOneShotRuns({ ...baseOptions, range }),
      { initialProps: { range: "24h" as OneShotAnalyticsRange } },
    );

    await waitFor(() => {
      expect(result.current.data?.analytics.throughput.window.range).toBe(
        "24h",
      );
    });

    rerender({ range: "all" });
    expect(result.current.data).toBeNull();
    await waitFor(() => {
      expect(result.current.data?.analytics.throughput.window.range).toBe(
        "all",
      );
    });

    rerender({ range: "24h" });
    expect(result.current.data).toBeNull();
    await waitFor(() => {
      expect(result.current.data?.analytics.throughput.window.range).toBe(
        "24h",
      );
    });

    expect(requests).toEqual([
      { range: "24h", ifNoneMatch: undefined },
      { range: "all", ifNoneMatch: undefined },
      { range: "24h", ifNoneMatch: undefined },
    ]);
  });

  it("preserves the current payload on a same-query 304 response", async () => {
    const requests: Array<{
      range: OneShotAnalyticsRange;
      ifNoneMatch: string | undefined;
    }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const range = requestRange(input);
        requests.push({ range, ifNoneMatch: requestIfNoneMatch(init) });

        if (requests.length === 1) return jsonResponse("24h", '"etag-24h"');
        if (requests.length === 2) return new Response(null, { status: 304 });
        throw new Error(`Unexpected request #${requests.length}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useOneShotRuns({ ...baseOptions, range: "24h" }),
    );

    await waitFor(() => {
      expect(result.current.data?.analytics.throughput.window.range).toBe(
        "24h",
      );
    });

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.data?.analytics.throughput.window.range).toBe("24h");
    expect(requests).toEqual([
      { range: "24h", ifNoneMatch: undefined },
      { range: "24h", ifNoneMatch: '"etag-24h"' },
    ]);
  });

  it("polls on a 15s interval", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return jsonResponse("24h", `"etag-${calls}"`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    try {
      const { result } = renderHook(() =>
        useOneShotRuns({ ...baseOptions, range: "24h" }),
      );

      // Flush the immediate initial poll() microtasks.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.data).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_999);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates lastCheckedAt but not lastChangedAt on a 304, and marks isStale on a post-load failure while keeping data", async () => {
    const responses = [
      () => jsonResponse("24h", '"etag-24h"'),
      () => new Response(null, { status: 304 }),
      () => {
        throw new Error("network blip");
      },
    ];
    let callIndex = 0;
    const fetchMock = vi.fn(async () => {
      const makeResponse = responses[callIndex];
      callIndex += 1;
      if (!makeResponse) throw new Error("unexpected extra request");
      return makeResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useOneShotRuns({ ...baseOptions, range: "24h" }),
    );

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });
    const firstChangedAt = result.current.lastChangedAt;
    const firstCheckedAt = result.current.lastCheckedAt;
    expect(firstChangedAt).not.toBeNull();
    expect(firstCheckedAt).not.toBeNull();
    expect(result.current.isStale).toBe(false);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.lastCheckedAt).not.toBe(firstCheckedAt);
    });
    expect(result.current.lastChangedAt).toBe(firstChangedAt);
    expect(result.current.isStale).toBe(false);
    expect(result.current.data).not.toBeNull();

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.isStale).toBe(true);
    });
    expect(result.current.data).not.toBeNull();
    expect(result.current.error).not.toBeNull();
  });

  it("triggers an immediate refresh when the tab becomes visible again", async () => {
    const fetchMock = vi.fn(async () => jsonResponse("24h", '"etag-24h"'));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useOneShotRuns({ ...baseOptions, range: "24h" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
