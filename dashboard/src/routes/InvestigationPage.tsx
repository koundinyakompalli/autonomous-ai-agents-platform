import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BrainCircuit,
  Bot,
  Database,
  FileText,
  FileCode2,
  Filter,
  Orbit,
  Radar,
  Repeat2,
  ScanSearch,
  Search,
  ShieldCheck,
  TicketCheck,
} from "lucide-react";
import { DashboardNav } from "../components/DashboardNav.js";
import {
  approveInvestigationRecommendation,
  createMeridianDbaTicket,
  createInvestigationRun,
  escalateInvestigationRun,
  getInvestigationHealth,
  getInvestigationRun,
  listInvestigationRuns,
  postInvestigationSummary,
  subscribeInvestigationEvents,
  type InvestigationEvidenceAnalyzer,
  type InvestigationEnvironment,
  type InvestigationHealth,
  type InvestigationRun,
  type InvestigationStatus,
  type InvestigationTab,
} from "../investigation/api.js";
import "../investigation/investigation.css";

const TABS: InvestigationTab[] = [
  "overview",
  "lenses",
  "timeline",
  "findings",
  "evidence",
  "jira",
  "audit",
  "approvals",
];

const TAB_LABELS: Record<InvestigationTab, string> = {
  overview: "Overview",
  lenses: "Failure Lens",
  timeline: "Timeline",
  findings: "Findings",
  evidence: "Evidence",
  jira: "Jira",
  audit: "Audit",
  approvals: "Approvals",
};

const ANALYZER_STYLES = {
  llm: { label: "RCA Planner", icon: BrainCircuit },
  aws: { label: "AWS", icon: Radar },
  code: { label: "Code", icon: FileCode2 },
  data: { label: "Data", icon: Database },
  host: { label: "Host / SSM", icon: Bot },
} as const;

type DisplayAnalyzer = keyof typeof ANALYZER_STYLES;

function toneClass(status: InvestigationStatus): string {
  switch (status) {
    case "queued":
    case "waiting_for_target":
      return "inv-tone-amber";
    case "running":
      return "inv-tone-cyan";
    case "awaiting_review":
      return "inv-tone-amber";
    case "completed":
      return "inv-tone-green";
    case "escalated":
    case "failed":
      return "inv-tone-red";
  }
}

function statusTone(status: string): "green" | "amber" | "red" | "neutral" {
  const normalized = status.trim().toLowerCase();

  if (["ready", "healthy", "complete", "completed", "ok", "live"].includes(normalized)) {
    return "green";
  }

  if (["running", "waiting", "waiting_for_target", "pilot", "in_progress", "in progress", "queued", "degraded", "not_configured"].includes(normalized)) {
    return "amber";
  }

  if (["blocked", "failed", "error", "unavailable", "down", "expired"].includes(normalized)) {
    return "red";
  }

  return "neutral";
}

function displayFindingAnalyzer(finding: InvestigationRun["findings"][number]): DisplayAnalyzer {
  return finding.analyzer;
}

function displayEvidenceAnalyzer(artifact: InvestigationRun["evidence"][number]): DisplayAnalyzer {
  return artifact.analyzer;
}

function displayRunStatus(run: InvestigationRun): InvestigationStatus {
  return run.status;
}

function isTerminalRunStatus(status: InvestigationStatus): boolean {
  return status === "completed" || status === "escalated" || status === "failed";
}

function reconcileRunList(current: InvestigationRun[], incoming: InvestigationRun[]): InvestigationRun[] {
  const currentById = new Map(current.map((run) => [run.id, run]));
  return incoming.map((run) => {
    const existing = currentById.get(run.id);
    return existing && isTerminalRunStatus(existing.status) && !isTerminalRunStatus(run.status)
      ? existing
      : run;
  });
}

function isRecommendationApproved(run: InvestigationRun): boolean {
  return run.recommendation === "Recommendation approved and packaged for operator follow-through.";
}

