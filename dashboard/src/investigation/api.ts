export type InvestigationStatus = "queued" | "waiting_for_target" | "running" | "awaiting_review" | "completed" | "escalated" | "failed";
export type InvestigationTab = "overview" | "lenses" | "timeline" | "findings" | "evidence" | "jira" | "audit" | "approvals";
export type AnalyzerStatus = "running" | "ready" | "waiting" | "complete" | "blocked";
export type InvestigationEnvironment = "DEV" | "INT" | "UAT" | "STAGE" | "PROD-REPLICA";
export type InvestigationMode = "aws-first" | "mixed" | "data-led";
export type InvestigationEvidenceAnalyzer = "llm" | "aws" | "code" | "data" | "host";

export interface InvestigationFinding {
  id: string;
  analyzer: InvestigationEvidenceAnalyzer;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  summary: string;
  confidence: number;
  requiresAction?: "code" | "data" | "ops";
}

export interface InvestigationEvidence {
  id: string;
  analyzer: InvestigationEvidenceAnalyzer;
  title: string;
  detail: string;
  meta: string[];
  trace?: Array<{
    title: string;
    detail: string;
    safeSql?: string;
    rowCount?: number;
  }>;
}

export interface InvestigationEvent {
  id: string;
  sequence: number;
  at: string;
  title: string;
  body: string;
  analyzer?: InvestigationEvidenceAnalyzer | "system";
}

export interface MeridianSqlArtifact {
  id: string;
  filename: string;
  contentType: "text/sql";
  sizeBytes: number;
  sha256: string;
  source: string;
  createdAt: string;
  updateCount?: number;
  skippedCount?: number;
  downloadPath: string;
}

export interface MeridianDbaTicket {
  status: "created";
  key: string;
  url: string;
  linkedTo: string;
  sqlArtifactId: string;
  sqlFilename: string;
  assignedOperatorDisplay: string;
  assigneeAccountId?: string;
  assignmentStatus: "assigned" | "unresolved" | "failed";
  linkStatus: "linked" | "failed";
  createdAt: string;
}

export interface InvestigationTicketCommentContext {
  id: string;
  created?: string;
  updated?: string;
  body: string;
}

export interface InvestigationTicketAttachmentContext {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  created?: string;
  extractionStatus: "metadata_only" | "text_extracted" | "skipped" | "failed";
  textExcerpt?: string;
  extractedTerms?: string[];
  sha256?: string;
  contentRef?: string;
}

export interface InvestigationTicketIdentifierContext {
  kind: "case_number" | "member_identifier";
  source: "description" | "comment" | "attachment";
  value: string;
  sensitive: true;
}

export interface InvestigationTicketContext {
  source: "jira";
  jiraKey: string;
  fetchStatus: "fetched" | "unavailable";
  title?: string;
  statusName?: string;
  createdAt?: string;
  updatedAt?: string;
  labels?: string[];
  releaseVersion?: string;
  description?: string;
  comments?: InvestigationTicketCommentContext[];
  attachments?: InvestigationTicketAttachmentContext[];
  identifiers?: InvestigationTicketIdentifierContext[];
  extractedTerms?: string[];
  failureReason?: string;
}

export interface InvestigationRun {
  id: string;
  jiraKey: string;
  title: string;
  client: string;
  environment: InvestigationEnvironment;
  status: InvestigationStatus;
  mode: InvestigationMode;
  confidence: number;
  accent: "cyan" | "amber" | "red" | "green";
  updatedAt: string;
  targetKey?: string;
  releaseVersion?: string;
  throttleReason?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  summary: string;
  recommendation: string;
  analyzers: Array<{
    key: InvestigationEvidenceAnalyzer;
    label: string;
    status: AnalyzerStatus;
    pulse: string;
    detail: string;
  }>;
  findings: InvestigationFinding[];
  evidence: InvestigationEvidence[];
  events: InvestigationEvent[];
  approvalText?: string;
  jiraDraft: {
    clientSummary: string;
    internalAnalysis: string;
    proposedRemediation: {
      sqlCorrection?: string;
      codeFix?: string;
      validationNotes: string;
    };
  };
  audit: string[];
  ticketContext?: InvestigationTicketContext;
  meridianSqlArtifacts?: MeridianSqlArtifact[];
  dbaTicket?: MeridianDbaTicket;
  resolution?: {
    diagnosisReady: boolean;
    operationallyClosed: boolean;
    missingDiagnosisDimensions: string[];
    unexplainedSymptomClusterIds: string[];
    ambiguousSymptomClusterIds?: string[];
    selectedHypothesisIds: string[];
  };
}

export interface InvestigationHealth {
  status: string;
  mode: string;
  scopePolicy: string;
  adapters: Record<string, { status: string; detail: string }>;
  queue?: {
    queueDepth: number;
    activeWorkers: number;
    workerConcurrency: number;
    throttleStore: string;
    outstandingRuns?: number;
    outstandingCapacity?: number;
  };
}

const API_ROOT = "/api/investigation";

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
    throw new Error(body?.error || `Investigation request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getInvestigationHealth() {
  return requestJson<InvestigationHealth>("/health");
}

export function listInvestigationRuns() {
  return requestJson<{ runs: InvestigationRun[] }>("/runs");
}

export function getInvestigationRun(runId: string) {
  return requestJson<InvestigationRun>(`/runs/${encodeURIComponent(runId)}`);
}

export function createInvestigationRun(input?: {
  jiraKey?: string;
  title?: string;
  client?: string;
  environment?: InvestigationEnvironment;
  mode?: InvestigationMode;
  operatorSshPassword?: string;
  investigationHint?: string;
}) {
  return requestJson<InvestigationRun>("/runs", {
    method: "POST",
    body: JSON.stringify(input || {}),
  });
}

export function createInvestigationRuns(input: {
  tickets: Array<{
    jiraKey?: string;
    title?: string;
    client?: string;
    environment?: InvestigationEnvironment;
    mode?: InvestigationMode;
  }>;
}) {
  return requestJson<{ runs: InvestigationRun[] }>("/runs/batch", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function approveInvestigationRecommendation(runId: string) {
  return requestJson<InvestigationRun>(`/runs/${encodeURIComponent(runId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function escalateInvestigationRun(runId: string) {
  return requestJson<InvestigationRun>(`/runs/${encodeURIComponent(runId)}/escalate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function postInvestigationSummary(runId: string) {
  return requestJson<InvestigationRun>(`/runs/${encodeURIComponent(runId)}/jira/post-summary`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function createMeridianDbaTicket(runId: string, artifactId?: string) {
  return requestJson<InvestigationRun>(`/runs/${encodeURIComponent(runId)}/meridian/dba-ticket`, {
    method: "POST",
    body: JSON.stringify({ artifactId }),
  });
}

export function subscribeInvestigationEvents(
  runId: string,
  handlers: {
    onEvent: (event: InvestigationEvent) => void;
    onError?: () => void;
  },
) {
  const EventSourceCtor = globalThis.EventSource;
  if (!EventSourceCtor) {
    handlers.onError?.();
    return () => undefined;
  }

  const stream = new EventSourceCtor(`${API_ROOT}/runs/${encodeURIComponent(runId)}/events/stream`);

  stream.addEventListener("run.progress", (message) => {
    const payload = JSON.parse((message as MessageEvent<string>).data) as InvestigationEvent | { error?: string };
    if ("error" in payload) {
      handlers.onError?.();
      return;
    }
    handlers.onEvent(payload as InvestigationEvent);
  });

  stream.onerror = () => {
    handlers.onError?.();
  };

  return () => {
    stream.close();
  };
}
