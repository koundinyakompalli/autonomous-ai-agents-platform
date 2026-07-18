import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  answerWatchdogClarification,
  approveWatchdogSession,
  cancelWatchdogSession,
  createWatchdogSession,
  createWatchdogDarciHandoff,
  createWatchdogDarciTask,
  getWatchdogDarciResult,
  getWatchdogDarciMapping,
  getWatchdogEvidencePayload,
  getWatchdogHealth,
  getWatchdogSession,
  listWatchdogCatalogClients,
  listWatchdogCatalogLogSources,
  listWatchdogClarifications,
  listWatchdogDarciHandoffs,
  listWatchdogEvidence,
  listWatchdogFindings,
  listWatchdogSessions,
  openWatchdogEvents,
  previewJira,
  previewNaturalLanguage,
  rerunWatchdogSession,
  runNextWatchdogAttempt,
  setWatchdogAwsCredentials,
  syncWatchdogDarciHandoff,
} from "../watchdog/api.js";
import type {
  WatchdogClarification,
  WatchdogEvidenceArtifact,
  WatchdogDarciHandoff,
  WatchdogDarciMappingDiagnostics,
  WatchdogFinding,
  WatchdogLogSource,
  WatchdogScope,
  WatchdogServerEvent,
  WatchdogSession,
} from "../watchdog/types.js";
import "../watchdog/watchdog.css";

type WatchdogMode = "jira" | "natural_language" | "manual";
type NavView = "task" | "history" | "catalog";
type TaskTab = "investigation" | "findings" | "evidence" | "darci";
type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "watchdog.theme";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage unavailable
  }
  return "light";
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const SEVERITY_GLYPH: Record<string, string> = {
  critical: "▲",
  high: "◆",
  medium: "◇",
  low: "∘",
  info: "·",
};

const KIND_GLYPH: Record<string, string> = {
  finding: "◉",
  no_evidence: "∅",
  limitation: "⌀",
};

const PIPE_STAGES: ReadonlyArray<{ key: WatchdogDarciHandoff["status"] | "queued"; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "task_created", label: "Task" },
  { key: "running", label: "Running" },
  { key: "delivering", label: "Delivering" },
  { key: "delivered", label: "Delivered" },
];

const PIPE_ORDER: Record<WatchdogDarciHandoff["status"], number> = {
  queued: 0,
  task_created: 1,
  running: 2,
  delivering: 3,
  delivered: 4,
  failed: -1,
  cancelled: -1,
};

const RUN_PHASE_ORDER = ["scope_resolution", "evidence_collection", "analysis", "finalization"] as const;
const RUN_PHASE_LABEL: Record<string, string> = {
  scope_resolution: "Scope",
  evidence_collection: "Evidence",
  analysis: "Analysis",
  finalization: "Sealing",
};

const QUICK_TIME_WINDOWS = [
  { value: "today", label: "Today", hours: null },
  { value: "last_1_hour", label: "Last 1 hour", hours: 1 },
  { value: "last_3_hours", label: "Last 3 hours", hours: 3 },
  { value: "last_6_hours", label: "Last 6 hours", hours: 6 },
  { value: "last_12_hours", label: "Last 12 hours", hours: 12 },
  { value: "last_24_hours", label: "Last 24 hours", hours: 24 },
] as const;

const defaultScope = (): WatchdogScope => {
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 60 * 60 * 1000);
  return {
    clientId: "",
    environment: "PROD",
    serviceIds: ["core"],
    timeWindow: {
      startTs: start.toISOString(),
      endTs: end.toISOString(),
      sourceHint: "last 3 hours",
    },
    includeKeywords: ["error"],
    excludeKeywords: [],
  };
};

function uniqueValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))).sort();
}

function sourceEnvironment(source: WatchdogLogSource): string | undefined {
  return source.environment?.trim();
}

function sourceService(source: WatchdogLogSource): string | undefined {
  return source.component || source.log_type || source.logType;
}

function currentServicesMatch(current: string[], options: string[]): boolean {
  return current.length > 0 && current.every((service) =>
    options.some((option) => option.toLowerCase() === service.toLowerCase()),
  );
}

function isoToDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function dateTimeLocalToIso(value: string): string {
  if (!value) return "";
  return `${value.length === 16 ? `${value}:00` : value}.000Z`;
}

function quickTimeWindow(value: string) {
  const end = new Date();
  if (value === "today") {
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 0, 0, 0, 0));
    return { startTs: start.toISOString(), endTs: end.toISOString(), sourceHint: "today" };
  }
  const option = QUICK_TIME_WINDOWS.find((item) => item.value === value);
  const hours = option?.hours ?? 3;
  return {
    startTs: new Date(end.getTime() - hours * 60 * 60 * 1000).toISOString(),
    endTs: end.toISOString(),
    sourceHint: option?.label.toLowerCase() || `last ${hours} hours`,
  };
}

function evidenceSourceRef(artifact: WatchdogEvidenceArtifact) {
  return artifact.sourceRef || {};
}

function evidenceSummaryCounts(artifact: WatchdogEvidenceArtifact) {
  return evidenceSourceRef(artifact).summaryCounts || {};
}

function formatNumber(value: unknown) {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue.toLocaleString() : "0";
}

