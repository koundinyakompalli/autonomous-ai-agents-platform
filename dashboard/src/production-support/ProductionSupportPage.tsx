import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock3,
  Home,
  PackageSearch,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";
import "../watchdog/watchdog.css";
import "./production-support.css";

type SupportStatus =
  | "assigned"
  | "in_progress"
  | "posting_to_jira"
  | "completed"
  | "posted_to_jira"
  | "failed";

interface SupportAgent {
  id: number;
  name: string;
  task_type: string;
}

interface SupportTask {
  id: number;
  jira_number: string;
  status: SupportStatus;
  agent_id: number;
  agent_name: string;
  customer_name: string;
  branch: string;
  source: string;
  created_at: string;
  updated_at: string;
}

interface SupportStateResponse {
  agents: SupportAgent[];
  tasks: SupportTask[];
}

type StatusFilter = "all" | "active" | "failed" | "complete";

const ACTIVE_STATUSES: SupportStatus[] = [
  "assigned",
  "in_progress",
  "posting_to_jira",
];

const STATUS_LABEL: Record<SupportStatus, string> = {
  assigned: "Queued",
  in_progress: "Running",
  posting_to_jira: "Posting",
  completed: "Complete",
  posted_to_jira: "Posted",
  failed: "Failed",
};

function crossNavigate(
  path:
    | "/"
    | "/oneshot"
    | "/spec-factory"
    | "/production-support"
    | "/product-catalog"
    | "/watchdog",
) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function formatAge(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 3_600_000) return `${Math.round(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.round(deltaMs / 3_600_000)}h ago`;
  return `${Math.round(deltaMs / 86_400_000)}d ago`;
}

function statusTone(status: SupportStatus): "active" | "ok" | "bad" | "wait" {
  if (status === "failed") return "bad";
  if (status === "posted_to_jira" || status === "completed") return "ok";
  if (status === "assigned") return "wait";
  return "active";
}

function matchesFilter(task: SupportTask, filter: StatusFilter): boolean {
  if (filter === "active") return ACTIVE_STATUSES.includes(task.status);
  if (filter === "failed") return task.status === "failed";
  if (filter === "complete") {
    return task.status === "completed" || task.status === "posted_to_jira";
  }
  return true;
}

