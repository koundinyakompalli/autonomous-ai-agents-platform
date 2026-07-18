import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OneShotAnalyticsRange,
  OneShotStatisticsResponse,
} from "../oneshot/types.js";

interface UseOneShotStatisticsOptions {
  range: OneShotAnalyticsRange;
  enabled: boolean;
  refreshToken: number;
}

export function useOneShotStatistics({
  range,
  enabled,
  refreshToken,
}: UseOneShotStatisticsOptions) {
  const [data, setData] = useState<OneShotStatisticsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ range });
    return params.toString();
  }, [range]);

  useEffect(() => {
    if (!enabled) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);

    async function load() {
      try {
        const response = await fetch(`/api/oneshot/statistics?${queryString}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Statistics request failed with status ${response.status}`);
        }
        setData((await response.json()) as OneShotStatisticsResponse);
      } catch (fetchError) {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        ) {
          return;
        }
        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Statistics request failed",
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [enabled, queryString, refreshToken]);

  return { data, isLoading, error };
}
