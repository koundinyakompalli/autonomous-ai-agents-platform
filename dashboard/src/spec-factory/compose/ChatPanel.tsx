import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  AtSign,
  Check,
  ClipboardPaste,
  Clock3,
  Copy,
  ListChecks,
  Maximize2,
  MessageCircleQuestion,
  Paperclip,
  SearchCode,
  ShieldAlert,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { FormattedText } from "../SpecFactoryPage.js";
import type {
  ComposeChatMessage,
  ComposeMessageRole,
  ComposeOpenQuestion,
} from "./composeTypes.js";
import { isUserFacingClarification } from "./clarificationPolicy.js";
import { avatarForAgent } from "./personas.js";

type ChatDisplayTurn = {
  key: string;
  role: Exclude<ComposeMessageRole, "system">;
  content: string;
  createdAt: string;
  openQuestion: boolean;
};

const COMPOSE_AGENT_NAMES = [
  "Bohr",
  "Herschel",
  "Huygens",
  "Godel",
  "Ohm",
  "Pascal",
  "Avicenna",
  "Mendel",
  "Fermat",
  "Archimedes",
  "Hegel",
  "Chandrasekhar",
  "Pauli",
  "Sartre",
  "Wegener",
  "Plato",
  "Averroes",
  "Jason",
  "Poincare",
  "Gibbs",
  "Harvey",
  "Ptolemy",
  "Dirac",
  "Goodall",
  "Parfit",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentNameForSession(sessionId: number | null | undefined): string {
  if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) {
    return COMPOSE_AGENT_NAMES[0];
  }
  return COMPOSE_AGENT_NAMES[
    Math.abs(Math.trunc(sessionId)) % COMPOSE_AGENT_NAMES.length
  ];
}

function normalizeTurnText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function questionPrefixPattern(question: string): RegExp {
  return new RegExp(
    `^${question.trim().split(/\s+/).map(escapeRegExp).join("\\s+")}\\s*`,
    "i",
  );
}

function splitQuestionPrefixedUserTurn(
  content: string,
  openQuestions: string[],
): { question: string; answer: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const sortedQuestions = [...openQuestions].sort(
    (a, b) => b.length - a.length,
  );
  for (const question of sortedQuestions) {
    const match = trimmed.match(questionPrefixPattern(question));
    if (!match) continue;
    const answer = trimmed
      .slice(match[0].length)
      .replace(/^[:;\-\u2013\u2014\s]+/, "")
      .trim();
    return { question, answer };
  }
  return null;
}

function timeLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function dayLabel(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
  );
  const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(parsed);
}

function friendlyThinkingLabel(value?: string | null): string {
  const label = value?.trim().toLowerCase() ?? "";
  if (!label) return "Thinking...";
  if (label.includes("queue")) return "Waiting to start...";
  if (label.includes("research")) return "Researching...";
  if (label.includes("analy") || label.includes("source")) {
    return "Reviewing sources...";
  }
  if (label.includes("synth") || label.includes("brief")) {
    return "Updating your brief...";
  }
  if (label.includes("send") || label.includes("prepar") || label === "working on it") {
    return "Thinking...";
  }
  return value?.trim() || "Thinking...";
}

export interface ComposeRetryStatus {
  attempt: number;
  maxAttempts: number;
  nextRetryInSeconds: number;
  message?: string | null;
}

export interface ResearchConsentPrompt {
  problemStatement: string;
  busy: boolean;
  onApprove: () => void;
  onDismiss: () => void;
}

