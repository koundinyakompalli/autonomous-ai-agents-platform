import type {
  OneShotCreateRunMode,
  OneShotDashboardRow,
  OneShotRunRequestSummary,
  OneShotRunRequestValidation,
} from "./types.js";

const MOCK_RUN_STATUS_NAME = "Local mock";

function normalizeCreateRunJiraKey(value: string): string {
  return value.trim().toUpperCase();
}

function buildMockRunTitle(jiraKey: string): string {
  return `Mock run for ${jiraKey}`;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string" ? payload.error : fallback;
}

export async function validateCreateRun(
  mode: OneShotCreateRunMode,
  jiraKey: string,
): Promise<OneShotRunRequestValidation> {
  const normalized = normalizeCreateRunJiraKey(jiraKey);
  if (mode === "mock") {
    return {
      jiraKey: normalized,
      title: buildMockRunTitle(normalized),
      statusName: MOCK_RUN_STATUS_NAME,
    };
  }

  const response = await fetch("/api/oneshot/run-requests/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jiraKey: normalized }),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Jira validation failed: ${response.status}`,
      ),
    );
  }

  return (await response.json()) as OneShotRunRequestValidation;
}

export type CreateRunResult =
  | {
      kind: "request";
      request: OneShotRunRequestSummary;
    }
  | {
      kind: "mock";
      row: OneShotDashboardRow;
    };

export async function submitCreateRun(
  mode: OneShotCreateRunMode,
  jiraKey: string,
): Promise<CreateRunResult> {
  const normalized = normalizeCreateRunJiraKey(jiraKey);

  if (mode === "mock") {
    const response = await fetch("/api/oneshot/mock-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jiraKey: normalized,
        title: buildMockRunTitle(normalized),
      }),
    });

    if (!response.ok) {
      throw new Error(
        await readErrorMessage(response, `Mock run failed: ${response.status}`),
      );
    }

    return {
      kind: "mock",
      row: (await response.json()) as OneShotDashboardRow,
    };
  }

  const response = await fetch("/api/oneshot/run-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jiraKey: normalized }),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Run request failed: ${response.status}`,
      ),
    );
  }

  return {
    kind: "request",
    request: (await response.json()) as OneShotRunRequestSummary,
  };
}
