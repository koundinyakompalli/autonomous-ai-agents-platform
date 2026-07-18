import type {
  SpecFactoryAttachmentRetryResult,
  SpecFactoryAttachmentSummary,
  SpecFactoryDraftDetail,
  SpecFactoryDraftBundle,
  SpecFactoryDraftRequestResult,
  SpecFactoryEventSummary,
  SpecFactoryOneShotSubmissionSummary,
  SpecFactoryRefreshResult,
  SpecFactorySourceSummary,
  SpecFactoryStatusSummary,
} from "./types.js";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.error?.message === "string"
          ? body.error.message
          : `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function normalizeSources(
  payload: SpecFactorySourceSummary[] | { sources: SpecFactorySourceSummary[] },
): SpecFactoryRefreshResult {
  return Array.isArray(payload) ? { sources: payload } : payload;
}

export async function fetchBoardSources(): Promise<SpecFactoryRefreshResult> {
  return normalizeSources(
    await requestJson<SpecFactorySourceSummary[] | SpecFactoryRefreshResult>(
      "/api/spec-factory/sources",
    ),
  );
}

export function fetchSource(
  sourceId: number,
): Promise<SpecFactorySourceSummary> {
  return requestJson<SpecFactorySourceSummary>(
    `/api/spec-factory/sources/${sourceId}`,
  );
}

export function refreshBoardSources(
  force = false,
): Promise<SpecFactoryRefreshResult> {
  return requestJson<SpecFactorySourceSummary[] | SpecFactoryRefreshResult>(
    "/api/spec-factory/sources/refresh",
    {
      method: "POST",
      body: JSON.stringify({ force }),
    },
  ).then(normalizeSources);
}

export const fetchLouiseCandidates = fetchBoardSources;
export const refreshLouiseCandidates = refreshBoardSources;

export function fetchStatus(): Promise<SpecFactoryStatusSummary> {
  return requestJson<SpecFactoryStatusSummary>("/api/spec-factory/status");
}

export function generateDraft(
  sourceId: number,
): Promise<SpecFactoryDraftRequestResult> {
  return requestJson<SpecFactoryDraftRequestResult>(
    `/api/spec-factory/sources/${sourceId}/drafts`,
    { method: "POST" },
  );
}

export function fetchLatestDraft(
  sourceId: number,
): Promise<SpecFactoryDraftDetail> {
  return requestJson<SpecFactoryDraftDetail>(
    `/api/spec-factory/sources/${sourceId}/drafts/latest`,
  );
}

export function fetchSourceEvents(
  sourceId: number,
): Promise<SpecFactoryEventSummary[]> {
  return requestJson<SpecFactoryEventSummary[]>(
    `/api/spec-factory/sources/${sourceId}/events`,
  );
}

export function fetchSourceAttachments(
  sourceId: number,
): Promise<SpecFactoryAttachmentSummary[]> {
  return requestJson<SpecFactoryAttachmentSummary[]>(
    `/api/spec-factory/sources/${sourceId}/attachments`,
  );
}

export function retrySourceAttachments(
  sourceId: number,
): Promise<SpecFactoryAttachmentRetryResult> {
  return requestJson<SpecFactoryAttachmentRetryResult>(
    `/api/spec-factory/sources/${sourceId}/attachments/retry`,
    { method: "POST" },
  );
}

export function approveDraft(
  sourceId: number,
  draftId: number,
): Promise<SpecFactoryDraftDetail> {
  return requestJson<SpecFactoryDraftDetail>(
    `/api/spec-factory/drafts/${draftId}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ sourceId }),
    },
  );
}

export function updateDraft(
  sourceId: number,
  draftId: number,
  draft: SpecFactoryDraftBundle,
): Promise<SpecFactoryDraftDetail> {
  return requestJson<SpecFactoryDraftDetail>(
    `/api/spec-factory/drafts/${draftId}`,
    {
      method: "PUT",
      body: JSON.stringify({ sourceId, draft }),
    },
  );
}

export function oneShotNow(sourceId: number): Promise<unknown> {
  return requestJson(`/api/spec-factory/sources/${sourceId}/oneshot`, {
    method: "POST",
  });
}

export function discardSource(
  sourceId: number,
): Promise<SpecFactorySourceSummary> {
  return requestJson<SpecFactorySourceSummary>(
    `/api/spec-factory/sources/${sourceId}/discard`,
    { method: "POST" },
  );
}

export function restoreSource(
  sourceId: number,
): Promise<SpecFactorySourceSummary> {
  return requestJson<SpecFactorySourceSummary>(
    `/api/spec-factory/sources/${sourceId}/restore`,
    { method: "POST" },
  );
}

export function fetchOneShotSubmissions(): Promise<
  SpecFactoryOneShotSubmissionSummary[]
> {
  return requestJson<SpecFactoryOneShotSubmissionSummary[]>(
    "/api/spec-factory/oneshot/submissions",
  );
}

export function fetchArchivedSources(): Promise<SpecFactorySourceSummary[]> {
  return requestJson<SpecFactorySourceSummary[]>(
    "/api/spec-factory/archive/sources",
  );
}