function displayAnalyzersForRun(run: InvestigationRun): InvestigationRun["analyzers"] {
  const findingAnalyzers = run.findings.map(displayFindingAnalyzer);
  const evidenceAnalyzers = run.evidence.map(displayEvidenceAnalyzer);
  const observed = new Set<DisplayAnalyzer>([...findingAnalyzers, ...evidenceAnalyzers]);
  const byKey = new Map(run.analyzers.map((analyzer) => [analyzer.key, analyzer]));

  for (const key of observed) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        label: ANALYZER_STYLES[key].label,
        status: "complete",
        pulse: "warm",
        detail: "Evidence attached for this investigation lane.",
      });
    }
  }

  if (observed.has("host")) {
    byKey.set("host", {
      ...(byKey.get("host") || { key: "host", label: "Host / SSM", pulse: "warm" }),
      status: "complete",
      detail: "SSM host logs/runtime evidence support the failure pattern.",
    });
  }

  if (observed.has("code")) {
    byKey.set("code", {
      ...(byKey.get("code") || { key: "code", label: "Code", pulse: "warm" }),
      status: "complete",
      detail: "Code-path evidence was attached for this investigation.",
    });
  }

  const analyzerOrder: InvestigationEvidenceAnalyzer[] = [
    "llm",
    "aws",
    "host",
    "code",
    "data",
  ];
  return analyzerOrder
    .map((key) => byKey.get(key))
    .filter((entry): entry is InvestigationRun["analyzers"][number] => Boolean(entry));
}

function statusLabel(status: string): string {
  const normalized = status.trim().toLowerCase();

  if (["ready", "healthy", "complete", "completed", "ok", "live"].includes(normalized)) {
    return "complete";
  }

  if (["running", "waiting", "waiting_for_target", "pilot", "in_progress", "in progress", "queued"].includes(normalized)) {
    return "in progress";
  }

  if (["blocked", "failed", "error", "unavailable", "down", "expired"].includes(normalized)) {
    return "issue";
  }

  if (normalized === "not_configured") {
    return "needs config";
  }

  return status || "unknown";
}

function adapterLabel(key: string): string {
  if (key === "aws") return "AWS";
  if (key === "code") return "CODE";
  if (key === "data") return "DATA";
  if (key === "host") return "HOST";
  return key.toUpperCase();
}

