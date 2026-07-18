import type { OneShotDashboardRow, OneShotTicketType } from "./types.js";

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string" ? payload.error : fallback;
}

export async function updateOneShotTicketType(
  dashboardId: string,
  ticketType: OneShotTicketType,
): Promise<OneShotDashboardRow> {
  const response = await fetch(
    `/api/oneshot/runs/${encodeURIComponent(dashboardId)}/ticket-type`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketType }),
    },
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Ticket type update failed: ${response.status}`,
      ),
    );
  }

  const payload = (await response.json()) as { row?: OneShotDashboardRow };
  if (!payload.row) {
    throw new Error("Ticket type update did not return an updated row.");
  }
  return payload.row;
}
