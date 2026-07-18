import { useEffect, useState } from "react";
import type { OneShotRunTimelineResponse } from "../oneshot/types.js";

const TIMELINE_POLL_MS = 5_000;

export function useOneShotRunTimeline(
  dashboardId: string | null,
  shouldPoll: boolean,
) {
  const [data, setData] = useState<OneShotRunTimelineResponse | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(dashboardId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!dashboardId) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let timerId: number | undefined;
    const controller = new AbortController();
    const encodedDashboardId = encodeURIComponent(dashboardId);
    setData(null);
    setIsLoading(true);
    setError(null);

    async function fetchTimeline() {
      try {
        const response = await fetch(
          `/api/oneshot/runs/${encodedDashboardId}/timeline`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `Timeline request failed: ${response.status}`,
          );
        }
        const payload = (await response.json()) as OneShotRunTimelineResponse;
        if (!cancelled) {
          setData(payload);
          setError(null);
          setIsLoading(false);
        }
      } catch (fetchError) {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        ) {
          return;
        }
        if (!cancelled) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Timeline request failed",
          );
          setIsLoading(false);
        }
      } finally {
        if (!cancelled && shouldPoll) {
          timerId = window.setTimeout(fetchTimeline, TIMELINE_POLL_MS);
        }
      }
    }

    void fetchTimeline();

    return () => {
      cancelled = true;
      controller.abort();
      if (timerId) window.clearTimeout(timerId);
    };
  }, [dashboardId, shouldPoll]);

  return { data, isLoading, error };
}
