import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowDownUp,
  BookOpen,
  ChevronDown,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Download,
  Diamond,
  ExternalLink,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FilePlus2,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import type {
  ComposeContextProjection,
  ComposeConversionStatus,
  ComposeReadiness,
  ComposeSourceDeletionSummary,
  ComposeSourceKind,
  ComposeSourcePreview,
  ComposeSourceSummary,
} from "./composeTypes.js";
import { ArtifactsSection } from "./ArtifactsSection.js";

const BADGE_LABEL: Record<ComposeConversionStatus, string> = {
  awaiting_upload: "Uploading",
  pending: "Processing",
  converting: "Processing",
  converted: "Ready",
  unsupported: "Needs attention",
  failed: "Failed",
};

const STATUS_DETAIL: Record<ComposeConversionStatus, string> = {
  awaiting_upload: "Uploading source",
  pending: "Queued for conversion",
  converting: "Converting to markdown",
  converted: "Converted to markdown",
  unsupported: "Needs a supported converter",
  failed: "Conversion failed",
};

function isRetryable(status: ComposeConversionStatus): boolean {
  return status === "failed" || status === "unsupported";
}

function sourceTitle(source: ComposeSourceSummary): string {
  return source.originalFilename ?? `source-${source.id}`;
}

function jiraIssueKey(source: ComposeSourceSummary): string | null {
  const rawTitle = sourceTitle(source);
  const match = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(rawTitle);
  return match?.[0] ?? null;
}

function safeFileStem(value: string): string {
  const stem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "compose-source";
}

function sourceMeta(source: ComposeSourceSummary): string {
  const attempts = source.conversionAttempts ?? 0;
  return attempts > 0 ? `${source.kind} · Attempt ${attempts}` : source.kind;
}

function sourceUsefulnessLabel(
  usefulness: ComposeSourceSummary["sourceUsefulness"],
): string | null {
  if (!usefulness) return null;
  const labels: Record<
    NonNullable<ComposeSourceSummary["sourceUsefulness"]>,
    string
  > = {
    high_signal: "High signal",
    needs_clarification: "Needs clarification",
    duplicate: "Duplicate",
    missing_repo_context: "Missing repo context",
    weak_requirement_detail: "Weak detail",
    unknown: "Supporting context",
  };
  return labels[usefulness];
}

function sourceEntityChips(source: ComposeSourceSummary): string[] {
  const entities = source.sourceEntities;
  if (!entities) return [];
  return [
    ...entities.jiraKeys,
    ...entities.repositories,
    ...entities.files.slice(0, 5),
    ...entities.clients,
    ...entities.loeHours.map((hours) => `${hours}h`),
    ...entities.dates,
  ].slice(0, 12);
}

type SourceCategoryKey =
  | ComposeSourceKind
  | "audio"
  | "video"
  | "image"
  | "document";

interface SourceCategory {
  key: SourceCategoryKey;
  label: string;
  icon: ReactNode;
}

const AUDIO_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "webm"]);
const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);
const DOCUMENT_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "md",
  "pdf",
  "ppt",
  "pptx",
  "txt",
  "xls",
  "xlsx",
]);

