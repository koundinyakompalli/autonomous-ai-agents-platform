import type {
  ComposeChatMessage,
  ComposeContextProjection,
  ComposeHandoffResult,
  ComposeReadiness,
  ComposeSessionExportBundle,
  ComposeSessionImportResult,
  ComposeRepositoryOption,
  ComposeSessionSummary,
  ComposeSessionWorkflowState,
  ComposeSourceDeletionSummary,
  ComposeSourcePreview,
  ComposeSourceSummary,
  ComposeTurnAccepted,
  ComposeUploadTarget,
} from "./composeTypes.js";

const BASE = "/api/spec-factory/compose";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.error?.message === "string"
          ? body.error.message
          : null;
    const message =
      body?.reason === "queue_full"
        ? "This session already has clarification turns in progress. Please wait for the current reply before sending more."
        : body?.reason === "durable_turn_required"
          ? "Durable turn workers are required for new messages right now. Please try again shortly."
          : apiError === "idempotency_key_reused"
            ? "This reply conflicted with an earlier retry and was not submitted. Please send it again."
            : (apiError ?? `Request failed with ${response.status}`);
    throw new Error(message);
  }
  return body as T;
}

function tokenHeaders(token?: string | null): Record<string, string> {
  return token ? { "x-compose-token": token } : {};
}

function idempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `client-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function turnHeaders(token?: string | null): Record<string, string> {
  return {
    ...tokenHeaders(token),
    "Idempotency-Key": idempotencyKey(),
  };
}

export function createSession(input: {
  name: string;
  userName?: string;
  password?: string;
}): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(`${BASE}/sessions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listSessions(): Promise<ComposeSessionSummary[]> {
  return requestJson<ComposeSessionSummary[]>(`${BASE}/sessions`);
}

export function listRepositories(): Promise<ComposeRepositoryOption[]> {
  return requestJson<ComposeRepositoryOption[]>(`${BASE}/repositories`);
}

export function getSession(
  sessionId: number,
  token?: string | null,
): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(`${BASE}/sessions/${sessionId}`, {
    headers: tokenHeaders(token),
  });
}

export function resumeSession(
  sessionId: number,
  password?: string,
): Promise<ComposeSessionSummary & { streamToken?: string }> {
  return requestJson<ComposeSessionSummary & { streamToken?: string }>(
    `${BASE}/sessions/${sessionId}/resume`,
    { method: "POST", body: JSON.stringify({ password }) },
  );
}

export function deleteSession(
  sessionId: number,
  password?: string,
): Promise<unknown> {
  return requestJson(`${BASE}/sessions/${sessionId}`, {
    method: "DELETE",
    body: JSON.stringify({ password }),
  });
}

export function exportSession(
  sessionId: number,
  password?: string,
): Promise<ComposeSessionExportBundle> {
  return requestJson<ComposeSessionExportBundle>(
    `${BASE}/sessions/${sessionId}/export`,
    { method: "POST", body: JSON.stringify({ password }) },
  );
}

export function importSession(
  bundle: unknown,
): Promise<ComposeSessionImportResult> {
  return requestJson<ComposeSessionImportResult>(`${BASE}/sessions/import`, {
    method: "POST",
    body: JSON.stringify({ bundle }),
  });
}

export function listSources(
  sessionId: number,
  token?: string | null,
): Promise<ComposeSourceSummary[]> {
  return requestJson<ComposeSourceSummary[]>(
    `${BASE}/sessions/${sessionId}/sources`,
    { headers: tokenHeaders(token) },
  );
}

export function listMessages(
  sessionId: number,
  token?: string | null,
): Promise<ComposeChatMessage[]> {
  return requestJson<ComposeChatMessage[]>(
    `${BASE}/sessions/${sessionId}/messages`,
    { headers: tokenHeaders(token) },
  );
}

export function getContextProjection(
  sessionId: number,
  token?: string | null,
): Promise<ComposeContextProjection | null> {
  return requestJson<ComposeContextProjection | null>(
    `${BASE}/sessions/${sessionId}/context`,
    { headers: tokenHeaders(token) },
  );
}

export function addNote(
  sessionId: number,
  content: string,
  token?: string | null,
): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(
    `${BASE}/sessions/${sessionId}/notes`,
    {
      method: "POST",
      headers: tokenHeaders(token),
      body: JSON.stringify({ content }),
    },
  );
}

export function addYoutube(
  sessionId: number,
  url: string,
  token?: string | null,
): Promise<unknown> {
  return requestJson(`${BASE}/sessions/${sessionId}/youtube`, {
    method: "POST",
    headers: tokenHeaders(token),
    body: JSON.stringify({ url }),
  });
}

export function addJira(
  sessionId: number,
  jiraKey: string,
  token?: string | null,
): Promise<unknown> {
  return requestJson(`${BASE}/sessions/${sessionId}/jira`, {
    method: "POST",
    headers: tokenHeaders(token),
    body: JSON.stringify({ jiraKey }),
  });
}

export function addConfluence(
  sessionId: number,
  url: string,
  token?: string | null,
): Promise<unknown> {
  return requestJson(`${BASE}/sessions/${sessionId}/confluence`, {
    method: "POST",
    headers: tokenHeaders(token),
    body: JSON.stringify({ url }),
  });
}

