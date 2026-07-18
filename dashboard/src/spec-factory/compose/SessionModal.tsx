import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  GitBranchPlus,
  Info,
  LockKeyhole,
  LockKeyholeOpen,
  Play,
  Search,
  Trash2,
  TrendingUp,
  UploadCloud,
} from "lucide-react";
import type { ComposeSessionSummary } from "./composeTypes.js";
import { formatSessionContextDescription } from "./sessionContext.js";

type Mode = "choose" | "new" | "load" | "about" | "upload";
type SessionStatusFilter = "all" | "draft" | "ready" | "handed_off";
type SessionSort = "recent" | "oldest" | "name";
const SESSION_PAGE_SIZE = 6;
type PasswordPrompt = {
  action: "resume" | "delete" | "export";
  session: ComposeSessionSummary;
  password: string;
} | null;

function sessionOwnerName(session: ComposeSessionSummary): string | null {
  return session.createdByDisplay?.trim() || session.createdBy?.trim() || null;
}

const SESSION_ACTION_LABELS: Record<string, string> = {
  analyze_requested: "Analyze requested",
  analyze_reset_requested: "Analyze reset",
  analyze_started: "Analyze running",
  analyze_completed: "Analyze complete",
  analyze_failed: "Analyze failed",
  chat_started: "Chat running",
  chat_completed: "Chat complete",
  chat_failed: "Chat failed",
  message_received: "Message received",
  note_source_added: "Note added",
  jira_source_added: "Jira added",
  confluence_source_added: "Confluence added",
  youtube_source_added: "YouTube added",
  upload_requested: "Upload requested",
  upload_confirmed: "Upload confirmed",
  source_deleted: "Source deleted",
  source_reconvert_queued: "Reconvert queued",
  failed_sources_reconvert_queued: "Retry queued",
  handoff_requested: "Handoff requested",
};

