import type { OneShotDashboardRow } from "./types.js";

export interface OneShotRetryResult {
  oneshotRunId: number;
  stage: string;
  state: string;
  version: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  publishError?: string;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string" ? payload.error : fallback;
}

export async function retryOneShotRun(
  dashboardId: string,
): Promise<{
  row: OneShotDashboardRow;
  retry: OneShotRetryResult;
  publishError?: string;
}> {
  const response = await fetch(
    `/api/oneshot/runs/${encodeURIComponent(dashboardId)}/retry`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to retry OneShot run: ${response.status}`,
      ),
    );
  }
  return (await response.json()) as {
    row: OneShotDashboardRow;
    retry: OneShotRetryResult;
    publishError?: string;
  };
}
