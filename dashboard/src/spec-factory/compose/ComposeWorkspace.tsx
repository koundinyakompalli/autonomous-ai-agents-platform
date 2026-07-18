import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  MessageCircle,
  PanelLeft,
  PanelRight,
  Square,
  UserRound,
  X,
} from "lucide-react";
import * as composeApi from "./composeApi.js";
import { useComposeStream } from "./useComposeStream.js";
import { SessionModal } from "./SessionModal.js";
import { SourcesPanel } from "./SourcesPanel.js";
import { ChatPanel, type ComposeRetryStatus } from "./ChatPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { AddSourceModal } from "./AddSourceModal.js";
import { AgentPresence } from "./AgentPresence.js";
import { mergeContextReadiness } from "./contextProjection.js";
import { formatContextStatus, formatContextVersion } from "./sessionContext.js";
import type {
  ComposeChatMessage,
  ComposeCanonicalEvent,
  ComposeConversionStatus,
  ComposeContextProjection,
  ComposeBackgroundAgentState,
  ComposeHandoffResult,
  ComposeOpenQuestion,
  ComposeReadiness,
  ComposeSessionExportBundle,
  ComposeSessionSummary,
  ComposeSessionWorkflowState,
  ComposeSourceDeletionSummary,
  ComposeSourceSummary,
  ComposeStreamEvent,
} from "./composeTypes.js";

const SOURCE_POLL_MS = 3000;
const IN_FLIGHT_STATUSES = new Set<ComposeConversionStatus>([
  "awaiting_upload",
  "pending",
  "converting",
]);
const HANDOFF_BLOCKING_STATUSES = new Set<ComposeConversionStatus>([
  "awaiting_upload",
  "pending",
  "converting",
  "failed",
  "unsupported",
]);
const ACTIVE_TURN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_on_research",
  "awaiting_user_input",
  "synthesizing",
]);
const ACTIVE_HANDOFF_STATUSES = new Set([
  "requested",
  "snapshot_building",
  "snapshot_ready",
  "draft_queued",
  "drafting",
  "publishing",
]);
const CLARIFICATION_EXPIRED_CODE = "clarification_expired";
const CLARIFICATION_EXPIRED_MESSAGE =
  "Clarification expired. Send a new message to continue with fresh context.";

function workflowProgress(state: ComposeSessionWorkflowState): string | null {
  const turn = state.turn;
  if (turn && ACTIVE_TURN_STATUSES.has(turn.status)) {
    if (turn.status === "queued") {
      return turn.queuePosition
        ? `Waiting to start · ${turn.queuePosition} in line`
        : "Waiting to start...";
    }
    if (turn.status === "waiting_on_research") return "Researching...";
    if (turn.status === "awaiting_user_input") return "Waiting for your answer";
    if (turn.status === "synthesizing") return "Updating your brief...";
    return turn.kind === "analyze" ? "Reviewing sources..." : "Thinking...";
  }
  const handoff = state.handoff;
  if (!handoff) return null;
  if (handoff.workflowStage) return "Preparing your draft...";
  return ACTIVE_HANDOFF_STATUSES.has(handoff.status)
    ? "Preparing your draft..."
    : null;
}

const AGENT_LABEL = {
  sources: "Sources",
  requirements: "Requirements",
  research: "Research",
  draft: "Draft",
} as const;

function fallbackAgentActivity(stale: boolean): ComposeBackgroundAgentState[] {
  return Object.entries(AGENT_LABEL).map(([key, label]) => ({
    key: key as ComposeBackgroundAgentState["key"],
    label,
    status: stale ? "attention" : "waiting",
    detail: stale ? "Status unavailable" : "Loading status",
    activeCount: 0,
  }));
}

function newActionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function sourceLabel(source: ComposeSourceSummary): string {
  return source.originalFilename ?? `source-${source.id}`;
}

function isClearProblemStatement(value: string | null): value is string {
  if (!value) return false;
  const normalized = value.trim();
  if (normalized.length < 30 || normalized.split(/\s+/).length < 5) {
    return false;
  }
  return !/^(?:tbd|unknown|not established|needs? more (?:detail|information)|requires? clarification)\b/i.test(
    normalized,
  );
}

function handoffBlockedReason(sources: ComposeSourceSummary[]): string | null {
  const blocked = sources.filter((source) =>
    HANDOFF_BLOCKING_STATUSES.has(source.conversionStatus),
  );
  if (blocked.length === 0) return null;
  return `Resolve source status before generating: ${blocked
    .map((source) => `${sourceLabel(source)} (${source.conversionStatus})`)
    .join(", ")}`;
}

function safeFileStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "compose-session";
}

function clipboardFilename(mimeType: string): string {
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/gif"
          ? "gif"
          : mimeType === "application/pdf"
            ? "pdf"
            : "png";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `clipboard-${timestamp}.${extension}`;
}

function sameMessageContent(
  a: Pick<ComposeChatMessage, "role" | "content">,
  b: Pick<ComposeChatMessage, "role" | "content">,
): boolean {
  return a.role === b.role && a.content.trim() === b.content.trim();
}