export function ChatPanel({
  messages,
  onSend,
  thinking,
  progressMessage,
  openQuestions = [],
  sessionId,
  agentPersonaName = null,
  retryStatus = null,
  activeQuestion = null,
  clarificationExpiredMessage = null,
  onPopOut,
  isPoppedOut = false,
  researchConsentPrompt = null,
  onOpenAddSources,
  onPasteSource,
  pasteSourceBusy = false,
}: {
  messages: ComposeChatMessage[];
  onSend: (content: string) => void;
  thinking: boolean;
  progressMessage?: string | null;
  ideating?: string | null;
  problem?: string | null;
  openQuestions?: string[];
  sessionId?: number | null;
  agentPersonaName?: string | null;
  retryStatus?: ComposeRetryStatus | null;
  activeQuestion?: ComposeOpenQuestion | null;
  clarificationExpiredMessage?: string | null;
  onPopOut?: () => void;
  isPoppedOut?: boolean;
  researchConsentPrompt?: ResearchConsentPrompt | null;
  onOpenAddSources?: () => void;
  onPasteSource?: () => void;
  pasteSourceBusy?: boolean;
}) {
  const [input, setInput] = useState("");
  const [copiedTurn, setCopiedTurn] = useState<string | null>(null);
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const inferredSessionId =
    sessionId ??
    messages.find((message) => typeof message.sessionId === "number")
      ?.sessionId;
  const agentName =
    agentPersonaName?.trim() || agentNameForSession(inferredSessionId);
  const agentAvatar = avatarForAgent(agentName);
  const thinkingLabel = friendlyThinkingLabel(progressMessage);
  const normalizedOpenQuestions = openQuestions
    .map((question) => question.trim())
    .filter((question) => isUserFacingClarification(question));
  const clarificationExpiredText = clarificationExpiredMessage?.trim() ?? "";
  const visibleActiveQuestion =
    activeQuestion && isUserFacingClarification(activeQuestion)
      ? activeQuestion
      : null;
  const firstOpenQuestion = normalizedOpenQuestions[0] ?? null;
  const displayTurns = useMemo(
    () =>
      messages
        .filter((message) => message.role !== "system")
        .flatMap<ChatDisplayTurn>((message) => {
          if (message.role === "system") return [];
          if (message.role === "user") {
            const split = splitQuestionPrefixedUserTurn(
              message.content,
              normalizedOpenQuestions,
            );
            if (split) {
              const turns: ChatDisplayTurn[] = [
                {
                  key: `${message.id}-question`,
                  role: "assistant",
                  content: split.question,
                  createdAt: message.createdAt,
                  openQuestion: true,
                },
              ];
              if (split.answer) {
                turns.push({
                  key: `${message.id}-answer`,
                  role: "user",
                  content: split.answer,
                  createdAt: message.createdAt,
                  openQuestion: false,
                });
              }
              return turns;
            }
          }
          const isAssistantOpenQuestion =
            message.role === "assistant" &&
            normalizedOpenQuestions.some(
              (question) =>
                normalizeTurnText(question) ===
                normalizeTurnText(message.content),
            );
          return [
            {
              key: String(message.id),
              role: message.role,
              content: message.content,
              createdAt: message.createdAt,
              openQuestion: isAssistantOpenQuestion,
            },
          ];
        }),
    [messages, normalizedOpenQuestions],
  );

  const shouldPromptFirstQuestion =
    Boolean(firstOpenQuestion) &&
    !displayTurns.some(
      (turn) =>
        turn.role === "assistant" &&
        normalizeTurnText(turn.content) ===
          normalizeTurnText(firstOpenQuestion ?? ""),
    );

  useEffect(() => {
    const windowElement = chatWindowRef.current;
    if (!windowElement) return;
    window.requestAnimationFrame(() => {
      windowElement.scrollTop = windowElement.scrollHeight;
    });
  }, [displayTurns.length, thinking, visibleActiveQuestion?.id]);

  function send() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  async function copyTurn(turn: ChatDisplayTurn) {
    try {
      await navigator.clipboard.writeText(turn.content);
      setCopiedTurn(turn.key);
      window.setTimeout(() => setCopiedTurn(null), 1_500);
    } catch {
      setCopiedTurn(null);
    }
  }

  let previousDay: string | null = null;

  return (
    <section
      className="sf-compose-panel sf-chat-panel"
      aria-label="Clarification chat"
    >
      {onPopOut ? (
        <div className="sf-chat-popout-floating-wrap">
          <button
            type="button"
            className="sf-chat-popout sf-chat-popout-floating"
            onClick={onPopOut}
            aria-label={isPoppedOut ? "Exit full screen" : "Pop out chat"}
            title={isPoppedOut ? "Exit full screen" : "Pop out chat"}
          >
            {isPoppedOut ? (
              <X size={16} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : null}
      <div
        ref={chatWindowRef}
        className="sf-chat-window"
        aria-label="Compose conversation"
      >
        {shouldPromptFirstQuestion ? (
          <ChatTurn
            turn={{
              key: "first-open-question",
              role: "assistant",
              content: firstOpenQuestion ?? "",
              createdAt: "",
              openQuestion: true,
            }}
            agentName={agentName}
            agentAvatar={agentAvatar}
            copied={false}
            onCopy={() => undefined}
          />
        ) : null}
        {displayTurns.map((turn) => {
          const currentDay = dayLabel(turn.createdAt);
          const showDay = Boolean(currentDay && currentDay !== previousDay);
          if (currentDay) previousDay = currentDay;
          return (
            <div key={turn.key} className="sf-chat-turn-group">
              {showDay ? (
                <div className="sf-chat-day" role="separator">
                  <span>{currentDay}</span>
                </div>
              ) : null}
              <ChatTurn
                turn={turn}
                agentName={agentName}
                agentAvatar={agentAvatar}
                copied={copiedTurn === turn.key}
                onCopy={() => void copyTurn(turn)}
              />
            </div>
          );
        })}
        {visibleActiveQuestion?.options &&
        visibleActiveQuestion.options.length > 0 ? (
          <section
            className="sf-chat-decision"
            aria-label="Decision needed"
          >
            <div className="sf-chat-decision-head">
              <span>Decision needed</span>
              <small>Choose the outcome that best matches your need.</small>
            </div>
            <strong>{visibleActiveQuestion.question}</strong>
            <div
              className="sf-chat-options"
              role="group"
              aria-label="Suggested answers"
            >
              {visibleActiveQuestion.options.map((option, index) => (
                <button
                  key={`${visibleActiveQuestion.id}-${index}`}
                  type="button"
                  className="sf-chat-option"
                  onClick={() => onSend(option)}
                  disabled={thinking}
                >
                  <span className="sf-chat-option-radio" aria-hidden="true" />
                  <span>{option}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {thinking && retryStatus ? (
          <div className="sf-chat-turn is-assistant">
            <img className="sf-chat-avatar" src={agentAvatar} alt="" />
            <div className="sf-chat-turn-body">
              <span className="sf-chat-speaker">{agentName}</span>
              <div
                role="status"
                aria-label="Retrying"
                aria-live="polite"
                className="sf-chat-msg is-assistant sf-chat-thinking is-retrying"
              >
                <em>
                  {`Trying again... attempt ${retryStatus.attempt} of ${retryStatus.maxAttempts}, in ${retryStatus.nextRetryInSeconds}s`}
                </em>
                {retryStatus.message?.trim() ? (
                  <span className="sf-chat-retry-detail">
                    {retryStatus.message}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : thinking ? (
          <div className="sf-chat-turn is-assistant is-thinking">
            <img className="sf-chat-avatar" src={agentAvatar} alt="" />
            <div className="sf-chat-turn-body">
              <span className="sf-chat-speaker">{agentName}</span>
              <div
                className="sf-chat-msg is-assistant sf-chat-thinking"
                aria-live="polite"
              >
                <em>{thinkingLabel}</em>
                <span className="sf-chat-typing-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {clarificationExpiredText ? (
        <div className="sf-chat-expiry-alert" role="alert">
          <strong>That question expired</strong>
          <span>{clarificationExpiredText}</span>
        </div>
      ) : null}
      {researchConsentPrompt ? (
        <section
          className="sf-research-consent"
          aria-label="Code research approval"
        >
          <SearchCode size={18} aria-hidden="true" />
          <div>
            <strong>Problem statement ready</strong>
            <p>{researchConsentPrompt.problemStatement}</p>
            <span className="sf-research-consent-question">
              May I ask the development agent to research the codebase now?
            </span>
          </div>
          <div className="sf-research-consent-actions">
            <button
              type="button"
              onClick={researchConsentPrompt.onDismiss}
              disabled={researchConsentPrompt.busy}
              title="Decide later"
            >
              <Clock3 size={15} aria-hidden="true" />
              <span>Not now</span>
            </button>
            <button
              type="button"
              className="is-primary"
              onClick={researchConsentPrompt.onApprove}
              disabled={researchConsentPrompt.busy}
            >
              {researchConsentPrompt.busy ? (
                <span>Starting research</span>
              ) : (
                <>
                  <SearchCode size={15} aria-hidden="true" />
                  <span>Start code research</span>
                </>
              )}
            </button>
          </div>
        </section>
      ) : null}
      <div className="sf-chat-quick-actions" aria-label="Conversation actions">
        <button type="button" onClick={() => setInput("I have a follow-up: ")}>
          <MessageCircleQuestion size={14} aria-hidden="true" />
          Ask a follow-up
        </button>
        <button
          type="button"
          onClick={() => onSend("Summarize the key points and decisions so far.")}
        >
          <ListChecks size={14} aria-hidden="true" />
          Summarize key points
        </button>
        <button
          type="button"
          onClick={() =>
            onSend("What business or functional information is still missing?")
          }
        >
          <Sparkles size={14} aria-hidden="true" />
          What's missing?
        </button>
        <button
          type="button"
          onClick={() => onSend("Show me the unresolved requirement conflicts.")}
        >
          <ShieldAlert size={14} aria-hidden="true" />
          Show conflicts
        </button>
      </div>
      <div className="sf-chat-dock">
        <textarea
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={
            visibleActiveQuestion?.options &&
            visibleActiveQuestion.options.length > 0
              ? "Pick A/B/C above, or type your own answer..."
              : "Ask a question or describe what you want to achieve..."
          }
        />
        <div className="sf-chat-dock-actions">
          <div>
            {onOpenAddSources ? (
              <button
                type="button"
                onClick={onOpenAddSources}
                aria-label="Add source"
                title="Add source"
              >
                <Paperclip size={17} aria-hidden="true" />
              </button>
            ) : null}
            {onPasteSource ? (
              <button
                type="button"
                onClick={onPasteSource}
                disabled={pasteSourceBusy}
                aria-label="Paste source from clipboard"
                title="Paste source from clipboard"
              >
                <ClipboardPaste size={17} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setInput((current) => `${current}@`)}
              aria-label="Mention"
              title="Mention"
            >
              <AtSign size={17} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="sf-chat-send"
            onClick={send}
            disabled={input.trim().length === 0}
            aria-label="Send"
            title="Send"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </div>
        <span className="sf-chat-responder">{agentName} will respond</span>
      </div>
    </section>
  );
}

function ChatTurn({
  turn,
  agentName,
  agentAvatar,
  copied,
  onCopy,
}: {
  turn: ChatDisplayTurn;
  agentName: string;
  agentAvatar: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const isUser = turn.role === "user";
  const timestamp = timeLabel(turn.createdAt);
  return (
    <div
      className={`sf-chat-turn is-${turn.role}${
        turn.openQuestion ? " is-open-question" : ""
      }`}
    >
      {isUser ? (
        <span className="sf-chat-user-avatar" aria-hidden="true">
          <UserRound size={16} />
        </span>
      ) : (
        <img className="sf-chat-avatar" src={agentAvatar} alt="" />
      )}
      <div className="sf-chat-turn-body">
        <div className="sf-chat-turn-meta">
          <span className="sf-chat-speaker">
            {isUser ? "You" : agentName}
          </span>
          {timestamp ? <time dateTime={turn.createdAt}>{timestamp}</time> : null}
        </div>
        <article
          className={`sf-chat-msg is-${turn.role}${
            turn.openQuestion ? " is-open-question" : ""
          }`}
          aria-label={
            isUser
              ? "User reply"
              : turn.openQuestion
                ? `${agentName} question`
                : `${agentName} reply`
          }
        >
          <FormattedText text={turn.content} />
        </article>
        <button
          type="button"
          className="sf-chat-copy"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy response"}
          title={copied ? "Copied" : "Copy response"}
        >
          {copied ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
