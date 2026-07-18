import type { OneShotDashboardRow } from "./types.js";

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string" ? payload.error : fallback;
}

export async function requestOneShotCiRefresh(
  dashboardId: string,
): Promise<{
  row: OneShotDashboardRow;
  refresh: { requested: boolean; mode: string };
}> {
  const response = await fetch(
    `/api/oneshot/runs/${encodeURIComponent(dashboardId)}/refresh-ci`,
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
        `Failed to request CI refresh: ${response.status}`,
      ),
    );
  }
  return (await response.json()) as {
    row: OneShotDashboardRow;
    refresh: { requested: boolean; mode: string };
  };
}