function sessionActivityLabel(session: ComposeSessionSummary): string | null {
  if (session.analysisRunning) return "Turn running";
  const action = session.lastAction?.trim();
  if (!action) return null;
  return SESSION_ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

function sessionUpdatedLabel(session: ComposeSessionSummary): string {
  const value = session.lastActiveAt || session.updatedAt;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Updated recently";
  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 60_000),
  );
  if (elapsedMinutes < 1) return "Updated just now";
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes} min ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Updated ${elapsedHours} hr${elapsedHours === 1 ? "" : "s"} ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `Updated ${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
  }
  return `Updated ${new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function sessionHomeStatus(session: ComposeSessionSummary): string {
  if (session.analysisRunning || session.contextStatus === "building") {
    return "In progress";
  }
  if (session.status === "ready") return "Draft ready";
  if (session.status === "handed_off") return "In review";
  return "In progress";
}

function sessionStatusLabel(session: ComposeSessionSummary): string {
  if (session.analysisRunning || session.contextStatus === "building") {
    return "In progress";
  }
  if (session.status === "ready") return "Ready";
  if (session.status === "handed_off") return "In review";
  return "Draft";
}

function sessionDecisionCount(session: ComposeSessionSummary): number {
  return (
    session.readiness?.questions?.filter(
      (question) => question.answered || Boolean(question.answer?.trim()),
    ).length ?? 0
  );
}

function sessionOpenQuestionCount(session: ComposeSessionSummary): number {
  const questions = session.readiness?.questions;
  if (questions?.length) {
    return questions.filter(
      (question) => !question.answered && !question.answer?.trim(),
    ).length;
  }
  return session.readiness?.openQuestions.length ?? 0;
}

function sessionDescription(session: ComposeSessionSummary): string {
  return (
    session.readiness?.problem?.trim() ||
    session.readiness?.summary?.trim() ||
    "Continue this workspace with its sources, decisions, and agent context intact."
  );
}

export function SessionModal({
  sessions,
  onCreate,
  onLoad,
  onDelete,
  onExport,
  onImport,
  errorMessage,
  initialMode = "choose",
}: {
  sessions: ComposeSessionSummary[];
  onCreate: (input: {
    name: string;
    userName?: string;
    password?: string;
  }) => void;
  onLoad: (sessionId: number, password?: string) => void;
  onDelete: (sessionId: number, password?: string) => void;
  onExport: (sessionId: number, password?: string) => void;
  onImport: (file: File) => void;
  errorMessage?: string | null;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState("");
  const [userName, setUserName] = useState("");
  const [password, setPassword] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<SessionStatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [sessionSort, setSessionSort] = useState<SessionSort>("recent");
  const [sessionPage, setSessionPage] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );

  const agentOptions = useMemo(
    () =>
      Array.from(
        new Set(
          sessions
            .map((session) => session.agentPersonaName?.trim())
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [sessions],
  );

  const matchingSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    const filtered = sessions.filter((session) => {
      const matchesQuery =
        !query ||
        [session.name, session.agentPersonaName, session.status]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(query));
      const matchesStatus =
        statusFilter === "all" || session.status === statusFilter;
      const matchesAgent =
        agentFilter === "all" || session.agentPersonaName === agentFilter;
      return matchesQuery && matchesStatus && matchesAgent;
    });
    return filtered.sort((a, b) => {
      if (sessionSort === "name") return a.name.localeCompare(b.name);
      const aTime = new Date(a.lastActiveAt || a.updatedAt).getTime();
      const bTime = new Date(b.lastActiveAt || b.updatedAt).getTime();
      const delta =
        (Number.isFinite(bTime) ? bTime : 0) -
        (Number.isFinite(aTime) ? aTime : 0);
      return sessionSort === "oldest" ? -delta : delta;
    });
  }, [agentFilter, sessionSearch, sessionSort, sessions, statusFilter]);

  const sessionPageCount = Math.max(
    1,
    Math.ceil(matchingSessions.length / SESSION_PAGE_SIZE),
  );
  const boundedSessionPage = Math.min(sessionPage, sessionPageCount - 1);
  const visibleSessionPage = matchingSessions.slice(
    boundedSessionPage * SESSION_PAGE_SIZE,
    (boundedSessionPage + 1) * SESSION_PAGE_SIZE,
  );
  const selectedSession =
    visibleSessionPage.find((session) => session.id === selectedSessionId) ??
    visibleSessionPage[0] ??
    null;

  function openNewSession(suggestedName = "") {
    setName(suggestedName);
    setMode("new");
  }

  // Escape key returns to 'choose' mode from 'new' or 'load' sub-modes.
  // When already in 'choose' mode, Escape is a no-op; users navigate via side-nav or backdrop click.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (passwordPrompt) {
        setPasswordPrompt(null);
        return;
      }
      setMode("choose");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [passwordPrompt, setMode]);

  function requestSessionAction(
    session: ComposeSessionSummary,
    action: "resume" | "delete" | "export",
  ) {
    if (session.passwordProtected) {
      setPasswordPrompt({ action, session, password: "" });
      return;
    }
    if (action === "resume") onLoad(session.id, undefined);
    else if (action === "delete") onDelete(session.id, undefined);
    else onExport(session.id, undefined);
  }

  function submitPasswordPrompt() {
    if (!passwordPrompt) return;
    const enteredPassword = passwordPrompt.password.trim();
    if (!enteredPassword) return;
    if (passwordPrompt.action === "resume") {
      onLoad(passwordPrompt.session.id, enteredPassword);
    } else if (passwordPrompt.action === "delete") {
      onDelete(passwordPrompt.session.id, enteredPassword);
    } else {
      onExport(passwordPrompt.session.id, enteredPassword);
    }
    setPasswordPrompt(null);
  }

  return (
    <div
      className="sf-compose-modal-backdrop"
      onMouseDown={() => setMode("choose")}
    >
      <div
        className={`sf-compose-session-modal${
          mode === "choose" ? " is-home" : mode === "load" ? " is-sessions" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Compose session"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="sf-compose-modal-brand">
          <span>
            <img
              className="sf-compose-modal-mhk-logo"
              src="/spec-factory/mhk-logo.png"
              alt="MHK"
            />
            <img
              className="sf-compose-modal-sf-logo"
              src="/spec-factory/sf-logo.png"
              alt="Spec Factory"
            />
          </span>
          {mode === "choose" ? (
            <button type="button" onClick={() => setMode("about")}>
              How it works
            </button>
          ) : mode === "load" ? (
            <button type="button" onClick={() => setMode("choose")}>
              Back to start
            </button>
          ) : null}
        </header>
        {errorMessage ? (
          <div className="sf-compose-modal-error" role="alert">
            {errorMessage}
          </div>
        ) : null}

        {mode === "choose" ? (
          <div className="sf-compose-home">
            <div className="sf-compose-home-intro">
              <span>Product discovery workspace</span>
              <h2>What would you like to shape?</h2>
              <p>
                Turn raw product intent into a source-backed, Jira-ready
                specification.
              </p>
            </div>
            <div className="sf-compose-home-surface">
              <section className="sf-compose-home-start">
                <h3>Start a new session</h3>
                <p>
                  Describe the capability, attach source material, and let the
                  agent team guide the product decisions.
                </p>
                <button
                  type="button"
                  className="sf-compose-home-primary"
                  onClick={() => openNewSession()}
                >
                  Start new session
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
                <div className="sf-compose-home-prompts">
                  <strong>Start from a prompt</strong>
                  <button
                    type="button"
                    onClick={() => openNewSession("New workflow")}
                  >
                    <GitBranchPlus size={17} aria-hidden="true" />
                    <span>Design a new workflow</span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewSession("Feature improvement")}
                  >
                    <TrendingUp size={17} aria-hidden="true" />
                    <span>Improve an existing feature</span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openNewSession("Change request")}
                  >
                    <FileText size={17} aria-hidden="true" />
                    <span>Turn a change request into stories</span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </section>
              <section className="sf-compose-home-recent">
                <header>
                  <h3>Recent sessions</h3>
                  <button type="button" onClick={() => setMode("load")}>
                    View all
                  </button>
                </header>
                <label className="sf-compose-session-search">
                  <Search size={17} aria-hidden="true" />
                  <input
                    aria-label="Find a recent session"
                    value={sessionSearch}
                    onChange={(event) => setSessionSearch(event.target.value)}
                    placeholder="Find a session..."
                  />
                </label>
                {matchingSessions.length > 0 ? (
                  <ul className="sf-compose-home-session-list">
                    {matchingSessions.slice(0, 3).map((session) => (
                      <li key={session.id}>
                        <button
                          type="button"
                          aria-label={`Resume ${session.name}`}
                          onClick={() => {
                            if (session.passwordProtected) setMode("load");
                            requestSessionAction(session, "resume");
                          }}
                        >
                          <FileText size={22} aria-hidden="true" />
                          <span>
                            <strong>
                              <i>Session #{session.id}</i>
                              {session.name}
                            </strong>
                            <small>
                              {sessionUpdatedLabel(session)} · {session.sourceCount}{" "}
                              source{session.sourceCount === 1 ? "" : "s"}
                            </small>
                          </span>
                          <b
                            className={`is-${session.status}`}
                          >
                            {sessionHomeStatus(session)}
                          </b>
                          <ArrowRight size={17} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="sf-compose-home-empty">
                    <FolderOpen size={22} aria-hidden="true" />
                    <p>
                      {sessions.length === 0
                        ? "Your recent sessions will appear here."
                        : "No sessions match that search."}
                    </p>
                  </div>
                )}
              </section>
              <footer className="sf-compose-home-footer">
                <button type="button" onClick={() => setMode("upload")}>
                  <UploadCloud size={17} aria-hidden="true" />
                  Upload session
                </button>
                <button type="button" onClick={() => setMode("about")}>
                  <Info size={17} aria-hidden="true" />
                  About Compose
                </button>
                <button type="button" onClick={() => setMode("load")}>
                  <FolderOpen size={17} aria-hidden="true" />
                  All sessions
                </button>
                <span>{sessions.length} saved sessions</span>
              </footer>
            </div>
          </div>
        ) : null}

        {mode === "new" ? (
          <form
            className="sf-compose-modal-new"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              onCreate({
                name: trimmed,
                userName: userName.trim() || undefined,
                password: password.trim() || undefined,
              });
            }}
          >
            <div className="sf-compose-modal-title">
              <h2>New Session</h2>
              <p>Name the idea, then add sources and clarify scope.</p>
            </div>
            <label htmlFor="sf-compose-session-name">
              Session name
              <input
                id="sf-compose-session-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Billing export workflow"
                autoFocus
              />
            </label>
            <label htmlFor="sf-compose-user-name">
              Your name (optional)
              <input
                id="sf-compose-user-name"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Used for session ownership"
              />
            </label>
            <label htmlFor="sf-compose-session-password">
              Session password (optional)
              <input
                id="sf-compose-session-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Require this password to resume or delete"
                autoComplete="new-password"
              />
            </label>
            <div className="sf-compose-modal-actions">
              <button type="button" onClick={() => setMode("choose")}>
                Back
              </button>
              <button type="submit" disabled={name.trim().length === 0}>
                Create session
              </button>
            </div>
          </form>
        ) : null}

        {mode === "load" ? (
          <div className="sf-compose-sessions">
            <div className="sf-compose-sessions-intro">
              <span>Saved workspaces</span>
              <h2>Resume a session</h2>
              <p>
                Continue where you left off with sources, decisions, and agent
                context intact.
              </p>
            </div>
            <div className="sf-compose-sessions-surface">
              <div className="sf-compose-sessions-toolbar">
                <label className="sf-compose-session-search is-load">
                  <Search size={17} aria-hidden="true" />
                  <input
                    aria-label="Search sessions"
                    value={sessionSearch}
                    onChange={(event) => {
                      setSessionSearch(event.target.value);
                      setSessionPage(0);
                      setSelectedSessionId(null);
                    }}
                    placeholder="Search sessions..."
                  />
                </label>
                <select
                  aria-label="Filter sessions by status"
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value as SessionStatusFilter);
                    setSessionPage(0);
                    setSelectedSessionId(null);
                  }}
                >
                  <option value="all">All statuses</option>
                  <option value="draft">Draft</option>
                  <option value="ready">Ready</option>
                  <option value="handed_off">In review</option>
                </select>
                <select
                  aria-label="Filter sessions by agent"
                  value={agentFilter}
                  onChange={(event) => {
                    setAgentFilter(event.target.value);
                    setSessionPage(0);
                    setSelectedSessionId(null);
                  }}
                >
                  <option value="all">All agents</option>
                  {agentOptions.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Sort sessions"
                  value={sessionSort}
                  onChange={(event) => {
                    setSessionSort(event.target.value as SessionSort);
                    setSessionPage(0);
                    setSelectedSessionId(null);
                  }}
                >
                  <option value="recent">Recently updated</option>
                  <option value="oldest">Oldest updated</option>
                  <option value="name">Name A–Z</option>
                </select>
                <span>{matchingSessions.length} sessions</span>
              </div>

              <div className="sf-compose-sessions-body">
                <section className="sf-compose-sessions-list-panel">
                  <h3>Recent sessions</h3>
                  {matchingSessions.length === 0 ? (
                    <div className="sf-compose-sessions-empty">
                      <FolderOpen size={24} aria-hidden="true" />
                      <p>
                        {sessions.length === 0
                          ? "No saved sessions yet."
                          : "No sessions match these filters."}
                      </p>
                    </div>
                  ) : (
                    <ul className="sf-compose-sessions-list">
                      {visibleSessionPage.map((session) => {
                        const persona = session.agentPersonaName?.trim();
                        return (
                          <li key={session.id}>
                            <button
                              type="button"
                              className={
                                selectedSession?.id === session.id
                                  ? "is-selected"
                                  : undefined
                              }
                              aria-label={`View ${session.name}`}
                              onClick={() => setSelectedSessionId(session.id)}
                            >
                              <FileText size={24} aria-hidden="true" />
                              <span>
                                <strong>{session.name}</strong>
                                <small>
                                  <span
                                    className={`sf-compose-session-lock ${
                                      session.passwordProtected
                                        ? "is-protected"
                                        : "is-open"
                                    }`}
                                    role="img"
                                    aria-label={
                                      session.passwordProtected
                                        ? "Password protected"
                                        : "No password"
                                    }
                                    title={
                                      session.passwordProtected
                                        ? "Password protected"
                                        : "No password"
                                    }
                                  >
                                    {session.passwordProtected ? (
                                      <LockKeyhole size={11} aria-hidden="true" />
                                    ) : (
                                      <LockKeyholeOpen size={11} aria-hidden="true" />
                                    )}
                                  </span>
                                  {sessionStatusLabel(session)} · {session.sourceCount}{" "}
                                  source{session.sourceCount === 1 ? "" : "s"}
                                  {persona ? ` · ${persona}` : ""}
                                </small>
                              </span>
                              <b className={`is-${session.status}`}>
                                {sessionStatusLabel(session)}
                              </b>
                              <time dateTime={session.lastActiveAt || session.updatedAt}>
                                {sessionUpdatedLabel(session)}
                              </time>
                              <ChevronRight size={18} aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <aside className="sf-compose-session-detail">
                  {selectedSession ? (
                    <>
                      <header>
                        <span>
                          <h3>{selectedSession.name}</h3>
                          <b className={`is-${selectedSession.status}`}>
                            {sessionStatusLabel(selectedSession)}
                          </b>
                        </span>
                        <p>
                          Session #{selectedSession.id} · {sessionUpdatedLabel(selectedSession)}
                        </p>
                      </header>
                      <p className="sf-compose-session-detail-summary">
                        {sessionDescription(selectedSession)}
                      </p>
                      <dl className="sf-compose-session-stats">
                        <div>
                          <dt>Sources</dt>
                          <dd>{selectedSession.sourceCount}</dd>
                        </div>
                        <div>
                          <dt>Decisions</dt>
                          <dd>{sessionDecisionCount(selectedSession)}</dd>
                        </div>
                        <div>
                          <dt>Open questions</dt>
                          <dd>{sessionOpenQuestionCount(selectedSession)}</dd>
                        </div>
                      </dl>
                      <section className="sf-compose-session-activity">
                        <h4>Last activity</h4>
                        <p>
                          <i aria-hidden="true" />
                          <span>
                            {(selectedSession.lastActor ||
                              selectedSession.agentPersonaName ||
                              "Agent") +
                              " · " +
                              (sessionActivityLabel(selectedSession) ||
                                "Workspace updated")}
                          </span>
                          <time
                            dateTime={
                              selectedSession.lastActiveAt || selectedSession.updatedAt
                            }
                          >
                            {sessionUpdatedLabel(selectedSession).replace("Updated ", "")}
                          </time>
                        </p>
                      </section>
                      <p className="sf-compose-session-context">
                        {formatSessionContextDescription(selectedSession) ||
                          "Context not generated"}
                        {selectedSession.agentPersonaName
                          ? ` · Agent: ${selectedSession.agentPersonaName}`
                          : ""}
                      </p>
                      <button
                        type="button"
                        className="sf-compose-session-resume"
                        aria-label={`Resume ${selectedSession.name}`}
                        onClick={() =>
                          requestSessionAction(selectedSession, "resume")
                        }
                      >
                        Resume session
                        <ArrowRight size={18} aria-hidden="true" />
                      </button>
                      <div className="sf-compose-session-secondary-actions">
                        <button
                          type="button"
                          aria-label={`Export ${selectedSession.name}`}
                          onClick={() =>
                            requestSessionAction(selectedSession, "export")
                          }
                        >
                          <Download size={15} aria-hidden="true" />
                          Export
                        </button>
                        <details>
                          <summary>
                            More actions
                            <ChevronDown size={15} aria-hidden="true" />
                          </summary>
                          <div>
                            <button
                              type="button"
                              className="is-danger"
                              aria-label={`Delete ${selectedSession.name}`}
                              onClick={() =>
                                requestSessionAction(selectedSession, "delete")
                              }
                            >
                              <Trash2 size={15} aria-hidden="true" />
                              Delete session
                            </button>
                          </div>
                        </details>
                      </div>
                    </>
                  ) : (
                    <div className="sf-compose-sessions-empty">
                      <FolderOpen size={24} aria-hidden="true" />
                      <p>Select a session to see its details.</p>
                    </div>
                  )}
                </aside>
              </div>

              <footer className="sf-compose-sessions-footer">
                <button type="button" onClick={() => setMode("upload")}>
                  <UploadCloud size={18} aria-hidden="true" />
                  Upload session
                </button>
                <span>Session retention: 30 days</span>
                <div>
                  <span>
                    {matchingSessions.length === 0
                      ? "0 of 0"
                      : `${boundedSessionPage * SESSION_PAGE_SIZE + 1}–${
                          boundedSessionPage * SESSION_PAGE_SIZE +
                          visibleSessionPage.length
                        } of ${matchingSessions.length}`}
                  </span>
                  <button
                    type="button"
                    aria-label="Previous page"
                    disabled={boundedSessionPage === 0}
                    onClick={() => {
                      setSessionPage((page) => Math.max(0, page - 1));
                      setSelectedSessionId(null);
                    }}
                  >
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next page"
                    disabled={boundedSessionPage >= sessionPageCount - 1}
                    onClick={() => {
                      setSessionPage((page) =>
                        Math.min(sessionPageCount - 1, page + 1),
                      );
                      setSelectedSessionId(null);
                    }}
                  >
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                </div>
              </footer>
            </div>
            {passwordPrompt ? (
              <div
                className="sf-compose-password-backdrop"
                role="presentation"
                onMouseDown={() => setPasswordPrompt(null)}
              >
                <form
                  className="sf-compose-password-popover"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="sf-compose-password-title"
                  onMouseDown={(e) => e.stopPropagation()}
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitPasswordPrompt();
                  }}
                >
                  <div className="sf-compose-modal-title">
                    <strong className="sf-compose-password-greeting">
                      {sessionOwnerName(passwordPrompt.session)
                        ? `Welcome back, ${sessionOwnerName(passwordPrompt.session)}`
                        : "Welcome back"}
                    </strong>
                    <h2 id="sf-compose-password-title">
                      {passwordPrompt.action === "resume"
                        ? "Resume protected session"
                        : passwordPrompt.action === "delete"
                          ? "Delete protected session"
                          : "Export protected session"}
                    </h2>
                    <p>{passwordPrompt.session.name}</p>
                  </div>
                  <label htmlFor="sf-compose-session-action-password">
                    Session password
                    <input
                      id="sf-compose-session-action-password"
                      type="password"
                      value={passwordPrompt.password}
                      onChange={(e) =>
                        setPasswordPrompt((prev) =>
                          prev ? { ...prev, password: e.target.value } : prev,
                        )
                      }
                      autoComplete="current-password"
                      autoFocus
                    />
                  </label>
                  <div className="sf-compose-modal-actions">
                    <button
                      type="button"
                      onClick={() => setPasswordPrompt(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={passwordPrompt.password.trim().length === 0}
                    >
                      {passwordPrompt.action === "resume"
                        ? "Resume session"
                        : passwordPrompt.action === "delete"
                          ? "Delete session"
                          : "Export session"}
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === "about" ? (
          <div className="sf-compose-modal-info">
            <div className="sf-compose-modal-title">
              <h2>About Compose</h2>
              <p>
                Compose gathers files, URLs, notes, and conversation into a
                handoff-ready Spec Factory draft.
              </p>
            </div>
            <ul>
              <li>Add source material.</li>
              <li>Sources are distilled into working context automatically.</li>
              <li>Clarify business goals and expected behavior.</li>
              <li>Approve code research when implementation evidence is needed.</li>
              <li>Send the result to the Spec Board.</li>
            </ul>
            <div className="sf-compose-modal-actions">
              <button type="button" onClick={() => setMode("choose")}>
                Back
              </button>
            </div>
          </div>
        ) : null}

        {mode === "upload" ? (
          <form
            className="sf-compose-modal-info"
            onSubmit={(e) => {
              e.preventDefault();
              if (importFile) onImport(importFile);
            }}
          >
            <div className="sf-compose-modal-title">
              <h2>Upload Session</h2>
              <p>Restore a saved Compose workspace bundle.</p>
            </div>
            <label htmlFor="sf-compose-session-import-file">
              Session bundle
              <input
                id="sf-compose-session-import-file"
                type="file"
                accept="application/json,.json"
                onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <div className="sf-compose-modal-placeholder">
              <UploadCloud size={34} aria-hidden="true" />
              <span>{importFile ? importFile.name : "No bundle selected"}</span>
            </div>
            <div className="sf-compose-modal-actions">
              <button type="button" onClick={() => setMode("choose")}>
                Back
              </button>
              <button type="submit" disabled={!importFile}>
                Import session
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