function sourceExtension(source: ComposeSourceSummary): string {
  const title = sourceTitle(source).split(/[?#]/)[0] ?? "";
  const match = /\.([a-z0-9]+)$/i.exec(title);
  return match?.[1]?.toLowerCase() ?? "";
}

function isImageSource(source: ComposeSourceSummary): boolean {
  const mime = source.mimeType?.toLowerCase() ?? "";
  return (
    mime.startsWith("image/") || IMAGE_EXTENSIONS.has(sourceExtension(source))
  );
}

function sourceBadgeLabel(
  source: ComposeSourceSummary,
  category: SourceCategory,
): string {
  const extension = sourceExtension(source);
  if (source.kind === "jira") return "Jira";
  if (source.kind === "confluence") return "Conf";
  if (source.kind === "youtube") return "YT";
  if (extension && extension.length <= 5) return extension.toUpperCase();
  if (category.key === "audio") return "Aud";
  if (category.key === "video") return "Vid";
  if (category.key === "image") return "Img";
  if (category.key === "document") return "Doc";
  if (category.key === "note") return "Note";
  if (category.key === "chat") return "Chat";
  return "File";
}

function sourceCategory(source: ComposeSourceSummary): SourceCategory {
  if (source.kind === "jira") {
    return {
      key: "jira",
      label: "JIRA",
      icon: <Diamond size={20} aria-hidden="true" />,
    };
  }
  if (source.kind === "confluence") {
    return {
      key: "confluence",
      label: "Confluence",
      icon: <BookOpen size={15} aria-hidden="true" />,
    };
  }
  if (source.kind === "youtube") {
    return {
      key: "youtube",
      label: "Video",
      icon: <FileVideo size={21} aria-hidden="true" />,
    };
  }
  if (source.kind === "note" || source.kind === "chat") {
    return {
      key: source.kind,
      label: source.kind === "note" ? "Note" : "Chat",
      icon:
        source.kind === "note" ? (
          <StickyNote size={16} aria-hidden="true" />
        ) : (
          <MessageSquareText size={16} aria-hidden="true" />
        ),
    };
  }

  const extension = sourceExtension(source);
  if (AUDIO_EXTENSIONS.has(extension)) {
    return {
      key: "audio",
      label: "Audio",
      icon: <FileAudio size={21} aria-hidden="true" />,
    };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return {
      key: "video",
      label: "Video",
      icon: <FileVideo size={21} aria-hidden="true" />,
    };
  }
  if (isImageSource(source)) {
    return {
      key: "image",
      label: "Image",
      icon: <FileImage size={21} aria-hidden="true" />,
    };
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return {
      key: "document",
      label: "Document",
      icon: <FileText size={16} aria-hidden="true" />,
    };
  }
  return {
    key: "file",
    label: "File",
    icon: <File size={16} aria-hidden="true" />,
  };
}

function shortSourceDescription(source: ComposeSourceSummary): string {
  const rawTitle = sourceTitle(source).trim();
  let value = rawTitle;
  if (source.kind === "jira") {
    const key = jiraIssueKey(source);
    const summary = rawTitle.split(/\s+\|\s+/)[0]?.trim() || rawTitle;
    const description = key
      ? summary
          .replace(key, "")
          .replace(/^[-:\s|]+/, "")
          .trim() || "Jira ticket"
      : summary;
    value = key ? `${key}: ${description}` : description;
  } else if (/^https?:\/\//i.test(rawTitle)) {
    try {
      const url = new URL(rawTitle);
      const pathLabel = decodeURIComponent(
        url.pathname.split("/").filter(Boolean).pop() ?? "",
      )
        .replace(/[-_]+/g, " ")
        .trim();
      value = pathLabel || url.hostname.replace(/^www\./, "");
    } catch {
      value = rawTitle;
    }
  } else if (source.kind === "file") {
    value = rawTitle.replace(/\.[^.]+$/, "");
  }

  value = value.replace(/\s+/g, " ").trim() || rawTitle;
  return value.length > 48 ? `${value.slice(0, 45).trimEnd()}…` : value;
}

function failureLabel(source: ComposeSourceSummary): string {
  if (source.conversionStatus === "unsupported") return "Unsupported source";
  const message = source.errorMessage ?? "";
  if (/not allowed|public url|private|localhost|https/i.test(message)) {
    return "URL policy blocked";
  }
  if (/timeout|timed out|SDK timeout/i.test(message)) {
    return "Timed out";
  }
  if (/size|too large|limit/i.test(message)) {
    return "Size limit";
  }
  return "Conversion failed";
}

function canPreview(source: ComposeSourceSummary): boolean {
  if (isImageSource(source) && source.conversionStatus !== "awaiting_upload") {
    return true;
  }
  return (
    source.conversionStatus === "converted" &&
    Boolean(source.markdownContent?.trim())
  );
}

function previewButtonLabel(
  source: ComposeSourceSummary,
  title: string,
): string {
  return isImageSource(source)
    ? `Open image preview for ${title}`
    : `Open markdown preview for ${title}`;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g)
    .filter(Boolean);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${part}-${idx}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${part}-${idx}`}>{part.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = link[2].trim();
      const safeHref = /^(https?:|mailto:)/i.test(href) ? href : "#";
      return (
        <a
          key={`${part}-${idx}`}
          href={safeHref}
          target="_blank"
          rel="noreferrer"
        >
          {link[1]}
        </a>
      );
    }
    return <span key={`${part}-${idx}`}>{part}</span>;
  });
}

function inlineMarkdownText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    lines[index]?.includes("|") &&
    index + 1 < lines.length &&
    isTableSeparator(lines[index + 1])
  );
}

function MarkdownPreviewDocument({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  const nodes: ReactElement[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const content = paragraph.join(" ");
    paragraph = [];
    nodes.push(
      <p key={`p-${nodes.length}`}>{renderInlineMarkdown(content)}</p>,
    );
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {items.map((item, idx) => (
          <li key={`${item}-${idx}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
  };

  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed === "---") {
      flushBlocks();
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushBlocks();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      nodes.push(
        <pre key={`code-${nodes.length}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (isTableStart(lines, i)) {
      flushBlocks();
      const headers = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      i -= 1;
      nodes.push(
        <table key={`table-${nodes.length}`}>
          <thead>
            <tr>
              {headers.map((header, idx) => (
                <th key={`${header}-${idx}`} scope="col">
                  {renderInlineMarkdown(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={`row-${rowIdx}`}>
                {headers.map((_, cellIdx) => (
                  <td
                    key={`cell-${rowIdx}-${cellIdx}`}
                    aria-label={
                      inlineMarkdownText(row[cellIdx] ?? "") || undefined
                    }
                  >
                    {renderInlineMarkdown(row[cellIdx] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushBlocks();
      const content = renderInlineMarkdown(heading[2]);
      if (heading[1].length === 1) {
        nodes.push(<h1 key={`h-${nodes.length}`}>{content}</h1>);
      } else if (heading[1].length === 2) {
        nodes.push(<h2 key={`h-${nodes.length}`}>{content}</h2>);
      } else {
        nodes.push(<h3 key={`h-${nodes.length}`}>{content}</h3>);
      }
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1]);
      continue;
    }

    const quote = /^>\s?(.+)$/.exec(trimmed);
    if (quote) {
      flushBlocks();
      nodes.push(
        <blockquote key={`quote-${nodes.length}`}>
          {renderInlineMarkdown(quote[1])}
        </blockquote>,
      );
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }
  flushBlocks();

  return <div className="sf-markdown-preview-document">{nodes}</div>;
}

export function SourcesPanel({
  sources,
  sourceDeletions,
  onReconvert,
  onReconvertFailed,
  onDeleteSource,
  onRestoreSource,
  onOpenAddSources,
  onPasteSource = () => undefined,
  pasteSourceBusy = false,
  onGetSourcePreview,
  contextProjection,
  readiness,
  contextUpdating,
}: {
  sources: ComposeSourceSummary[];
  sourceDeletions: ComposeSourceDeletionSummary[];
  onReconvert: (sourceId: number) => void;
  onReconvertFailed: () => void;
  onDeleteSource: (sourceId: number) => void;
  onRestoreSource: (sourceId: number) => void;
  onOpenAddSources: () => void;
  onPasteSource?: () => void;
  pasteSourceBusy?: boolean;
  onGetSourcePreview?: (sourceId: number) => Promise<ComposeSourcePreview>;
  contextProjection: ComposeContextProjection | null;
  readiness: ComposeReadiness | null;
  contextUpdating: boolean;
}) {
  const [previewSource, setPreviewSource] =
    useState<ComposeSourceSummary | null>(null);
  const [deleteSource, setDeleteSource] = useState<ComposeSourceSummary | null>(
    null,
  );
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [activeTab, setActiveTab] = useState<"sources" | "artifacts">(
    "sources",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const uploadedSources = sources.filter(
    (source) => source.kind !== "generated_research",
  );
  const generatedSources = sources.filter(
    (source) => source.kind === "generated_research",
  );
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleUploadedSources = uploadedSources
    .filter((source) => {
      if (
        needsAttentionOnly &&
        !isRetryable(source.conversionStatus) &&
        source.conversionStatus !== "unsupported"
      ) {
        return false;
      }
      if (!normalizedSearch) return true;
      return [
        sourceTitle(source),
        source.sourceSummary,
        source.sourceContribution,
        jiraIssueKey(source),
      ].some((value) => value?.toLowerCase().includes(normalizedSearch));
    })
    .sort((left, right) =>
      newestFirst ? right.id - left.id : left.id - right.id,
    );
  const showEmptySourceState = uploadedSources.length === 0;
  const retryableCount = uploadedSources.filter((source) =>
    isRetryable(source.conversionStatus),
  ).length;
  const undoableDeletions = sourceDeletions.filter(
    (deletion) =>
      deletion.status === "undoable" &&
      new Date(deletion.undoUntil).getTime() > now,
  );

  useEffect(() => {
    if (undoableDeletions.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [undoableDeletions.length]);

  function toggleSource(sourceId: number) {
    setExpandedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  }

  return (
    <section className="sf-compose-panel sf-sources-panel" aria-label="Sources">
      <header className="sf-sources-header">
        <div className="sf-knowledge-tabs" role="tablist" aria-label="Knowledge">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "sources"}
            className={activeTab === "sources" ? "is-active" : ""}
            onClick={() => setActiveTab("sources")}
          >
            Sources <span>{uploadedSources.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "artifacts"}
            className={activeTab === "artifacts" ? "is-active" : ""}
            onClick={() => setActiveTab("artifacts")}
          >
            Artifacts
          </button>
        </div>
      </header>

      {activeTab === "sources" ? (
        <>
          <div className="sf-source-toolbar">
            <label className="sf-source-search">
              <Search size={16} aria-hidden="true" />
              <span className="sf-visually-hidden">Search sources</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search sources..."
              />
            </label>
          </div>
          <div className="sf-source-view-controls">
            <button
              type="button"
              className={needsAttentionOnly ? "is-active" : ""}
              onClick={() => setNeedsAttentionOnly((current) => !current)}
              aria-pressed={needsAttentionOnly}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              Needs attention
              {retryableCount > 0 ? <span>{retryableCount}</span> : null}
            </button>
            <button
              type="button"
              onClick={() => setNewestFirst((current) => !current)}
              aria-label={`Sort ${newestFirst ? "oldest" : "newest"} first`}
            >
              <ArrowDownUp size={14} aria-hidden="true" />
              {newestFirst ? "Newest" : "Oldest"}
            </button>
          </div>
          <div className="sf-source-add-row">
            <button
              className="sf-source-add-button"
              type="button"
              onClick={onOpenAddSources}
            >
              <FilePlus2 size={17} aria-hidden="true" />
              Add source
            </button>
            <button
              className="sf-source-paste-button"
              type="button"
              onClick={onPasteSource}
              disabled={pasteSourceBusy}
              aria-label="Paste clipboard as a source"
              title="Paste clipboard as a source"
            >
              <ClipboardPaste size={17} aria-hidden="true" />
              {pasteSourceBusy ? "Pasting..." : "Paste"}
            </button>
          </div>
          <div className="sf-source-count">
            {visibleUploadedSources.length} source
            {visibleUploadedSources.length === 1 ? "" : "s"}
          </div>
          <div className="sf-source-panel-body">
        {showEmptySourceState ? (
          <div className="sf-source-saved-area">
            <strong>Saved sources will appear here</strong>
            <span>
              Drop files, paste notes, or add a YouTube/web URL from "Add
              sources".
            </span>
          </div>
        ) : visibleUploadedSources.length > 0 ? (
          <ul className="sf-compose-source-list">
            {visibleUploadedSources.map((source) => {
              const title = sourceTitle(source);
              const category = sourceCategory(source);
              const badgeLabel = sourceBadgeLabel(source, category);
              const description = shortSourceDescription(source);
              const expanded = expandedSourceIds.has(source.id);
              const detailsId = `sf-compose-source-details-${source.id}`;
              const usefulness = sourceUsefulnessLabel(source.sourceUsefulness);
              const entityChips = sourceEntityChips(source);

              return (
                <li
                  key={source.id}
                  className={`sf-compose-source is-${source.conversionStatus} ${
                    expanded ? "is-expanded" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="sf-compose-source-row"
                    aria-expanded={expanded}
                    aria-controls={detailsId}
                    aria-label={`${expanded ? "Collapse" : "Expand"} source ${title}`}
                    onClick={() => toggleSource(source.id)}
                  >
                    <span
                      className={`sf-compose-source-kind is-${category.key}`}
                      aria-label={`${category.label}: ${badgeLabel}`}
                      title={`${category.label}: ${badgeLabel}`}
                    >
                      {category.icon}
                      <span>{badgeLabel}</span>
                    </span>
                    <span className="sf-compose-source-main">
                      <span className="sf-compose-source-name">
                        {description}
                      </span>
                      {source.sourceSummary ? (
                        <span className="sf-compose-source-summary">
                          {source.sourceSummary}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`sf-compose-source-state is-${source.conversionStatus}`}
                      aria-label={`${BADGE_LABEL[source.conversionStatus]}: ${STATUS_DETAIL[source.conversionStatus]}`}
                    >
                      <SourceStatusIcon status={source.conversionStatus} />
                      {source.conversionStatus === "converted" ? null : (
                        <span>{BADGE_LABEL[source.conversionStatus]}</span>
                      )}
                    </span>
                    <ChevronDown
                      className="sf-compose-source-chevron"
                      size={16}
                      aria-hidden="true"
                    />
                  </button>
                  {expanded ? (
                    <div id={detailsId} className="sf-compose-source-details">
                      <div className="sf-compose-source-expanded-title">
                        <strong>{title}</strong>
                        <small>{sourceMeta(source)}</small>
                      </div>
                      <div className="sf-compose-source-actions">
                        {canPreview(source) ? (
                          <button
                            type="button"
                            className="sf-compose-source-open"
                            aria-label={previewButtonLabel(source, title)}
                            title={
                              isImageSource(source)
                                ? "Open image preview"
                                : "Open markdown preview"
                            }
                            onClick={() => setPreviewSource(source)}
                          >
                            <ExternalLink size={15} aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="sf-compose-source-delete"
                          aria-label={`Delete source ${title}`}
                          title="Delete source"
                          onClick={() => setDeleteSource(source)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                        {isRetryable(source.conversionStatus) ? (
                          <button
                            type="button"
                            className="sf-compose-source-retry"
                            aria-label={`Retry source ${title}`}
                            onClick={() => onReconvert(source.id)}
                          >
                            <RefreshCw size={14} aria-hidden="true" />
                            <span>Retry</span>
                          </button>
                        ) : null}
                      </div>
                      {source.errorMessage ? (
                        <div className="sf-compose-source-error">
                          <strong>{failureLabel(source)}</strong>
                          <span>{source.errorMessage}</span>
                        </div>
                      ) : null}
                      {source.sourceSummary ||
                      source.sourceContribution ||
                      usefulness ||
                      entityChips.length > 0 ? (
                        <div
                          className="sf-compose-source-intelligence"
                          aria-label={`Source intelligence for ${title}`}
                        >
                          <div className="sf-compose-source-intelligence-head">
                            <strong>Source intelligence</strong>
                            {usefulness ? <span>{usefulness}</span> : null}
                          </div>
                          {source.sourceContribution ? (
                            <p>{source.sourceContribution}</p>
                          ) : source.sourceSummary ? (
                            <p>{source.sourceSummary}</p>
                          ) : null}
                          {entityChips.length > 0 ? (
                            <div
                              className="sf-compose-source-entity-chips"
                              aria-label="Extracted entities"
                            >
                              {entityChips.map((chip) => (
                                <span key={chip}>{chip}</span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="sf-source-saved-area is-filtered">
            <strong>No matching sources</strong>
            <span>Clear the search or filter to see all sources.</span>
          </div>
        )}
        {undoableDeletions.length > 0 ? (
          <section
            className="sf-source-deletions"
            aria-labelledby="sf-source-deletions-title"
          >
            <div className="sf-source-deletions-heading">
              <strong id="sf-source-deletions-title">Recently removed</strong>
              <span>{undoableDeletions.length}</span>
            </div>
            <ul>
              {undoableDeletions.map((deletion) => {
                const secondsRemaining = Math.max(
                  1,
                  Math.ceil(
                    (new Date(deletion.undoUntil).getTime() - now) / 1_000,
                  ),
                );
                const timeRemaining =
                  secondsRemaining >= 60
                    ? `${Math.ceil(secondsRemaining / 60)} min`
                    : `${secondsRemaining}s`;
                return (
                  <li key={deletion.id}>
                    <span>
                      <strong>{deletion.sourceTitle}</strong>
                      <small>
                        Undo available for {timeRemaining}
                        {deletion.dependentSourceCount > 0
                          ? ` · ${deletion.dependentSourceCount} derived artifact${
                              deletion.dependentSourceCount === 1 ? "" : "s"
                            } removed`
                          : ""}
                      </small>
                    </span>
                    <button
                      type="button"
                      onClick={() => onRestoreSource(deletion.sourceId)}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Undo
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
          </div>
          <footer className="sf-sources-footer">
        <div className="sf-source-footer-actions">
          {retryableCount > 0 ? (
            <button
              type="button"
              className="sf-button sf-button-compact sf-source-retry-all"
              onClick={onReconvertFailed}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Retry failed ({retryableCount})
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
          <span aria-hidden="true" />
        </div>
          </footer>
        </>
      ) : (
        <div className="sf-source-panel-body sf-artifact-panel-body">
          <ArtifactsSection
            projection={contextProjection}
            readiness={readiness}
            generatedSources={generatedSources}
            updating={contextUpdating}
            embedded
          />
        </div>
      )}
      {previewSource ? (
        <SourcePreviewModal
          source={previewSource}
          onClose={() => setPreviewSource(null)}
          onGetSourcePreview={onGetSourcePreview}
        />
      ) : null}
      {deleteSource ? (
        <DeleteSourceModal
          source={deleteSource}
          onClose={() => setDeleteSource(null)}
          onConfirm={() => {
            onDeleteSource(deleteSource.id);
            setDeleteSource(null);
          }}
        />
      ) : null}
    </section>
  );
}

function SourceStatusIcon({ status }: { status: ComposeConversionStatus }) {
  if (status === "awaiting_upload") {
    return <UploadCloud size={15} aria-hidden="true" />;
  }
  if (status === "pending" || status === "converting") {
    return (
      <LoaderCircle size={15} aria-hidden="true" className="is-spinning" />
    );
  }
  if (status === "converted") {
    return <CheckCircle2 size={15} aria-hidden="true" />;
  }
  return <AlertTriangle size={15} aria-hidden="true" />;
}

function DeleteSourceModal({
  source,
  onClose,
  onConfirm,
}: {
  source: ComposeSourceSummary;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const title = sourceTitle(source);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const modal = (
    <div
      className="sf-source-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="sf-source-modal sf-delete-source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-delete-source-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          className="sf-source-close"
          type="button"
          aria-label="Close delete source"
          onClick={onClose}
        >
          <X size={28} aria-hidden="true" />
        </button>
        <header className="sf-source-modal-header">
          <h2 id="sf-delete-source-title">Delete source</h2>
          <p>{title}</p>
        </header>
        <p className="sf-delete-source-warning">
          This source and any research derived from it will be removed from the
          current requirements. You can undo this action for a short time.
        </p>
        <div className="sf-compose-modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="is-danger" onClick={onConfirm}>
            Delete source
          </button>
        </div>
      </section>
    </div>
  );

  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}

function SourcePreviewModal({
  source,
  onClose,
  onGetSourcePreview,
}: {
  source: ComposeSourceSummary;
  onClose: () => void;
  onGetSourcePreview?: (sourceId: number) => Promise<ComposeSourcePreview>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [imagePreview, setImagePreview] = useState<ComposeSourcePreview | null>(
    null,
  );
  const [imageError, setImageError] = useState<string | null>(null);
  const title = sourceTitle(source);
  const markdown = source.markdownContent ?? "";
  const imagePreviewMode = isImageSource(source);

  async function copyMarkdown() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is unavailable");
      }
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function downloadMarkdown() {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileStem(title)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!imagePreviewMode) return;
    if (!onGetSourcePreview) {
      setImageError("Image preview is unavailable");
      return;
    }
    let active = true;
    setImagePreview(null);
    setImageError(null);
    onGetSourcePreview(source.id)
      .then((preview) => {
        if (active) setImagePreview(preview);
      })
      .catch((error) => {
        if (!active) return;
        setImageError(
          error instanceof Error ? error.message : "Image preview failed",
        );
      });
    return () => {
      active = false;
    };
  }, [imagePreviewMode, onGetSourcePreview, source.id]);

  const modal = (
    <div
      className="sf-source-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="sf-source-modal sf-markdown-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-markdown-preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          className="sf-source-close"
          type="button"
          aria-label="Close source preview"
          onClick={onClose}
        >
          <X size={28} aria-hidden="true" />
        </button>
        <header className="sf-source-modal-header sf-markdown-preview-header">
          <h2 id="sf-markdown-preview-title">
            {imagePreviewMode ? "Source Preview" : "Source Summary"}
          </h2>
          <p>{title}</p>
        </header>
        <div className="sf-markdown-preview-meta">
          <span>{source.kind}</span>
          <span>{BADGE_LABEL[source.conversionStatus]}</span>
        </div>
        {imagePreviewMode ? (
          <div className="sf-source-image-preview-frame">
            {imagePreview ? (
              <img src={imagePreview.url} alt={title} />
            ) : imageError ? (
              <p role="alert">{imageError}</p>
            ) : (
              <p>Loading preview...</p>
            )}
          </div>
        ) : (
          <>
            <div className="sf-markdown-preview-actions">
              <button
                type="button"
                className="sf-button sf-button-compact"
                aria-label={`Copy markdown for ${title}`}
                onClick={() => void copyMarkdown()}
              >
                <Copy size={14} aria-hidden="true" />
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy"}
              </button>
              <button
                type="button"
                className="sf-button sf-button-compact"
                aria-label={`Download markdown for ${title}`}
                onClick={downloadMarkdown}
              >
                <Download size={14} aria-hidden="true" />
                Download
              </button>
            </div>
            <MarkdownPreviewDocument markdown={markdown} />
          </>
        )}
      </section>
    </div>
  );

  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}
