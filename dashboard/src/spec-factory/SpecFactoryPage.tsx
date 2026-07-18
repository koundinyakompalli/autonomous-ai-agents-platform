import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Clock3,
  FilePlus2,
  GitBranch,
  Home,
  HardDrive,
  Layers3,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Target,
  X,
} from "lucide-react";
import {
  approveDraft,
  discardSource,
  fetchArchivedSources,
  fetchLatestDraft,
  fetchBoardSources,
  fetchOneShotSubmissions,
  fetchSource,
  fetchSourceAttachments,
  fetchSourceEvents,
  fetchStatus,
  generateDraft,
  oneShotNow,
  refreshBoardSources,
  restoreSource,
  retrySourceAttachments,
  updateDraft,
} from "./api.js";
import { VantaWavesBackground } from "./VantaWavesBackground.js";
import type {
  SpecFactoryAttachmentSummary,
  SpecFactoryDraftBundle,
  SpecFactoryDraftDetail,
  SpecFactoryEventSummary,
  SpecFactoryOneShotSubmissionSummary,
  SpecFactoryQualificationReason,
  SpecFactoryRefreshResult,
  SpecFactorySourceOrigin,
  SpecFactorySourceState,
  SpecFactorySourceSummary,
  SpecFactoryStatusSummary,
} from "./types.js";
import "./SpecFactoryPage.css";
import "./compose/ComposeExperience.css";
import { ComposeWorkspace } from "./compose/ComposeWorkspace.js";

type SpecFactoryTab = "compose" | "board" | "oneshot" | "archive";
type BoardColumnId = "intake" | "not_qualified" | "ready" | "approved";
type SpecterPath = "/" | "/oneshot" | "/production-support" | "/watchdog";
type BoardDropAction = "generate" | "approve" | "none";
type BoardOriginFilter = "all" | SpecFactorySourceOrigin;

const tabs: Array<{ id: SpecFactoryTab; label: string }> = [
  { id: "compose", label: "Compose" },
  { id: "board", label: "Spec Board" },
  { id: "oneshot", label: "Development" },
  { id: "archive", label: "Archive" },
];

const specterLinks: Array<{
  path: SpecterPath;
  label: string;
  icon: typeof Home;
}> = [
  { path: "/", label: "Floor", icon: Home },
  { path: "/oneshot", label: "OneShot", icon: Target },
  { path: "/watchdog", label: "Watchdog", icon: Search },
  {
    path: "/production-support",
    label: "Production Support",
    icon: ShieldCheck,
  },
];

const boardColumnConfig: Array<{
  id: BoardColumnId;
  title: string;
  emptyText: string;
  icon: typeof ClipboardList;
}> = [
  {
    id: "intake",
    title: "To Process",
    emptyText: "No tickets waiting.",
    icon: ClipboardList,
  },
  {
    id: "not_qualified",
    title: "Not Qualified",
    emptyText: "No excluded tickets.",
    icon: AlertTriangle,
  },
  {
    id: "ready",
    title: "Ready For Review",
    emptyText: "No previews ready.",
    icon: BookOpen,
  },
  {
    id: "approved",
    title: "Approved",
    emptyText: "No approved Epics.",
    icon: CheckCircle2,
  },
];

const boardOriginFilters: Array<{ id: BoardOriginFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "louise", label: "Louise" },
  { id: "compose", label: "Compose" },
];

const JIRA_BROWSE_BASE_URL = "https://mhkjira.atlassian.net/browse";

function jiraIssueHref(key: string | null | undefined): string | null {
  const trimmed = key?.trim();
  if (!trimmed || trimmed.startsWith("COMPOSE-")) return null;
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(trimmed)) return null;
  return `${JIRA_BROWSE_BASE_URL}/${encodeURIComponent(trimmed)}`;
}

function JiraIssueLink({ issueKey }: { issueKey: string }) {
  const href = jiraIssueHref(issueKey);
  if (!href) return <>{issueKey}</>;

  return (
    <a
      className="sf-jira-key-link"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {issueKey}
    </a>
  );
}

function formatLoe(hours: number | null): string {
  return hours == null ? "LOE: n/a" : `LOE: ${hours}h`;
}

function formatLoeValue(hours: number | null): string {
  return hours == null ? "n/a" : `${hours}h`;
}

function formatState(state: string): string {
  return state.replace(/_/g, " ");
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 10 ? 0 : 2,
    maximumFractionDigits: value >= 10 ? 0 : 2,
  }).format(value);
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return "0s";
  const normalized = Math.max(0, value);
  const text = Number.isInteger(normalized)
    ? String(normalized)
    : normalized.toFixed(1);
  return `${text}s`;
}

function formatOptionalDate(iso: string | null): string {
  return iso ? formatDate(iso) : "never";
}

function formatTurnOutcomeByContextVersion(
  outcome: SpecFactoryStatusSummary["composeControlPlane"]["turns"]["outcomesByContextVersionToday"][number],
): string {
  const label =
    outcome.contextVersionUsed === null
      ? "No context"
      : `v${outcome.contextVersionUsed}`;
  return `${label}: ${outcome.completed} completed / ${outcome.failed} failed`;
}

function topAgentTaskCapability(
  byCapability: SpecFactoryStatusSummary["composeControlPlane"]["agentTasks"]["byCapability"],
): { capability: string; queued: number; running: number } | null {
  return (
    Object.entries(byCapability)
      .sort(([, left], [, right]) => {
        const leftActive = left.queued + left.running;
        const rightActive = right.queued + right.running;
        if (leftActive !== rightActive) return rightActive - leftActive;
        return right.total - left.total;
      })
      .map(([capability, value]) => ({
        capability,
        queued: value.queued,
        running: value.running,
      }))[0] ?? null
  );
}

function topLlmPurpose(
  byPurpose: SpecFactoryStatusSummary["composeControlPlane"]["llm"]["byPurposeToday"],
): { purpose: string; estimatedCostUsdToday: number } | null {
  return (
    Object.entries(byPurpose)
      .sort(([, left], [, right]) => {
        if (left.estimatedCostUsdToday !== right.estimatedCostUsdToday) {
          return right.estimatedCostUsdToday - left.estimatedCostUsdToday;
        }
        return right.callsToday - left.callsToday;
      })
      .map(([purpose, value]) => ({
        purpose,
        estimatedCostUsdToday: value.estimatedCostUsdToday,
      }))[0] ?? null
  );
}

function tabIcon(tab: SpecFactoryTab) {
  if (tab === "compose") return <FilePlus2 size={16} aria-hidden="true" />;
  if (tab === "board") return <Layers3 size={16} aria-hidden="true" />;
  if (tab === "oneshot") return <Archive size={16} aria-hidden="true" />;
  return <HardDrive size={16} aria-hidden="true" />;
}

function crossNavigate(path: SpecterPath) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function stateTone(state: SpecFactorySourceState): string {
  if (state === "needs_attention" || state === "not_qualified") return "danger";
  if (state === "drafting") return "working";
  if (state === "draft_ready") return "ready";
  if (state === "approved") return "approved";
  return "muted";
}

const qualificationReasonLabels: Record<
  SpecFactoryQualificationReason,
  string
> = {
  config_only: "Config Only",
  needs_repo: "Needs Repo",
  needs_information: "Needs Information",
  attachment_issue: "Attachment Issue",
  generation_failed: "Generation Failed",
};

function qualificationReasonsForSource(
  source: SpecFactorySourceSummary,
): SpecFactoryQualificationReason[] {
  const reasons = source.qualificationReasons ?? [];
  if (reasons.length > 0) return reasons;
  if (source.state === "needs_attention" || source.state === "not_qualified") {
    return ["needs_information"];
  }
  return [];
}

function cardBadgesForSource(
  source: SpecFactorySourceSummary,
  processing: boolean,
): Array<{ label: string; tone: string; reason?: boolean }> {
  if (processing || source.state === "drafting") {
    return [{ label: "Processing", tone: "working" }];
  }

  const reasons = qualificationReasonsForSource(source);
  if (
    (source.state === "needs_attention" || source.state === "not_qualified") &&
    reasons.length > 0
  ) {
    return reasons.map((reason) => ({
      label: qualificationReasonLabels[reason],
      tone: "danger",
      reason: true,
    }));
  }

  if (source.state === "draft_ready") {
    return [{ label: "Draft Ready", tone: "ready" }];
  }

  if (source.state === "approved") {
    return [{ label: "Approved", tone: "approved" }];
  }

  if (source.state === "oneshot_submitted") {
    return [{ label: "Submitted", tone: "approved" }];
  }

  return [{ label: formatState(source.state), tone: stateTone(source.state) }];
}

function sourceOrigin(
  source: SpecFactorySourceSummary,
): SpecFactorySourceOrigin {
  return source.origin ?? "louise";
}

function LoeBadge({ hours }: { hours: number | null }) {
  return (
    <span className="sf-card-loe">
      <Clock3 size={12} aria-hidden="true" />
      <span>LOE:</span>
      {formatLoeValue(hours)}
    </span>
  );
}

