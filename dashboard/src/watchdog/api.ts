import type {
  WatchdogEvidenceArtifact,
  WatchdogClarification,
  WatchdogDarciHandoff,
  WatchdogDarciMappingDiagnostics,
  WatchdogFinding,
  WatchdogLogSource,
  WatchdogRunAttempt,
  WatchdogScope,
  WatchdogServerEvent,
  WatchdogSession,
} from "./types.js";

const API_ROOT = "/api/watchdog/v1";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Watchdog request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getWatchdogHealth() {
  return requestJson<{
    status: string;
    mode: string;
    targetAwsAccountId: string;
    dependencies: Record<string, { status: string; message?: string }>;
  }>("/health");
}

export function setWatchdogAwsCredentials(input: {
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken?: string;
  awsAccountId?: string;
}) {
  return requestJson<{
    status: string;
    aws: {
      source: string;
      account_id: string;
      arn?: string;
      has_session_token?: boolean;
    };
  }>("/settings/aws-credentials", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listWatchdogSessions() {
  return requestJson<{
    sessions: WatchdogSession[];
    pagination: { limit: number; offset: number; total: number };
  }>("/sessions");
}

export function getWatchdogSession(sessionId: string) {
  return requestJson<WatchdogSession>(`/sessions/${sessionId}`);
}

export function listWatchdogCatalogClients() {
  return requestJson<{ status: string; clients: string[] }>("/catalog/clients");
}

export function listWatchdogCatalogLogSources(clientCode: string, environment?: string) {
  const query = new URLSearchParams({ clientCode });
  if (environment) query.set("environment", environment);
  return requestJson<{ status: string; sources: WatchdogLogSource[] }>(`/catalog/log-sources?${query.toString()}`);
}

export function previewJira(jiraKey: string) {
  return requestJson<{
    ticket: { key: string; summary: string; status: string; synopsis?: string };
    suggestedScope: WatchdogScope;
    suggestions: Record<string, unknown>;
  }>("/jira/preview", {
    method: "POST",
    body: JSON.stringify({ jiraKey }),
  });
}

export function previewNaturalLanguage(prompt: string) {
  return requestJson<{
    prompt: string;
    interpretedIntent?: string;
    suggestedScope: WatchdogScope;
    suggestions: Record<string, unknown>;
    ambiguities: string[];
  }>("/intake/preview", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

export function createWatchdogSession(input: {
  mode: "jira" | "natural_language" | "manual";
  jiraKey?: string;
  naturalLanguagePrompt?: string;
  draftScope: WatchdogScope;
}) {
  return requestJson<WatchdogSession>("/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function approveWatchdogSession(sessionId: string, approvedScope: WatchdogScope) {
  return requestJson<WatchdogRunAttempt>(`/sessions/${sessionId}/approve`, {
    method: "POST",
    body: JSON.stringify({ approvedScope, idempotencyKey: crypto.randomUUID() }),
  });
}

export function runNextWatchdogAttempt(sessionId: string) {
  return requestJson<WatchdogRunAttempt>(`/sessions/${sessionId}/run-next`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function rerunWatchdogSession(sessionId: string, approvedScope?: WatchdogScope) {
  return requestJson<WatchdogRunAttempt>(`/sessions/${sessionId}/rerun`, {
    method: "POST",
    body: JSON.stringify({ approvedScope }),
  });
}

export function cancelWatchdogSession(sessionId: string) {
  return requestJson<WatchdogSession>(`/sessions/${sessionId}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listWatchdogFindings(sessionId: string) {
  return requestJson<{ findings: WatchdogFinding[] }>(`/sessions/${sessionId}/findings`);
}

export function listWatchdogDarciHandoffs(sessionId: string) {
  return requestJson<{ handoffs: WatchdogDarciHandoff[] }>(`/sessions/${sessionId}/darci-handoffs`);
}

export function getWatchdogDarciMapping(sessionId: string) {
  return requestJson<WatchdogDarciMappingDiagnostics>(`/sessions/${sessionId}/darci-mapping`);
}

export function createWatchdogDarciHandoff(sessionId: string, findingIds: string[]) {
  return requestJson<WatchdogDarciHandoff>(`/sessions/${sessionId}/darci-handoffs`, {
    method: "POST",
    body: JSON.stringify({ findingIds, idempotencyKey: crypto.randomUUID() }),
  });
}

export function createWatchdogDarciTask(sessionId: string, handoffId: string) {
  return requestJson<{
    handoffId: string;
    status: string;
    taskManagementId?: number;
    taskS3Bucket?: string;
    taskS3Key?: string;
  }>(`/sessions/${sessionId}/darci-handoffs/${handoffId}/create-task`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
  });
}

export function syncWatchdogDarciHandoff(sessionId: string, handoffId: string) {
  return requestJson<{
    handoffId: string;
    status: string;
    taskManagementId?: number;
    taskId?: number;
    resultS3Bucket?: string;
    resultS3Key?: string;
    errorMessage?: string;
    changed: boolean;
  }>(`/sessions/${sessionId}/darci-handoffs/${handoffId}/sync`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getWatchdogDarciResult(sessionId: string, handoffId: string) {
  return requestJson<{
    handoffId: string;
    sessionId: string;
    status: string;
    taskManagementId?: number;
    taskId?: number;
    resultS3Bucket: string;
    resultS3Key: string;
    contentType: "text/markdown";
    markdown: string;
  }>(`/sessions/${sessionId}/darci-handoffs/${handoffId}/result`);
}

export function listWatchdogEvidence(sessionId: string) {
  return requestJson<{ artifacts: WatchdogEvidenceArtifact[] }>(`/sessions/${sessionId}/evidence`);
}

export function getWatchdogEvidencePayload(sessionId: string, evidenceId: string) {
  return requestJson<{
    artifactId: string;
    sessionId: string;
    runAttemptId: string;
    contentType: "application/json";
    sha256?: string;
    byteCount?: number;
    payload: unknown;
  }>(`/sessions/${sessionId}/evidence/${evidenceId}/payload`);
}

export function listWatchdogClarifications(sessionId: string) {
  return requestJson<{ clarifications: WatchdogClarification[] }>(`/sessions/${sessionId}/clarifications`);
}

export function answerWatchdogClarification(sessionId: string, clarificationId: string, answer: unknown) {
  return requestJson<WatchdogRunAttempt>(`/sessions/${sessionId}/clarifications/${clarificationId}/answer`, {
    method: "POST",
    body: JSON.stringify({ answer, idempotencyKey: crypto.randomUUID() }),
  });
}

export function openWatchdogEvents(
  sessionId: string,
  onEvent: (event: WatchdogServerEvent) => void,
  options?: {
    lastEventSequence?: number;
    onOpen?: () => void;
    onError?: () => void;
  },
): EventSource {
  const query = options?.lastEventSequence ? `?last_event_id=${options.lastEventSequence}` : "";
  const source = new EventSource(`${API_ROOT}/sessions/${sessionId}/events${query}`);
  source.onopen = () => options?.onOpen?.();
  source.onerror = () => options?.onError?.();
  const eventTypes = [
    "session.created",
    "session.updated",
    "run.queued",
    "run.started",
    "run.progress",
    "evidence.created",
    "finding.created",
    "clarification.required",
    "clarification.answered",
    "darci_handoff.created",
    "darci_handoff.updated",
    "run.completed",
    "run.failed",
    "session.expired",
  ];
  eventTypes.forEach((type) => {
    source.addEventListener(type, (event) => {
      onEvent(JSON.parse((event as MessageEvent).data) as WatchdogServerEvent);
    });
  });
  return source;
}