export function deleteSource(
  sessionId: number,
  sourceId: number,
  token?: string | null,
): Promise<ComposeSourceDeletionSummary> {
  return requestJson<ComposeSourceDeletionSummary>(
    `${BASE}/sessions/${sessionId}/sources/${sourceId}`,
    {
      method: "DELETE",
      headers: tokenHeaders(token),
    },
  );
}

export function listSourceDeletions(
  sessionId: number,
  token?: string | null,
): Promise<ComposeSourceDeletionSummary[]> {
  return requestJson<ComposeSourceDeletionSummary[]>(
    `${BASE}/sessions/${sessionId}/source-deletions`,
    { headers: tokenHeaders(token) },
  );
}

export function restoreSource(
  sessionId: number,
  sourceId: number,
  token?: string | null,
): Promise<ComposeSourceDeletionSummary> {
  return requestJson<ComposeSourceDeletionSummary>(
    `${BASE}/sessions/${sessionId}/sources/${sourceId}/restore`,
    {
      method: "POST",
      headers: tokenHeaders(token),
    },
  );
}

export function getSourcePreview(
  sessionId: number,
  sourceId: number,
  token?: string | null,
): Promise<ComposeSourcePreview> {
  return requestJson<ComposeSourcePreview>(
    `${BASE}/sessions/${sessionId}/sources/${sourceId}/preview`,
    { headers: tokenHeaders(token) },
  );
}

export function reconvert(
  sessionId: number,
  sourceId: number,
  token?: string | null,
): Promise<unknown> {
  return requestJson(
    `${BASE}/sessions/${sessionId}/sources/${sourceId}/reconvert`,
    { method: "POST", headers: tokenHeaders(token) },
  );
}

export function reconvertFailed(
  sessionId: number,
  token?: string | null,
): Promise<{ queued: number }> {
  return requestJson<{ queued: number }>(
    `${BASE}/sessions/${sessionId}/sources/reconvert-failed`,
    { method: "POST", headers: tokenHeaders(token) },
  );
}

export function analyze(
  sessionId: number,
  repositoryIds: number[] = [],
  reset = false,
  token?: string | null,
): Promise<ComposeTurnAccepted> {
  return requestJson<ComposeTurnAccepted>(
    `${BASE}/sessions/${sessionId}/analyze`,
    {
      method: "POST",
      headers: turnHeaders(token),
      body: JSON.stringify({ repositoryIds, reset }),
    },
  );
}

export function postMessage(
  sessionId: number,
  content: string,
  token?: string | null,
): Promise<ComposeTurnAccepted> {
  return requestJson<ComposeTurnAccepted>(
    `${BASE}/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: turnHeaders(token),
      body: JSON.stringify({ content }),
    },
  );
}

export function requestCodeResearch(
  sessionId: number,
  input: {
    question: string;
    parentSourceIds: number[];
    contextVersionUsed: number | null;
  },
  token?: string | null,
): Promise<{
  accepted: true;
  agentTaskId: number;
  capability: "code_research";
  status: "queued";
}> {
  return requestJson(`${BASE}/sessions/${sessionId}/research/code`, {
    method: "POST",
    headers: tokenHeaders(token),
    body: JSON.stringify(input),
  });
}

export function handoff(
  sessionId: number,
  token?: string | null,
  actionIdempotencyKey = idempotencyKey(),
): Promise<ComposeHandoffResult> {
  return requestJson(`${BASE}/sessions/${sessionId}/handoff`, {
    method: "POST",
    headers: {
      ...tokenHeaders(token),
      "Idempotency-Key": actionIdempotencyKey,
    },
  });
}

export function getWorkflowState(
  sessionId: number,
  token?: string | null,
): Promise<ComposeSessionWorkflowState> {
  return requestJson(`${BASE}/sessions/${sessionId}/workflow-state`, {
    headers: tokenHeaders(token),
  });
}

export function cancelTurn(
  sessionId: number,
  turnJobId: number,
  token?: string | null,
): Promise<{
  cancelled: boolean;
  turnJobId: number;
  cancelledAgentTaskIds: number[];
  status: string;
}> {
  return requestJson(
    `${BASE}/sessions/${sessionId}/turns/${turnJobId}/cancel`,
    {
      method: "POST",
      headers: tokenHeaders(token),
    },
  );
}

/** Presigned upload flow: request target -> PUT bytes to S3 -> confirm. Returns the sourceId. */
export async function uploadFile(
  sessionId: number,
  file: File,
  token?: string | null,
): Promise<number> {
  const target = await requestJson<ComposeUploadTarget>(
    `${BASE}/sessions/${sessionId}/uploads`,
    {
      method: "POST",
      headers: tokenHeaders(token),
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    },
  );

  const put = await fetch(target.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Upload failed with ${put.status}`);
  }

  await requestJson(
    `${BASE}/sessions/${sessionId}/sources/${target.sourceId}/uploaded`,
    { method: "POST", headers: tokenHeaders(token) },
  );
  return target.sourceId;
}