function statusTitle(status: string): string {
  return `${statusLabel(status)} (${status || "unknown"})`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function runScopeText(run: InvestigationRun): string {
  return [
    run.client,
    run.releaseVersion ? `${run.environment} ${run.releaseVersion}` : run.environment,
    run.mode,
  ].join(" · ");
}

export function InvestigationPage() {
  const [runs, setRuns] = useState<InvestigationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<InvestigationRun | null>(null);
  const [health, setHealth] = useState<InvestigationHealth | null>(null);
  const [tab, setTab] = useState<InvestigationTab>("overview");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<InvestigationStatus | "all">("all");
  const [environmentFilter, setEnvironmentFilter] = useState<InvestigationEnvironment | "all">("all");
  const [newRunJiraKey, setNewRunJiraKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<"start" | "approve" | "escalate" | "post_jira" | "dba_ticket" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let syncing = false;

    const sync = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const [runsResponse, healthResponse] = await Promise.all([
          listInvestigationRuns(),
          getInvestigationHealth(),
        ]);
        if (cancelled) {
          return;
        }

        setRuns((current) => reconcileRunList(current, runsResponse.runs));
        setHealth(healthResponse);
        setError(null);

        const nextSelectedId = selectedRunId || runsResponse.runs[0]?.id || "";
        if (nextSelectedId && nextSelectedId !== selectedRunId) {
          setSelectedRunId(nextSelectedId);
        }
      } catch (syncError) {
        if (!cancelled) {
          setError(syncError instanceof Error ? syncError.message : "Failed to load investigation runs");
        }
      } finally {
        syncing = false;
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void sync();
    const timer = window.setInterval(() => void sync(), 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }

    let cancelled = false;
    let syncing = false;

    const syncSelectedRun = async () => {
      if (syncing) return;
      syncing = true;
      try {
        const run = await getInvestigationRun(selectedRunId);
        if (!cancelled) {
          setSelectedRun(run);
          setRuns((current) => current.some((candidate) => candidate.id === run.id)
            ? current.map((candidate) => candidate.id === run.id ? run : candidate)
            : [run, ...current]);
        }
      } catch (syncError) {
        if (!cancelled) {
          setError(syncError instanceof Error ? syncError.message : "Failed to load investigation detail");
        }
      } finally {
        syncing = false;
      }
    };

    void syncSelectedRun();
    const timer = window.setInterval(() => void syncSelectedRun(), 5_000);
    const stopStreaming = subscribeInvestigationEvents(selectedRunId, {
      onEvent: () => {
        void syncSelectedRun();
      },
      onError: () => {
        void syncSelectedRun();
      },
    });

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      stopStreaming();
    };
  }, [selectedRunId]);

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return runs.filter((run) => {
      if (statusFilter !== "all" && displayRunStatus(run) !== statusFilter) {
        return false;
      }
      if (environmentFilter !== "all" && run.environment !== environmentFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      return [run.jiraKey, run.title, run.client, run.environment]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [environmentFilter, query, runs, statusFilter]);

  const flightRuns = useMemo(
    () => filteredRuns.filter((run) => !["completed", "escalated", "failed"].includes(displayRunStatus(run))),
    [filteredRuns],
  );
  const recentRuns = useMemo(
    () => filteredRuns.filter((run) => ["completed", "escalated", "failed"].includes(displayRunStatus(run))).slice(0, 10),
    [filteredRuns],
  );
  const outstandingCapacity = health?.queue?.outstandingCapacity ?? 10;
  const outstandingRuns = health?.queue?.outstandingRuns ?? runs.filter(
    (run) => !["completed", "escalated", "failed"].includes(displayRunStatus(run)),
  ).length;

  useEffect(() => {
    const firstVisibleRun = flightRuns[0] ?? recentRuns[0];
    if (!selectedRunId && firstVisibleRun) {
      setSelectedRunId(firstVisibleRun.id);
      return;
    }

    if (selectedRunId && filteredRuns.length > 0 && !filteredRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(filteredRuns[0].id);
    }
  }, [filteredRuns, flightRuns, recentRuns, selectedRunId]);

  const activeRun = filteredRuns.find((run) => run.id === selectedRunId)
    ?? runs.find((run) => run.id === selectedRunId)
    ?? selectedRun;
  const detailRun = activeRun ?? selectedRun;

  const statusCounts = useMemo(() => ({
    queued: runs.filter((run) => displayRunStatus(run) === "queued").length,
    waitingForTarget: runs.filter((run) => displayRunStatus(run) === "waiting_for_target").length,
    running: runs.filter((run) => displayRunStatus(run) === "running").length,
    awaitingReview: runs.filter((run) => displayRunStatus(run) === "awaiting_review").length,
    completed: runs.filter((run) => displayRunStatus(run) === "completed").length,
    escalated: runs.filter((run) => displayRunStatus(run) === "escalated").length,
    failed: runs.filter((run) => displayRunStatus(run) === "failed").length,
  }), [runs]);

  const hottestRun = useMemo(() => [...runs].sort((left, right) => right.confidence - left.confidence)[0] ?? null, [runs]);

  const adapterHealthEntries = useMemo(
    () => Object.entries(health?.adapters ?? {}),
    [health],
  );

  const readyAdapterCount = useMemo(
    () => adapterHealthEntries.filter(([, adapter]) => adapter.status === "ready" || adapter.status === "healthy").length,
    [adapterHealthEntries],
  );

  const queuePressure = statusCounts.queued + statusCounts.waitingForTarget;
  const detailStatus = detailRun ? displayRunStatus(detailRun) : undefined;
  const detailAnalyzers = useMemo(() => (detailRun ? displayAnalyzersForRun(detailRun) : []), [detailRun]);
  const latestMeridianSqlArtifact = detailRun?.meridianSqlArtifacts?.[0] ?? null;
  const detailTicketContext = detailRun?.ticketContext?.fetchStatus === "fetched" ? detailRun.ticketContext : null;

  const applyRunUpdate = (updatedRun: InvestigationRun) => {
    setRuns((current) => {
      const next = current.some((run) => run.id === updatedRun.id)
        ? current.map((run) => (run.id === updatedRun.id ? updatedRun : run))
        : [updatedRun, ...current];
      return next;
    });
    setSelectedRun(updatedRun);
    setSelectedRunId(updatedRun.id);
  };

  const handleStartRun = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const jiraKey = newRunJiraKey.trim().toUpperCase();
    if (!jiraKey) {
      setError("Jira key is required to start an investigation.");
      return;
    }

    setActing("start");
    try {
      applyRunUpdate(await createInvestigationRun({
        jiraKey,
      }));
      setNewRunJiraKey("");
      setQuery("");
      setStatusFilter("all");
      setEnvironmentFilter("all");
      setTab("timeline");
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to start investigation");
    } finally {
      setActing(null);
    }
  };

  const handleApprove = async () => {
    if (!detailRun) return;
    if (isRecommendationApproved(detailRun)) return;
    setActing("approve");
    try {
      applyRunUpdate(await approveInvestigationRecommendation(detailRun.id));
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to approve recommendation");
    } finally {
      setActing(null);
    }
  };

  const handleEscalate = async () => {
    if (!detailRun) return;
    setActing("escalate");
    try {
      applyRunUpdate(await escalateInvestigationRun(detailRun.id));
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to escalate investigation");
    } finally {
      setActing(null);
    }
  };

  const handlePostSummary = async () => {
    if (!detailRun) return;
    setActing("post_jira");
    try {
      applyRunUpdate(await postInvestigationSummary(detailRun.id));
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to post Jira summary");
    } finally {
      setActing(null);
    }
  };

  const handleCreateDbaTicket = async () => {
    if (!detailRun || !latestMeridianSqlArtifact) return;
    setActing("dba_ticket");
    try {
      applyRunUpdate(await createMeridianDbaTicket(detailRun.id, latestMeridianSqlArtifact.id));
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Failed to create DBA ticket");
    } finally {
      setActing(null);
    }
  };

  return (
    <main className="inv-page">
      <div className="inv-atmosphere" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <header className="inv-header">
        <div>
          <p className="inv-kicker">Specter / Investigation Cockpit</p>
          <h1>Investigation Cockpit</h1>
          <p className="inv-subtitle">Bounded triage for AWS, code, and data.</p>
        </div>
      </header>

      <section className="inv-operations-theater">
        <article className="inv-briefing-panel">
          <div className="inv-briefing-top">
            <span>Operations Theater</span>
            <strong>{health?.status || "loading"}</strong>
          </div>
          <div className="inv-briefing-ribbon">
            <span>{runs.length} total runs</span>
            <span>{statusCounts.running} in motion</span>
            <span>{queuePressure} queued or throttled</span>
          </div>
          <div className="inv-briefing-callouts">
            <article>
              <div className="inv-callout-top">
                <Orbit size={16} />
                <span>Hottest run</span>
              </div>
              <strong>{hottestRun ? `${hottestRun.jiraKey} · ${Math.round(hottestRun.confidence * 100)}%` : "No active run"}</strong>
              <p>{hottestRun
                ? `${hottestRun.client} · ${hottestRun.environment} · ${displayRunStatus(hottestRun).replaceAll("_", " ")}`
                : "Waiting for investigation input."}</p>
            </article>
            <article>
              <div className="inv-callout-top">
                <ShieldCheck size={16} />
                <span>Queue pressure</span>
              </div>
              <strong>{queuePressure}</strong>
              <p>{health?.queue ? `${health.queue.queueDepth} queued · ${health.queue.activeWorkers}/${health.queue.workerConcurrency} workers · ${health.queue.throttleStore}` : "Waiting for worker capacity."}</p>
            </article>
            <article>
              <div className="inv-callout-top">
                <Activity size={16} />
                <span>Queue mix</span>
              </div>
              <strong>{statusCounts.queued} queued · {statusCounts.waitingForTarget} throttled · {statusCounts.running} running</strong>
              <p>{statusCounts.failed} failed · {statusCounts.awaitingReview} review · {statusCounts.escalated} escalated.</p>
            </article>
          </div>
        </article>

        <article className="inv-radar-panel inv-radar-panel-lanes">
          <div className="inv-radar-top">
            <Bot size={16} />
            <span>Lanes</span>
          </div>
          <div className="inv-lane-list">
            {adapterHealthEntries.map(([key, adapter]) => (
              <div key={key} className="inv-lane-item" title={`${adapterLabel(key)}: ${adapter.detail}`}>
                <strong>{adapterLabel(key)}</strong>
                <span
                  className={`inv-status-capsule inv-status-${statusTone(adapter.status)}`}
                  title={statusTitle(adapter.status)}
                  aria-label={`${adapterLabel(key)} ${statusTitle(adapter.status)}`}
                />
              </div>
            ))}
          </div>
        </article>

        <form className="inv-new-jira-run" onSubmit={handleStartRun}>
          <div className="inv-new-jira-copy">
            <Repeat2 size={16} />
            <h2>New Jira Run</h2>
            <div className="inv-session-status" title="SSH credentials are established by the attended launcher and are never stored with a ticket.">
              <ShieldCheck size={14} />
              <span>Session authentication</span>
            </div>
          </div>
          <div className="inv-new-jira-controls">
            <label className="inv-search-shell inv-jira-key-shell">
              <span className="inv-field-label">Jira key</span>
              <input
                value={newRunJiraKey}
                onChange={(event) => setNewRunJiraKey(event.target.value)}
                aria-label="Jira ticket"
                placeholder="CPSUP-12345"
              />
            </label>
            <button type="submit" className="inv-button inv-button-primary" disabled={acting !== null || outstandingRuns >= outstandingCapacity}>
              <Repeat2 size={16} />
              {acting === "start" ? "Starting..." : outstandingRuns >= outstandingCapacity ? "Queue full" : "Start run"}
            </button>
          </div>
        </form>
      </section>

      <section className="inv-command-line">
        <div className="inv-search-shell">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by ticket, client, title, or environment"
            aria-label="Search investigations"
          />
        </div>
        <div className="inv-command-filters">
          <div className="inv-select-shell">
            <Filter size={15} />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as InvestigationStatus | "all")}>
              <option value="all">all statuses</option>
              <option value="queued">queued</option>
              <option value="waiting_for_target">waiting for target</option>
              <option value="running">running</option>
              <option value="awaiting_review">awaiting review</option>
              <option value="completed">completed</option>
              <option value="escalated">escalated</option>
              <option value="failed">failed</option>
            </select>
          </div>
          <div className="inv-select-shell">
            <Activity size={15} />
            <select value={environmentFilter} onChange={(event) => setEnvironmentFilter(event.target.value as InvestigationEnvironment | "all")}>
              <option value="all">all environments</option>
              <option value="DEV">DEV</option>
              <option value="INT">INT</option>
              <option value="UAT">UAT</option>
              <option value="STAGE">STAGE</option>
              <option value="PROD-REPLICA">PROD-REPLICA</option>
            </select>
          </div>
        </div>
      </section>

      {error ? <div className="inv-panel" role="alert">{error}</div> : null}

      <section className="inv-layout">
        <aside className="inv-sidebar">
          <div className="inv-guardrail-line">
            <span>Guardrails</span>
            <strong>Lower env first. Approved endpoints only. Read-only identities only.</strong>
          </div>

          <div className="inv-sidebar-header inv-header-queue">
            <h2 className="inv-section-title">Flight Queue</h2>
            <span>{flightRuns.length}/{outstandingCapacity} active</span>
          </div>
          <div className="inv-run-list">
            {flightRuns.map((run) => (
              <button
                type="button"
                key={run.id}
                className={`inv-run-card ${detailRun?.id === run.id ? "is-active" : ""} ${toneClass(displayRunStatus(run))}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                <div className="inv-run-card-bar" />
                <div className="inv-run-card-body">
                  <div className="inv-run-card-top">
                    <strong>{run.jiraKey}</strong>
                    <span>{run.updatedAt}</span>
                  </div>
                  <h3>{run.title}</h3>
                  <p>{runScopeText(run)}</p>
                  <div className="inv-run-card-meta">
                    <span>{displayRunStatus(run).replace("_", " ")}</span>
                    <span>{Math.round(run.confidence * 100)}%</span>
                  </div>
                </div>
              </button>
            ))}
            {flightRuns.length === 0 ? <p className="inv-empty-queue">No outstanding investigations.</p> : null}
          </div>
          <div className="inv-sidebar-header inv-header-queue inv-recent-header">
            <h2 className="inv-section-title">Recent Investigations</h2>
            <span>{recentRuns.length} visible</span>
          </div>
          <div className="inv-run-list inv-recent-run-list">
            {recentRuns.map((run) => (
              <button
                type="button"
                key={run.id}
                className={`inv-run-card ${detailRun?.id === run.id ? "is-active" : ""} ${toneClass(displayRunStatus(run))}`}
                onClick={() => setSelectedRunId(run.id)}
              >
                <div className="inv-run-card-bar" />
                <div className="inv-run-card-body">
                  <div className="inv-run-card-top">
                    <strong>{run.jiraKey}</strong>
                    <span>{run.updatedAt}</span>
                  </div>
                  <h3>{run.title}</h3>
                  <div className="inv-run-card-meta">
                    <span>{displayRunStatus(run).replace("_", " ")}</span>
                    <span>{Math.round(run.confidence * 100)}%</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {detailRun ? (
          <section className="inv-detail">
            <div className={`inv-hero ${toneClass(detailStatus ?? detailRun.status)}`}>
              <div className="inv-hero-copy">
                <p>{runScopeText(detailRun)}</p>
                <h2>{detailRun.jiraKey} — {detailRun.title}</h2>
                <div className="inv-hero-ribbon">
                  <span>{detailRun.findings.length} findings</span>
                  <span>{detailRun.evidence.length} evidence artifacts</span>
                  <span>{detailRun.events.length} timeline events</span>
                  {detailRun.targetKey ? <span>{detailRun.targetKey}</span> : null}
                </div>
                {detailRun.throttleReason ? <div className="inv-throttle-note">{detailRun.throttleReason}</div> : null}
              </div>
              <div className="inv-hero-stats">
                <div>
                  <span>Status</span>
                  <strong>{(detailStatus ?? detailRun.status).replace("_", " ")}</strong>
                </div>
                <div>
                  <span>Queued</span>
                  <strong>{detailRun.queuedAt ? new Date(detailRun.queuedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "n/a"}</strong>
                </div>
                <div>
                  <span>Confidence</span>
                  <strong>{Math.round(detailRun.confidence * 100)}%</strong>
                </div>
                <div>
                  <span>Recommendation</span>
                  <strong>{detailRun.recommendation}</strong>
                </div>
              </div>
            </div>

            <div className="inv-tabs" role="tablist" aria-label="Investigation detail tabs">
              {TABS.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry}
                  className={[
                    tab === entry ? "is-active" : "",
                    entry === "lenses" ? "inv-tab-lens" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => setTab(entry)}
                >
                  {entry === "lenses" ? <ScanSearch className="inv-tab-icon" size={14} /> : null}
                  {TAB_LABELS[entry]}
                </button>
              ))}
            </div>

            {tab === "overview" ? (
              <div className="inv-overview-shell">
                <section className="inv-signal-ribbon inv-panel">
                  <div className="inv-panel-header inv-header-mission">
                    <h3>Mission Control</h3>
                    <span>operator shortcuts</span>
                  </div>
                  <div className="inv-signal-ribbon-grid">
                    <div className="inv-signal-cell">
                      <span>Suggested lane</span>
                      <strong>{detailRun.mode}</strong>
                      <p>Use this as the investigation anchor before branching to deeper probes.</p>
                    </div>
                    <div className="inv-signal-cell">
                      <span>Current verdict</span>
                      <strong>{detailRun.recommendation}</strong>
                      <p>Shows whether code evidence and read-only DB diagnostics completed for this run.</p>
                    </div>
                  </div>
                </section>

                <div className="inv-overview-grid">
                  <section className="inv-panel">
                    <div className="inv-panel-header inv-header-lanes">
                      <h3>Lane Array</h3>
                      <span>{health?.mode || "brokered"} runtime</span>
                    </div>
                    <div className="inv-analyzer-grid">
                      {detailAnalyzers.map((analyzer) => {
                        const style = ANALYZER_STYLES[analyzer.key as DisplayAnalyzer]
                          ?? { label: analyzer.label, icon: Bot };
                        const Icon = style.icon;
                        return (
                          <article key={analyzer.key} className={`inv-analyzer-card inv-analyzer-${analyzer.status}`}>
                            <div className="inv-analyzer-icon">
                              <Icon size={18} />
                            </div>
                            <div>
                              <div className="inv-analyzer-top">
                                <strong>{analyzer.label}</strong>
                                <span
                                  className={`inv-status-capsule inv-status-${statusTone(analyzer.status)}`}
                                  title={statusTitle(analyzer.status)}
                                  aria-label={`${analyzer.label} ${statusTitle(analyzer.status)}`}
                                />
                              </div>
                              <p>{analyzer.detail}</p>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>

                  <section className="inv-panel">
                    <div className="inv-panel-header inv-header-findings">
                      <h3>Top Findings</h3>
                      <span>current signals</span>
                    </div>
                    <div className="inv-beam">
                      {detailRun.findings.slice(0, 3).map((finding) => {
                        const analyzer = displayFindingAnalyzer(finding);
                        return (
                          <div key={finding.id} className={`inv-beam-node inv-severity-${finding.severity}`}>
                            <div className="inv-beam-node-top">
                              <span>{ANALYZER_STYLES[analyzer].label.toUpperCase()}</span>
                              <strong>{Math.round(finding.confidence * 100)}%</strong>
                            </div>
                            <h4>{finding.title}</h4>
                            <p>{finding.summary}</p>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>

              </div>
            ) : null}

            {tab === "lenses" ? (
              <div className="inv-failure-lens-shell">
                <section className="inv-panel inv-failure-lens-hero">
                  <div className="inv-failure-lens-mark">
                    <ScanSearch size={28} />
                  </div>
                  <div className="inv-failure-lens-copy">
                    <div className="inv-panel-header inv-header-lenses">
                      <h3>Failure Lens</h3>
                      <span>testable RCA hypotheses</span>
                    </div>
                    <p>
                      {detailTicketContext
                        ? `${detailRun.jiraKey} lens view uses fetched Jira metadata, comments, attachments, identifiers, and run evidence to keep hypotheses tied to this ticket.`
                        : "Failure lenses appear only after Cockpit has ticket context or run evidence that supports a specific diagnostic angle."}
                    </p>
                    <div className="inv-lens-recommendation">
                      <span>Current recommendation</span>
                      <strong>{detailRun.recommendation}</strong>
                    </div>
                    {detailTicketContext ? (
                      <div className="inv-ticket-context-strip" aria-label="Fetched Jira context">
                        <div>
                          <span>Jira status</span>
                          <strong>{detailTicketContext.statusName || "Unknown"}</strong>
                        </div>
                        <div>
                          <span>Comments</span>
                          <strong>{detailTicketContext.comments?.length ?? 0}</strong>
                        </div>
                        <div>
                          <span>Attachments</span>
                          <strong>{detailTicketContext.attachments?.length ?? 0}</strong>
                        </div>
                        <div>
                          <span>Identifiers</span>
                          <strong>{detailTicketContext.identifiers?.length ?? 0}</strong>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="inv-panel inv-lens-empty">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>No ticket-specific failure lens yet</strong>
                    <p>Cockpit has not received a configured failure lens for {detailRun.jiraKey}. Review the ticket context, evidence, and findings tabs for raw details.</p>
                  </div>
                </section>

              </div>
            ) : null}

            {tab === "timeline" ? (
              <section className="inv-panel">
                <div className="inv-panel-header inv-header-feed">
                  <h3>Run Feed</h3>
                  <span>SSE-style replay</span>
                </div>
                <div className="inv-timeline">
                  {detailRun.events.map((event) => (
                    <article key={event.id} className="inv-timeline-item">
                      <div className={`inv-timeline-dot inv-source-${event.analyzer ?? "system"}`} />
                      <div>
                        <div className="inv-timeline-top">
                          <strong>{event.title}</strong>
                          <span>{event.at}</span>
                        </div>
                        <p>{event.body}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {tab === "findings" ? (
              <section className="inv-findings-grid">
                {detailRun.findings.map((finding) => {
                  const analyzer = displayFindingAnalyzer(finding);
                  return (
                    <article key={finding.id} className={`inv-finding-card inv-severity-${finding.severity}`}>
                      <div className="inv-finding-top">
                        <span>{ANALYZER_STYLES[analyzer].label.toUpperCase()}</span>
                        <span>{finding.severity}</span>
                      </div>
                      <h3>{finding.title}</h3>
                      <p>{finding.summary}</p>
                      <div className="inv-finding-footer">
                        <strong>{Math.round(finding.confidence * 100)}% confidence</strong>
                        <span>{finding.requiresAction ?? "review"}</span>
                      </div>
                    </article>
                  );
                })}
              </section>
            ) : null}

            {tab === "evidence" ? (
              <section className="inv-evidence-grid">
                {detailRun.evidence.map((artifact) => {
                  const analyzer = displayEvidenceAnalyzer(artifact);
                  return (
                    <article key={artifact.id} className="inv-evidence-card">
                      <div className="inv-evidence-top">
                        <span>{ANALYZER_STYLES[analyzer].label.toUpperCase()}</span>
                        <code>{artifact.id}</code>
                      </div>
                      <h3>{artifact.title}</h3>
                      <p>{artifact.detail}</p>
                      <div className="inv-tag-row">
                        {artifact.meta.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                      {artifact.trace && artifact.trace.length > 0 ? (
                        <div className="inv-trace-list">
                          {artifact.trace.map((step) => (
                            <article key={`${artifact.id}-${step.title}`} className="inv-trace-step">
                              <strong>{step.title}</strong>
                              <p>{step.detail}</p>
                              {step.safeSql ? <pre>{step.safeSql}</pre> : null}
                              {typeof step.rowCount === "number" ? <span>{step.rowCount} rows</span> : null}
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </section>
            ) : null}

            {tab === "jira" ? (
              <section className="inv-panel">
                <div className="inv-panel-header inv-header-jira">
                  <h3>Jira Drafts</h3>
                  <span>redaction-first posting</span>
                </div>
                <div className="inv-jira-stack">
                  <div className="inv-jira-card">
                    <div className="inv-jira-top">
                      <strong>Client Summary</strong>
                      <span>{detailRun.jiraKey}</span>
                    </div>
                    <pre>{detailRun.jiraDraft.clientSummary}</pre>
                  </div>

                  <div className="inv-jira-card inv-jira-card-internal">
                    <div className="inv-jira-top">
                      <strong>Internal Analysis</strong>
                      <span>operator notes</span>
                    </div>
                    <pre>{detailRun.jiraDraft.internalAnalysis}</pre>
                  </div>

                  <div className="inv-jira-card inv-jira-card-remediation">
                    <div className="inv-jira-top">
                      <strong>Proposed Remediation</strong>
                      <span>internal only</span>
                    </div>
                    <div className="inv-remediation-stack">
                      {detailRun.jiraDraft.proposedRemediation.sqlCorrection ? (
                        <div className="inv-remediation-item">
                          <span>SQL correction</span>
                          <pre>{detailRun.jiraDraft.proposedRemediation.sqlCorrection}</pre>
                        </div>
                      ) : null}
                      {detailRun.jiraDraft.proposedRemediation.codeFix ? (
                        <div className="inv-remediation-item">
                          <span>Code fix</span>
                          <pre>{detailRun.jiraDraft.proposedRemediation.codeFix}</pre>
                        </div>
                      ) : null}
                      {detailRun.meridianSqlArtifacts?.length ? (
                        <div className="inv-remediation-item">
                          <span>Meridian SQL files</span>
                          <div className="inv-sql-artifact-list">
                            {detailRun.meridianSqlArtifacts.map((artifact) => (
                              <a
                                key={artifact.id}
                                className="inv-sql-artifact"
                                href={artifact.downloadPath}
                                download={artifact.filename}
                              >
                                <FileText size={16} />
                                <strong>{artifact.filename}</strong>
                                <small>
                                  {formatBytes(artifact.sizeBytes)} · {artifact.updateCount ?? 0} update(s) · sha256 {artifact.sha256.slice(0, 12)}
                                </small>
                              </a>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="inv-remediation-item">
                        <span>Validation notes</span>
                        <pre>{detailRun.jiraDraft.proposedRemediation.validationNotes}</pre>
                      </div>
                    </div>
                  </div>

                  <div className="inv-jira-top">
                    <strong>Posting</strong>
                    <button
                      type="button"
                      className="inv-button inv-button-secondary"
                      onClick={() => void handlePostSummary()}
                      disabled={acting !== null}
                    >
                      {acting === "post_jira" ? "Posting..." : "Post summary"}
                    </button>
                  </div>
                </div>
              </section>
            ) : null}

            {tab === "audit" ? (
              <section className="inv-panel">
                <div className="inv-panel-header inv-header-audit">
                  <h3>Audit Trail</h3>
                  <span>append-only</span>
                </div>
                <div className="inv-audit-list">
                  {detailRun.audit.map((entry) => (
                    <div key={entry} className="inv-audit-item">{entry}</div>
                  ))}
                </div>
              </section>
            ) : null}

            {tab === "approvals" ? (
              <section className="inv-panel">
                <div className="inv-panel-header inv-header-review">
                  <h3>Review Gate</h3>
                  <span>MVP-safe controls</span>
                </div>
                <div className="inv-approval-card">
                  <div className="inv-approval-copy">
                    <Bot size={18} />
                    <div>
                      <strong>Human review required</strong>
                      <p>{detailRun.approvalText ?? "No approval action is needed for this run."}</p>
                      {detailRun.dbaTicket ? (
                        <a className="inv-dba-ticket-link" href={detailRun.dbaTicket.url} target="_blank" rel="noreferrer">
                          {detailRun.dbaTicket.key} · {detailRun.dbaTicket.assignmentStatus} · {detailRun.dbaTicket.linkStatus}
                        </a>
                      ) : null}
                    </div>
                  </div>
                  <div className="inv-approval-actions">
                    {latestMeridianSqlArtifact || detailRun.dbaTicket ? (
                      <button
                        type="button"
                        className="inv-button inv-button-primary"
                        onClick={() => void handleCreateDbaTicket()}
                        disabled={acting !== null || Boolean(detailRun.dbaTicket)}
                      >
                        <TicketCheck size={16} />
                        {acting === "dba_ticket"
                          ? "Creating..."
                          : detailRun.dbaTicket
                            ? `DBA ticket ${detailRun.dbaTicket.key}`
                            : "Create DBA ticket"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="inv-button inv-button-secondary"
                      onClick={() => void handleApprove()}
                      disabled={acting !== null || isRecommendationApproved(detailRun)}
                    >
                      {acting === "approve"
                        ? "Approving..."
                        : isRecommendationApproved(detailRun)
                          ? "Approved"
                          : "Approve recommendation"}
                    </button>
                    <button
                      type="button"
                      className="inv-button inv-button-secondary"
                      onClick={() => void handleEscalate()}
                      disabled={acting !== null}
                    >
                      {acting === "escalate" ? "Escalating..." : "Escalate"}
                    </button>
                  </div>
                </div>
              </section>
            ) : null}
          </section>
        ) : (
          <section className="inv-detail inv-empty">
            <p>{loading ? "Loading investigations..." : "No runs match the current filters."}</p>
          </section>
        )}
      </section>

      <footer className="inv-footer">
        <DashboardNav
          currentPath="/investigation"
          onNavigate={() => undefined}
          items={[{ path: "/investigation", label: "Investigation Cockpit" }]}
        />
      </footer>
    </main>
  );
}
