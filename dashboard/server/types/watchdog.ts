export type WatchdogMode = "jira" | "natural_language" | "manual";

export type WatchdogSessionStatus =
  | "draft"
  | "queued"
  | "running"
  | "awaiting_user_input"
  | "completed"
  | "failed"
  | "expired";

export type WatchdogRunStatus =
  | "queued"
  | "running"
  | "awaiting_user_input"
  | "completed"
  | "failed"
  | "expired";

export type WatchdogRunTrigger =
  | "initial"
  | "approval"
  | "clarification_resume"
  | "user_rerun"
  | "expiry_rerun";

export interface WatchdogOperatorIdentity {
  id: string;
  display: string;
  authSource: "alb_oidc" | "local_dev";
}

export interface WatchdogTimeWindow {
  startTs: string;
  endTs: string;
  sourceHint?: string;
}

export interface WatchdogInvestigationScope {
  clientId: string;
  environment: string;
  serviceIds: string[];
  timeWindow: WatchdogTimeWindow;
  includeKeywords: string[];
  excludeKeywords: string[];
  advancedFilters?: Record<string, unknown>;
}

export interface WatchdogRunAttempt {
  id: string;
  sessionId: string;
  attemptNumber: number;
  trigger: WatchdogRunTrigger;
  status: WatchdogRunStatus;
  correlationId: string;
  approvedScope?: WatchdogInvestigationScope;
  providerKey?: string;
  modelId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WatchdogSession {
  id: string;
  title: string;
  mode: WatchdogMode;
  status: WatchdogSessionStatus;
  owner: { id: string; display: string };
  authSource: "alb_oidc" | "local_dev";
  jiraKey?: string;
  naturalLanguagePrompt?: string;
  draftScope?: WatchdogInvestigationScope;
  approvedScope?: WatchdogInvestigationScope;
  latestRunAttempt?: WatchdogRunAttempt;
  createdAt: string;
  updatedAt: string;
}

export interface WatchdogServerEvent {
  id: string;
  sessionId: string;
  runAttemptId?: string;
  correlationId: string;
  eventType: string;
  sequence: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface CreateWatchdogSessionInput {
  mode: WatchdogMode;
  jiraKey?: string;
  naturalLanguagePrompt?: string;
  draftScope?: WatchdogInvestigationScope;
  idempotencyKey?: string;
  operator: WatchdogOperatorIdentity;
}

export interface WatchdogFinding {
  id: string;
  sessionId: string;
  runAttemptId: string;
  kind: "finding" | "no_evidence" | "limitation";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  summary: string;
  details?: Record<string, unknown>;
  confidence?: number;
  evidenceIds: string[];
  createdAt: string;
}