function renderInlineFormattedText(text: string): Array<string | ReactElement> {
  const nodes: Array<string | ReactElement> = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      nodes.push(<strong key={`strong-${key++}`}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      nodes.push(<code key={`code-${key++}`}>{match[3]}</code>);
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function decodeEscapedFormattedText(text: string): string {
  const escapedLineBreaks = text.match(/\\n/g)?.length ?? 0;
  if (escapedLineBreaks < 2 && !/\\n\\n/.test(text)) return text;
  return text
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"');
}

function sanitizeFormattedText(text: string): string {
  return decodeEscapedFormattedText(text)
    .replace(/\r\n/g, "\n")
    .replace(/<\/?(?:invoke|parameter)(?:\s[^>]*)?>/gi, "")
    .split("\n")
    .filter(
      (line) =>
        !/^\s*<\/?(?:function_calls|tool_use|invoke|parameter|result)(?:\s[^>]*)?>\s*$/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}

export function FormattedText({
  text,
  emptyText = "No detail available.",
}: {
  text: string | null | undefined;
  emptyText?: string;
}) {
  const content = text ? sanitizeFormattedText(text) : "";
  if (!content) return <p className="sf-muted">{emptyText}</p>;

  const blocks: Array<
    | { type: "heading"; text: string }
    | { type: "paragraph"; text: string }
    | { type: "list"; items: string[] }
  > = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", text: heading[1] });
      continue;
    }

    const bullet = trimmed.match(/^(?:[-*•]|\d+\.)\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      continue;
    }

    if (
      listItems.length > 0 &&
      (/^\s{2,}\S/.test(line) || /^[\u2013\u2014-]\s*\S/.test(trimmed))
    ) {
      listItems[listItems.length - 1] =
        `${listItems[listItems.length - 1]} ${trimmed.replace(/^[\u2013\u2014-]\s*/, "")}`;
      continue;
    }

    flushList();
    blocks.push({ type: "paragraph", text: trimmed });
  }
  flushList();

  return (
    <div className="sf-formatted-text">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <h4 key={`${block.type}-${index}`}>
              {renderInlineFormattedText(block.text)}
            </h4>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>
                  {renderInlineFormattedText(item)}
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={`${block.type}-${index}`}>
            {renderInlineFormattedText(block.text)}
          </p>
        );
      })}
    </div>
  );
}

function sourceColumn(
  source: SpecFactorySourceSummary,
  _processingIds: Set<number>,
): BoardColumnId {
  if (source.state === "needs_attention" || source.state === "not_qualified") {
    return "not_qualified";
  }
  if (source.state === "draft_ready") return "ready";
  if (source.state === "approved") return "approved";
  return "intake";
}

function sourceMatchesColumn(
  source: SpecFactorySourceSummary,
  column: BoardColumnId,
  processingIds: Set<number>,
) {
  return sourceColumn(source, processingIds) === column;
}

function dropActionForSource(
  source: SpecFactorySourceSummary,
  targetColumn: BoardColumnId,
  processingIds: Set<number>,
): BoardDropAction {
  if (processingIds.has(source.id) || source.state === "drafting") {
    return "none";
  }
  const currentColumn = sourceColumn(source, processingIds);
  if (currentColumn === targetColumn) return "none";
  if (targetColumn === "ready") return "generate";
  if (targetColumn === "approved" && source.state === "draft_ready") {
    return "approve";
  }
  return "none";
}

function sourceMayHaveDraft(
  source: SpecFactorySourceSummary | null,
): source is SpecFactorySourceSummary {
  return Boolean(
    source &&
    ["draft_ready", "approved", "oneshot_submitted"].includes(source.state),
  );
}

