import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OneShotAnalyticsRange,
  OneShotRunsResponse,
} from "../oneshot/types.js";

interface UseOneShotRunsOptions {
  limit: number;
  offset: number;
  search: string;
  state: string;
  deployment: string;
  ticketType: string;
  view: string;
  range: OneShotAnalyticsRange;
  refreshToken: number;
  snapshot?: "dashboard";
}

const POLL_MS_SINGLE = 15_000;
const BACKOFF_CAP_MS = 30_000;

interface CachedRunsPayload {
  queryString: string;
  payload: OneShotRunsResponse;
}

function buildQueryString(
  options: Omit<UseOneShotRunsOptions, "refreshToken">,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit));
  params.set("offset", String(options.offset));

  if (options.search.trim()) {
    params.set("search", options.search.trim());
  }

  if (options.state && options.state !== "all") {
    params.set("state", options.state);
  }

  if (options.deployment && options.deployment !== "all") {
    params.set("deployment", options.deployment);
  }

  if (options.ticketType && options.ticketType !== "all") {
    params.set("ticketType", options.ticketType);
  }

  if (options.view && options.view !== "all") {
    params.set("view", options.view);
  }

  params.set("range", options.range);

  if (options.snapshot === "dashboard") {
    params.set("snapshot", options.snapshot);
  }

  return params.toString();
}

export function useOneShotRuns(options: UseOneShotRunsOptions) {
  const [cachedPayload, setCachedPayload] =
    useState<CachedRunsPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revalidationToken, setRevalidationToken] = useState(0);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [lastChangedAt, setLastChangedAt] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);

  const etagCacheRef = useRef<Map<string, string>>(new Map());
  const cachedPayloadRef = useRef<CachedRunsPayload | null>(null);
  const consecutiveErrorsRef = useRef(0);

  const currentQueryString = buildQueryString({
    limit: options.limit,
    offset: options.offset,
    search: options.search,
    state: options.state,
    deployment: options.deployment,
    ticketType: options.ticketType,
    view: options.view,
    range: options.range,
    snapshot: options.snapshot,
  });
  const data =
    cachedPayload?.queryString === currentQueryString
      ? cachedPayload.payload
      : null;
  const hasStalePayload =
    cachedPayload !== null && cachedPayload.queryString !== currentQueryString;
  const isInitialLoading = (isLoading || hasStalePayload) && data === null;
  const isRefreshing = isLoading && data !== null;

  cachedPayloadRef.current = cachedPayload;

  const retry = useCallback(() => {
    consecutiveErrorsRef.current = 0;
    setError(null);
    setIsStale(false);
    setIsLoading(true);
    setRevalidationToken((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let timerId: number | undefined;

    async function fetchSinglePage(
      queryOptions: Omit<UseOneShotRunsOptions, "refreshToken">,
    ): Promise<{
      queryString: string;
      payload: OneShotRunsResponse | null;
      unchanged: boolean;
    }> {
      const queryString = buildQueryString(queryOptions);
      const headers: Record<string, string> = {};

      const cachedEtag = etagCacheRef.current.get(queryString);
      if (
        cachedEtag &&
        cachedPayloadRef.current?.queryString === queryString
      ) {
        headers["If-None-Match"] = cachedEtag;
      }

      const response = await fetch(`/api/oneshot/runs?${queryString}`, {
        cache: "no-store",
        headers,
      });

      if (response.status === 304) {
        return { queryString, payload: null, unchanged: true };
      }

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const newEtag = response.headers.get("ETag");
      if (newEtag) {
        etagCacheRef.current.set(queryString, newEtag);
      }

      return {
        queryString,
        payload: (await response.json()) as OneShotRunsResponse,
        unchanged: false,
      };
    }

    function scheduleNext() {
      if (cancelled) return;

      const baseMs = POLL_MS_SINGLE;
      const errors = consecutiveErrorsRef.current;
      const delay =
        errors > 0
          ? Math.min(baseMs * Math.pow(2, errors), BACKOFF_CAP_MS)
          : baseMs;

      timerId = window.setTimeout(() => {
        void poll();
      }, delay);
    }

    async function poll() {
      if (polling || cancelled) return;
      if (document.hidden) {
        scheduleNext();
        return;
      }
      polling = true;

      try {
        const { queryString, payload, unchanged } = await fetchSinglePage({
          limit: options.limit,
          offset: options.offset,
          search: options.search,
          state: options.state,
          deployment: options.deployment,
          ticketType: options.ticketType,
          view: options.view,
          range: options.range,
          snapshot: options.snapshot,
        });
        if (!cancelled) {
          if (!unchanged && payload) {
            const nextPayload = { queryString, payload };
            cachedPayloadRef.current = nextPayload;
            setCachedPayload(nextPayload);
            setLastChangedAt(Date.now());
          }
          setLastCheckedAt(Date.now());
          setIsStale(false);
          setError(null);
          setIsLoading(false);
          setRevalidationToken((t) => t + 1);
          consecutiveErrorsRef.current = 0;
        }
      } catch (err) {
        if (!cancelled) {
          consecutiveErrorsRef.current += 1;
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
          if (cachedPayloadRef.current !== null) {
            setIsStale(true);
          }
        }
      } finally {
        polling = false;
        scheduleNext();
      }
    }

    void poll();

    const onVisibilityChange = () => {
      if (!document.hidden) {
        if (timerId != null) window.clearTimeout(timerId);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (timerId != null) window.clearTimeout(timerId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    options.deployment,
    options.limit,
    options.offset,
    options.range,
    options.refreshToken,
    options.search,
    options.snapshot,
    options.state,
    options.ticketType,
    options.view,
  ]);

  return {
    data,
    isLoading,
    isInitialLoading,
    isRefreshing,
    error,
    revalidationToken,
    retry,
    lastCheckedAt,
    lastChangedAt,
    isStale,
  };
}