export function ProductionSupportPage() {
  const [tasks, setTasks] = useState<SupportTask[]>([]);
  const [agents, setAgents] = useState<SupportAgent[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadState() {
      try {
        const response = await fetch("/api/state");
        if (!response.ok) {
          throw new Error(`State API returned ${response.status}`);
        }
        const payload = (await response.json()) as SupportStateResponse;
        if (cancelled) return;
        setAgents(payload.agents ?? []);
        setTasks(payload.tasks ?? []);
        setLoadedAt(new Date().toISOString());
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Production Support state failed to load",
        );
      }
    }

    void loadState();
    const interval = window.setInterval(loadState, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const summary = useMemo(() => {
    const active = tasks.filter((task) => ACTIVE_STATUSES.includes(task.status));
    return {
      total: tasks.length,
      active: active.length,
      failed: tasks.filter((task) => task.status === "failed").length,
      posted: tasks.filter((task) => task.status === "posted_to_jira").length,
    };
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...tasks]
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )
      .filter((task) => matchesFilter(task, filter))
      .filter((task) => {
        if (!normalized) return true;
        return [
          task.jira_number,
          task.agent_name,
          task.customer_name,
          task.branch,
          task.status,
        ].some((value) => value.toLowerCase().includes(normalized));
      });
  }, [filter, query, tasks]);

  const supportAgentNames = useMemo(
    () =>
      agents
        .map((agent) => agent.name)
        .filter((name) =>
          ["DARCI", "HERMES", "WATCHDOG", "SRLOG", "SCRIBE"].includes(
            name.toUpperCase(),
          ),
        ),
    [agents],
  );

  return (
    <div className="wd-scope wd-theme-light ps-scope">
      <div className="ps-layout">
        <nav className="ps-nav" aria-label="Production Support navigation">
          <div className="ps-brand">
            <div className="ps-brand-mark">
              <ShieldCheck size={20} strokeWidth={1.8} />
            </div>
            <div>
              <div className="ps-brand-name">Production Support</div>
              <div className="ps-brand-tagline">Agent task command</div>
            </div>
          </div>

          <div className="ps-nav-group">
            <div className="ps-nav-label">Workspace</div>
            <button type="button" className="ps-nav-item is-active">
              <Activity size={16} strokeWidth={1.8} />
              <span>Tasks</span>
              <span className="ps-nav-count">{summary.active}</span>
            </button>
            <button type="button" className="ps-nav-item" onClick={() => setFilter("failed")}>
              <AlertTriangle size={16} strokeWidth={1.8} />
              <span>Failures</span>
              <span className="ps-nav-count">{summary.failed}</span>
            </button>
          </div>

          <div className="ps-nav-group">
            <div className="ps-nav-label">Specter</div>
            <button type="button" className="ps-nav-item" onClick={() => crossNavigate("/")}>
              <Home size={16} strokeWidth={1.8} />
              <span>Floor</span>
            </button>
            <button type="button" className="ps-nav-item" onClick={() => crossNavigate("/oneshot")}>
              <Target size={16} strokeWidth={1.8} />
              <span>OneShot</span>
            </button>
            <button type="button" className="ps-nav-item" onClick={() => crossNavigate("/spec-factory")}>
              <Sparkles size={16} strokeWidth={1.8} />
              <span>Spec Factory</span>
            </button>
            <button type="button" className="ps-nav-item" onClick={() => crossNavigate("/product-catalog")}>
              <PackageSearch size={16} strokeWidth={1.8} />
              <span>Product Catalog</span>
            </button>
            <button type="button" className="ps-nav-item" onClick={() => crossNavigate("/watchdog")}>
              <Search size={16} strokeWidth={1.8} />
              <span>Watchdog</span>
            </button>
          </div>

          <div className="ps-nav-foot">
            <div className="ps-runtime-label">Support agents</div>
            <div className="ps-runtime-list">
              {(supportAgentNames.length > 0
                ? supportAgentNames
                : ["DARCI", "HERMES"]
              ).map((name) => (
                <span key={name}>{name}</span>
              ))}
            </div>
          </div>
        </nav>

        <main className="ps-main" aria-label="Production Support">
          <header className="ps-header">
            <div>
              <div className="ps-kicker">Live task queue</div>
              <h1>Production Support</h1>
              <p>
                Current and recent agent work across DARCI, HERMES, Watchdog, and
                adjacent support agents.
              </p>
            </div>
            <div className="ps-header-meta">
              <Clock3 size={15} strokeWidth={1.8} />
              <span>{loadedAt ? `refreshed ${formatAge(loadedAt)}` : "loading"}</span>
            </div>
          </header>

          <section className="ps-stat-strip" aria-label="Production support metrics">
            <div className="ps-stat">
              <span>Total</span>
              <strong>{summary.total}</strong>
            </div>
            <div className="ps-stat">
              <span>Active</span>
              <strong>{summary.active}</strong>
            </div>
            <div className="ps-stat">
              <span>Posted</span>
              <strong>{summary.posted}</strong>
            </div>
            <div className="ps-stat">
              <span>Failed</span>
              <strong>{summary.failed}</strong>
            </div>
          </section>

          <section className="ps-task-panel" aria-label="Production support tasks">
            <div className="ps-toolbar">
              <label className="ps-search" aria-label="Search support tasks">
                <Search size={15} strokeWidth={1.8} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search ticket, agent, customer, branch, or status"
                />
              </label>
              <div className="ps-tabs" role="tablist" aria-label="Task filters">
                {(["all", "active", "failed", "complete"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={filter === value}
                    className={filter === value ? "is-active" : ""}
                    onClick={() => setFilter(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="ps-error" role="alert">
                {error}
              </div>
            )}

            <div className="ps-table">
              <div className="ps-table-head">
                <div>Status</div>
                <div>Ticket</div>
                <div>Agent</div>
                <div>Customer</div>
                <div>Branch</div>
                <div>Updated</div>
              </div>
              {visibleTasks.map((task) => (
                <div key={task.id} className="ps-table-row">
                  <div>
                    <span className={`ps-status ps-status-${statusTone(task.status)}`}>
                      {statusTone(task.status) === "ok" ? (
                        <CheckCircle2 size={13} strokeWidth={2} />
                      ) : (
                        <ClipboardList size={13} strokeWidth={2} />
                      )}
                      {STATUS_LABEL[task.status]}
                    </span>
                  </div>
                  <div className="ps-mono ps-ticket">{task.jira_number}</div>
                  <div>{task.agent_name}</div>
                  <div>{task.customer_name}</div>
                  <div className="ps-mono ps-branch">{task.branch}</div>
                  <div className="ps-mono ps-muted" title={task.updated_at}>
                    {formatAge(task.updated_at)}
                  </div>
                </div>
              ))}
              {visibleTasks.length === 0 && (
                <div className="ps-empty">No production support tasks match the current filters.</div>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