function SideNav({
  active,
  onSelect,
}: {
  active: SpecFactoryTab;
  onSelect: (tab: SpecFactoryTab) => void;
}) {
  return (
    <nav className="sf-side-nav" aria-label="Spec Factory sections">
      <div className="sf-product-mark">
        <img
          className="sf-product-mhk-logo"
          src="/spec-factory/mhk-logo.png"
          alt="Spec Factory"
        />
      </div>
      <div className="sf-nav-group">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={active === tab.id ? "is-active" : ""}
            onClick={() => onSelect(tab.id)}
            aria-label={tab.label}
            aria-current={active === tab.id ? "page" : undefined}
            title={tab.label}
          >
            {tabIcon(tab.id)}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="sf-nav-group sf-nav-group-specter">
        {specterLinks.map((link) => {
          const Icon = link.icon;
          return (
            <button
              key={link.path}
              type="button"
              className="sf-nav-link"
              onClick={() => crossNavigate(link.path)}
              aria-label={link.label}
              title={link.label}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{link.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const SourceCard = memo(function SourceCard({
  source,
  processing,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  source: SpecFactorySourceSummary;
  processing: boolean;
  onOpen: (source: SpecFactorySourceSummary) => void;
  onDragStart: (sourceId: number) => void;
  onDragEnd: () => void;
}) {
  const badges = cardBadgesForSource(source, processing);
  const origin = sourceOrigin(source);
  const originLabel = origin === "compose" ? "Compose" : "Louise";
  return (
    <button
      type="button"
      className={`sf-task-card sf-state-${stateTone(source.state)}${processing ? " is-processing" : ""}`}
      onClick={() => onOpen(source)}
      draggable={!processing}
      onDragStart={(event) => {
        if (processing) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(source.id));
        onDragStart(source.id);
      }}
      onDragEnd={onDragEnd}
      aria-label={`${source.sourceJiraKey} ${source.sourceSummary}`}
    >
      <span className="sf-card-title" title={source.sourceSummary}>
        {source.sourceSummary}
      </span>
      <span className="sf-card-badge-row" aria-label="Ticket metadata">
        <span className={`sf-origin-chip sf-origin-${origin}`}>
          {originLabel}
        </span>
        <LoeBadge hours={source.loeHours} />
        {source.approvedEpicKey ? (
          <span className="sf-epic-chip">{source.approvedEpicKey}</span>
        ) : null}
        {badges.map((badge) => (
          <span
            key={`${badge.label}-${badge.tone}`}
            className={
              badge.reason
                ? "sf-reason-chip"
                : `sf-state-pill sf-state-${badge.tone}`
            }
          >
            {badge.label}
          </span>
        ))}
      </span>
      <span className="sf-card-footer">
        <span className="sf-card-key">
          <GitBranch size={13} aria-hidden="true" />
          {source.sourceJiraKey}
        </span>
      </span>
    </button>
  );
});

function DraftStoryList({ draft }: { draft: SpecFactoryDraftDetail | null }) {
  const stories = draft?.draft?.childTickets ?? [];
  const persisted = draft?.childTickets ?? [];
  if (stories.length === 0 && persisted.length === 0) {
    return <p className="sf-muted">No generated stories yet.</p>;
  }

  return (
    <div className="sf-story-list">
      {stories.map((story) => (
        <article
          key={`${story.repoName}-${story.summary}`}
          className="sf-story-row"
        >
          <div>
            <span className="sf-repo-chip">{story.repoName}</span>
            <strong>{story.summary}</strong>
            <FormattedText text={story.overview} />
          </div>
          <small>{formatLoe(story.loeHours ?? null)}</small>
        </article>
      ))}
      {stories.length === 0
        ? persisted.map((child) => (
            <article key={child.id} className="sf-story-row">
              <div>
                <span className="sf-repo-chip">{child.repoName}</span>
                <strong>{child.summary}</strong>
                <FormattedText
                  text={child.description ?? formatState(child.state)}
                />
              </div>
              <small>{child.jiraKey ?? formatLoe(child.loeHours)}</small>
            </article>
          ))
        : null}
    </div>
  );
}

function EvidenceSummary({ draft }: { draft: SpecFactoryDraftDetail | null }) {
  const evidenceCount = draft?.draft?.evidenceSummary.length ?? 0;
  const warningCount = draft?.draft?.warnings.length ?? 0;
  const childCount =
    draft?.draft?.childTickets.length ?? draft?.childTickets.length ?? 0;

  return (
    <div className="sf-evidence-grid" aria-label="Evidence status">
      <div>
        <span>Evidence</span>
        <strong>{evidenceCount}</strong>
      </div>
      <div>
        <span>Repo stories</span>
        <strong>{childCount}</strong>
      </div>
      <div>
        <span>Warnings</span>
        <strong>{warningCount}</strong>
      </div>
    </div>
  );
}

const attachmentStatusLabels: Record<
  SpecFactoryAttachmentSummary["extractionStatus"],
  string
> = {
  extracted: "Extracted",
  stored: "Archived",
  unsupported: "Unsupported",
  failed: "Failed",
  skipped: "Skipped",
};

function formatBytes(value: number | null): string {
  if (value === null) return "Unknown size";
  if (value < 1024) return `${value.toString()} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function attachmentNeedsAttention(
  attachment: SpecFactoryAttachmentSummary,
): boolean {
  return ["failed", "skipped", "unsupported"].includes(
    attachment.extractionStatus,
  );
}

function AttachmentArchiveSummary({
  attachments,
  busy,
  onRetry,
}: {
  attachments: SpecFactoryAttachmentSummary[];
  busy: boolean;
  onRetry: () => void;
}) {
  const total = attachments.length;
  const downloaded = attachments.filter((attachment) =>
    Boolean(attachment.s3Key),
  ).length;
  const processed = attachments.filter((attachment) =>
    ["extracted", "stored"].includes(attachment.extractionStatus),
  ).length;
  const attentionAttachments = attachments.filter(attachmentNeedsAttention);
  const attention = attentionAttachments.length;
  const priorityAttention = attentionAttachments.filter(
    (attachment) => attachment.isPriority,
  );
  const nonPriorityAttention = attention - priorityAttention.length;
  const visible = attachments.slice(0, 5);

  return (
    <section className="sf-attachment-archive" aria-label="Attachment archive">
      <header>
        <Paperclip size={15} aria-hidden="true" />
        <div>
          <strong>Attachment Archive</strong>
          <span>
            {total === 0
              ? "No attachments archived yet"
              : `${total} total / ${processed} processed / ${attention} attention`}
          </span>
        </div>
        {attention > 0 ? (
          <button
            className="sf-button sf-button-compact sf-attachment-retry"
            type="button"
            onClick={onRetry}
            disabled={busy}
          >
            <RefreshCw size={13} aria-hidden="true" />
            Retry Attachments
          </button>
        ) : null}
      </header>
      {total > 0 ? (
        <>
          <div className="sf-attachment-stats">
            <div>
              <span>Downloaded</span>
              <strong>{downloaded}</strong>
            </div>
            <div>
              <span>Processed</span>
              <strong>{processed}</strong>
            </div>
            <div className={attention > 0 ? "is-danger" : undefined}>
              <span>Attention</span>
              <strong>{attention}</strong>
            </div>
          </div>
          {priorityAttention.length > 0 ? (
            <p className="sf-attachment-generation-note is-danger">
              Draft generation is blocked by{" "}
              {priorityAttention.length.toString()} priority attachment
              {priorityAttention.length === 1 ? "" : "s"}. Use Retry
              Attachments.
            </p>
          ) : nonPriorityAttention > 0 ? (
            <p className="sf-attachment-generation-note">
              Draft generation can continue with{" "}
              {nonPriorityAttention.toString()} non-priority attachment
              {nonPriorityAttention === 1 ? "" : "s"} still needing attention.
            </p>
          ) : null}
          <ul className="sf-attachment-list">
            {visible.map((attachment) => (
              <li
                key={attachment.id}
                className={
                  attachmentNeedsAttention(attachment) ? "is-danger" : ""
                }
              >
                <div>
                  <strong>{attachment.filename}</strong>
                  <small>
                    {attachment.artifactKind} /{" "}
                    {formatBytes(attachment.sizeBytes)}
                    {attachment.isPriority ? " / priority" : ""}
                  </small>
                  {attachment.errorMessage ? (
                    <p>{attachment.errorMessage}</p>
                  ) : null}
                </div>
                <span>
                  {attachmentStatusLabels[attachment.extractionStatus]}
                </span>
              </li>
            ))}
          </ul>
          {attachments.length > visible.length ? (
            <p className="sf-attachment-more">
              +{(attachments.length - visible.length).toString()} more
              attachments
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function healthTone(input: {
  danger?: boolean;
  working?: boolean;
}): "ok" | "working" | "danger" {
  if (input.danger) return "danger";
  if (input.working) return "working";
  return "ok";
}

function SpecFactoryHealthStrip({
  status,
}: {
  status: SpecFactoryStatusSummary | null;
}) {
  if (!status) {
    return (
      <section className="sf-health-strip" aria-label="Spec Factory health">
        <div className="sf-health-card is-working">
          <span>Status</span>
          <strong>Loading</strong>
          <small>Checking Spec Factory queues</small>
        </div>
      </section>
    );
  }

  const queuedJobs = status.processing.byStatus.queued;
  const runningJobs = status.processing.byStatus.running;
  const staleJobs = status.processing.staleRunning;
  const draftTone = healthTone({
    danger: staleJobs > 0,
    working: queuedJobs + runningJobs > 0,
  });
  const composeTone = healthTone({
    danger: status.composeConversion.retryable > 0,
    working: status.composeConversion.inFlight > 0,
  });
  const turnTone = healthTone({
    danger:
      status.composeControlPlane.turns.leaseExpired > 0 ||
      status.composeControlPlane.turns.leaseFenceRejected > 0 ||
      status.composeControlPlane.turns.durableAbandoned > 0,
    working:
      status.composeControlPlane.turns.durableQueued +
        status.composeControlPlane.turns.durableRunning >
      0,
  });
  const agentTaskTone = healthTone({
    danger:
      status.composeControlPlane.agentTasks.leaseExpired > 0 ||
      status.composeControlPlane.agentTasks.leaseFenceRejected > 0 ||
      status.composeControlPlane.agentTasks.abandoned > 0,
    working:
      status.composeControlPlane.agentTasks.queued +
        status.composeControlPlane.agentTasks.running >
      0,
  });
  const llmTone = healthTone({
    danger: status.composeControlPlane.llm.failedToday > 0,
    working: status.composeControlPlane.llm.callsToday > 0,
  });
  const coordinatorDecisions =
    status.composeControlPlane.coordinator.decisionsToday;
  const primaryTurnOutcome =
    status.composeControlPlane.turns.outcomesByContextVersionToday[0] ?? null;
  const primaryAgentTaskCapability = topAgentTaskCapability(
    status.composeControlPlane.agentTasks.byCapability,
  );
  const primaryLlmPurpose = topLlmPurpose(
    status.composeControlPlane.llm.byPurposeToday,
  );
  const coordinatorTone = healthTone({
    danger: coordinatorDecisions.rejected > 0,
    working:
      coordinatorDecisions.answer +
        coordinatorDecisions.dispatchResearch +
        coordinatorDecisions.askClarification +
        coordinatorDecisions.escalate >
      0,
  });
  const workerTone = healthTone({
    danger: status.composeControlPlane.workers.stale > 0,
    working: status.composeControlPlane.workers.live > 0,
  });
  const retentionTone = healthTone({
    danger: status.composeControlPlane.retention.failedWorkspaceCleanup > 0,
    working:
      status.composeControlPlane.retention.pendingWorkspaceCleanup +
        status.composeControlPlane.retention.pendingLlmAuditArtifacts >
      0,
  });
  const eventTone = healthTone({
    danger:
      status.composeControlPlane.events.durablePersistFailuresToday > 0 ||
      status.composeControlPlane.events.payloadTooLargeToday > 0,
    working: status.composeControlPlane.events.durablePublishedToday > 0,
  });
  const streamTone = healthTone({
    working: status.composeControlPlane.streams.activeSubscribers > 0,
  });
  const streamTokenTone = healthTone({
    danger: status.composeControlPlane.streamTokens.expiredUnrevokedTokens > 0,
    working: status.composeControlPlane.streamTokens.activeTokens > 0,
  });
  const researchTone = healthTone({
    danger: status.composeControlPlane.research.failedToday > 0,
    working:
      status.composeControlPlane.research.runningTasks +
        status.composeControlPlane.research.completedToday >
      0,
  });
  const contextTone = healthTone({
    danger:
      status.composeControlPlane.context.patchesFailed > 0 ||
      status.composeControlPlane.context.versionsFailedToday > 0,
    working:
      status.composeControlPlane.context.patchesReady +
        status.composeControlPlane.context.patchesBuilding +
        status.composeControlPlane.context.versionsBuilding >
      0,
  });

  return (
    <section className="sf-health-strip" aria-label="Spec Factory health">
      <div className="sf-health-card is-ok">
        <span>Board</span>
        <strong>{status.board.activeSourceCount} active</strong>
        <small>
          Last refresh {formatOptionalDate(status.board.latestRefreshAt)}
        </small>
      </div>
      <div className={`sf-health-card is-${draftTone}`}>
        <span>Draft queue</span>
        <strong>
          {queuedJobs} queued / {runningJobs} running
        </strong>
        <small>
          {staleJobs > 0
            ? `${staleJobs} stale worker${staleJobs === 1 ? "" : "s"}`
            : `Oldest queued ${formatOptionalDate(status.processing.oldestQueuedAt)}`}
        </small>
      </div>
      <div className={`sf-health-card is-${composeTone}`}>
        <span>Compose conversion</span>
        <strong>{status.composeConversion.inFlight} in flight</strong>
        <small>
          {status.composeConversion.retryable} retryable failure
          {status.composeConversion.retryable === 1 ? "" : "s"}
        </small>
      </div>
      <div className={`sf-health-card is-${turnTone}`}>
        <span>Compose turns</span>
        <strong>
          {status.composeControlPlane.turns.durableQueued} queued /{" "}
          {status.composeControlPlane.turns.durableRunning} running
        </strong>
        <small>
          {status.composeControlPlane.turns.legacyInflight} legacy active /{" "}
          {status.composeControlPlane.turns.legacyQueued} legacy queued
        </small>
        <small>
          {status.composeControlPlane.turns.durableAbandoned} abandoned /{" "}
          {status.composeControlPlane.turns.leaseExpired} lease expired
        </small>
        {status.composeControlPlane.turns.duplicateSuppressedToday > 0 ? (
          <small>
            {status.composeControlPlane.turns.duplicateSuppressedToday}{" "}
            duplicates suppressed
          </small>
        ) : null}
        {status.composeControlPlane.turns.leaseFenceRejected > 0 ? (
          <small>
            {status.composeControlPlane.turns.leaseFenceRejected} fence rejected
          </small>
        ) : null}
        {primaryTurnOutcome ? (
          <small>{formatTurnOutcomeByContextVersion(primaryTurnOutcome)}</small>
        ) : null}
      </div>
      <div className={`sf-health-card is-${agentTaskTone}`}>
        <span>Agent tasks</span>
        <strong>
          {status.composeControlPlane.agentTasks.queued} queued /{" "}
          {status.composeControlPlane.agentTasks.running} running
        </strong>
        <small>
          {status.composeControlPlane.agentTasks.abandoned} abandoned /{" "}
          {status.composeControlPlane.agentTasks.leaseExpired} lease expired
        </small>
        {status.composeControlPlane.agentTasks.leaseFenceRejected > 0 ? (
          <small>
            {status.composeControlPlane.agentTasks.leaseFenceRejected} fence
            rejected
          </small>
        ) : null}
        {primaryAgentTaskCapability ? (
          <small>
            {primaryAgentTaskCapability.capability}:{" "}
            {primaryAgentTaskCapability.queued} queued /{" "}
            {primaryAgentTaskCapability.running} running
          </small>
        ) : null}
      </div>
      <div className={`sf-health-card is-${llmTone}`}>
        <span>LLM spend</span>
        <strong>
          {formatUsd(status.composeControlPlane.llm.estimatedCostUsdToday)}{" "}
          today
        </strong>
        <small>
          {status.composeControlPlane.llm.callsToday} calls /{" "}
          {status.composeControlPlane.llm.failedToday} failed
        </small>
        {primaryLlmPurpose ? (
          <small>
            {primaryLlmPurpose.purpose}:{" "}
            {formatUsd(primaryLlmPurpose.estimatedCostUsdToday)}
          </small>
        ) : null}
      </div>
      <div className={`sf-health-card is-${coordinatorTone}`}>
        <span>Coordinator</span>
        <strong>
          {coordinatorDecisions.answer} answer /{" "}
          {coordinatorDecisions.dispatchResearch} research
        </strong>
        <small>
          {coordinatorDecisions.askClarification} clarify /{" "}
          {coordinatorDecisions.escalate} escalate /{" "}
          {coordinatorDecisions.rejected} rejected
        </small>
      </div>
      <div className={`sf-health-card is-${workerTone}`}>
        <span>Workers</span>
        <strong>
          {status.composeControlPlane.workers.live} live /{" "}
          {status.composeControlPlane.workers.stale} stale
        </strong>
        <small>{status.composeControlPlane.workers.total} registered</small>
      </div>
      <div className={`sf-health-card is-${retentionTone}`}>
        <span>Retention</span>
        <strong>
          {status.composeControlPlane.retention.pendingWorkspaceCleanup} cleanup
          pending /{" "}
          {status.composeControlPlane.retention.pendingLlmAuditArtifacts} audit
          artifacts
        </strong>
        <small>
          {status.composeControlPlane.retention.failedWorkspaceCleanup} cleanup
          error
          {status.composeControlPlane.retention.failedWorkspaceCleanup === 1
            ? ""
            : "s"}
        </small>
        <small>
          Oldest archive{" "}
          {formatOptionalDate(
            status.composeControlPlane.retention.oldestPendingArchivedAt,
          )}
        </small>
        <small>
          Oldest audit artifact{" "}
          {formatOptionalDate(
            status.composeControlPlane.retention
              .oldestPendingLlmAuditArtifactAt,
          )}
        </small>
      </div>
      <div className={`sf-health-card is-${eventTone}`}>
        <span>Events</span>
        <strong>
          {status.composeControlPlane.events.durablePublishedToday} durable
          today
        </strong>
        <small>
          {status.composeControlPlane.events.liveDeliveredByThisReplica} live /{" "}
          {status.composeControlPlane.events.replayedByThisReplica} replayed
        </small>
        <small>
          {status.composeControlPlane.events.durablePersistFailuresToday}{" "}
          persist failed
        </small>
        <small>
          {status.composeControlPlane.events.payloadTooLargeToday} payload too
          large
        </small>
        <small>
          Latest durable{" "}
          {formatOptionalDate(
            status.composeControlPlane.events.latestPublishedAt,
          )}{" "}
          / error{" "}
          {formatOptionalDate(
            status.composeControlPlane.events.latestDurableErrorAt,
          )}
        </small>
      </div>
      <div className={`sf-health-card is-${streamTone}`}>
        <span>Streams</span>
        <strong>
          {status.composeControlPlane.streams.activeSubscribers} active
          subscribers
        </strong>
        <small>
          {status.composeControlPlane.streams.activeSessions} active sessions
        </small>
        <small>
          {status.composeControlPlane.streams.connectedByThisReplica} connected
          / {status.composeControlPlane.streams.disconnectedByThisReplica}{" "}
          disconnected
        </small>
      </div>
      <div className={`sf-health-card is-${streamTokenTone}`}>
        <span>Stream tokens</span>
        <strong>
          {status.composeControlPlane.streamTokens.activeTokens} active tokens
        </strong>
        <small>
          {status.composeControlPlane.streamTokens.createdToday} minted /{" "}
          {status.composeControlPlane.streamTokens.revokedToday} revoked
        </small>
        <small>
          {status.composeControlPlane.streamTokens.expiredUnrevokedTokens}{" "}
          expired unrevoked
        </small>
      </div>
      <div className={`sf-health-card is-${researchTone}`}>
        <span>Research</span>
        <strong>
          {status.composeControlPlane.research.runningTasks} running tasks
        </strong>
        <small>
          {status.composeControlPlane.research.completedToday} completed /{" "}
          {status.composeControlPlane.research.failedToday} failed
        </small>
        <small>
          {formatSeconds(
            status.composeControlPlane.research.avgRuntimeSecondsToday,
          )}{" "}
          avg /{" "}
          {formatSeconds(
            status.composeControlPlane.research.maxRuntimeSecondsToday,
          )}{" "}
          max
        </small>
      </div>
      <div className={`sf-health-card is-${contextTone}`}>
        <span>Context</span>
        <strong>
          {status.composeControlPlane.context.patchesReady} patches ready
        </strong>
        <small>
          {status.composeControlPlane.context.patchesBuilding} building /{" "}
          {status.composeControlPlane.context.patchesFailed} failed
        </small>
        <small>
          {status.composeControlPlane.context.versionsCommittedToday} versions
          today
          {" / "}
          {status.composeControlPlane.context.versionsFailedToday} failed
        </small>
        <small>
          Oldest ready{" "}
          {formatOptionalDate(
            status.composeControlPlane.context.oldestReadyPatchAt,
          )}
        </small>
      </div>
      <div className="sf-health-card is-ok">
        <span>Sources</span>
        <strong>
          {status.board.byOrigin.louise} Louise /{" "}
          {status.board.byOrigin.compose} Compose
        </strong>
        <small>Generated {formatDate(status.generatedAt)}</small>
      </div>
    </section>
  );
}

function PublishedEpicDetails({
  source,
  draft,
}: {
  source: SpecFactorySourceSummary;
  draft: SpecFactoryDraftDetail | null;
}) {
  if (!source.approvedEpicKey) return null;

  const createdChildren =
    draft?.childTickets.filter((child) => child.jiraKey !== null) ?? [];
  const totalChildren =
    draft?.childTickets.length ??
    draft?.draft?.childTickets.length ??
    createdChildren.length;
  const pendingChildren = Math.max(0, totalChildren - createdChildren.length);
  const publishStatus =
    pendingChildren > 0 ? "Partial publish" : "Publish complete";
  const epicTitle = draft?.draft?.epic.summary ?? source.sourceSummary;
  const epicDescription = draft?.draft?.epic.description ?? null;

  return (
    <section className="sf-published-epic" aria-label="Published Epic">
      <header>
        <span className="sf-section-label">Published Epic</span>
        <strong>
          <JiraIssueLink issueKey={source.approvedEpicKey} />
        </strong>
      </header>
      <div className="sf-published-epic-summary">
        <h3>{epicTitle}</h3>
        {epicDescription ? <FormattedText text={epicDescription} /> : null}
      </div>
      <div className="sf-published-epic-grid">
        <div>
          <span>Source</span>
          <strong>
            <JiraIssueLink issueKey={source.sourceJiraKey} />
          </strong>
        </div>
        <div>
          <span>Status</span>
          <strong>{formatState(source.state)}</strong>
        </div>
        <div>
          <span>Child stories</span>
          <strong>
            {createdChildren.length}
            {totalChildren > createdChildren.length
              ? ` / ${totalChildren}`
              : ""}
          </strong>
        </div>
        <div>
          <span>Publish status</span>
          <strong>{publishStatus}</strong>
        </div>
      </div>
      {pendingChildren > 0 ? (
        <p className="sf-published-epic-note">
          {pendingChildren} child{" "}
          {pendingChildren === 1 ? "story is" : "stories are"} still pending.
          Resolve the publish error, then use Retry Publish.
        </p>
      ) : null}
      {createdChildren.length > 0 ? (
        <div className="sf-published-child-list">
          {createdChildren.map((child) => (
            <div key={child.id}>
              <span>
                <JiraIssueLink issueKey={child.jiraKey ?? ""} />
              </span>
              <p>{child.summary}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="sf-muted">
          Child story keys will appear after Jira publish completes.
        </p>
      )}
    </section>
  );
}

function formatEventType(eventType: string): string {
  return eventType
    .replace(/^draft_generation_/, "draft_")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function metadataNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataArray(
  metadata: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = metadata[key];
  return Array.isArray(value) ? value : [];
}

function childMetadataLabel(value: unknown): string | null {
  const child = metadataRecord(value);
  if (!child) return null;
  const jiraKey = metadataString(child, "jiraKey");
  const summary = metadataString(child, "summary");
  const repoName = metadataString(child, "repoName");
  const childId =
    metadataNumber(child, "childId") ?? metadataNumber(child, "id");
  const base =
    jiraKey ??
    summary ??
    (childId === null ? null : `Child #${childId.toString()}`);
  if (!base) return null;
  const suffixes = [
    summary && jiraKey ? summary : null,
    repoName ? repoName : null,
    childId !== null && !base.includes(`#${childId}`) ? `#${childId}` : null,
  ].filter(Boolean);
  return suffixes.length > 0 ? `${base} (${suffixes.join(", ")})` : base;
}

function submissionResultLabel(value: unknown): string | null {
  const result = metadataRecord(value);
  if (!result) return null;
  const childId = metadataNumber(result, "childId");
  const requestId = metadataNumber(result, "requestId");
  if (childId === null && requestId === null) return null;
  const childLabel =
    childId === null ? "Child" : `Child #${childId.toString()}`;
  return requestId === null
    ? `${childLabel} PFOS labeled`
    : `${childLabel} request #${requestId.toString()}`;
}

function eventMetadataDetails(event: SpecFactoryEventSummary): string[] {
  const metadata = metadataRecord(event.metadata);
  if (!metadata) return [];
  const details: string[] = [];
  const error = metadataString(metadata, "error");

  if (event.eventType === "draft_publish_failed") {
    const failedStep = metadataString(metadata, "failedStep");
    const failedChild = childMetadataLabel(metadata.failedChild);
    const createdChildren = metadataArray(metadata, "createdChildren")
      .map(childMetadataLabel)
      .filter((label): label is string => Boolean(label));
    if (failedStep === "epic") details.push("Failed step: Epic publish");
    if (failedChild) details.push(`Failed child: ${failedChild}`);
    if (createdChildren.length > 0) {
      details.push(`Created before failure: ${createdChildren.join(", ")}`);
    }
  } else if (event.eventType === "draft_publish_child_created") {
    const child = childMetadataLabel(metadata);
    if (child) details.push(`Created child: ${child}`);
  } else if (event.eventType === "draft_publish_completed") {
    const children = metadataArray(metadata, "children")
      .map(childMetadataLabel)
      .filter((label): label is string => Boolean(label));
    if (children.length > 0) {
      details.push(`Published children: ${children.join(", ")}`);
    }
  } else if (event.eventType === "draft_publish_skipped") {
    const reason = metadataString(metadata, "reason");
    if (reason === "already_complete") {
      details.push("Skipped: publish already complete");
    }
  } else if (event.eventType === "oneshot_child_submitted") {
    const submitted = submissionResultLabel(metadata);
    if (submitted) details.push(`Submitted child: ${submitted}`);
  } else if (event.eventType === "oneshot_submission_failed") {
    const failedChild = childMetadataLabel(metadata.failedChild);
    const submitted = metadataArray(metadata, "submittedResults")
      .map(submissionResultLabel)
      .filter((label): label is string => Boolean(label));
    if (failedChild) details.push(`Failed child: ${failedChild}`);
    if (submitted.length > 0) {
      details.push(`Submitted before failure: ${submitted.join(", ")}`);
    }
  } else if (event.eventType === "oneshot_submitted") {
    const submitted = metadataArray(metadata, "results")
      .map(submissionResultLabel)
      .filter((label): label is string => Boolean(label));
    if (submitted.length > 0) {
      details.push(`Submitted children: ${submitted.join(", ")}`);
    }
  } else if (event.eventType === "attachment_archive_retried") {
    const retriedCount = metadataNumber(metadata, "retriedCount");
    const afterAttentionCount = metadataNumber(metadata, "afterAttentionCount");
    if (retriedCount !== null) {
      details.push(`Retried attachments: ${retriedCount.toString()}`);
    }
    if (afterAttentionCount !== null) {
      details.push(
        `Attachment attention remaining: ${afterAttentionCount.toString()}`,
      );
    }
  } else if (event.eventType === "attachment_archive_retry_failed") {
    const beforeAttentionCount = metadataNumber(
      metadata,
      "beforeAttentionCount",
    );
    if (beforeAttentionCount !== null) {
      details.push(
        `Retry failed for ${beforeAttentionCount.toString()} attachment${
          beforeAttentionCount === 1 ? "" : "s"
        }`,
      );
    }
  }

  if (error) details.push(`Error: ${error}`);
  return details;
}

function ActivityTimeline({ events }: { events: SpecFactoryEventSummary[] }) {
  return (
    <section className="sf-activity-timeline" aria-label="Source activity">
      <span className="sf-section-label">Activity</span>
      {events.length === 0 ? (
        <p className="sf-muted">No activity recorded yet.</p>
      ) : (
        <ol>
          {events.slice(0, 8).map((event) => (
            <ActivityTimelineItem key={event.id} event={event} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityTimelineItem({ event }: { event: SpecFactoryEventSummary }) {
  const details = eventMetadataDetails(event);
  return (
    <li>
      <span aria-hidden="true" />
      <div>
        <strong>{formatEventType(event.eventType)}</strong>
        <small>
          {formatDate(event.createdAt)}
          {event.actor ? ` / ${event.actor}` : ""}
        </small>
        {details.length > 0 ? (
          <div className="sf-activity-details">
            {details.map((detail) => (
              <p key={detail}>{detail}</p>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function listToLines(items: string[]): string {
  return items.join("\n");
}

function linesToList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function DraftEditor({
  draft,
  busy,
  onSave,
  onCancel,
}: {
  draft: SpecFactoryDraftBundle;
  busy: boolean;
  onSave: (draft: SpecFactoryDraftBundle) => Promise<void>;
  onCancel: () => void;
}) {
  const [epicSummary, setEpicSummary] = useState(draft.epic.summary);
  const [epicDescription, setEpicDescription] = useState(
    draft.epic.description,
  );
  const [epicCriteria, setEpicCriteria] = useState(
    listToLines(draft.epic.acceptanceCriteria),
  );
  const [children, setChildren] = useState(
    draft.childTickets.map((child) => ({
      summary: child.summary,
      overview: child.overview,
      acceptanceCriteria: listToLines(child.acceptanceCriteria),
      implementationNotes: listToLines(
        child.technicalDetails.implementationNotes,
      ),
    })),
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const canSave =
    epicSummary.trim().length > 0 &&
    epicDescription.trim().length > 0 &&
    linesToList(epicCriteria).length > 0 &&
    children.every(
      (child) =>
        child.summary.trim().length > 0 &&
        child.overview.trim().length > 0 &&
        linesToList(child.acceptanceCriteria).length >= 2 &&
        linesToList(child.implementationNotes).length > 0,
    );

  function updateChild(
    index: number,
    patch: Partial<(typeof children)[number]>,
  ) {
    setChildren((prev) =>
      prev.map((child, childIndex) =>
        childIndex === index ? { ...child, ...patch } : child,
      ),
    );
  }

  async function save() {
    if (!canSave || busy) return;
    setLocalError(null);
    const edited: SpecFactoryDraftBundle = {
      ...draft,
      epic: {
        ...draft.epic,
        summary: epicSummary.trim(),
        description: epicDescription.trim(),
        acceptanceCriteria: linesToList(epicCriteria),
      },
      childTickets: draft.childTickets.map((child, index) => ({
        ...child,
        summary: children[index].summary.trim(),
        overview: children[index].overview.trim(),
        acceptanceCriteria: linesToList(children[index].acceptanceCriteria),
        technicalDetails: {
          ...child.technicalDetails,
          implementationNotes: linesToList(children[index].implementationNotes),
        },
      })),
    };

    try {
      await onSave(edited);
      onCancel();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="sf-draft-editor" aria-label="Edit draft">
      {localError ? (
        <div className="sf-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {localError}
        </div>
      ) : null}
      <label>
        Epic summary
        <input
          value={epicSummary}
          onChange={(event) => setEpicSummary(event.target.value)}
        />
      </label>
      <label>
        Epic description
        <textarea
          value={epicDescription}
          onChange={(event) => setEpicDescription(event.target.value)}
        />
      </label>
      <label>
        Epic acceptance criteria
        <textarea
          value={epicCriteria}
          onChange={(event) => setEpicCriteria(event.target.value)}
        />
      </label>
      <div className="sf-draft-editor-stories">
        {draft.childTickets.map((child, index) => (
          <fieldset key={`${child.repoName}-${index}`}>
            <legend>{child.repoName}</legend>
            <label>
              Story summary
              <input
                value={children[index].summary}
                onChange={(event) =>
                  updateChild(index, { summary: event.target.value })
                }
              />
            </label>
            <label>
              Story overview
              <textarea
                value={children[index].overview}
                onChange={(event) =>
                  updateChild(index, { overview: event.target.value })
                }
              />
            </label>
            <label>
              Story acceptance criteria
              <textarea
                value={children[index].acceptanceCriteria}
                onChange={(event) =>
                  updateChild(index, {
                    acceptanceCriteria: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Implementation notes
              <textarea
                value={children[index].implementationNotes}
                onChange={(event) =>
                  updateChild(index, {
                    implementationNotes: event.target.value,
                  })
                }
              />
            </label>
          </fieldset>
        ))}
      </div>
      <div className="sf-draft-editor-actions">
        <button className="sf-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="sf-button sf-button-primary"
          type="button"
          onClick={() => void save()}
          disabled={busy || !canSave}
        >
          Save Draft Revision
        </button>
      </div>
    </div>
  );
}

function PreviewModal({
  source,
  draft,
  events,
  attachments,
  processing,
  busy,
  error,
  onClose,
  onGenerate,
  onApprove,
  onOneShot,
  onDiscard,
  onRestore,
  onRetryAttachments,
  onSaveDraft,
}: {
  source: SpecFactorySourceSummary | null;
  draft: SpecFactoryDraftDetail | null;
  events: SpecFactoryEventSummary[];
  attachments: SpecFactoryAttachmentSummary[];
  processing: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onGenerate: () => void;
  onApprove: () => void;
  onOneShot: () => void;
  onDiscard: () => void;
  onRestore: () => void;
  onRetryAttachments: () => void;
  onSaveDraft: (draft: SpecFactoryDraftBundle) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!source) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, source]);

  useEffect(() => {
    setEditing(false);
  }, [draft?.id, source?.id]);

  if (!source) return null;

  const hasCreatedChildren = Boolean(
    draft?.childTickets.some((child) => child.jiraKey !== null),
  );
  const pendingPublishChildren =
    draft?.childTickets.filter((child) => child.jiraKey === null).length ?? 0;
  const hasPublishedJiraWork = Boolean(
    source.approvedEpicKey || hasCreatedChildren,
  );
  const retryingPublish = Boolean(
    source.approvedEpicKey && pendingPublishChildren > 0,
  );
  const canApprove = Boolean(draft?.id && draft.status === "ready");
  const canEdit = Boolean(
    draft?.draft && draft.status === "ready" && !hasPublishedJiraWork,
  );
  const canOneShot = Boolean(
    hasPublishedJiraWork && pendingPublishChildren === 0,
  );
  const priorityAttachmentAttention = attachments.filter(
    (attachment) =>
      attachment.isPriority && attachmentNeedsAttention(attachment),
  );
  const draftGenerationBlockedByAttachments =
    priorityAttachmentAttention.length > 0;
  const archived = source.state === "archived";
  const reasons = qualificationReasonsForSource(source);
  const title = draft?.draft?.epic.summary ?? source.sourceSummary;
  const description =
    draft?.draft?.epic.description ?? "Generate a draft to preview the Epic.";

  return (
    <div
      className="sf-modal-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="sf-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sf-preview-header">
          <div>
            <span className="sf-kicker">{source.sourceJiraKey}</span>
            <h2 id="sf-preview-title">{title}</h2>
            <div className="sf-preview-meta">
              <LoeBadge hours={source.loeHours} />
              <span>{formatDate(source.updatedAt)}</span>
            </div>
          </div>
          <button
            className="sf-icon-button"
            type="button"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {error ? (
          <div className="sf-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            {error}
          </div>
        ) : null}

        {reasons.length > 0 || source.errorMessage ? (
          <div className="sf-qualification-banner" role="note">
            <div>
              <span className="sf-section-label">Qualification</span>
              <strong>
                {reasons.length > 0
                  ? reasons
                      .map((reason) => qualificationReasonLabels[reason])
                      .join(", ")
                  : "Needs review"}
              </strong>
              {source.errorMessage ? <p>{source.errorMessage}</p> : null}
            </div>
          </div>
        ) : null}

        <div className="sf-preview-body">
          <section className="sf-preview-main" aria-label="Epic preview">
            {editing && draft?.draft ? (
              <DraftEditor
                draft={draft.draft}
                busy={busy}
                onSave={onSaveDraft}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <div className="sf-preview-section sf-preview-section-header">
                  <span className="sf-section-label">Epic</span>
                  {canEdit ? (
                    <button
                      className="sf-button sf-button-compact"
                      type="button"
                      onClick={() => setEditing(true)}
                      disabled={busy || processing}
                    >
                      Edit Draft
                    </button>
                  ) : null}
                </div>
                <div className="sf-preview-section">
                  <FormattedText text={description} />
                </div>
                <div className="sf-preview-section">
                  <span className="sf-section-label">Acceptance Criteria</span>
                  {(draft?.draft?.epic.acceptanceCriteria ?? []).length > 0 ? (
                    <ul className="sf-clean-list">
                      {draft?.draft?.epic.acceptanceCriteria.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="sf-muted">
                      Criteria will appear after draft generation.
                    </p>
                  )}
                </div>
                <div className="sf-preview-section">
                  <span className="sf-section-label">Generated Stories</span>
                  <DraftStoryList draft={draft} />
                </div>
                <PublishedEpicDetails source={source} draft={draft} />
              </>
            )}
          </section>

          <aside className="sf-preview-rail" aria-label="Preview controls">
            <EvidenceSummary draft={draft} />
            <div className="sf-evidence-step">
              <Clock3 size={15} aria-hidden="true" />
              <div>
                <strong>
                  {processing ? "Processing evidence" : "Evidence snapshot"}
                </strong>
                <span>
                  Jira ticket, comments, attachments, and repo references are
                  refreshed before generation.
                </span>
              </div>
            </div>
            <AttachmentArchiveSummary
              attachments={attachments}
              busy={busy}
              onRetry={onRetryAttachments}
            />
            <ActivityTimeline events={events} />
            <footer className="sf-modal-actions">
              {archived ? (
                <button
                  className="sf-button sf-button-primary"
                  type="button"
                  onClick={onRestore}
                  disabled={busy}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                  Restore To Board
                </button>
              ) : (
                <>
                  <button
                    className="sf-button sf-button-primary"
                    type="button"
                    onClick={onGenerate}
                    disabled={
                      busy || processing || draftGenerationBlockedByAttachments
                    }
                  >
                    {processing ? (
                      <Loader2
                        size={15}
                        aria-hidden="true"
                        className="sf-spin"
                      />
                    ) : (
                      <RefreshCw size={15} aria-hidden="true" />
                    )}
                    Generate / Refresh Draft
                  </button>
                  <button
                    className="sf-button"
                    type="button"
                    onClick={onApprove}
                    disabled={busy || processing || !canApprove}
                  >
                    {retryingPublish ? (
                      <RefreshCw size={15} aria-hidden="true" />
                    ) : (
                      <CheckCircle2 size={15} aria-hidden="true" />
                    )}
                    {retryingPublish ? "Retry Publish" : "Approve Epic"}
                  </button>
                  <button
                    className="sf-button"
                    type="button"
                    onClick={onOneShot}
                    disabled={busy || processing || !canOneShot}
                  >
                    <Send size={15} aria-hidden="true" />
                    OneShot Now
                  </button>
                  <button
                    className="sf-button sf-button-danger"
                    type="button"
                    onClick={onDiscard}
                    disabled={busy || processing}
                  >
                    <Archive size={15} aria-hidden="true" />
                    Discard
                  </button>
                </>
              )}
            </footer>
          </aside>
        </div>
      </section>
    </div>
  );
}

function SpecBoard({
  sources,
  status,
  processingIds,
  draggingSourceId,
  originFilter,
  busy,
  error,
  onRefresh,
  onOriginFilterChange,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropSource,
}: {
  sources: SpecFactorySourceSummary[];
  status: SpecFactoryStatusSummary | null;
  processingIds: Set<number>;
  draggingSourceId: number | null;
  originFilter: BoardOriginFilter;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onOriginFilterChange: (filter: BoardOriginFilter) => void;
  onOpen: (source: SpecFactorySourceSummary) => void;
  onDragStart: (sourceId: number) => void;
  onDragEnd: () => void;
  onDropSource: (sourceId: number, targetColumn: BoardColumnId) => void;
}) {
  const originCounts = useMemo(
    () => ({
      all: sources.length,
      louise: sources.filter((source) => sourceOrigin(source) === "louise")
        .length,
      compose: sources.filter((source) => sourceOrigin(source) === "compose")
        .length,
    }),
    [sources],
  );
  const visibleSources = useMemo(
    () =>
      originFilter === "all"
        ? sources
        : sources.filter((source) => sourceOrigin(source) === originFilter),
    [originFilter, sources],
  );
  const boardColumns = useMemo(
    () =>
      boardColumnConfig.map((column) => ({
        ...column,
        cards: visibleSources.filter((source) =>
          sourceMatchesColumn(source, column.id, processingIds),
        ),
      })),
    [processingIds, visibleSources],
  );
  const draggedSource = useMemo(
    () =>
      draggingSourceId
        ? (visibleSources.find((source) => source.id === draggingSourceId) ??
          null)
        : null,
    [draggingSourceId, visibleSources],
  );

  return (
    <section
      className="sf-workspace sf-board-workspace"
      aria-label="Spec Board"
    >
      <header className="sf-header sf-board-header">
        <div>
          <h1>SPEC BOARD</h1>
        </div>
        <div className="sf-board-toolbar">
          <div className="sf-segmented" aria-label="Filter board sources">
            {boardOriginFilters.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={`sf-segment${originFilter === filter.id ? " is-active" : ""}`}
                aria-pressed={originFilter === filter.id}
                aria-label={`${filter.label} ${originCounts[filter.id]}`}
                onClick={() => onOriginFilterChange(filter.id)}
              >
                {filter.label}
                <span>{originCounts[filter.id]}</span>
              </button>
            ))}
          </div>
          <button
            className="sf-button"
            type="button"
            onClick={onRefresh}
            disabled={busy}
          >
            <RefreshCw
              size={15}
              aria-hidden="true"
              className={busy ? "sf-spin" : ""}
            />
            Refresh
          </button>
        </div>
      </header>
      <SpecFactoryHealthStrip status={status} />
      {error ? (
        <div className="sf-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {error}
        </div>
      ) : null}
      <div className="sf-spec-board">
        {boardColumns.map((column) => {
          const Icon = column.icon;
          const dropAction = draggedSource
            ? dropActionForSource(draggedSource, column.id, processingIds)
            : "none";
          const canDrop = dropAction !== "none";

          return (
            <section
              key={column.id}
              className={`sf-kanban-column sf-kanban-column-${column.id}${canDrop ? " is-drop-target" : ""}`}
              aria-label={column.title}
              onDragOver={(event) => {
                if (!canDrop) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = Number(
                  event.dataTransfer.getData("text/plain") || draggingSourceId,
                );
                if (Number.isFinite(sourceId) && canDrop) {
                  onDropSource(sourceId, column.id);
                }
                onDragEnd();
              }}
            >
              <header>
                <span>
                  <Icon size={14} aria-hidden="true" />
                  {column.title}
                </span>
                <strong>{column.cards.length}</strong>
              </header>
              <div className="sf-kanban-stack">
                {column.cards.length === 0 ? (
                  <div className="sf-column-empty">{column.emptyText}</div>
                ) : (
                  column.cards.map((source) => (
                    <SourceCard
                      key={source.id}
                      source={source}
                      processing={
                        processingIds.has(source.id) ||
                        source.state === "drafting"
                      }
                      onOpen={onOpen}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function ArchiveView({
  sources,
  busy,
  onOpen,
}: {
  sources: SpecFactorySourceSummary[];
  busy: boolean;
  onOpen: (source: SpecFactorySourceSummary) => void;
}) {
  return (
    <section className="sf-workspace sf-archive-workspace" aria-label="Archive">
      <header className="sf-header">
        <div>
          <span className="sf-kicker">Discarded</span>
          <h1>Archive</h1>
          <p>Spec Factory tickets removed from the active board.</p>
        </div>
      </header>
      {busy ? <div className="sf-empty">Loading archived work.</div> : null}
      {!busy && sources.length === 0 ? (
        <div className="sf-empty">No Spec Factory tickets are archived.</div>
      ) : null}
      <div className="sf-submissions">
        {sources.map((source) => {
          const reasons = qualificationReasonsForSource(source);
          return (
            <button
              key={source.id}
              type="button"
              className="sf-submission-row sf-archive-row"
              aria-label={`${source.sourceJiraKey} ${source.sourceSummary}`}
              onClick={() => onOpen(source)}
            >
              <div>
                <span className="sf-card-key">{source.sourceJiraKey}</span>
                <strong>{source.sourceSummary}</strong>
                {reasons.length > 0 ? (
                  <span className="sf-reason-row">
                    {reasons.map((reason) => (
                      <span key={reason} className="sf-reason-chip">
                        {qualificationReasonLabels[reason]}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
              <small>
                {formatLoe(source.loeHours)} / {formatDate(source.updatedAt)}
              </small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function OneShotView({
  submissions,
  busy,
}: {
  submissions: SpecFactoryOneShotSubmissionSummary[];
  busy: boolean;
}) {
  return (
    <section className="sf-workspace" aria-label="Development">
      <header className="sf-header">
        <div>
          <span className="sf-kicker">PFOS submitted</span>
          <h1>Development</h1>
          <p>Approved Spec Factory stories that have moved into development.</p>
        </div>
      </header>
      {busy ? <div className="sf-empty">Loading submitted work.</div> : null}
      {!busy && submissions.length === 0 ? (
        <div className="sf-empty">No Spec Factory work has been sent yet.</div>
      ) : null}
      <div className="sf-submissions">
        {submissions.map((submission) => (
          <article key={submission.source.id} className="sf-submission-row">
            <div>
              <span className="sf-card-key">
                {submission.source.sourceJiraKey}
              </span>
              <strong>{submission.source.sourceSummary}</strong>
            </div>
            <small>
              {submission.childTickets.length} stories
              {submission.source.approvedEpicKey
                ? ` / ${submission.source.approvedEpicKey}`
                : ""}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

export function SpecFactoryPage() {
  const [tab, setTab] = useState<SpecFactoryTab>("compose");
  const [sources, setSources] = useState<SpecFactorySourceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedSourceFallback, setSelectedSourceFallback] =
    useState<SpecFactorySourceSummary | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [draft, setDraft] = useState<SpecFactoryDraftDetail | null>(null);
  const [sourceEvents, setSourceEvents] = useState<SpecFactoryEventSummary[]>(
    [],
  );
  const [sourceAttachments, setSourceAttachments] = useState<
    SpecFactoryAttachmentSummary[]
  >([]);
  const [submissions, setSubmissions] = useState<
    SpecFactoryOneShotSubmissionSummary[]
  >([]);
  const [archivedSources, setArchivedSources] = useState<
    SpecFactorySourceSummary[]
  >([]);
  const [statusSummary, setStatusSummary] =
    useState<SpecFactoryStatusSummary | null>(null);
  const [boardOriginFilter, setBoardOriginFilter] =
    useState<BoardOriginFilter>("all");
  const [processingIds, setProcessingIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [draggingSourceId, setDraggingSourceId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applySources = useCallback(
    (nextSources: SpecFactorySourceSummary[]) => {
      setSources(nextSources);
    },
    [],
  );

  const loadBoardSources = useCallback(
    async (
      options: { refresh?: boolean; force?: boolean } = {},
    ): Promise<SpecFactoryRefreshResult> => {
      if (options.refresh) {
        try {
          const result = await refreshBoardSources(Boolean(options.force));
          applySources(result.sources);
          return result;
        } catch (refreshError) {
          const cached = await fetchBoardSources();
          applySources(cached.sources);
          throw refreshError;
        }
      }

      const result = await fetchBoardSources();
      applySources(result.sources);
      return result;
    },
    [applySources],
  );

  const loadStatus = useCallback(async () => {
    try {
      setStatusSummary(await fetchStatus());
    } catch {
      /* health is advisory; keep the board usable */
    }
  }, []);

  const loadSourceEvents = useCallback(async (sourceId: number) => {
    try {
      setSourceEvents(await fetchSourceEvents(sourceId));
    } catch {
      setSourceEvents([]);
    }
  }, []);

  const loadSourceAttachments = useCallback(async (sourceId: number) => {
    try {
      const attachments = await fetchSourceAttachments(sourceId);
      setSourceAttachments(
        attachments.filter(
          (attachment) =>
            typeof attachment.filename === "string" &&
            attachment.filename.length > 0 &&
            typeof attachment.extractionStatus === "string",
        ),
      );
    } catch {
      setSourceAttachments([]);
    }
  }, []);

  useEffect(() => {
    setBusy(true);
    setError(null);
    loadBoardSources()
      .then(() => loadStatus())
      .then(() => loadBoardSources({ refresh: true }))
      .then(async (result) => {
        await loadStatus();
        return result;
      })
      .then((result) => {
        if (!["started", "running"].includes(result.refresh?.status ?? ""))
          return;
        window.setTimeout(() => {
          loadBoardSources().catch((err) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
        }, 3000);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  }, [loadBoardSources, loadStatus]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 30000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (tab !== "oneshot") return;
    setBusy(true);
    fetchOneShotSubmissions()
      .then(setSubmissions)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  }, [tab]);

  useEffect(() => {
    if (tab !== "archive") return;
    setBusy(true);
    fetchArchivedSources()
      .then(setArchivedSources)
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  }, [tab]);

  useEffect(() => {
    const hasProcessing = sources.some((source) => source.state === "drafting");
    if (!hasProcessing && processingIds.size === 0) return;

    const timer = window.setInterval(() => {
      loadBoardSources()
        .then(() => {
          if (!selectedId) return;
          const current =
            sources.find((source) => source.id === selectedId) ?? null;
          if (!sourceMayHaveDraft(current)) return;
          return fetchLatestDraft(selectedId)
            .then(setDraft)
            .catch(() => undefined);
        })
        .catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [loadBoardSources, processingIds, selectedId, sources]);

  const selected = useMemo(() => {
    const primary = tab === "archive" ? archivedSources : sources;
    const secondary = tab === "archive" ? sources : archivedSources;
    return (
      primary.find((source) => source.id === selectedId) ??
      secondary.find((source) => source.id === selectedId) ??
      (selectedSourceFallback?.id === selectedId
        ? selectedSourceFallback
        : null) ??
      null
    );
  }, [archivedSources, selectedId, selectedSourceFallback, sources, tab]);

  useEffect(() => {
    if (!selected) {
      setDraft(null);
      setSourceEvents([]);
      setSourceAttachments([]);
      return;
    }
    if (!sourceMayHaveDraft(selected)) {
      setDraft(null);
    }
    if (previewOpen) {
      void loadSourceEvents(selected.id);
      void loadSourceAttachments(selected.id);
    }
    if (!sourceMayHaveDraft(selected)) return;
    fetchLatestDraft(selected.id)
      .then(setDraft)
      .catch(() => setDraft(null));
  }, [loadSourceAttachments, loadSourceEvents, previewOpen, selected]);

  const setProcessing = useCallback((sourceId: number, processing: boolean) => {
    setProcessingIds((current) => {
      const next = new Set(current);
      if (processing) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  }, []);

  const openPreview = useCallback((source: SpecFactorySourceSummary) => {
    setSelectedId(source.id);
    setSelectedSourceFallback(source);
    setPreviewOpen(true);
  }, []);

  async function refreshBoard() {
    setBusy(true);
    setError(null);
    try {
      const result = await loadBoardSources({ refresh: true, force: true });
      await loadStatus();
      if (["started", "running"].includes(result.refresh?.status ?? "")) {
        window.setTimeout(() => {
          loadBoardSources().catch((err) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
        }, 3000);
      }
      if (sourceMayHaveDraft(selected)) {
        setDraft(await fetchLatestDraft(selected.id).catch(() => null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([
        sourceMayHaveDraft(selected)
          ? fetchLatestDraft(selected.id)
              .then(setDraft)
              .catch(() => undefined)
          : Promise.resolve(),
        loadBoardSources().catch(() => undefined),
        loadStatus().catch(() => undefined),
        selected
          ? loadSourceEvents(selected.id).catch(() => undefined)
          : Promise.resolve(),
        selected
          ? loadSourceAttachments(selected.id).catch(() => undefined)
          : Promise.resolve(),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateDraft() {
    if (!selected) return;
    await generateDraftForSource(selected.id, { openPreviewAfter: true });
  }

  async function generateDraftForSource(
    sourceId: number,
    options: { openPreviewAfter?: boolean } = {},
  ) {
    setProcessing(sourceId, true);
    setBusy(true);
    setError(null);
    try {
      const result = await generateDraft(sourceId);
      setDraft(result.draft);
      setSelectedId(sourceId);
      if (options.openPreviewAfter) {
        setPreviewOpen(true);
      }
      await loadBoardSources();
      await loadStatus();
      await loadSourceEvents(sourceId);
      await loadSourceAttachments(sourceId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await loadBoardSources().catch(() => undefined);
    } finally {
      setProcessing(sourceId, false);
      setBusy(false);
    }
  }

  async function handleApproveDraft() {
    if (!selected || !draft) return;
    await approveDraftForSource(selected, draft);
  }

  async function handleSaveDraftEdit(editedDraft: SpecFactoryDraftBundle) {
    if (!selected || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const savedDraft = await updateDraft(selected.id, draft.id, editedDraft);
      setDraft(savedDraft);
      await loadBoardSources();
      await loadStatus();
      await loadSourceEvents(selected.id);
      await loadSourceAttachments(selected.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  async function approveDraftForSource(
    source: SpecFactorySourceSummary,
    sourceDraft: SpecFactoryDraftDetail,
  ) {
    setBusy(true);
    setError(null);
    try {
      const approvedDraft = await approveDraft(source.id, sourceDraft.id);
      setDraft(approvedDraft);
      setSelectedId(source.id);
      await loadBoardSources();
      await loadStatus();
      await loadSourceEvents(source.id);
      await loadSourceAttachments(source.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([
        fetchLatestDraft(source.id)
          .then(setDraft)
          .catch(() => undefined),
        loadBoardSources().catch(() => undefined),
        loadStatus().catch(() => undefined),
        loadSourceEvents(source.id).catch(() => undefined),
        loadSourceAttachments(source.id).catch(() => undefined),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function dropSourceIntoColumn(
    sourceId: number,
    targetColumn: BoardColumnId,
  ) {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    const action = dropActionForSource(source, targetColumn, processingIds);
    if (action === "none") return;
    setSelectedId(sourceId);

    if (action === "generate") {
      await generateDraftForSource(sourceId);
      return;
    }

    let sourceDraft = draft && draft.sourceId === sourceId ? draft : null;
    if (!sourceDraft) {
      sourceDraft = await fetchLatestDraft(sourceId).catch(() => null);
    }
    if (!sourceDraft || sourceDraft.status !== "ready") {
      setError("Generate a ready Epic draft before approving this ticket.");
      return;
    }
    await approveDraftForSource(source, sourceDraft);
  }

  async function handleOneShotNow() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await oneShotNow(selected.id);
      setPreviewOpen(false);
      await loadBoardSources();
      await loadStatus();
      setSubmissions(await fetchOneShotSubmissions());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (selected) {
        await Promise.all([
          fetchLatestDraft(selected.id)
            .then(setDraft)
            .catch(() => undefined),
          loadBoardSources().catch(() => undefined),
          loadStatus().catch(() => undefined),
          loadSourceEvents(selected.id).catch(() => undefined),
          loadSourceAttachments(selected.id).catch(() => undefined),
          fetchOneShotSubmissions()
            .then(setSubmissions)
            .catch(() => undefined),
        ]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryAttachments() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await retrySourceAttachments(selected.id);
      setSourceAttachments(result.attachments);
      await Promise.all([
        loadSourceEvents(selected.id).catch(() => undefined),
        loadStatus().catch(() => undefined),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await Promise.all([
        loadSourceAttachments(selected.id).catch(() => undefined),
        loadSourceEvents(selected.id).catch(() => undefined),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscardSource() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await discardSource(selected.id);
      setPreviewOpen(false);
      setDraft(null);
      await loadBoardSources();
      await loadStatus();
      setArchivedSources(await fetchArchivedSources());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreSource() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const restored = await restoreSource(selected.id);
      setPreviewOpen(false);
      setSelectedId(restored.id);
      setTab("board");
      await loadBoardSources();
      await loadStatus();
      setArchivedSources(await fetchArchivedSources());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function openComposeEpicModal(
    sourceId: number,
    options: { markProcessing?: boolean } = {},
  ) {
    if (options.markProcessing) {
      setProcessing(sourceId, true);
    }
    setError(null);
    try {
      const source = await fetchSource(sourceId);
      setSelectedSourceFallback(source);
      setSelectedId(sourceId);
      setBoardOriginFilter("compose");
      setDraft(null);
      setSourceEvents([]);
      setSourceAttachments([]);
      setPreviewOpen(true);
      await Promise.all([
        loadStatus().catch(() => undefined),
        loadSourceEvents(sourceId).catch(() => undefined),
        loadSourceAttachments(sourceId).catch(() => undefined),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (options.markProcessing) {
        setProcessing(sourceId, false);
      }
    }
  }

  async function handleComposeHandoff(result: { sourceId: number }) {
    await openComposeEpicModal(result.sourceId, { markProcessing: true });
  }

  const wavesAnimated = tab === "compose";

  return (
    <main className={`sf-shell sf-shell-${tab}`} aria-label="Spec Factory">
      <VantaWavesBackground
        animated={wavesAnimated}
        className="sf-shell-waves"
        variant={wavesAnimated ? "compose" : "workspace"}
        waveCount={9}
      />
      <SideNav active={tab} onSelect={setTab} />
      {tab === "compose" ? (
        <ComposeWorkspace
          onHandoff={handleComposeHandoff}
          onViewEpic={(sourceId) => openComposeEpicModal(sourceId)}
        />
      ) : tab === "oneshot" ? (
        <OneShotView submissions={submissions} busy={busy} />
      ) : tab === "archive" ? (
        <ArchiveView
          sources={archivedSources}
          busy={busy}
          onOpen={openPreview}
        />
      ) : (
        <SpecBoard
          sources={sources}
          status={statusSummary}
          processingIds={processingIds}
          draggingSourceId={draggingSourceId}
          originFilter={boardOriginFilter}
          busy={busy}
          error={error}
          onRefresh={refreshBoard}
          onOriginFilterChange={setBoardOriginFilter}
          onOpen={openPreview}
          onDragStart={setDraggingSourceId}
          onDragEnd={() => setDraggingSourceId(null)}
          onDropSource={dropSourceIntoColumn}
        />
      )}
      <PreviewModal
        source={previewOpen ? selected : null}
        draft={draft}
        events={sourceEvents}
        attachments={sourceAttachments}
        processing={
          selected
            ? processingIds.has(selected.id) || selected.state === "drafting"
            : false
        }
        busy={busy}
        error={error}
        onClose={() => setPreviewOpen(false)}
        onGenerate={handleGenerateDraft}
        onApprove={handleApproveDraft}
        onOneShot={handleOneShotNow}
        onDiscard={handleDiscardSource}
        onRestore={handleRestoreSource}
        onRetryAttachments={handleRetryAttachments}
        onSaveDraft={handleSaveDraftEdit}
      />
    </main>
  );
}