function downloadBundle(
  session: ComposeSessionSummary,
  bundle: ComposeSessionExportBundle,
): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileStem(session.name)}-${session.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function mergeSessionSummary(
  current: ComposeSessionSummary,
  next: ComposeSessionSummary,
): ComposeSessionSummary {
  return {
    ...current,
    ...next,
    createdBy: next.createdBy ?? current.createdBy ?? null,
    createdByDisplay: next.createdByDisplay ?? current.createdByDisplay ?? null,
  };
}

function upsertSessionSummary(
  sessions: ComposeSessionSummary[],
  session: ComposeSessionSummary,
): ComposeSessionSummary[] {
  const exists = sessions.some((item) => item.id === session.id);
  if (!exists) return [session, ...sessions];
  return sessions.map((item) =>
    item.id === session.id ? mergeSessionSummary(item, session) : item,
  );
}

export function ComposeWorkspace({
  onHandoff,
  onViewEpic,
}: {
  onHandoff?: (result: ComposeHandoffResult) => void | Promise<void>;
  onViewEpic?: (sourceId: number) => void | Promise<void>;
} = {}) {
  const [sessions, setSessions] = useState<ComposeSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionPickerMode, setSessionPickerMode] = useState<"choose" | "load">(
    "choose",
  );
  const [sources, setSources] = useState<ComposeSourceSummary[]>([]);
  const [sourceDeletions, setSourceDeletions] = useState<
    ComposeSourceDeletionSummary[]
  >([]);
  const sourceRefreshGenerationRef = useRef(0);
  const sourceDeletionRefreshGenerationRef = useRef(0);
  const deletedSourceCacheRef = useRef(new Map<number, ComposeSourceSummary>());
  const [messages, setMessages] = useState<ComposeChatMessage[]>([]);
  const [readiness, setReadiness] = useState<ComposeReadiness | null>(null);
  const [contextProjection, setContextProjection] =
    useState<ComposeContextProjection | null>(null);
  const [streamToken, setStreamToken] = useState<string | null>(null);
  const streamTokenRef = useRef<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [activeQuestion, setActiveQuestion] =
    useState<ComposeOpenQuestion | null>(null);
  const [chatPoppedOut, setChatPoppedOut] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [clarificationExpiredMessage, setClarificationExpiredMessage] =
    useState<string | null>(null);
  const [retryStatus, setRetryStatus] = useState<ComposeRetryStatus | null>(
    null,
  );
  const [researchStarting, setResearchStarting] = useState(false);
  const [dismissedResearchContextVersion, setDismissedResearchContextVersion] =
    useState<number | null>(null);
  const [handingOff, setHandingOff] = useState(false);
  const [workflowState, setWorkflowState] =
    useState<ComposeSessionWorkflowState | null>(null);
  const workflowStateRef = useRef<ComposeSessionWorkflowState | null>(null);
  const [workflowStateStale, setWorkflowStateStale] = useState(false);
  const [cancellingTurn, setCancellingTurn] = useState(false);
  const [draftAnywayConfirmOpen, setDraftAnywayConfirmOpen] = useState(false);
  const [addSourcesOpen, setAddSourcesOpen] = useState(false);
  const [pasteSourceBusy, setPasteSourceBusy] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"sources" | "chat" | "brief">(
    "chat",
  );
  const [error, setError] = useState<string | null>(null);
  const localMessageId = useRef(-1);
  const handoffActionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    streamTokenRef.current = streamToken;
  }, [streamToken]);

  useEffect(() => {
    composeApi
      .listSessions()
      .then(setSessions)
      .catch(() => undefined);
  }, []);

  const refreshSources = useCallback(
    async (id: number, token?: string | null) => {
      const generation = ++sourceRefreshGenerationRef.current;
      try {
        const nextSources = await composeApi.listSources(
          id,
          token ?? streamTokenRef.current,
        );
        if (generation === sourceRefreshGenerationRef.current) {
          setSources(nextSources);
        }
      } catch {
        /* keep last */
      }
    },
    [],
  );

  const refreshSourceDeletions = useCallback(
    async (id: number, token?: string | null) => {
      const generation = ++sourceDeletionRefreshGenerationRef.current;
      try {
        const nextDeletions = await composeApi.listSourceDeletions(
          id,
          token ?? streamTokenRef.current,
        );
        if (generation === sourceDeletionRefreshGenerationRef.current) {
          setSourceDeletions(nextDeletions);
        }
      } catch {
        /* keep last */
      }
    },
    [],
  );

  const createLocalMessage = useCallback(
    (
      id: number,
      role: ComposeChatMessage["role"],
      content: string,
    ): ComposeChatMessage => ({
      id: localMessageId.current--,
      sessionId: id,
      role,
      content,
      createdAt: new Date().toISOString(),
    }),
    [],
  );

  const refreshMessages = useCallback(
    async (id: number, token?: string | null) => {
      try {
        const persisted = await composeApi.listMessages(
          id,
          token ?? streamTokenRef.current,
        );
        setMessages((prev) => {
          const localOnly = prev.filter(
            (message) =>
              message.id < 0 &&
              message.sessionId === id &&
              !persisted.some((persistedMessage) =>
                sameMessageContent(persistedMessage, message),
              ),
          );
          return [...persisted, ...localOnly];
        });
      } catch {
        /* keep last */
      }
    },
    [],
  );

  const refreshContext = useCallback(
    async (
      id: number,
      token?: string | null,
    ): Promise<ComposeContextProjection | null> => {
      try {
        const projection = await composeApi.getContextProjection(
          id,
          token ?? streamTokenRef.current,
        );
        setContextProjection(projection);
        setReadiness((current) => mergeContextReadiness(current, projection));
        return projection;
      } catch {
        return null;
      }
    },
    [],
  );

  const refreshSessionReadiness = useCallback(
    async (id: number, token?: string | null) => {
      try {
        const session = await composeApi.getSession(
          id,
          token ?? streamTokenRef.current,
        );
        setSessions((prev) => upsertSessionSummary(prev, session));
        setReadiness(session.readiness ?? null);
        setActiveQuestion((prev) =>
          prev && session.readiness
            ? (session.readiness.questions?.find(
                (question) => question.id === prev.id,
              ) ?? null)
            : null,
        );
      } catch {
        /* keep last */
      }
    },
    [],
  );

  const applyWorkflowState = useCallback(
    (state: ComposeSessionWorkflowState) => {
      const previous = workflowStateRef.current;
      workflowStateRef.current = state;
      setWorkflowState(state);
      setWorkflowStateStale(false);
      const turnActive = Boolean(
        state.turn && ACTIVE_TURN_STATUSES.has(state.turn.status),
      );
      setThinking(turnActive);
      setHandingOff(
        Boolean(
          state.handoff &&
          (ACTIVE_HANDOFF_STATUSES.has(state.handoff.status) ||
            state.handoff.workflowStatus === "queued" ||
            state.handoff.workflowStatus === "running"),
        ),
      );
      setProgressMessage(workflowProgress(state));
      const sameSession = previous?.sessionId === state.sessionId;
      const clarificationExpiredIsCurrent = Boolean(
        state.turn?.status === "abandoned" &&
        state.turn.errorCode === CLARIFICATION_EXPIRED_CODE,
      );
      const clarificationExpiredBecameCurrent = Boolean(
        sameSession &&
        clarificationExpiredIsCurrent &&
        (previous?.turn?.id !== state.turn?.id ||
          previous?.turn?.status !== "abandoned" ||
          previous?.turn?.errorCode !== CLARIFICATION_EXPIRED_CODE),
      );
      if (!sameSession || !clarificationExpiredIsCurrent) {
        setClarificationExpiredMessage(null);
        setError((current) =>
          current === CLARIFICATION_EXPIRED_MESSAGE ? null : current,
        );
      }
      const turnFailureBecameCurrent = Boolean(
        sameSession &&
        state.turn?.status === "failed" &&
        state.turn.errorMessage &&
        (previous?.turn?.id !== state.turn.id ||
          previous.turn.status !== "failed"),
      );
      const handoffFailureBecameCurrent = Boolean(
        sameSession &&
        state.handoff?.errorMessage &&
        (previous?.handoff?.id !== state.handoff.id ||
          previous.handoff.errorMessage !== state.handoff.errorMessage),
      );
      if (clarificationExpiredBecameCurrent) {
        setClarificationExpiredMessage(CLARIFICATION_EXPIRED_MESSAGE);
        setError(CLARIFICATION_EXPIRED_MESSAGE);
      } else if (turnFailureBecameCurrent && state.turn?.errorMessage) {
        setError(
          workflowErrorMessage(state.turn.errorCode, state.turn.errorMessage),
        );
      } else if (handoffFailureBecameCurrent && state.handoff?.errorMessage) {
        setError(
          workflowErrorMessage(
            state.handoff.errorCode,
            state.handoff.errorMessage,
          ),
        );
      }
    },
    [],
  );

  const refreshWorkflowState = useCallback(
    async (id: number, token?: string | null) => {
      try {
        applyWorkflowState(
          await composeApi.getWorkflowState(
            id,
            token ?? streamTokenRef.current,
          ),
        );
      } catch {
        setWorkflowStateStale(true);
      }
    },
    [applyWorkflowState],
  );

  // poll sources while any are in-flight
  useEffect(() => {
    if (sessionId === null) return;
    const anyInFlight = sources.some((s) =>
      IN_FLIGHT_STATUSES.has(s.conversionStatus),
    );
    if (!anyInFlight) return;
    const t = setInterval(() => void refreshSources(sessionId), SOURCE_POLL_MS);
    return () => clearInterval(t);
  }, [sessionId, sources, refreshSources]);

  useEffect(() => {
    if (!chatPoppedOut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChatPoppedOut(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [chatPoppedOut]);

  const onStreamEvent = useCallback(
    (event: ComposeStreamEvent) => {
      if (event.type === "status") {
        const isThinking = event.status === "thinking";
        const isRetrying = event.status === "retrying";
        setThinking(isThinking || isRetrying);
        if (isRetrying) {
          setRetryStatus({
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            nextRetryInSeconds: event.nextRetryInSeconds,
            message: event.message ?? null,
          });
          setProgressMessage(event.message ?? null);
        } else if (isThinking) {
          setRetryStatus(null);
          setProgressMessage(event.message ?? null);
        } else {
          setRetryStatus(null);
          setProgressMessage(null);
        }
        if (event.status === "error" && event.message) {
          const recoverableTransportError =
            event.code === "payload_too_large" ||
            event.code === "event_persist_failed";
          if (event.code === CLARIFICATION_EXPIRED_CODE && sessionId !== null) {
            // The status frame has no turn id and may be delayed or replayed.
            // Only authoritative workflow state may decide whether this expiry
            // belongs to the current turn and should be shown to the user.
            void refreshWorkflowState(sessionId);
          } else if (recoverableTransportError && sessionId !== null) {
            void refreshMessages(sessionId);
            void refreshSessionReadiness(sessionId);
            void refreshContext(sessionId);
            void refreshWorkflowState(sessionId);
          } else {
            setError(workflowErrorMessage(event.code, event.message));
          }
        }
      } else if (event.type === "message") {
        if (sessionId !== null) {
          const localMessage = createLocalMessage(
            sessionId,
            event.role,
            event.content,
          );
          setMessages((prev) => {
            if (
              prev.some(
                (message) =>
                  message.sessionId === sessionId &&
                  sameMessageContent(message, localMessage),
              )
            ) {
              return prev;
            }
            return [...prev, localMessage];
          });
          void refreshMessages(sessionId);
        }
      } else if (event.type === "readiness") {
        setReadiness(event.readiness);
        setActiveQuestion((prev) =>
          prev
            ? (event.readiness.questions?.find((q) => q.id === prev.id) ?? null)
            : prev,
        );
      } else if (event.type === "invalidate" && sessionId !== null) {
        if (event.resource === "messages") {
          void refreshMessages(sessionId);
        } else {
          void refreshSessionReadiness(sessionId);
        }
      }
    },
    [
      createLocalMessage,
      sessionId,
      refreshMessages,
      refreshSessionReadiness,
      refreshContext,
      refreshWorkflowState,
    ],
  );

  const onCanonicalEvent = useCallback(
    (event: ComposeCanonicalEvent) => {
      if (sessionId === null || event.sessionId !== sessionId) return;
      if (
        event.eventType.startsWith("turn.") ||
        event.eventType.startsWith("handoff.") ||
        event.eventType.startsWith("draft.") ||
        event.eventType.startsWith("task.") ||
        event.eventType.startsWith("context.") ||
        event.eventType === "readiness.updated"
      ) {
        void refreshWorkflowState(sessionId);
      }
      if (
        event.eventType.startsWith("context.") ||
        event.eventType.startsWith("source.distillation.") ||
        event.eventType === "source.deleted" ||
        event.eventType === "source.invalidated" ||
        event.eventType === "source.restored" ||
        event.eventType === "source.purged" ||
        event.eventType.startsWith("task.")
      ) {
        void refreshContext(sessionId);
        void refreshSources(sessionId);
        void refreshSourceDeletions(sessionId);
      }
    },
    [
      sessionId,
      refreshContext,
      refreshSources,
      refreshSourceDeletions,
      refreshWorkflowState,
    ],
  );

  useEffect(() => {
    if (sessionId === null) return;
    const active = Boolean(
      (workflowState?.turn &&
        ACTIVE_TURN_STATUSES.has(workflowState.turn.status)) ||
      (workflowState?.handoff &&
        (ACTIVE_HANDOFF_STATUSES.has(workflowState.handoff.status) ||
          workflowState.handoff.workflowStatus === "queued" ||
          workflowState.handoff.workflowStatus === "running")) ||
      workflowState?.agents?.some((agent) => agent.status === "working"),
    );
    if (!active) return;
    const timer = setInterval(
      () => void refreshWorkflowState(sessionId),
      2_000,
    );
    return () => clearInterval(timer);
  }, [sessionId, workflowState, refreshWorkflowState]);

  useEffect(() => {
    const handoff = workflowState?.handoff;
    if (!handoff) return;
    const active =
      ACTIVE_HANDOFF_STATUSES.has(handoff.status) ||
      handoff.workflowStatus === "queued" ||
      handoff.workflowStatus === "running";
    if (!active) handoffActionKeyRef.current = null;
  }, [workflowState]);

  const clearTransientStreamState = useCallback(() => {
    setThinking(false);
    setProgressMessage(null);
    setRetryStatus(null);
  }, []);

  const onStreamReconnect = useCallback(() => {
    if (sessionId === null) return;
    // EventSource auto-reconnects; reconcile authoritative workflow rows before
    // changing any in-progress state.
    void refreshMessages(sessionId);
    void refreshWorkflowState(sessionId);
    void composeApi
      .resumeSession(sessionId)
      .then(async (session) => {
        setStreamToken(session.streamToken ?? null);
        setSessions((prev) => upsertSessionSummary(prev, session));
        if (session.readiness) {
          setReadiness(session.readiness);
          return;
        }
        await refreshContext(sessionId, session.streamToken ?? null);
      })
      .catch(() => {
        /* keep last */
      });
  }, [sessionId, refreshMessages, refreshContext, refreshWorkflowState]);

  useComposeStream(
    sessionId,
    onStreamEvent,
    {
      onOpen: onStreamReconnect,
      onCanonicalEvent,
    },
    streamToken,
  );

  const openSession = useCallback(
    async (id: number, password?: string) => {
      setError(null);
      setClarificationExpiredMessage(null);
      try {
        const session = await composeApi.resumeSession(id, password);
        setStreamToken(session.streamToken ?? null);
        setSessions((prev) => upsertSessionSummary(prev, session));
        workflowStateRef.current = null;
        setSessionId(id);
        setMobilePanel("chat");
        deletedSourceCacheRef.current.clear();
        setWorkflowState(null);
        setWorkflowStateStale(false);
        setContextProjection(null);
        setReadiness(session.readiness ?? null);
        const token = session.streamToken ?? null;
        await Promise.all([
          refreshSources(id, token),
          refreshSourceDeletions(id, token),
          refreshMessages(id, token),
          refreshWorkflowState(id, token),
          refreshContext(id, token),
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to resume session");
      }
    },
    [
      refreshSources,
      refreshSourceDeletions,
      refreshMessages,
      refreshContext,
      refreshWorkflowState,
    ],
  );

  const handleCreate = useCallback(
    async (input: { name: string; userName?: string; password?: string }) => {
      try {
        const session = await composeApi.createSession(input);
        setSessions((prev) => [session, ...prev]);
        await openSession(session.id, input.password);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create session");
      }
    },
    [openSession],
  );

  const handleDeleteSession = useCallback(
    async (id: number, password?: string) => {
      try {
        setError(null);
        await composeApi.deleteSession(id, password);
        setSessions((prev) => prev.filter((session) => session.id !== id));
        if (sessionId === id) {
          workflowStateRef.current = null;
          sourceRefreshGenerationRef.current += 1;
          sourceDeletionRefreshGenerationRef.current += 1;
          deletedSourceCacheRef.current.clear();
          setSessionId(null);
          setSources([]);
          setSourceDeletions([]);
          setMessages([]);
          setReadiness(null);
          setContextProjection(null);
          setStreamToken(null);
          setActiveQuestion(null);
          setChatPoppedOut(false);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to delete session");
      }
    },
    [sessionId],
  );

  const handleExportSession = useCallback(
    async (id: number, password?: string) => {
      try {
        setError(null);
        const session = sessions.find((item) => item.id === id);
        const bundle = await composeApi.exportSession(id, password);
        downloadBundle(
          session ?? {
            id,
            name: bundle.session.name,
            status: "draft",
            sourceId: null,
            readiness: bundle.session.readiness,
            sourceCount: bundle.sources.length,
            passwordProtected: false,
            createdAt: bundle.exportedAt,
            updatedAt: bundle.exportedAt,
          },
          bundle,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to export session");
      }
    },
    [sessions],
  );

  const handleImportSession = useCallback(
    async (file: File) => {
      try {
        setError(null);
        const bundle = JSON.parse(await file.text()) as unknown;
        const result = await composeApi.importSession(bundle);
        setSessions((prev) => [
          result.session,
          ...prev.filter((session) => session.id !== result.session.id),
        ]);
        workflowStateRef.current = null;
        setWorkflowState(null);
        setSessionId(result.session.id);
        setMobilePanel("chat");
        setContextProjection(null);
        setReadiness(result.session.readiness ?? null);
        await Promise.all([
          refreshSources(result.session.id),
          refreshSourceDeletions(result.session.id),
          refreshMessages(result.session.id),
          refreshContext(result.session.id),
        ]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to import session");
      }
    },
    [refreshContext, refreshMessages, refreshSourceDeletions, refreshSources],
  );

  const returnToSessionPicker = useCallback(() => {
    sourceRefreshGenerationRef.current += 1;
    sourceDeletionRefreshGenerationRef.current += 1;
    deletedSourceCacheRef.current.clear();
    workflowStateRef.current = null;
    setError(null);
    setAddSourcesOpen(false);
    setSessionPickerMode("load");
    setSessionId(null);
    setSources([]);
    setSourceDeletions([]);
    setMessages([]);
    setReadiness(null);
    setContextProjection(null);
    setStreamToken(null);
    setWorkflowState(null);
    setWorkflowStateStale(false);
    setThinking(false);
    setProgressMessage(null);
    setRetryStatus(null);
    setHandingOff(false);
    setDraftAnywayConfirmOpen(false);
    setDismissedResearchContextVersion(null);
    setActiveQuestion(null);
    setChatPoppedOut(false);
    setPasteSourceBusy(false);
    setMobilePanel("chat");
  }, []);

  const guarded = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }, []);

  const pasteClipboardSource = useCallback(async () => {
    if (sessionId === null || pasteSourceBusy) return false;
    let added = false;
    setPasteSourceBusy(true);
    try {
      await guarded(async () => {
        const clipboard = navigator.clipboard;
        if (!clipboard) {
          throw new Error("Clipboard access is not available in this browser.");
        }

        const files: File[] = [];
        let text = "";
        if (typeof clipboard.read === "function") {
          const items = await clipboard.read();
          for (const item of items) {
            const fileType = item.types.find(
              (type) => type.startsWith("image/") || type === "application/pdf",
            );
            if (fileType) {
              const blob = await item.getType(fileType);
              files.push(
                new File([blob], clipboardFilename(fileType), {
                  type: fileType,
                }),
              );
              continue;
            }
            if (item.types.includes("text/plain")) {
              text = (await (await item.getType("text/plain")).text()).trim();
            }
          }
        } else if (typeof clipboard.readText === "function") {
          text = (await clipboard.readText()).trim();
        }

        if (files.length > 0) {
          for (const file of files) {
            await composeApi.uploadFile(
              sessionId,
              file,
              streamTokenRef.current,
            );
          }
        } else if (text) {
          await composeApi.addNote(sessionId, text, streamTokenRef.current);
        } else {
          throw new Error(
            "The clipboard does not contain text, an image, or a PDF.",
          );
        }

        setReadiness(null);
        await refreshSources(sessionId);
        added = true;
      });
    } finally {
      setPasteSourceBusy(false);
    }
    return added;
  }, [guarded, pasteSourceBusy, refreshSources, sessionId]);

  if (sessionId === null) {
    return (
      <section
        className="sf-workspace sf-compose"
        aria-label="Compose workspace"
      >
        <SessionModal
          sessions={sessions}
          initialMode={sessionPickerMode}
          onCreate={handleCreate}
          onLoad={openSession}
          onDelete={handleDeleteSession}
          onExport={handleExportSession}
          onImport={handleImportSession}
          errorMessage={error}
        />
      </section>
    );
  }

  const activeSession =
    sessions.find((session) => session.id === sessionId) ?? null;
  const activeSessionName = activeSession?.name ?? `Session ${sessionId}`;
  const activeSourceId = activeSession?.sourceId ?? null;
  const activeSessionOwner =
    activeSession?.createdByDisplay?.trim() ||
    activeSession?.createdBy?.trim() ||
    null;
  const activeContextVersion = activeSession
    ? formatContextVersion(activeSession)
    : null;
  const activeContextStatus =
    activeSession?.latestContextVersion != null
      ? formatContextStatus(activeSession.contextStatus)
      : null;
  const contextVersion = contextProjection?.version ?? null;
  const problemStatement =
    contextProjection?.summary?.problemStatement?.trim() ||
    readiness?.problem?.trim() ||
    null;
  const researchAgent = workflowState?.agents?.find(
    (agent) => agent.key === "research",
  );
  const hasResearchForCurrentContext = sources.some(
    (source) =>
      source.kind === "generated_research" &&
      source.contextVersionUsed != null &&
      contextVersion != null &&
      source.contextVersionUsed >= Math.max(1, contextVersion - 1),
  );
  const showResearchConsent = Boolean(
    isClearProblemStatement(problemStatement) &&
    contextVersion &&
    researchAgent &&
    dismissedResearchContextVersion !== contextVersion &&
    !hasResearchForCurrentContext &&
    researchAgent.status !== "working",
  );
  const backgroundAgents = workflowState?.agents?.length
    ? workflowState.agents
    : fallbackAgentActivity(workflowStateStale);

  const chatPanelEl = (
    <ChatPanel
      sessionId={sessionId}
      messages={messages}
      thinking={thinking}
      progressMessage={progressMessage}
      retryStatus={retryStatus}
      ideating={readiness?.ideating ?? null}
      problem={readiness?.problem ?? null}
      openQuestions={readiness?.openQuestions ?? []}
      activeQuestion={activeQuestion}
      clarificationExpiredMessage={clarificationExpiredMessage}
      agentPersonaName={activeSession?.agentPersonaName ?? null}
      onPopOut={() => setChatPoppedOut((v) => !v)}
      isPoppedOut={chatPoppedOut}
      onOpenAddSources={() => setAddSourcesOpen(true)}
      onPasteSource={() => void pasteClipboardSource()}
      pasteSourceBusy={pasteSourceBusy}
      onSend={(content) =>
        guarded(async () => {
          const localMessage = createLocalMessage(sessionId, "user", content);
          setMessages((prev) => [...prev, localMessage]);
          setThinking(true);
          setClarificationExpiredMessage(null);
          setProgressMessage("Thinking...");
          try {
            const accepted = await composeApi.postMessage(
              sessionId,
              content,
              streamTokenRef.current,
            );
            if (accepted.accepted) void refreshWorkflowState(sessionId);
          } catch (error) {
            setMessages((prev) =>
              prev.filter((message) => message.id !== localMessage.id),
            );
            setThinking(false);
            setProgressMessage(null);
            throw error;
          }
        })
      }
      researchConsentPrompt={
        showResearchConsent && problemStatement && contextVersion
          ? {
              problemStatement,
              busy: researchStarting,
              onDismiss: () =>
                setDismissedResearchContextVersion(contextVersion),
              onApprove: () => {
                setResearchStarting(true);
                void guarded(async () => {
                  try {
                    await composeApi.requestCodeResearch(
                      sessionId,
                      {
                        question: [
                          "Research the current implementation for this confirmed product problem:",
                          problemStatement,
                          "Identify current behavior, integration points, constraints, reusable capabilities, and implementation risks. Resolve technical choices from evidence; do not turn them into user-facing questions.",
                        ].join("\n\n"),
                        parentSourceIds: sources
                          .filter(
                            (source) =>
                              source.kind !== "generated_research" &&
                              source.conversionStatus === "converted",
                          )
                          .map((source) => source.id),
                        contextVersionUsed: contextVersion,
                      },
                      streamTokenRef.current,
                    );
                    setDismissedResearchContextVersion(contextVersion);
                    await refreshWorkflowState(sessionId);
                  } finally {
                    setResearchStarting(false);
                  }
                });
              },
            }
          : null
      }
    />
  );

  return (
    <section
      className="sf-workspace sf-compose is-active-session"
      aria-label="Compose workspace"
      data-mobile-panel={mobilePanel}
    >
      <div className="sf-compose-workspace-toolbar">
        <div className="sf-compose-brand" aria-label="Spec Factory">
          <img src="/spec-factory/mhk-logo.png" alt="" />
          <img src="/spec-factory/sf-logo.png" alt="Spec Factory" />
        </div>
        <div className="sf-compose-active-session" aria-label="Active session">
          <span className="sf-compose-session-identity">
            <span className="sf-compose-session-number">
              Session #{sessionId}
            </span>
            <strong title={activeSessionName}>{activeSessionName}</strong>
          </span>
          {activeContextVersion ? (
            <span className="sf-compose-context-chip">
              {activeContextVersion}
            </span>
          ) : null}
          {activeContextStatus ? (
            <span className="sf-compose-context-chip is-status">
              {activeContextStatus}
            </span>
          ) : null}
          {workflowStateStale ? (
            <span className="sf-compose-context-chip is-attention">
              Status reconnecting
            </span>
          ) : null}
        </div>
        <span
          className={`sf-compose-progress-state${
            thinking || handingOff ? " is-active" : ""
          }`}
        >
          <i aria-hidden="true" />
          {thinking || handingOff
            ? progressMessage || "In progress"
            : "Up to date"}
        </span>
        <button
          type="button"
          className="sf-compose-back-button"
          onClick={returnToSessionPicker}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>Sessions</span>
        </button>
        <div className="sf-compose-toolbar-actions">
          {workflowState?.turn &&
          ACTIVE_TURN_STATUSES.has(workflowState.turn.status) ? (
            <button
              type="button"
              className="sf-compose-turn-cancel"
              aria-label="Stop current response"
              title="Stop current response"
              disabled={cancellingTurn}
              onClick={() => {
                const turnJobId = workflowState.turn?.id;
                if (!turnJobId) return;
                setCancellingTurn(true);
                void composeApi
                  .cancelTurn(
                    workflowState.sessionId,
                    turnJobId,
                    streamTokenRef.current,
                  )
                  .then(() =>
                    refreshWorkflowState(
                      workflowState.sessionId,
                      streamTokenRef.current,
                    ),
                  )
                  .catch((cancelError) =>
                    setError(
                      cancelError instanceof Error
                        ? cancelError.message
                        : "Failed to stop the response",
                    ),
                  )
                  .finally(() => setCancellingTurn(false));
              }}
            >
              <Square size={12} aria-hidden="true" />
            </button>
          ) : null}
          {activeSessionOwner ? (
            <div
              className="sf-compose-session-owner"
              aria-label="Session owner"
            >
              <UserRound size={15} aria-hidden="true" />
              <span title={activeSessionOwner}>{activeSessionOwner}</span>
            </div>
          ) : null}
        </div>
        {error ? (
          <div className="sf-compose-error sf-compose-error-toast" role="alert">
            <span className="sf-compose-error-message">{error}</span>
            <button
              type="button"
              className="sf-compose-error-dismiss"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      <nav className="sf-mobile-workspace-tabs" aria-label="Workspace panels">
        <button
          type="button"
          className={mobilePanel === "sources" ? "is-active" : ""}
          onClick={() => setMobilePanel("sources")}
        >
          <PanelLeft size={16} aria-hidden="true" />
          Knowledge
        </button>
        <button
          type="button"
          className={mobilePanel === "chat" ? "is-active" : ""}
          onClick={() => setMobilePanel("chat")}
        >
          <MessageCircle size={16} aria-hidden="true" />
          Chat
        </button>
        <button
          type="button"
          className={mobilePanel === "brief" ? "is-active" : ""}
          onClick={() => setMobilePanel("brief")}
        >
          <PanelRight size={16} aria-hidden="true" />
          Brief
        </button>
      </nav>
      <AgentPresence
        agents={backgroundAgents}
        primaryPersonaName={activeSession?.agentPersonaName ?? null}
      />
      <SourcesPanel
        sources={sources}
        sourceDeletions={sourceDeletions}
        onGetSourcePreview={(sourceId) =>
          composeApi.getSourcePreview(
            sessionId,
            sourceId,
            streamTokenRef.current,
          )
        }
        onReconvert={(sourceId) =>
          guarded(async () => {
            await composeApi.reconvert(
              sessionId,
              sourceId,
              streamTokenRef.current,
            );
            setReadiness(null);
            await refreshSources(sessionId);
          })
        }
        onReconvertFailed={() =>
          guarded(async () => {
            await composeApi.reconvertFailed(sessionId, streamTokenRef.current);
            setReadiness(null);
            await refreshSources(sessionId);
          })
        }
        onDeleteSource={(sourceId) =>
          guarded(async () => {
            const deletion = await composeApi.deleteSource(
              sessionId,
              sourceId,
              streamTokenRef.current,
            );
            const deletedSource = sources.find(
              (source) => source.id === sourceId,
            );
            if (deletedSource) {
              deletedSourceCacheRef.current.set(sourceId, deletedSource);
            }
            setSourceDeletions((current) => [
              deletion,
              ...current.filter((item) => item.id !== deletion.id),
            ]);
            setReadiness(null);
            await Promise.all([
              refreshSources(sessionId),
              refreshContext(sessionId),
              refreshWorkflowState(sessionId),
            ]);
          })
        }
        onRestoreSource={(sourceId) =>
          guarded(async () => {
            await composeApi.restoreSource(
              sessionId,
              sourceId,
              streamTokenRef.current,
            );
            const cachedSource = deletedSourceCacheRef.current.get(sourceId);
            if (cachedSource) {
              setSources((current) =>
                current.some((source) => source.id === sourceId)
                  ? current
                  : [cachedSource, ...current],
              );
            }
            setSourceDeletions((current) =>
              current.filter((item) => item.sourceId !== sourceId),
            );
            setReadiness(null);
            await Promise.all([
              refreshSources(sessionId),
              refreshSourceDeletions(sessionId),
              refreshContext(sessionId),
              refreshWorkflowState(sessionId),
            ]);
            deletedSourceCacheRef.current.delete(sourceId);
          })
        }
        onOpenAddSources={() => setAddSourcesOpen(true)}
        onPasteSource={() => void pasteClipboardSource()}
        pasteSourceBusy={pasteSourceBusy}
        contextProjection={contextProjection}
        readiness={readiness}
        contextUpdating={
          workflowState?.agents?.some(
            (agent) =>
              agent.key === "requirements" && agent.status === "working",
          ) ?? false
        }
      />
      {chatPoppedOut ? (
        <div className="sf-chat-placeholder" aria-hidden="true" />
      ) : (
        chatPanelEl
      )}
      {addSourcesOpen ? (
        <AddSourceModal
          onClose={() => setAddSourcesOpen(false)}
          onPasteClipboard={pasteClipboardSource}
          pasteClipboardBusy={pasteSourceBusy}
          onAddNote={(content) =>
            guarded(async () => {
              await composeApi.addNote(
                sessionId,
                content,
                streamTokenRef.current,
              );
              setReadiness(null);
              await refreshSources(sessionId);
            })
          }
          onAddYoutube={(url) =>
            guarded(async () => {
              await composeApi.addYoutube(
                sessionId,
                url,
                streamTokenRef.current,
              );
              setReadiness(null);
              await refreshSources(sessionId);
            })
          }
          onAddJira={(jiraKey) =>
            guarded(async () => {
              await composeApi.addJira(
                sessionId,
                jiraKey,
                streamTokenRef.current,
              );
              setReadiness(null);
              await refreshSources(sessionId);
            })
          }
          onAddConfluence={(url) =>
            guarded(async () => {
              await composeApi.addConfluence(
                sessionId,
                url,
                streamTokenRef.current,
              );
              setReadiness(null);
              await refreshSources(sessionId);
            })
          }
          onUploadFiles={(files) =>
            (async () => {
              try {
                setError(null);
                for (const file of files) {
                  await composeApi.uploadFile(
                    sessionId,
                    file,
                    streamTokenRef.current,
                  );
                }
                setReadiness(null);
                await refreshSources(sessionId);
              } catch (e) {
                const message =
                  e instanceof Error ? e.message : "Failed to upload source";
                setError(message);
                throw e;
              }
            })()
          }
        />
      ) : null}
      <PreviewPanel
        readiness={readiness}
        sourceCount={
          sources.filter((source) => source.kind !== "generated_research")
            .length
        }
        contextProjection={contextProjection}
        handingOff={handingOff}
        handoffBlockedReason={handoffBlockedReason(sources)}
        generatedSourceId={activeSourceId}
        epicKey={workflowState?.handoff?.epicKey ?? null}
        draftReady={
          workflowState?.handoff?.status === "draft_ready" ||
          workflowState?.handoff?.workflowStatus === "approval_wait"
        }
        workflowLabel={
          workflowState ? workflowProgress(workflowState) : progressMessage
        }
        onSelectQuestion={(question) => {
          if (sessionId !== null) {
            const text = question.question.trim();
            setMessages((prev) => {
              const alreadyShown = prev.some(
                (m) => m.role === "assistant" && m.content.trim() === text,
              );
              if (alreadyShown) return prev;
              return [
                ...prev,
                createLocalMessage(sessionId, "assistant", text),
              ];
            });
          }
          setActiveQuestion(question);
        }}
        onGenerate={() => {
          // If the session isn't ready and there's no hard block, ask for
          // explicit confirmation before drafting with warnings.
          const isReady =
            (readiness?.ready ?? false) &&
            (readiness?.openQuestions.length ?? 0) === 0;
          if (!isReady && !handoffBlockedReason(sources)) {
            setDraftAnywayConfirmOpen(true);
            return;
          }
          void runHandoff();
        }}
        onViewEpic={() =>
          guarded(async () => {
            if (activeSourceId === null) return;
            await onViewEpic?.(activeSourceId);
          })
        }
      />
      {draftAnywayConfirmOpen ? (
        <DraftAnywayConfirmModal
          openQuestions={readiness?.openQuestions ?? []}
          onCancel={() => setDraftAnywayConfirmOpen(false)}
          onConfirm={() => {
            setDraftAnywayConfirmOpen(false);
            void runHandoff();
          }}
        />
      ) : null}
      {chatPoppedOut ? (
        <div
          className="sf-chat-fullscreen-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Compose chat full screen"
        >
          <div className="sf-chat-fullscreen">{chatPanelEl}</div>
        </div>
      ) : null}
    </section>
  );

  async function runHandoff() {
    await guarded(async () => {
      let result: ComposeHandoffResult | null = null;
      setHandingOff(true);
      try {
        result = await composeApi.handoff(
          sessionId as number,
          streamTokenRef.current,
          (handoffActionKeyRef.current ??= newActionId()),
        );
        setSessions((prev) => upsertSessionSummary(prev, result!.session));
        setReadiness(result.session.readiness ?? null);
        setError(null);
        if (result.handoffId !== undefined) setHandingOff(true);
        void refreshWorkflowState(sessionId as number);
      } finally {
        if (!result) setHandingOff(false);
      }
      if (result && result.handoffId === undefined) {
        await onHandoff?.(result);
      }
    });
  }
}

export function workflowErrorMessage(
  errorCode: string | null | undefined,
  errorMessage: string,
): string {
  if (
    /GITHUB_REPO_TOKEN|GITHUB_APP_CREDENTIALS|github_credentials_required/i.test(
      `${errorCode ?? ""} ${errorMessage}`,
    )
  ) {
    return "Repository access is temporarily unavailable. Please retry after the Spec Factory connection is restored.";
  }
  if (/SDK timeout|timed out|timeout after/i.test(errorMessage)) {
    return "The request took longer than expected. Spec Factory will retry or continue with source-backed results.";
  }
  return errorMessage;
}

function DraftAnywayConfirmModal({
  openQuestions,
  onCancel,
  onConfirm,
}: {
  openQuestions: string[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const trimmedQuestions = openQuestions
    .map((question) => question.trim())
    .filter(Boolean);
  return (
    <div
      className="sf-source-backdrop"
      role="presentation"
      onMouseDown={onCancel}
    >
      <section
        className="sf-source-modal sf-draft-anyway-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-draft-anyway-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sf-source-modal-header">
          <h2 id="sf-draft-anyway-title">
            Draft without resolving open questions?
          </h2>
          <p>
            The Epic still has unanswered questions. Drafting now hands off with
            warnings — you can keep clarifying instead.
          </p>
        </header>
        {trimmedQuestions.length > 0 ? (
          <ul className="sf-draft-anyway-questions" aria-label="Open questions">
            {trimmedQuestions.map((question, index) => (
              <li key={`${question}-${index}`}>{question}</li>
            ))}
          </ul>
        ) : null}
        <div className="sf-compose-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="is-danger" onClick={onConfirm}>
            Draft anyway
          </button>
        </div>
      </section>
    </div>
  );
}