function formatClockTime(iso: string | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatRelative(iso: string | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const deltaMs = Date.now() - date.getTime();
  if (deltaMs < 45_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
  const days = Math.round(deltaMs / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatScopeTimestamp(iso: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatLocalTimestamp(iso: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function formatWindowDuration(startIso: string, endIso: string) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "Invalid window";
  const minutes = Math.round((end - start) / 60_000);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function keywordCandidatesFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const candidates: Array<[string, string[]]> = [
    ["error", ["error", "exception", "failed", "failure"]],
    ["auth", ["auth", "login", "token", "unauthorized", "forbidden", "401", "403"]],
    ["timeout", ["timeout", "timed out", "latency", "slow"]],
    ["5xx", ["500", "502", "503", "504", "5xx"]],
    ["denied", ["denied", "accessdenied", "permission"]],
    ["connection", ["connection", "connect", "socket", "reset"]],
    ["startup", ["startup", "start up", "boot", "restart"]],
  ];
  return candidates
    .filter(([, needles]) => needles.some((needle) => lower.includes(needle)))
    .map(([keyword]) => keyword);
}

function evidenceIdsForFinding(finding: WatchdogFinding): string[] {
  return finding.evidenceIds || finding.evidence_ids || [];
}

function severityClass(finding: WatchdogFinding): string {
  if (finding.kind === "limitation") return "kind-limitation";
  if (finding.kind === "no_evidence") return "kind-no_evidence";
  return `sev-${finding.severity || "info"}`;
}

function tickerFamily(eventType: string): string {
  if (eventType.startsWith("run.failed") || eventType.endsWith(".failed")) return "is-failed";
  if (eventType.startsWith("run.")) return "is-run";
  if (eventType.startsWith("finding.")) return "is-finding";
  if (eventType.startsWith("evidence.")) return "is-evidence";
  if (eventType.startsWith("darci_handoff.")) return "is-darci";
  return "";
}

function eventCaption(event: WatchdogServerEvent): string {
  if (typeof event.payload.message === "string") return event.payload.message;
  if (typeof event.payload.reason === "string") return event.payload.reason;
  if (typeof event.payload.code === "string") return event.payload.code;
  if (typeof event.payload.phase === "string") {
    return RUN_PHASE_LABEL[event.payload.phase] || event.payload.phase;
  }
  if (typeof event.payload.status === "string") return event.payload.status;
  if (typeof event.payload.findingId === "string") return `finding ${event.payload.findingId.slice(0, 10)}`;
  if (typeof event.payload.evidenceId === "string") return `evidence ${event.payload.evidenceId.slice(0, 10)}`;
  return event.eventType.replace(".", " ");
}

function clarificationChoiceLabel(choice: unknown): string {
  if (typeof choice === "string") return choice;
  if (choice && typeof choice === "object") {
    const record = choice as Record<string, unknown>;
    const label = record.label || record.name || record.client_code || record.value || record.id;
    if (typeof label === "string") return label;
  }
  return JSON.stringify(choice);
}

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${part}-${idx}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${part}-${idx}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`${part}-${idx}`}>{part}</span>;
  });
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  const nodes: ReactElement[] = [];
  let listItems: string[] = [];

  function flushList() {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    nodes.push(
      <ul key={`list-${nodes.length}`}>
        {items.map((item, idx) => (
          <li key={`${item}-${idx}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
  }

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") {
      flushList();
      return;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      if (level === 1) nodes.push(<h1 key={`h-${idx}`}>{content}</h1>);
      else if (level === 2) nodes.push(<h2 key={`h-${idx}`}>{content}</h2>);
      else nodes.push(<h3 key={`h-${idx}`}>{content}</h3>);
      return;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }
    flushList();
    nodes.push(<p key={`p-${idx}`}>{renderInlineMarkdown(trimmed)}</p>);
  });
  flushList();

  return <div className="wd-darci-result wd-markdown-preview">{nodes}</div>;
}

function sortFindings(findings: WatchdogFinding[]) {
  return [...findings].sort((a, b) => {
    const rankA = SEVERITY_RANK[a.severity] || 0;
    const rankB = SEVERITY_RANK[b.severity] || 0;
    if (rankA !== rankB) return rankB - rankA;
    return (a.title || "").localeCompare(b.title || "");
  });
}

function taskQuestionForSession(session: WatchdogSession | null): string {
  if (!session) return "the selected investigation";
  if (session.naturalLanguagePrompt?.trim()) return session.naturalLanguagePrompt.trim();
  if (session.jiraKey?.trim()) return `Jira ticket ${session.jiraKey.trim()}`;
  return session.title || "the selected investigation";
}

function buildAiSummary(session: WatchdogSession | null, findings: WatchdogFinding[]) {
  if (findings.length === 0) return null;
  const question = taskQuestionForSession(session);
  const topFinding = findings[0];
  const materialFindings = findings.filter((finding) => finding.kind === "finding");
  const limitations = findings.filter((finding) => finding.kind === "limitation");
  const noEvidence = findings.find((finding) => finding.kind === "no_evidence");

  if (noEvidence && materialFindings.length === 0) {
    return {
      tone: "info",
      answer: `Watchdog did not find evidence for: ${question}`,
      summary: noEvidence.summary,
      meta: `${findings.length} AI finding${findings.length === 1 ? "" : "s"} reviewed`,
    };
  }

  return {
    tone: topFinding.severity,
    answer: `Answer to: ${question}`,
    summary: `${topFinding.title}. ${topFinding.summary}`,
    meta: [
      `${materialFindings.length || findings.length} finding${(materialFindings.length || findings.length) === 1 ? "" : "s"}`,
      limitations.length > 0 ? `${limitations.length} limitation${limitations.length === 1 ? "" : "s"}` : null,
      `top severity: ${topFinding.severity}`,
    ].filter(Boolean).join(" · "),
  };
}

function currentRunPhase(events: WatchdogServerEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.eventType === "run.progress") {
      const phase = typeof event.payload.phase === "string" ? event.payload.phase : null;
      if (phase) return phase;
    }
    if (event.eventType === "run.completed" || event.eventType === "run.failed") {
      return "finalization";
    }
  }
  return null;
}

function sessionStatusFromEvent(event: WatchdogServerEvent, currentStatus: string): string {
  if (event.eventType === "session.updated" && typeof event.payload.status === "string") {
    return event.payload.status;
  }
  if (event.eventType === "run.started") return "running";
  if (event.eventType === "run.completed") return "completed";
  if (event.eventType === "run.failed") return "failed";
  if (event.eventType === "run.queued") return "queued";
  if (event.eventType === "clarification.required") return "awaiting_user_input";
  if (event.eventType === "session.expired") return "expired";
  return currentStatus;
}

function healthStateClass(status: string): "ok" | "warn" | "bad" | "dim" {
  const normalized = (status || "").toLowerCase();
  if (["ok", "ready", "healthy", "live"].includes(normalized)) return "ok";
  if (["degraded", "warning", "warn"].includes(normalized)) return "warn";
  if (["unavailable", "failed", "bad", "error"].includes(normalized)) return "bad";
  return "dim";
}

// Nav icons (inline SVG so we don't need an icon library)
const NAV_ICONS = {
  task: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7l4 4 10-10" />
      <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  catalog: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h6v16H4z" />
      <path d="M14 4h6v7h-6z" />
      <path d="M14 13h6v7h-6z" />
    </svg>
  ),
  floor: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-6 9 6" />
      <path d="M5 10v10h14V10" />
    </svg>
  ),
  oneshot: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  ),
  specFactory: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z" />
      <path d="M5 15l.9 2.1L8 18l-2.1.9L5 21l-.9-2.1L2 18l2.1-.9z" />
      <path d="M19 15l.7 1.6 1.6.7-1.6.7L19 20l-.7-1.6-1.6-.7 1.6-.7z" />
    </svg>
  ),
  support: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z" />
      <path d="M9 12l2 2 4-5" />
    </svg>
  ),
};

export function WatchdogPage() {
  const [view, setView] = useState<NavView>("task");
  const [taskTab, setTaskTab] = useState<TaskTab>("investigation");
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [mode, setMode] = useState<WatchdogMode>("natural_language");
  const [jiraKey, setJiraKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState<WatchdogScope>(() => defaultScope());
  const [sessions, setSessions] = useState<WatchdogSession[]>([]);
  const [activeSession, setActiveSession] = useState<WatchdogSession | null>(null);
  const [events, setEvents] = useState<WatchdogServerEvent[]>([]);
  const [findings, setFindings] = useState<WatchdogFinding[]>([]);
  const [evidence, setEvidence] = useState<WatchdogEvidenceArtifact[]>([]);
  const [clarifications, setClarifications] = useState<WatchdogClarification[]>([]);
  const [darciHandoffs, setDarciHandoffs] = useState<WatchdogDarciHandoff[]>([]);
  const [darciResults, setDarciResults] = useState<Record<string, string>>({});
  const [darciMapping, setDarciMapping] = useState<WatchdogDarciMappingDiagnostics | null>(null);
  const [health, setHealth] = useState<{
    status: string;
    mode: string;
    dependencies: Record<string, { status: string; message?: string }>;
  } | null>(null);
  const [catalogClients, setCatalogClients] = useState<string[]>([]);
  const [catalogSelected, setCatalogSelected] = useState<string | null>(null);
  const [catalogSources, setCatalogSources] = useState<WatchdogLogSource[]>([]);
  const [logSources, setLogSources] = useState<WatchdogLogSource[]>([]);
  const [clientLogSources, setClientLogSources] = useState<WatchdogLogSource[]>([]);
  const [includeKeywordDraft, setIncludeKeywordDraft] = useState("");
  const [excludeKeywordDraft, setExcludeKeywordDraft] = useState("");
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [evidencePayloads, setEvidencePayloads] = useState<Record<string, string>>({});
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({});
  const [previewSummary, setPreviewSummary] = useState<{
    title: string;
    status?: string;
    synopsis?: string;
    source: "jira" | "natural_language";
  } | null>(null);
  const [awsSettingsOpen, setAwsSettingsOpen] = useState(false);
  const [awsCredentialDraft, setAwsCredentialDraft] = useState({
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    awsSessionToken: "",
    awsAccountId: "239350186085",
  });
  const [awsCredentialStatus, setAwsCredentialStatus] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<"idle" | "connecting" | "live" | "reconnecting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const lastEventSequenceRef = useRef(0);
  const intakeHydrationSessionRef = useRef<string | null>(null);

  function changeMode(nextMode: WatchdogMode) {
    intakeHydrationSessionRef.current = null;
    setMode(nextMode);
    setError(null);
  }

  const sortedFindings = useMemo(() => sortFindings(findings), [findings]);
  const aiSummary = useMemo(
    () => buildAiSummary(activeSession, sortedFindings),
    [activeSession, sortedFindings],
  );
  const environmentOptions = useMemo(() => {
    const values = uniqueValues(clientLogSources.map(sourceEnvironment));
    return values.length > 0 ? values : uniqueValues([scope.environment, "PROD", "UAT", "CONFIG", "STAGE"]);
  }, [clientLogSources, scope.environment]);
  const serviceOptions = useMemo(() => {
    const scopedSources = clientLogSources.length > 0
      ? clientLogSources.filter((source) => sourceEnvironment(source)?.toUpperCase() === scope.environment.toUpperCase())
      : logSources;
    const values = uniqueValues(scopedSources.map(sourceService));
    return values.length > 0 ? values : scope.serviceIds;
  }, [clientLogSources, logSources, scope.environment, scope.serviceIds]);
  const runPhase = useMemo(() => currentRunPhase(events), [events]);
  const openClarification = useMemo(
    () => clarifications.find((clarification) => clarification.status === "open"),
    [clarifications],
  );
  const availableServiceOptions = useMemo(
    () =>
      serviceOptions.filter(
        (service) => !scope.serviceIds.some((item) => item.toLowerCase() === service.toLowerCase()),
      ),
    [scope.serviceIds, serviceOptions],
  );
  const suggestedKeywords = useMemo(() => {
    const text = [prompt, jiraKey, previewSummary?.title, previewSummary?.synopsis].filter(Boolean).join(" ");
    return keywordCandidatesFromText(text).filter(
      (keyword) => !scope.includeKeywords.some((item) => item.toLowerCase() === keyword.toLowerCase()),
    );
  }, [jiraKey, previewSummary?.synopsis, previewSummary?.title, prompt, scope.includeKeywords]);
  const scopeConfidenceOutcome = useMemo(() => {
    const sourceLabel =
      mode === "jira" && previewSummary?.source === "jira"
        ? "Suggested from Jira preview"
        : mode === "natural_language" && previewSummary?.source === "natural_language"
        ? "Suggested from custom prompt"
        : mode === "manual"
        ? "Manual operator selection"
        : "Awaiting preview";
    const missing = [
      !scope.clientId && "customer",
      !scope.environment && "environment",
      scope.serviceIds.length === 0 && "service",
    ].filter(Boolean);
    if (missing.length > 0) return `${sourceLabel}. Missing ${missing.join(", ")}.`;
    return `${sourceLabel}. Scope is ready.`;
  }, [
    mode,
    previewSummary?.source,
    scope.clientId,
    scope.environment,
    scope.serviceIds,
  ]);

  async function refreshHealth() {
    const response = await getWatchdogHealth();
    setHealth(response);
  }

  async function refreshSessions() {
    const response = await listWatchdogSessions();
    setSessions(response.sessions);
  }

  useEffect(() => {
    void refreshHealth().catch((err: Error) => setError(err.message));
    void refreshSessions().catch((err: Error) => setError(err.message));
    void listWatchdogCatalogClients()
      .then((response) => setCatalogClients(response.clients))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    if (!scope.clientId) {
      setLogSources([]);
      setClientLogSources([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void listWatchdogCatalogLogSources(scope.clientId)
        .then((response) => setClientLogSources(response.sources))
        .catch(() => setClientLogSources([]));
      void listWatchdogCatalogLogSources(scope.clientId, scope.environment)
        .then((response) => setLogSources(response.sources))
        .catch(() => setLogSources([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [scope.clientId, scope.environment]);

  useEffect(() => {
    if (clientLogSources.length === 0) return;
    const envs = uniqueValues(clientLogSources.map(sourceEnvironment));
    if (envs.length > 0 && !envs.some((env) => env.toUpperCase() === scope.environment.toUpperCase())) {
      setScope((current) => ({ ...current, environment: envs[0] }));
      return;
    }
    const services = uniqueValues(
      clientLogSources
        .filter((source) => sourceEnvironment(source)?.toUpperCase() === scope.environment.toUpperCase())
        .map(sourceService),
    );
    if (services.length > 0 && !currentServicesMatch(scope.serviceIds, services)) {
      setScope((current) => ({ ...current, serviceIds: [services[0]] }));
    }
  }, [clientLogSources, scope.environment, scope.serviceIds]);

  useEffect(() => {
    if (!catalogSelected) {
      setCatalogSources([]);
      return;
    }
    void listWatchdogCatalogLogSources(catalogSelected)
      .then((response) => setCatalogSources(response.sources))
      .catch(() => setCatalogSources([]));
  }, [catalogSelected]);

  useEffect(() => {
    if (!activeSession) return;
    lastEventSequenceRef.current = 0;
    setEvents([]);
    setFindings([]);
    setEvidence([]);
    setEvidencePayloads({});
    setClarifications([]);
    setClarificationAnswers({});
    setDarciHandoffs([]);
    setDarciResults({});
    setDarciMapping(null);
    setStreamStatus("connecting");

    const loadSessionDetails = () => {
      void listWatchdogFindings(activeSession.id)
        .then((response) => setFindings(response.findings))
        .catch(() => undefined);
      void listWatchdogEvidence(activeSession.id)
        .then((response) => setEvidence(response.artifacts))
        .catch(() => undefined);
      void listWatchdogClarifications(activeSession.id)
        .then((response) => setClarifications(response.clarifications))
        .catch(() => undefined);
      void listWatchdogDarciHandoffs(activeSession.id)
        .then((response) => setDarciHandoffs(response.handoffs))
        .catch(() => undefined);
      void getWatchdogDarciMapping(activeSession.id)
        .then(setDarciMapping)
        .catch(() => setDarciMapping(null));
    };

    const source = openWatchdogEvents(
      activeSession.id,
      (event) => {
        lastEventSequenceRef.current = Math.max(lastEventSequenceRef.current, event.sequence);
        setEvents((current) => {
          const next = [...current.filter((item) => item.id !== event.id), event].sort(
            (a, b) => a.sequence - b.sequence,
          );
          return next.slice(-80);
        });
        setActiveSession((current) => {
          if (!current || current.id !== event.sessionId) return current;
          return {
            ...current,
            status: sessionStatusFromEvent(event, current.status),
            updatedAt: event.createdAt,
          };
        });
        void refreshSessions().catch(() => undefined);
        if (
          event.eventType === "finding.created" ||
          event.eventType === "evidence.created" ||
          event.eventType.startsWith("clarification.") ||
          event.eventType === "run.completed" ||
          event.eventType.startsWith("darci_handoff.")
        ) {
          loadSessionDetails();
        }
      },
      {
        lastEventSequence: lastEventSequenceRef.current,
        onOpen: () => setStreamStatus("live"),
        onError: () => setStreamStatus("reconnecting"),
      },
    );

    loadSessionDetails();
    return () => {
      source.close();
      setStreamStatus("idle");
    };
  }, [activeSession?.id]);

  useEffect(() => {
    if (!activeSession) return;
    const syncable = darciHandoffs.filter(
      (handoff) =>
        handoff.taskManagementId &&
        ["task_created", "running", "delivering"].includes(handoff.status),
    );
    if (syncable.length === 0) return;
    const timer = window.setInterval(() => {
      void Promise.all(
        syncable.map((handoff) => syncWatchdogDarciHandoff(activeSession.id, handoff.id)),
      )
        .then(() => listWatchdogDarciHandoffs(activeSession.id))
        .then((response) => setDarciHandoffs(response.handoffs))
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [activeSession?.id, darciHandoffs]);

  function updateCustomer(clientId: string) {
    setScope((current) => ({
      ...current,
      clientId,
      environment: "",
      serviceIds: [],
    }));
  }

  function updateEnvironment(environment: string) {
    const services = uniqueValues(
      clientLogSources
        .filter((source) => sourceEnvironment(source)?.toUpperCase() === environment.toUpperCase())
        .map(sourceService),
    );
    setScope((current) => ({
      ...current,
      environment,
      serviceIds: services.length > 0 ? [services[0]] : current.serviceIds,
    }));
  }

  function updateQuickWindow(value: string) {
    setScope((current) => ({ ...current, timeWindow: quickTimeWindow(value) }));
  }

  function toggleService(service: string) {
    setScope((current) => {
      const exists = current.serviceIds.some((item) => item.toLowerCase() === service.toLowerCase());
      return {
        ...current,
        serviceIds: exists
          ? current.serviceIds.filter((item) => item.toLowerCase() !== service.toLowerCase())
          : [...current.serviceIds, service],
      };
    });
  }

  function addKeyword(kind: "include" | "exclude", value: string) {
    const keyword = value.trim();
    if (!keyword) return;
    setScope((current) => {
      const key = kind === "include" ? "includeKeywords" : "excludeKeywords";
      const existing = current[key];
      if (existing.some((item) => item.toLowerCase() === keyword.toLowerCase())) return current;
      return { ...current, [key]: [...existing, keyword] };
    });
    if (kind === "include") {
      setIncludeKeywordDraft("");
    } else {
      setExcludeKeywordDraft("");
    }
  }

  function removeKeyword(kind: "include" | "exclude", value: string) {
    setScope((current) => {
      const key = kind === "include" ? "includeKeywords" : "excludeKeywords";
      return {
        ...current,
        [key]: current[key].filter((item) => item !== value),
      };
    });
  }

  function acceptSuggestedKeywords() {
    suggestedKeywords.forEach((keyword) => addKeyword("include", keyword));
  }

  function focusEvidenceForFinding(finding: WatchdogFinding) {
    const ids = evidenceIdsForFinding(finding);
    setSelectedEvidenceIds(ids);
    setTaskTab("evidence");
  }

  async function handleViewEvidencePayload(artifact: WatchdogEvidenceArtifact) {
    if (!activeSession) return;
    if (evidencePayloads[artifact.id]) {
      setEvidencePayloads((current) => {
        const next = { ...current };
        delete next[artifact.id];
        return next;
      });
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const response = await getWatchdogEvidencePayload(activeSession.id, artifact.id);
      setEvidencePayloads((current) => ({
        ...current,
        [artifact.id]: JSON.stringify(response.payload, null, 2),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleAnswerClarification(clarification: WatchdogClarification, answerOverride?: unknown) {
    if (!activeSession) return;
    const typedAnswer = clarificationAnswers[clarification.id]?.trim();
    const answer = answerOverride ?? typedAnswer;
    if (
      answer === undefined ||
      answer === null ||
      (typeof answer === "string" && answer.trim().length === 0)
    ) {
      setError("Enter a clarification answer before resuming the run.");
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const run = await answerWatchdogClarification(activeSession.id, clarification.id, answer);
      setClarificationAnswers((current) => {
        const next = { ...current };
        delete next[clarification.id];
        return next;
      });
      const [updatedSession, clarificationResponse] = await Promise.all([
        getWatchdogSession(activeSession.id),
        listWatchdogClarifications(activeSession.id),
      ]);
      setActiveSession({ ...updatedSession, latestRunAttempt: run });
      setClarifications(clarificationResponse.clarifications);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  function scrollToTop() {
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
  }

  function switchView(nextView: NavView) {
    setView(nextView);
    scrollToTop();
  }

  async function handlePreview() {
    intakeHydrationSessionRef.current = null;
    setIsBusy(true);
    setError(null);
    try {
      if (mode === "jira") {
        const preview = await previewJira(jiraKey);
        setScope(preview.suggestedScope);
        setPreviewSummary({
          title: `${preview.ticket.key}: ${preview.ticket.summary}`,
          status: preview.ticket.status,
          synopsis: preview.ticket.synopsis,
          source: "jira",
        });
      } else if (mode === "natural_language") {
        const preview = await previewNaturalLanguage(prompt);
        setScope(preview.suggestedScope);
        setPreviewSummary({
          title: "Natural-language intake",
          status: preview.ambiguities.length > 0 ? "needs_review" : "ready",
          synopsis: preview.interpretedIntent || preview.prompt,
          source: "natural_language",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateAndApprove() {
    setIsBusy(true);
    setError(null);
    try {
      const session = await createWatchdogSession({
        mode,
        jiraKey: mode === "jira" ? jiraKey : undefined,
        naturalLanguagePrompt: mode === "natural_language" ? prompt : undefined,
        draftScope: scope,
      });
      const run = await approveWatchdogSession(session.id, scope);
      if (run.approvedScope) setScope(run.approvedScope);
      const refreshed = await listWatchdogSessions();
      const approved = refreshed.sessions.find((item) => item.id === session.id) || session;
      setActiveSession(approved);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRunQueuedAttempt() {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      await runNextWatchdogAttempt(activeSession.id);
      const response = await listWatchdogSessions();
      setSessions(response.sessions);
      const refreshed = response.sessions.find((session) => session.id === activeSession.id);
      if (refreshed) setActiveSession(refreshed);
      const findingResponse = await listWatchdogFindings(activeSession.id);
      setFindings(findingResponse.findings);
      const evidenceResponse = await listWatchdogEvidence(activeSession.id);
      setEvidence(evidenceResponse.artifacts);
      const handoffResponse = await listWatchdogDarciHandoffs(activeSession.id);
      setDarciHandoffs(handoffResponse.handoffs);
      await getWatchdogDarciMapping(activeSession.id)
        .then(setDarciMapping)
        .catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRerunSession() {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      const run = await rerunWatchdogSession(activeSession.id, scope);
      if (run.approvedScope) setScope(run.approvedScope);
      const response = await listWatchdogSessions();
      setSessions(response.sessions);
      const refreshed = response.sessions.find((session) => session.id === activeSession.id);
      if (refreshed) setActiveSession(refreshed);
      setTaskTab("investigation");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCancelSession() {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      const cancelled = await cancelWatchdogSession(activeSession.id);
      setActiveSession(cancelled);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateDarciHandoff(findingId: string) {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      await createWatchdogDarciHandoff(activeSession.id, [findingId]);
      const handoffResponse = await listWatchdogDarciHandoffs(activeSession.id);
      setDarciHandoffs(handoffResponse.handoffs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateDarciTask(handoffId: string) {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      await createWatchdogDarciTask(activeSession.id, handoffId);
      const handoffResponse = await listWatchdogDarciHandoffs(activeSession.id);
      setDarciHandoffs(handoffResponse.handoffs);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSyncDarciHandoff(handoffId: string) {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      await syncWatchdogDarciHandoff(activeSession.id, handoffId);
      const handoffResponse = await listWatchdogDarciHandoffs(activeSession.id);
      setDarciHandoffs(handoffResponse.handoffs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleLoadDarciResult(handoffId: string) {
    if (!activeSession) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await getWatchdogDarciResult(activeSession.id, handoffId);
      setDarciResults((current) => ({ ...current, [handoffId]: result.markdown }));
      const handoffResponse = await listWatchdogDarciHandoffs(activeSession.id);
      setDarciHandoffs(handoffResponse.handoffs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  function hydrateIntakeFromSession(session: WatchdogSession) {
    intakeHydrationSessionRef.current = session.id;
    setMode(session.mode);
    setJiraKey(session.jiraKey || "");
    setPrompt(session.naturalLanguagePrompt || "");
    setError(null);

    if (session.mode === "jira" && session.jiraKey) {
      const jiraKeyForSession = session.jiraKey;
      setPreviewSummary({
        title: `${jiraKeyForSession} Watchdog investigation`,
        status: session.status,
        synopsis: "Refreshing Jira summary for this historical task.",
        source: "jira",
      });
      void previewJira(jiraKeyForSession)
        .then((preview) => {
          if (intakeHydrationSessionRef.current !== session.id) return;
          setPreviewSummary({
            title: `${preview.ticket.key}: ${preview.ticket.summary}`,
            status: preview.ticket.status,
            synopsis: preview.ticket.synopsis,
            source: "jira",
          });
        })
        .catch((err) => {
          if (intakeHydrationSessionRef.current !== session.id) return;
          setPreviewSummary({
            title: `${jiraKeyForSession} Watchdog investigation`,
            status: session.status,
            synopsis: err instanceof Error
              ? `Jira summary could not be refreshed: ${err.message}`
              : "Jira summary could not be refreshed.",
            source: "jira",
          });
        });
      return;
    }

    if (session.mode === "natural_language" && session.naturalLanguagePrompt) {
      setPreviewSummary({
        title: "Natural-language intake",
        status: session.status,
        synopsis: session.naturalLanguagePrompt,
        source: "natural_language",
      });
      return;
    }

    setPreviewSummary(null);
  }

  function selectSession(session: WatchdogSession) {
    setActiveSession(session);
    const restoredScope = session.draftScope || session.approvedScope || session.latestRunAttempt?.approvedScope;
    if (restoredScope) setScope(restoredScope);
    hydrateIntakeFromSession(session);
    switchView("task");
    setTaskTab("investigation");
  }

  function startNewTask() {
    intakeHydrationSessionRef.current = null;
    setActiveSession(null);
    setEvents([]);
    setFindings([]);
    setEvidence([]);
    setEvidencePayloads({});
    setClarifications([]);
    setClarificationAnswers({});
    setDarciHandoffs([]);
    setDarciResults({});
    setDarciMapping(null);
    setSelectedEvidenceIds([]);
    setPreviewSummary(null);
    setError(null);
    setMode("natural_language");
    setScope(defaultScope());
    setPrompt("");
    setJiraKey("");
    setTaskTab("investigation");
    switchView("task");
  }

  function crossNavigate(path: "/" | "/oneshot" | "/spec-factory" | "/production-support") {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function openWatchdogAbout() {
    window.history.pushState({}, "", "/watchdog/intro");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  async function handleSaveAwsCredentials() {
    setIsBusy(true);
    setError(null);
    setAwsCredentialStatus(null);
    try {
      const result = await setWatchdogAwsCredentials({
        awsAccessKeyId: awsCredentialDraft.awsAccessKeyId,
        awsSecretAccessKey: awsCredentialDraft.awsSecretAccessKey,
        awsSessionToken: awsCredentialDraft.awsSessionToken || undefined,
        awsAccountId: awsCredentialDraft.awsAccountId || undefined,
      });
      setAwsCredentialStatus(
        [
          "Runtime credentials loaded",
          result.aws.account_id,
          result.aws.arn,
          result.aws.has_session_token ? "session token provided" : "static key",
        ].filter(Boolean).join(" · "),
      );
      setAwsCredentialDraft((current) => ({
        ...current,
        awsAccessKeyId: "",
        awsSecretAccessKey: "",
        awsSessionToken: "",
      }));
      await refreshHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  const scopeIsComplete =
    scope.clientId.trim().length > 0 &&
    scope.environment.trim().length > 0 &&
    scope.serviceIds.length > 0 &&
    scope.serviceIds.every((service) => service.trim().length > 0) &&
    scope.timeWindow.startTs.trim().length > 0 &&
    scope.timeWindow.endTs.trim().length > 0;
  const approvedScope = activeSession?.approvedScope;
  const canApprove = scopeIsComplete;
  const canRun = activeSession?.status === "queued";
  const canRerun = Boolean(activeSession && ["completed", "failed", "expired"].includes(activeSession.status));
  const canCancel = Boolean(activeSession && ["queued", "running", "awaiting_user_input"].includes(activeSession.status));
  const activeStatusKey = activeSession?.status || "";

  return (
    <div className={`wd-scope wd-theme-${theme}`} data-theme={theme}>
      <div className="wd-layout">
        {/* ─────────────────────────────── Sidebar */}
        <nav className="wd-nav" aria-label="Watchdog navigation">
          <div className="wd-brand">
            <img
              className="wd-brand-mark"
              src="/watchdog-logo.png"
              alt=""
              aria-hidden="true"
            />
            <div>
              <div className="wd-brand-name">Watchdog</div>
              <div className="wd-brand-tagline">Log investigations</div>
            </div>
          </div>

          <div className="wd-nav-group">
            <div className="wd-nav-label">Workspace</div>
            <button
              type="button"
              className={`wd-nav-item ${view === "task" ? "is-active" : ""}`}
              onClick={() => switchView("task")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.task}</span>
              <span>Task</span>
              {activeSession && activeStatusKey === "running" && (
                <span className="wd-nav-count">live</span>
              )}
            </button>
            <button
              type="button"
              className={`wd-nav-item ${view === "history" ? "is-active" : ""}`}
              onClick={() => switchView("history")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.history}</span>
              <span>History</span>
              <span className="wd-nav-count">{sessions.length}</span>
            </button>
            <button
              type="button"
              className={`wd-nav-item ${view === "catalog" ? "is-active" : ""}`}
              onClick={() => switchView("catalog")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.catalog}</span>
              <span>Catalog</span>
              <span className="wd-nav-count">{catalogClients.length}</span>
            </button>
          </div>

          <div className="wd-nav-group">
            <div className="wd-nav-label">Specter</div>
            <button
              type="button"
              className="wd-nav-item"
              onClick={() => crossNavigate("/")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.floor}</span>
              <span>Floor</span>
            </button>
            <button
              type="button"
              className="wd-nav-item"
              onClick={() => crossNavigate("/oneshot")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.oneshot}</span>
              <span>OneShot</span>
            </button>
            <button
              type="button"
              className="wd-nav-item"
              onClick={() => crossNavigate("/spec-factory")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.specFactory}</span>
              <span>Spec Factory</span>
            </button>
            <button
              type="button"
              className="wd-nav-item"
              onClick={() => crossNavigate("/production-support")}
            >
              <span className="wd-nav-icon">{NAV_ICONS.support}</span>
              <span>Production Support</span>
            </button>
          </div>

          <div className="wd-nav-foot">
            <div className="wd-theme-toggle" role="group" aria-label="Theme">
              <button
                type="button"
                className={`wd-theme-btn ${theme === "light" ? "is-active" : ""}`}
                onClick={() => setTheme("light")}
                aria-pressed={theme === "light"}
                title="Light theme"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" aria-hidden>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
                <span>Light</span>
              </button>
              <button
                type="button"
                className={`wd-theme-btn ${theme === "dark" ? "is-active" : ""}`}
                onClick={() => setTheme("dark")}
                aria-pressed={theme === "dark"}
                title="Dark theme"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" aria-hidden>
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
                <span>Dark</span>
              </button>
            </div>
            <div className="wd-nav-runtime">
              <div className="wd-nav-runtime-head">
                <span className="wd-nav-runtime-label">Runtime</span>
                <span className={`wd-nav-runtime-value ${health?.status === "ok" ? "is-ok" : ""}`}>
                  {health?.status || "…"}
                </span>
              </div>
              <div className="wd-nav-runtime-deps">
                {health
                  ? Object.entries(health.dependencies)
                      .slice(0, 4)
                      .map(([name, dep]) => (
                        <div key={name} className="wd-nav-runtime-dep">
                          <span className={`wd-nav-runtime-dep-dot ${healthStateClass(dep.status)}`} />
                          <span className="wd-nav-runtime-dep-name">{name}</span>
                          <span className="wd-nav-runtime-dep-status">{dep.status}</span>
                        </div>
                      ))
                  : null}
              </div>
            </div>
          </div>
        </nav>

        {/* ─────────────────────────────── Main column */}
        <main className="wd-main">
          {view === "task" && (
            <>
              <header className="wd-masthead">
                <div className="wd-masthead-copy">
                  <div className="wd-eyebrow">
                    <span className="wd-pulse" />
                    <span>Observatory</span>
                  </div>
                  <h1 className="wd-title">
                    Watchdog <em>Every log has a story</em>
                  </h1>
                </div>
                <div className="wd-masthead-actions">
                  <div className="wd-masthead-action-row">
                    <button
                      type="button"
                      className="wd-about-btn"
                      onClick={openWatchdogAbout}
                      title="About Watchdog"
                      aria-label="About Watchdog"
                    >
                      About
                    </button>
                    <button
                      type="button"
                      className="wd-gear-btn"
                      onClick={() => {
                        setAwsCredentialStatus(null);
                        setAwsSettingsOpen(true);
                      }}
                      title="Runtime AWS credentials"
                      aria-label="Runtime AWS credentials"
                    >
                      ⚙
                    </button>
                  </div>
                  <button
                    type="button"
                    className="wd-new-task-btn"
                    onClick={startNewTask}
                    title="New Task"
                    aria-label="New Task"
                  >
                    <span aria-hidden>＋</span> New Task
                  </button>
                </div>
              </header>

              <div className="wd-session-bar">
                <div className="wd-session-bar-left">
                  <span className="wd-session-label">Session</span>
                  {activeSession ? (
                    <>
                      <span className="wd-session-title" title={activeSession.title}>
                        {activeSession.title}
                      </span>
                      <span className="wd-chiprow">
                        <span
                          className={`wd-chip wd-status wd-status-${activeStatusKey}`}
                          title={`Session status: ${activeStatusKey}`}
                        >
                          <span className="wd-chip-dot" />
                          {activeStatusKey || "draft"}
                        </span>
                        <span className="wd-chip is-muted">{activeSession.mode.replace("_", " ")}</span>
                        {activeSession.latestRunAttempt && (
                          <span className="wd-chip is-muted">
                            attempt {activeSession.latestRunAttempt.attemptNumber}
                          </span>
                        )}
                        {activeSession.latestRunAttempt?.providerKey && (
                          <span
                            className="wd-chip is-muted"
                            title={activeSession.latestRunAttempt.modelId || activeSession.latestRunAttempt.providerKey}
                          >
                            {activeSession.latestRunAttempt.providerKey.replace("_agent_sdk", "")}
                          </span>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="wd-empty-session">
                      No session selected — seal a scope to begin
                    </span>
                  )}
                </div>
                <div className="wd-session-bar-right">
                  <span className={`wd-stream is-${streamStatus}`}>
                    <span className="wd-stream-dot" />
                    stream · {streamStatus}
                  </span>
                  <button
                    type="button"
                    className="wd-btn is-primary"
                    disabled={isBusy || !canRun}
                    onClick={handleRunQueuedAttempt}
                    title={canRun ? "Execute the queued run attempt" : "No queued attempt"}
                  >
                    <span className="wd-btn-glyph">▶</span> Run attempt
                  </button>
                  {canRerun && (
                    <button
                      type="button"
                      className="wd-btn is-primary"
                      disabled={isBusy || !scopeIsComplete}
                      onClick={handleRerunSession}
                      title="Create a new run attempt using the current scope controls"
                    >
                      <span className="wd-btn-glyph">↻</span> Rerun
                    </button>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      className="wd-btn is-danger"
                      disabled={isBusy}
                      onClick={handleCancelSession}
                      title="Stop this run and mark it failed with run_cancelled"
                    >
                      <span className="wd-btn-glyph">✕</span> Cancel
                    </button>
                  )}
                </div>
              </div>

              <div className="wd-tabs" role="tablist" aria-label="Investigation views">
                {(
                  [
                    { key: "investigation" as const, label: "Investigation" },
                    { key: "findings" as const, label: "Findings", count: sortedFindings.length },
                    { key: "evidence" as const, label: "Evidence", count: evidence.length },
                    { key: "darci" as const, label: "DARCI Results", count: darciHandoffs.length },
                  ]
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={taskTab === tab.key}
                    className={`wd-tab ${taskTab === tab.key ? "is-active" : ""}`}
                    onClick={() => setTaskTab(tab.key)}
                  >
                    <span>{tab.label}</span>
                    {"count" in tab && tab.count !== undefined && (
                      <span className="wd-tab-count">{tab.count}</span>
                    )}
                  </button>
                ))}
              </div>

              {taskTab === "investigation" && (
                <>
              {/* Unified tri-column panel */}
              <section className="wd-panel wd-unified" aria-label="Investigation console">
                {/* Intake */}
                <div className="wd-unified-col">
                  <div className="wd-unified-col-head">
                    <div>
                      <div className="wd-panel-kicker">Intake</div>
                      <h2 className="wd-panel-title">Frame the question</h2>
                    </div>
                  </div>
                  <div className="wd-unified-col-body">
                    <div className="wd-mode" role="tablist" aria-label="Intake mode">
                      {(["natural_language", "jira", "manual"] as const).map((item) => (
                        <button
                          key={item}
                          type="button"
                          role="tab"
                          aria-selected={mode === item}
                          onClick={() => changeMode(item)}
                          className={`wd-mode-btn ${mode === item ? "is-active" : ""}`}
                        >
                          {item === "natural_language"
                            ? "Custom"
                            : item === "jira"
                            ? "Jira"
                            : "Manual"}
                        </button>
                      ))}
                    </div>

                    {mode === "jira" && (
                      <>
                        <label className="wd-field">
                          <span className="wd-field-label">Jira key</span>
                          <input
                            className="wd-input is-mono"
                            value={jiraKey}
                            onChange={(event) => setJiraKey(event.target.value)}
                            placeholder="CPSUP-43946"
                            spellCheck={false}
                          />
                        </label>
                        <div className="wd-jira-summary">
                          <div className="wd-jira-summary-kicker">Ticket summary</div>
                          {previewSummary?.source === "jira" ? (
                            <>
                              <div className="wd-jira-summary-title">{previewSummary.title}</div>
                              {previewSummary.status && (
                                <span className="wd-preview-status">{previewSummary.status}</span>
                              )}
                              {previewSummary.synopsis && (
                                <p className="wd-jira-summary-copy">{previewSummary.synopsis}</p>
                              )}
                            </>
                          ) : (
                            <p className="wd-jira-summary-empty">
                              Enter a Jira key and click Preview. Watchdog will fetch the ticket,
                              summarize the issue, and prefill the investigation controls.
                            </p>
                          )}
                        </div>
                      </>
                    )}

                    {mode === "natural_language" && (
                      <label className="wd-field wd-field-fill">
                        <span className="wd-field-label">What are you chasing?</span>
                        <textarea
                          className="wd-textarea wd-textarea-fill"
                          value={prompt}
                          onChange={(event) => setPrompt(event.target.value)}
                          placeholder="Investigate Client UAT Core app for errors from the last 3 hours"
                        />
                      </label>
                    )}

                    {mode === "manual" && (
                      <p className="wd-field-hint" style={{ marginBottom: 12 }}>
                        Dial scope manually in the middle column. No preview required.
                      </p>
                    )}

                    <div className="wd-actions">
                      <button
                        type="button"
                        className="wd-btn is-ghost"
                        disabled={mode === "manual" || isBusy}
                        onClick={handlePreview}
                      >
                        <span className="wd-btn-glyph">◐</span> Preview
                      </button>
                      <button
                        type="button"
                        className="wd-btn is-primary"
                        disabled={isBusy || !canApprove}
                        onClick={handleCreateAndApprove}
                        title={canApprove ? "Seal the scope and create a session" : "Customer required"}
                      >
                        <span className="wd-btn-glyph">✓</span> Approve
                      </button>
                    </div>

                    {error && (
                      <div className="wd-error wd-error-action" role="alert">
                        <span>{error}</span>
                        {mode === "jira" && (
                          <button type="button" onClick={() => changeMode("manual")}>
                            Continue manually
                          </button>
                        )}
                      </div>
                    )}

                  </div>
                </div>

                {/* Draft scope */}
                <div className="wd-unified-col">
                  <div className="wd-unified-col-head">
                    <div>
                      <div className="wd-panel-kicker">Draft scope</div>
                      <h2 className="wd-panel-title">Dial the investigation</h2>
                    </div>
                    <span className="wd-field-hint">Frozen after approval</span>
                  </div>
                  <div className="wd-unified-col-body">
                    <div className="wd-scope-grid">
                      <label className="wd-field">
                        <span className="wd-field-label">Customer</span>
                        <select
                          className="wd-select is-mono"
                          value={scope.clientId}
                          onChange={(event) => updateCustomer(event.target.value)}
                        >
                          <option value="">Select customer</option>
                          {catalogClients.map((client) => (
                            <option key={client} value={client}>{client}</option>
                          ))}
                        </select>
                      </label>
                      <label className="wd-field">
                        <span className="wd-field-label">Environment</span>
                        <select
                          className="wd-select"
                          value={scope.environment}
                          onChange={(event) => updateEnvironment(event.target.value)}
                          disabled={!scope.clientId}
                        >
                          <option value="">Select environment</option>
                          {environmentOptions.map((env) => (
                            <option key={env} value={env}>{env}</option>
                          ))}
                        </select>
                      </label>
                      <label className="wd-field">
                        <span className="wd-field-label">Services</span>
                        <div className="wd-service-picker">
                          <select
                            className="wd-select"
                            value=""
                            onChange={(event) => {
                              if (event.target.value) toggleService(event.target.value);
                            }}
                            disabled={!scope.clientId || !scope.environment}
                          >
                            <option value="">
                              {availableServiceOptions.length > 0 ? "Add service" : "All services selected"}
                            </option>
                            {availableServiceOptions.map((service) => (
                              <option key={service} value={service}>{service}</option>
                            ))}
                          </select>
                          {scope.serviceIds.length > 0 && (
                            <div className="wd-keyword-ring">
                              {scope.serviceIds.map((service) => (
                                <button
                                  key={service}
                                  type="button"
                                  className="wd-keyword-chip is-service"
                                  onClick={() => toggleService(service)}
                                  title={`Remove ${service}`}
                                >
                                  {service} <span aria-hidden>×</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </label>
                      <label className="wd-field">
                        <span className="wd-field-label">Time window</span>
                        <select
                          className="wd-select"
                          value={QUICK_TIME_WINDOWS.find((item) => item.label.toLowerCase() === scope.timeWindow.sourceHint)?.value || ""}
                          onChange={(event) => updateQuickWindow(event.target.value)}
                        >
                          <option value="">Custom window</option>
                          {QUICK_TIME_WINDOWS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="wd-field span-2">
                        <span className="wd-field-label">Match keywords</span>
                        <div className="wd-keyword-entry">
                          <input
                            className="wd-input is-mono"
                            value={includeKeywordDraft}
                            onChange={(event) => setIncludeKeywordDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === ",") {
                                event.preventDefault();
                                addKeyword("include", includeKeywordDraft);
                              }
                            }}
                            placeholder="Type keyword, press Enter"
                          />
                          <button type="button" className="wd-chip-add" onClick={() => addKeyword("include", includeKeywordDraft)}>
                            Add
                          </button>
                        </div>
                        {scope.includeKeywords.length > 0 && (
                          <div className="wd-keyword-ring">
                            {scope.includeKeywords.map((kw) => (
                              <button key={kw} type="button" className="wd-keyword-chip" onClick={() => removeKeyword("include", kw)} title={`Remove ${kw}`}>
                                + {kw} <span aria-hidden>×</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {suggestedKeywords.length > 0 && (
                          <div className="wd-suggested-keywords">
                            <div className="wd-suggested-head">
                              <span>Suggested from intake</span>
                              <button type="button" onClick={acceptSuggestedKeywords}>Accept all</button>
                            </div>
                            <div className="wd-keyword-ring">
                              {suggestedKeywords.map((kw) => (
                                <button key={kw} type="button" className="wd-keyword-chip is-suggested" onClick={() => addKeyword("include", kw)}>
                                  + {kw}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </label>
                      <label className="wd-field span-2">
                        <span className="wd-field-label">Exclude keywords</span>
                        <div className="wd-keyword-entry">
                          <input
                            className="wd-input is-mono"
                            value={excludeKeywordDraft}
                            onChange={(event) => setExcludeKeywordDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === ",") {
                                event.preventDefault();
                                addKeyword("exclude", excludeKeywordDraft);
                              }
                            }}
                            placeholder="Type keyword, press Enter"
                          />
                          <button type="button" className="wd-chip-add" onClick={() => addKeyword("exclude", excludeKeywordDraft)}>
                            Add
                          </button>
                        </div>
                        {scope.excludeKeywords.length > 0 && (
                          <div className="wd-keyword-ring">
                            {scope.excludeKeywords.map((kw) => (
                              <button key={kw} type="button" className="wd-keyword-chip is-exclude" onClick={() => removeKeyword("exclude", kw)} title={`Remove ${kw}`}>
                                - {kw} <span aria-hidden>×</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </label>
                      <label className="wd-field">
                        <span className="wd-field-label">Start · UTC</span>
                        <input
                          className="wd-input is-mono"
                          type="datetime-local"
                          value={isoToDateTimeLocal(scope.timeWindow.startTs)}
                          onChange={(event) =>
                            setScope({
                              ...scope,
                              timeWindow: {
                                ...scope.timeWindow,
                                startTs: dateTimeLocalToIso(event.target.value),
                                sourceHint: "custom window",
                              },
                            })
                          }
                        />
                        <span className="wd-field-hint">
                          {formatScopeTimestamp(scope.timeWindow.startTs)} · {formatLocalTimestamp(scope.timeWindow.startTs)}
                        </span>
                      </label>
                      <label className="wd-field">
                        <span className="wd-field-label">End · UTC</span>
                        <input
                          className="wd-input is-mono"
                          type="datetime-local"
                          value={isoToDateTimeLocal(scope.timeWindow.endTs)}
                          onChange={(event) =>
                            setScope({
                              ...scope,
                              timeWindow: {
                                ...scope.timeWindow,
                                endTs: dateTimeLocalToIso(event.target.value),
                                sourceHint: "custom window",
                              },
                            })
                          }
                        />
                        <span className="wd-field-hint">
                          {formatScopeTimestamp(scope.timeWindow.endTs)} · {formatLocalTimestamp(scope.timeWindow.endTs)}
                        </span>
                      </label>
                    </div>

                    <div className="wd-scope-review">
                      <div className="wd-review-block">
                        <div className="wd-review-line">
                          <span>Scope confidence</span>
                          <span className={scopeIsComplete ? "is-ready" : "is-missing"}>
                            {scopeIsComplete ? "ready to approve" : "needs input"}
                          </span>
                          <strong>{scopeConfidenceOutcome}</strong>
                        </div>
                      </div>
                    </div>

                    {openClarification && (
                      <div className="wd-clarification-card">
                        <div className="wd-clarification-head">
                          <div>
                            <div className="wd-clarification-kicker">Clarification required</div>
                            <h3>Answer to resume investigation</h3>
                          </div>
                          <span>{formatLocalTimestamp(openClarification.expiresAt)}</span>
                        </div>
                        <p>{openClarification.question}</p>
                        {openClarification.choices.length > 0 && (
                          <div className="wd-clarification-choices">
                            {openClarification.choices.slice(0, 6).map((choice, index) => {
                              const label = clarificationChoiceLabel(choice);
                              return (
                                <button
                                  key={`${label}-${index}`}
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleAnswerClarification(openClarification, choice)}
                                >
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <textarea
                          className="wd-input wd-clarification-input"
                          rows={3}
                          value={clarificationAnswers[openClarification.id] || ""}
                          onChange={(event) =>
                            setClarificationAnswers((current) => ({
                              ...current,
                              [openClarification.id]: event.target.value,
                            }))
                          }
                          placeholder="Type the missing client, environment, service, or extra investigation detail..."
                        />
                        <div className="wd-clarification-actions">
                          <span>Creates a new clarification-resume run attempt.</span>
                          <button
                            type="button"
                            className="wd-btn is-primary"
                            disabled={isBusy}
                            onClick={() => void handleAnswerClarification(openClarification)}
                          >
                            Resume run
                          </button>
                        </div>
                      </div>
                    )}

                    {activeSession && activeStatusKey === "running" && runPhase && (
                      <div className="wd-progress">
                        <div className="wd-progress-head">
                          <span>Run progress</span>
                          <span className="wd-progress-phase">{RUN_PHASE_LABEL[runPhase] || runPhase}</span>
                        </div>
                        <div className="wd-progress-track">
                          {RUN_PHASE_ORDER.map((phase) => {
                            const activeIdx = RUN_PHASE_ORDER.indexOf(
                              runPhase as typeof RUN_PHASE_ORDER[number],
                            );
                            const idx = RUN_PHASE_ORDER.indexOf(phase);
                            return (
                              <div
                                key={phase}
                                className={`wd-progress-seg ${
                                  idx < activeIdx ? "is-complete" : idx === activeIdx ? "is-active" : ""
                                }`}
                              />
                            );
                          })}
                        </div>
                        <div className="wd-progress-labels">
                          {RUN_PHASE_ORDER.map((phase) => (
                            <span key={phase} className={runPhase === phase ? "is-active" : ""}>
                              {RUN_PHASE_LABEL[phase]}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {approvedScope && (
                      <div className="wd-sealed-nested" aria-label="Sealed approved scope">
                        <div className="wd-sealed-head">
                          <div>
                            <div className="wd-sealed-kicker">Sealed for run</div>
                            <div className="wd-sealed-title">Approved dossier</div>
                          </div>
                          <div className="wd-sealed-sigil" aria-hidden>✓</div>
                        </div>
                        <dl className="wd-sealed-list">
                          <div className="wd-sealed-row">
                            <dt>Customer</dt>
                            <dd>{approvedScope.clientId}</dd>
                          </div>
                          <div className="wd-sealed-row">
                            <dt>Environment</dt>
                            <dd>{approvedScope.environment}</dd>
                          </div>
                          <div className="wd-sealed-row">
                            <dt>Services</dt>
                            <dd>{approvedScope.serviceIds.join(" · ") || "—"}</dd>
                          </div>
                          <div className="wd-sealed-row">
                            <dt>Window</dt>
                            <dd>
                              {formatScopeTimestamp(approvedScope.timeWindow.startTs)}
                              <br />
                              {formatScopeTimestamp(approvedScope.timeWindow.endTs)}
                            </dd>
                          </div>
                          <div className="wd-sealed-row">
                            <dt>Include</dt>
                            <dd>{approvedScope.includeKeywords.join(", ") || "—"}</dd>
                          </div>
                        </dl>
                      </div>
                    )}
                  </div>
                </div>

                {/* Event stream */}
                <div className="wd-unified-col">
                  <div className="wd-unified-col-head">
                    <div>
                      <div className="wd-panel-kicker">Event stream</div>
                      <h2 className="wd-panel-title">Live tickertape</h2>
                    </div>
                    <span className={`wd-stream is-${streamStatus}`} aria-hidden>
                      <span className="wd-stream-dot" />
                      {streamStatus}
                    </span>
                  </div>
                  <div className="wd-unified-col-body">
                    {events.length === 0 ? (
                      <div className="wd-stream-empty">
                        Approve a scope to attach to the durable SSE stream. Events replay from the
                        last sequence on reconnect.
                      </div>
                    ) : (
                      <div className="wd-ticker-list">
                        {[...events].reverse().map((event) => (
                          <div
                            key={event.id}
                            className={`wd-ticker-row ${tickerFamily(event.eventType)}`}
                          >
                            <span className="wd-ticker-node" aria-hidden />
                            <span className="wd-ticker-seq">#{event.sequence}</span>
                            <span className="wd-ticker-main">
                              <span className="wd-ticker-type">{event.eventType}</span>
                              <span className="wd-ticker-caption">{eventCaption(event)}</span>
                            </span>
                            <span className="wd-ticker-time">{formatClockTime(event.createdAt)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
                </>
              )}

              {taskTab === "findings" && (
                <section className="wd-panel">
                  <header className="wd-section-head">
                    <div>
                      <div className="wd-section-kicker">Findings</div>
                      <h2 className="wd-section-title">What the run <em>caught</em></h2>
                    </div>
                    <span className="wd-section-count">
                      {sortedFindings.length} {sortedFindings.length === 1 ? "entry" : "entries"}
                    </span>
                  </header>
                  <div className="wd-findings-body">
                    {sortedFindings.length === 0 ? (
                      <div className="wd-empty wd-empty-action">
                        <strong>No findings yet</strong>
                        <span>Approve a scope, run the queued attempt, then Watchdog will show cited findings here.</span>
                        {canRun && (
                          <button type="button" className="wd-btn is-primary" disabled={isBusy} onClick={handleRunQueuedAttempt}>
                            Run queued attempt
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        {aiSummary && (
                          <section className={`wd-ai-summary tone-${aiSummary.tone}`}>
                            <div className="wd-ai-summary-kicker">AI Summary</div>
                            <h3>{aiSummary.answer}</h3>
                            <p>{aiSummary.summary}</p>
                            <div className="wd-ai-summary-meta">{aiSummary.meta}</div>
                          </section>
                        )}
                        <div className="wd-darci-cta">
                          <div>
                            <div className="wd-darci-cta-kicker">Code deep-dive</div>
                            <strong>Need source-level analysis?</strong>
                            <span>Send the selected finding to DARCI. Watchdog keeps the handoff and result with this session.</span>
                          </div>
                          <button
                            type="button"
                            className="wd-btn is-primary"
                            disabled={isBusy || !activeSession || sortedFindings.length === 0}
                            onClick={() => handleCreateDarciHandoff(sortedFindings[0].id)}
                          >
                            <span className="wd-btn-glyph">→</span> Send top finding
                          </button>
                        </div>
                        {sortedFindings.map((finding) => {
                        const confidence = Math.round((finding.confidence || 0) * 100);
                        const citedEvidenceIds = evidenceIdsForFinding(finding);
                        const sigil =
                          finding.kind === "finding"
                            ? SEVERITY_GLYPH[finding.severity] || "◉"
                            : KIND_GLYPH[finding.kind] || "•";
                        return (
                          <article
                            key={finding.id}
                            className={`wd-finding ${severityClass(finding)}`}
                            style={{ ["--wd-conf" as string]: `${confidence}%` }}
                          >
                            <div className="wd-finding-sigil" aria-hidden>{sigil}</div>
                            <div className="wd-finding-body">
                              <div className="wd-finding-head">
                                <h3 className="wd-finding-title">{finding.title}</h3>
                                {finding.kind === "finding" ? (
                                  <span className="wd-finding-severity">{finding.severity}</span>
                                ) : (
                                  <span className="wd-finding-severity">
                                    {finding.kind.replace("_", " ")}
                                  </span>
                                )}
                              </div>
                              <p className="wd-finding-summary">{finding.summary}</p>
                              {finding.confidence !== undefined && finding.confidence !== null && (
                                <div className="wd-finding-confidence">
                                  <span>Confidence {confidence}%</span>
                                  <span className="wd-finding-conf-bar" />
                                </div>
                              )}
                              <div className="wd-finding-evidence-row">
                                {citedEvidenceIds.length > 0 ? (
                                  <>
                                    <span>{citedEvidenceIds.length} cited evidence artifact{citedEvidenceIds.length === 1 ? "" : "s"}</span>
                                    <button type="button" onClick={() => focusEvidenceForFinding(finding)}>
                                      View evidence
                                    </button>
                                  </>
                                ) : (
                                  <span>No explicit evidence ids on this finding yet</span>
                                )}
                              </div>
                            </div>
                            <div className="wd-finding-action">
                              <button
                                type="button"
                                className="wd-btn is-primary"
                                disabled={isBusy || !activeSession}
                                onClick={() => handleCreateDarciHandoff(finding.id)}
                                title="Queue a DARCI handoff from this finding"
                              >
                                <span className="wd-btn-glyph">→</span> Send to DARCI
                              </button>
                            </div>
                          </article>
                        );
                        })}
                      </>
                    )}
                  </div>
                </section>
              )}

              {taskTab === "darci" && (
                <section className="wd-panel">
                  <header className="wd-section-head">
                    <div>
                      <div className="wd-section-kicker">DARCI Bridge</div>
                      <h2 className="wd-section-title">Escalation <em>pipeline</em></h2>
                    </div>
                    <span className="wd-section-count">
                      {darciHandoffs.length} handoff{darciHandoffs.length === 1 ? "" : "s"}
                    </span>
                  </header>
                  <div className="wd-darci-body">
                    {darciMapping && (
                      <div className="wd-darci-map">
                        <div>
                          <div className="wd-darci-map-head">Mapping diagnostics</div>
                          <div className="wd-darci-map-cells">
                            <div className="wd-darci-cell">
                              <span className="wd-darci-cell-label">Agent</span>
                              <span className="wd-darci-cell-value">
                                {darciMapping.darciAgent?.id
                                  ? `#${darciMapping.darciAgent.id} · ${darciMapping.darciAgent.name}`
                                  : "missing"}
                              </span>
                            </div>
                            <div className="wd-darci-cell">
                              <span className="wd-darci-cell-label">Customer</span>
                              <span className="wd-darci-cell-value">
                                {darciMapping.proposed.customerId
                                  ? `#${darciMapping.proposed.customerId}`
                                  : `${darciMapping.customerCandidates.length} candidate${darciMapping.customerCandidates.length === 1 ? "" : "s"}`}
                              </span>
                            </div>
                            <div className="wd-darci-cell">
                              <span className="wd-darci-cell-label">Repos</span>
                              <span className="wd-darci-cell-value">
                                {darciMapping.proposed.relatedCode || "none"}
                              </span>
                            </div>
                          </div>
                          {darciMapping.proposed.blockers.length > 0 && (
                            <div className="wd-darci-blockers">
                              <strong>Blockers</strong>
                              {darciMapping.proposed.blockers.join(" · ")}
                            </div>
                          )}
                        </div>
                        <span
                          className={`wd-chip ${darciMapping.proposed.ready ? "is-signal" : "is-amber"}`}
                        >
                          <span className="wd-chip-dot" />
                          {darciMapping.proposed.ready ? "ready" : "needs mapping"}
                        </span>
                      </div>
                    )}

                    {darciHandoffs.length === 0 ? (
                      <div className="wd-empty">
                        No handoffs queued. Send a finding above to start an escalation.
                      </div>
                    ) : (
                      darciHandoffs.map((handoff) => {
                        const pipeIdx = PIPE_ORDER[handoff.status];
                        const isFailed = handoff.status === "failed" || handoff.status === "cancelled";
                        const canCreate =
                          !handoff.taskManagementId &&
                          ["queued", "failed"].includes(handoff.status) &&
                          Boolean(darciMapping?.proposed.ready);
                        return (
                          <article key={handoff.id} className="wd-handoff">
                            <div className="wd-handoff-head">
                              <span className="wd-handoff-id">handoff · {handoff.id.slice(0, 12)}</span>
                              <span className={`wd-chip wd-status wd-status-${handoff.status}`}>
                                <span className="wd-chip-dot" />
                                {handoff.status.replace("_", " ")}
                              </span>
                            </div>
                            <div className="wd-pipeline" aria-label="Handoff pipeline">
                              {PIPE_STAGES.map((stage, idx) => {
                                const stageClass = isFailed
                                  ? idx === Math.max(0, pipeIdx)
                                    ? "is-failed"
                                    : ""
                                  : idx < pipeIdx
                                  ? "is-complete"
                                  : idx === pipeIdx
                                  ? "is-active"
                                  : "";
                                return (
                                  <div key={stage.key} className={`wd-pipe-stage ${stageClass}`}>
                                    <div className="wd-pipe-dot">
                                      {isFailed && idx === Math.max(0, pipeIdx)
                                        ? "✗"
                                        : idx < pipeIdx
                                        ? "✓"
                                        : idx + 1}
                                    </div>
                                    <div className="wd-pipe-label">{stage.label}</div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="wd-handoff-meta-grid">
                              <div className="wd-handoff-meta-cell">
                                <span className="wd-handoff-meta-label">Findings</span>
                                <span className="wd-handoff-meta-value">{handoff.findingIds.length}</span>
                              </div>
                              <div className="wd-handoff-meta-cell">
                                <span className="wd-handoff-meta-label">Requested by</span>
                                <span className="wd-handoff-meta-value">{handoff.requestedByDisplay}</span>
                              </div>
                              {handoff.taskManagementId && (
                                <div className="wd-handoff-meta-cell">
                                  <span className="wd-handoff-meta-label">task_management</span>
                                  <span className="wd-handoff-meta-value">
                                    #{handoff.taskManagementId}
                                    {handoff.taskId ? ` · task #${handoff.taskId}` : ""}
                                  </span>
                                </div>
                              )}
                              {handoff.resultS3Key && (
                                <div className="wd-handoff-meta-cell">
                                  <span className="wd-handoff-meta-label">Result</span>
                                  <span
                                    className="wd-handoff-meta-value"
                                    title={`${handoff.resultS3Bucket}/${handoff.resultS3Key}`}
                                  >
                                    s3://{handoff.resultS3Bucket}/{handoff.resultS3Key}
                                  </span>
                                </div>
                              )}
                            </div>
                            <div className="wd-handoff-actions">
                              {handoff.taskManagementId ? (
                                <>
                                  <button
                                    type="button"
                                    className="wd-btn is-ghost"
                                    disabled={isBusy}
                                    onClick={() => handleSyncDarciHandoff(handoff.id)}
                                  >
                                    <span className="wd-btn-glyph">↻</span> Sync
                                  </button>
                                  {handoff.resultS3Bucket && handoff.resultS3Key && (
                                    <button
                                      type="button"
                                      className="wd-btn is-primary"
                                      disabled={isBusy}
                                      onClick={() => handleLoadDarciResult(handoff.id)}
                                    >
                                      <span className="wd-btn-glyph">▣</span> View result
                                    </button>
                                  )}
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className={`wd-btn ${canCreate ? "is-primary" : "is-ghost"}`}
                                  disabled={isBusy || !canCreate}
                                  onClick={() => handleCreateDarciTask(handoff.id)}
                                  title={
                                    canCreate
                                      ? "Create task_management entry for DARCI"
                                      : darciMapping?.proposed.ready
                                      ? "Handoff not in queued state"
                                      : "Resolve mapping blockers first"
                                  }
                                >
                                  <span className="wd-btn-glyph">⇢</span>{" "}
                                  {handoff.status === "failed" ? "Retry task" : "Create DARCI task"}
                                </button>
                              )}
                            </div>
                            {handoff.errorMessage && (
                              <div className="wd-handoff-error">{handoff.errorMessage}</div>
                            )}
                            {darciResults[handoff.id] && (
                              <MarkdownPreview markdown={darciResults[handoff.id]} />
                            )}
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              )}

              {taskTab === "evidence" && (
                <section className="wd-panel">
                  <header className="wd-section-head">
                    <div>
                      <div className="wd-section-kicker">Evidence</div>
                      <h2 className="wd-section-title">Artifacts <em>captured</em></h2>
                    </div>
                    <span className="wd-section-count">
                      {selectedEvidenceIds.length > 0
                        ? `${selectedEvidenceIds.length} linked`
                        : `${evidence.length} artifact${evidence.length === 1 ? "" : "s"}`}
                    </span>
                  </header>
                  <div className="wd-evidence-body">
                    {selectedEvidenceIds.length > 0 && (
                      <div className="wd-linked-evidence-banner">
                        Showing evidence linked from the selected finding.
                        <button type="button" onClick={() => setSelectedEvidenceIds([])}>Show all</button>
                      </div>
                    )}
                    {evidence.length === 0 ? (
                      <div className="wd-empty wd-empty-action">
                        <strong>No evidence artifacts yet</strong>
                        <span>Redacted metadata will appear here as soon as the run captures logs, counts, or timelines.</span>
                      </div>
                    ) : (
                      evidence.map((artifact) => {
                        const counts = evidenceSummaryCounts(artifact);
                        const totalMatches = counts.total_matches ?? counts.totalMatches;
                        const returnedSamples = counts.returned_samples ?? counts.returnedSamples;
                        const isLinked =
                          selectedEvidenceIds.length === 0 || selectedEvidenceIds.includes(artifact.id);
                        return (
                          <article key={artifact.id} className={`wd-evidence ${isLinked ? "is-linked" : "is-dimmed"}`}>
                            <div className="wd-evidence-head">
                              <h3 className="wd-evidence-title">{artifact.title}</h3>
                              <span className="wd-evidence-kind">{artifact.kind}</span>
                            </div>
                            <p className="wd-evidence-summary">
                              {artifact.summary || "Redacted evidence metadata persisted."}
                            </p>
                            <div className="wd-evidence-stats">
                              <div className="wd-evidence-stat">
                                <span className="wd-evidence-stat-label">Search</span>
                                <span className="wd-evidence-stat-value">
                                  {evidenceSourceRef(artifact).searchId?.slice(0, 10) || "n/a"}
                                </span>
                              </div>
                              <div className="wd-evidence-stat">
                                <span className="wd-evidence-stat-label">Matches</span>
                                <span className="wd-evidence-stat-value is-signal">
                                  {formatNumber(totalMatches)}
                                </span>
                              </div>
                              <div className="wd-evidence-stat">
                                <span className="wd-evidence-stat-label">Samples</span>
                                <span className="wd-evidence-stat-value">
                                  {formatNumber(returnedSamples)}
                                </span>
                              </div>
                              <div className="wd-evidence-stat">
                                <span className="wd-evidence-stat-label">Regions</span>
                                <span className="wd-evidence-stat-value">
                                  {Object.keys(counts.regions || {}).join(", ") || "n/a"}
                                </span>
                              </div>
                            </div>
                            <div className="wd-evidence-source">
                              source · {artifact.sourceTool || artifact.source_tool || "unknown"}
                              {artifact.hasPayload && (
                                <button
                                  type="button"
                                  className="wd-inline-action"
                                  disabled={isBusy}
                                  onClick={() => void handleViewEvidencePayload(artifact)}
                                >
                                  {evidencePayloads[artifact.id] ? "Hide payload" : "View payload"}
                                </button>
                              )}
                            </div>
                            {evidencePayloads[artifact.id] && (
                              <pre className="wd-evidence-payload">{evidencePayloads[artifact.id]}</pre>
                            )}
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              )}
            </>
          )}

          {view === "history" && (
            <>
              <header className="wd-masthead">
                <div className="wd-masthead-copy">
                  <div className="wd-eyebrow">
                    <span className="wd-pulse" />
                    <span>Ledger</span>
                  </div>
                  <h1 className="wd-title">Session <em>history</em></h1>
                  <p className="wd-lede">
                    Every Watchdog session ever sealed. Select one to restore its scope and resume
                    the durable event stream.
                  </p>
                </div>
              </header>

              <section className="wd-panel wd-history-panel">
                <header className="wd-section-head">
                  <div>
                    <div className="wd-section-kicker">Sessions</div>
                    <h2 className="wd-section-title">All runs</h2>
                  </div>
                  <span className="wd-section-count">
                    {sessions.length} total
                  </span>
                </header>
                {sessions.length === 0 ? (
                  <div className="wd-evidence-body">
                    <div className="wd-empty">No Watchdog sessions on record.</div>
                  </div>
                ) : (
                  <div className="wd-history-table">
                    <div className="wd-history-th">
                      <span>#</span>
                      <span>Title</span>
                      <span>Status</span>
                      <span>Mode</span>
                      <span>Updated</span>
                    </div>
                    {sessions.map((session, idx) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => selectSession(session)}
                        className={`wd-history-tr ${activeSession?.id === session.id ? "is-active" : ""}`}
                      >
                        <span className="wd-history-idx">
                          {String(sessions.length - idx).padStart(2, "0")}
                        </span>
                        <span className="wd-history-title" title={session.title}>
                          {session.title}
                        </span>
                        <span className={`wd-chip wd-status wd-status-${session.status}`}>
                          <span className="wd-chip-dot" />
                          {session.status}
                        </span>
                        <span className="wd-history-mode">{session.mode.replace("_", " ")}</span>
                        <span className="wd-history-updated" title={session.updatedAt}>
                          {formatRelative(session.updatedAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}

          {view === "catalog" && (
            <>
              <header className="wd-masthead">
                <div className="wd-masthead-copy">
                  <div className="wd-eyebrow">
                    <span className="wd-pulse" />
                    <span>Log catalog</span>
                  </div>
                  <h1 className="wd-title">Browse <em>log sources</em></h1>
                  <p className="wd-lede">
                    The MCP catalog of customers and their CloudWatch log sources. Pick a customer
                    to see which log groups the investigator can target.
                  </p>
                </div>
              </header>

              <div className="wd-catalog-grid">
                <section className="wd-panel">
                  <header className="wd-section-head">
                    <div>
                      <div className="wd-section-kicker">Customers</div>
                      <h2 className="wd-section-title">Clients</h2>
                    </div>
                    <span className="wd-section-count">{catalogClients.length}</span>
                  </header>
                  <div className="wd-catalog-clients">
                    {catalogClients.length === 0 ? (
                      <div className="wd-catalog-hint">Catalog unavailable — check MCP runtime.</div>
                    ) : (
                      catalogClients.map((client) => (
                        <button
                          key={client}
                          type="button"
                          className={`wd-catalog-client-btn ${catalogSelected === client ? "is-active" : ""}`}
                          onClick={() => setCatalogSelected(client)}
                        >
                          <span>{client}</span>
                          {catalogSelected === client && (
                            <span className="wd-btn-glyph" aria-hidden>▸</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                </section>

                <section className="wd-panel">
                  <header className="wd-section-head">
                    <div>
                      <div className="wd-section-kicker">Log sources</div>
                      <h2 className="wd-section-title">
                        {catalogSelected ? catalogSelected : "Select a customer"}
                      </h2>
                    </div>
                    <span className="wd-section-count">
                      {catalogSources.length} source{catalogSources.length === 1 ? "" : "s"}
                    </span>
                  </header>
                  {!catalogSelected ? (
                    <div className="wd-catalog-hint">
                      Pick a customer on the left to see its CloudWatch log sources across
                      environments and regions.
                    </div>
                  ) : catalogSources.length === 0 ? (
                    <div className="wd-catalog-hint">No sources returned for this customer.</div>
                  ) : (
                    <div className="wd-catalog-sources">
                      {catalogSources.map((source, idx) => {
                        const env = source.environment || "—";
                        const region = source.region || "—";
                        const name = source.log_group_name || source.logGroupName || "—";
                        const kind = source.component || source.log_type || source.logType || "log";
                        return (
                          <div key={`${name}-${idx}`} className="wd-catalog-source-row">
                            <span className="wd-catalog-source-region">{env}</span>
                            <span className="wd-catalog-source-region">{region}</span>
                            <span className="wd-catalog-source-name" title={name}>{name}</span>
                            <span className="wd-catalog-source-kind">{kind}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </main>
      </div>
      {awsSettingsOpen && (
        <div
          className="wd-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAwsSettingsOpen(false);
          }}
        >
          <section
            className="wd-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="watchdog-aws-settings-title"
          >
            <header className="wd-settings-head">
              <div>
                <div className="wd-panel-kicker">Runtime settings</div>
                <h2 id="watchdog-aws-settings-title">AWS PROD credentials</h2>
              </div>
              <button
                type="button"
                className="wd-modal-close"
                onClick={() => setAwsSettingsOpen(false)}
                aria-label="Close AWS credential settings"
              >
                ×
              </button>
            </header>
            <p className="wd-settings-copy">
              Paste read-only PROD credentials for CloudWatch MCP calls. Values are write-only:
              Watchdog validates and keeps them in memory, but never displays or persists them.
            </p>
            <form
              className="wd-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveAwsCredentials();
              }}
            >
              <label className="wd-field">
                <span className="wd-field-label">AWS account id</span>
                <input
                  className="wd-input is-mono"
                  value={awsCredentialDraft.awsAccountId}
                  onChange={(event) => setAwsCredentialDraft((current) => ({
                    ...current,
                    awsAccountId: event.target.value,
                  }))}
                  placeholder="239350186085"
                />
              </label>
              <label className="wd-field">
                <span className="wd-field-label">AWS access key id</span>
                <input
                  className="wd-input is-mono"
                  type="password"
                  autoComplete="off"
                  value={awsCredentialDraft.awsAccessKeyId}
                  onChange={(event) => setAwsCredentialDraft((current) => ({
                    ...current,
                    awsAccessKeyId: event.target.value,
                  }))}
                  placeholder="Paste access key id"
                />
              </label>
              <label className="wd-field">
                <span className="wd-field-label">AWS secret access key</span>
                <input
                  className="wd-input is-mono"
                  type="password"
                  autoComplete="off"
                  value={awsCredentialDraft.awsSecretAccessKey}
                  onChange={(event) => setAwsCredentialDraft((current) => ({
                    ...current,
                    awsSecretAccessKey: event.target.value,
                  }))}
                  placeholder="Paste secret access key"
                />
              </label>
              <label className="wd-field">
                <span className="wd-field-label">AWS session token</span>
                <input
                  className="wd-input is-mono"
                  type="password"
                  autoComplete="off"
                  value={awsCredentialDraft.awsSessionToken}
                  onChange={(event) => setAwsCredentialDraft((current) => ({
                    ...current,
                    awsSessionToken: event.target.value,
                  }))}
                  placeholder="Optional temporary session token"
                />
              </label>
              <div className="wd-settings-note">
                Session tokens may expire. If a run fails with expired credentials, update them here
                and rerun the task.
              </div>
              {awsCredentialStatus && (
                <div className="wd-settings-status">{awsCredentialStatus}</div>
              )}
              <div className="wd-settings-actions">
                <button
                  type="button"
                  className="wd-btn"
                  onClick={() => setAwsSettingsOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="wd-btn is-primary"
                  disabled={isBusy || !awsCredentialDraft.awsAccessKeyId || !awsCredentialDraft.awsSecretAccessKey}
                >
                  {isBusy ? "Validating…" : "Set runtime credentials"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
