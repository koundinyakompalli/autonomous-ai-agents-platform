import { useEffect, useMemo, useRef, useState } from "react";
import { MiniPipeline } from "./MiniPipeline.js";
import {
  ERROR_DISPLAY_STATES,
  EXECUTING_STATES,
  PIPELINE_STAGES,
  QUEUED_STATES,
  STAGE_LABELS,
  TERMINAL_STATES,
  WAITING_STATES,
} from "./pipelineStyles.js";
import type {
  OneShotArtifactRun,
  OneShotArtifactRunMode,
  OneShotDashboardRow,
} from "./types.js";
import {
  TICKET_TYPE_OPTIONS,
  ticketTypeLabel,
  type TicketTypeFilter,
} from "./ticketTypes.js";
import type { ViewMode } from "./viewTabDefs.js";
import {
  formatDateTime,
  formatDuration,
  formatRunElapsed,
  hasManualRestart,
  formatRelTime,
  formatCostSource,
  formatTokens,
  formatUsd,
} from "./formatters.js";
import { StatusPill } from "./StatusPill.js";
import { PageHeader } from "./PageHeader.js";
import { PageHeaderActions } from "./PageHeaderActions.js";
import { deriveStatusTone } from "./statusTone.js";
import type { StatusTone } from "./statusTone.js";
import { glassPlaceStyle } from "./motion.js";
import {
  displayStateLabel,
  failureAttributionChipClass,
} from "./failureDisplay.js";
import { GitBranch, ICON_SIZE, ICON_STROKE } from "./icons.js";

type SegmentState = "completed" | "active" | "failed" | "warning" | "pending";

function stageIndex(stage: string): number {
  const idx = (PIPELINE_STAGES as string[]).indexOf(stage);
  return idx >= 0 ? idx : 0;
}

function classifySegment(
  row: OneShotDashboardRow,
  idx: number,
  current: number,
): SegmentState {
  if (idx < current) return "completed";
  if (idx > current) return "pending";
  if (
    TERMINAL_STATES.includes(row.displayState) &&
    !ERROR_DISPLAY_STATES.includes(row.displayState)
  ) {
    return "completed";
  }
  if (ERROR_DISPLAY_STATES.includes(row.displayState)) {
    return row.failureAttribution?.attribution === "ticket"
      ? "warning"
      : "failed";
  }
  return "active";
}

const RING_SEGMENT_CLASSES: Record<SegmentState, string> = {
  completed: "ring-mini-success",
  active: "ring-mini-running",
  failed: "ring-mini-failed",
  warning: "ring-mini-warning",
  pending: "ring-mini-pending",
};

// SVG ring constants.
// Radius is sized so the stroke fits inside the 36-unit viewBox: the stroke
// outer edge = RING_RADIUS + RING_STROKE/2 must stay <= 18 (the viewBox half)
// or the circle gets clipped flat. pathLength is pinned to 100 on every
// <circle> so the dash math below stays independent of the geometric radius.
const RING_RADIUS = 13.5; // 13.5 + 8/2 = 17.5 <= 18 ✓
const RING_STROKE = 8;
const RING_PATH_LENGTH = 100;
const RING_CIRCUMFERENCE = RING_PATH_LENGTH;
const RING_ARC_COUNT = 7;
const RING_ARC_LENGTH = RING_CIRCUMFERENCE / RING_ARC_COUNT; // ≈ 14.285
const RING_GAP = 4.4; // wider gap keeps the 7 arcs distinct at the thicker stroke
const RING_VISIBLE = RING_ARC_LENGTH - RING_GAP; // ≈ 9.885

function StageRing({
  row,
  size = 21,
}: {
  row: OneShotDashboardRow | null;
  size?: number;
}) {
  const current = row ? stageIndex(row.progressStage) : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      className={row ? undefined : "stage-ring-ghost"}
      aria-hidden="true"
    >
      {/* No track circle behind the arcs: the inter-segment gaps show pure row
          background, exactly like the gaps between single-repo pipeline pills.
          A track would tint those gaps (0.13 white -> a visible separator) and,
          on ghosts, double up with the arc's own 0.05 layer. Every stage already
          paints its own arc (pending stages included), so the track only ever
          filled the gaps. */}
      <g transform="rotate(-90 18 18)">
        {PIPELINE_STAGES.map((stage, idx) => {
          const cls = row
            ? RING_SEGMENT_CLASSES[classifySegment(row, idx, current)]
            : "ring-mini-pending";
          const offset = -(idx * RING_ARC_LENGTH) + 25;
          return (
            <circle
              key={stage}
              cx={18}
              cy={18}
              r={RING_RADIUS}
              strokeWidth={RING_STROKE}
              pathLength={RING_PATH_LENGTH}
              fill="none"
              strokeDasharray={`${RING_VISIBLE} ${RING_CIRCUMFERENCE - RING_VISIBLE}`}
              strokeDashoffset={offset}
              className={`ring-seg ${cls}`}
            />
          );
        })}
      </g>
    </svg>
  );
}

type RunFilter = "all" | "active" | "failed" | "completed";
type RunsSection = "pipeline" | "artifacts";
type ArtifactModeFilter = "all" | OneShotArtifactRunMode;
type RunGroup = {
  groupId: number;
  rows: OneShotDashboardRow[];
  groupMetadata: OneShotDashboardRow["groupMetadata"];
};
type RunItem = OneShotDashboardRow | RunGroup;

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [DEFAULT_PAGE_SIZE, 50, 100] as const;

const GROUP_TONE_PRIORITY: Record<StatusTone, number> = {
  failed: 7,
  blocked: 6,
  waiting: 5,
  queued: 4,
  running: 3,
  completed: 2,
  neutral: 1,
};

function isRunsCompleted(row: OneShotDashboardRow): boolean {
  return row.displayState === "completed" || row.displayState === "pr_open";
}

function deriveRunGroupStatusTone(rows: OneShotDashboardRow[]): StatusTone {
  return rows
    .map((row) => deriveStatusTone(row))
    .sort((a, b) => GROUP_TONE_PRIORITY[b] - GROUP_TONE_PRIORITY[a])[0] ?? "neutral";
}

function getTimestampMs(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getRunGroupSummary(rows: OneShotDashboardRow[]) {
  const completedCount = rows.filter(isRunsCompleted).length;
  const earliestCreatedAt = rows.reduce((earliest, row) =>
    getTimestampMs(row.createdAt) < getTimestampMs(earliest)
      ? row.createdAt
      : earliest,
  rows[0]?.createdAt ?? new Date(0).toISOString());
  const latestUpdatedAt = rows.reduce((latest, row) =>
    getTimestampMs(row.updatedAt) > getTimestampMs(latest)
      ? row.updatedAt
      : latest,
  rows[0]?.updatedAt ?? earliestCreatedAt);

  return {
    completedCount,
    earliestCreatedAt,
    latestUpdatedAt,
    elapsed: formatDuration(earliestCreatedAt, latestUpdatedAt),
    totalTokensUsed: rows.reduce((sum, row) => sum + row.totalTokensUsed, 0),
    estimatedCostUsd: rows.reduce((sum, row) => sum + row.estimatedCostUsd, 0),
  };
}

function isMultiBranchRetrofitGroup(
  groupMetadata: OneShotDashboardRow["groupMetadata"],
): boolean {
  return groupMetadata?.mode === "multi_branch_retrofit";
}

function getRepoMergeOrder(
  row: OneShotDashboardRow,
  groupMetadata: OneShotDashboardRow["groupMetadata"],
): number | null {
  const repoName = row.repoName;
  if (!repoName) return null;
  const order = groupMetadata?.mergeOrder?.[repoName];
  return typeof order === "number" ? order : null;
}

function getRepoBranch(
  row: OneShotDashboardRow,
  groupMetadata: OneShotDashboardRow["groupMetadata"],
): string | null {
  if (row.baseBranch) return row.baseBranch;
  const repoName = row.repoName;
  if (!repoName) return null;
  return groupMetadata?.repos.find((repo) => repo.repo_name === repoName)?.branch_name ?? null;
}

function getRetrofitTargetOrder(
  row: OneShotDashboardRow,
  groupMetadata: OneShotDashboardRow["groupMetadata"],
): number | null {
  if (!isMultiBranchRetrofitGroup(groupMetadata)) return null;
  const targetBranch = getRepoBranch(row, groupMetadata);
  if (!targetBranch) return null;
  const order = groupMetadata?.targetBranches?.find(
    (target) => target.targetBranch === targetBranch,
  )?.targetOrder;
  return typeof order === "number" ? order : null;
}

function sortRunGroupRows(
  rows: OneShotDashboardRow[],
  groupMetadata: OneShotDashboardRow["groupMetadata"],
): OneShotDashboardRow[] {
  return [...rows].sort((a, b) => {
    if (isMultiBranchRetrofitGroup(groupMetadata)) {
      const aOrder = getRetrofitTargetOrder(a, groupMetadata) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = getRetrofitTargetOrder(b, groupMetadata) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aBranch = getRepoBranch(a, groupMetadata) ?? a.jiraKey;
      const bBranch = getRepoBranch(b, groupMetadata) ?? b.jiraKey;
      return aBranch.localeCompare(bBranch);
    }
    const aOrder = getRepoMergeOrder(a, groupMetadata) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = getRepoMergeOrder(b, groupMetadata) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (a.repoName ?? a.jiraKey).localeCompare(b.repoName ?? b.jiraKey);
  });
}

function readinessLabel(row: OneShotDashboardRow): string | null {
  switch (row.readiness) {
    case "ready":
      return "Ready";
    case "draft":
      return "Draft";
    case "needs_review":
      return null;
    case "with_risks":
      return "With Risks";
    case "no_action":
      return "No Action";
    default:
      return null;
  }
}

function shouldShowFailureAttributionChip(
  row: OneShotDashboardRow,
): row is OneShotDashboardRow & {
  failureAttribution: NonNullable<OneShotDashboardRow["failureAttribution"]>;
} {
  return (
    row.failureAttribution !== null &&
    row.failureAttribution !== undefined &&
    row.failureAttribution.attribution !== "oneshot"
  );
}

function artifactModeLabel(mode: OneShotArtifactRunMode): string {
  switch (mode) {
    case "wiz":
      return "Wiz";
    case "sonar":
      return "SonarQube";
    case "wiz_sast":
      return "Wiz SAST";
    case "documentation":
      return "Documentation";
  }
}

function artifactStatusLabel(status: string): string {
  return status
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function artifactReviewLabel(run: OneShotArtifactRun): string {
  if (!run.humanReviewRequired) {
    return "None";
  }
  return run.humanReviewCount > 0
    ? `${run.humanReviewCount} item${run.humanReviewCount === 1 ? "" : "s"}`
    : "Required";
}

function isRunsWaiting(row: OneShotDashboardRow): boolean {
  return (
    row.displayState !== "pr_open" && WAITING_STATES.includes(row.displayState)
  );
}

function isRunsActive(row: OneShotDashboardRow): boolean {
  return !TERMINAL_STATES.includes(row.displayState) && !isRunsCompleted(row);
}

function matchesBucketFilter(
  row: OneShotDashboardRow,
  bucketFilter: ViewMode | null,
): boolean {
  if (bucketFilter === null) return true;
  if (bucketFilter === "running") {
    return EXECUTING_STATES.includes(row.displayState);
  }
  if (bucketFilter === "queued") {
    return QUEUED_STATES.includes(row.displayState);
  }
  if (bucketFilter === "waiting") {
    return isRunsWaiting(row);
  }
  return TERMINAL_STATES.includes(row.displayState) || isRunsCompleted(row);
}

function ArtifactRunDetailModal({
  run,
  onClose,
}: {
  run: OneShotArtifactRun;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "var(--modal-overlay)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="oneshot-modal-scroll artifact-run-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-run-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="artifact-run-detail">
          <div className="artifact-run-detail-head">
            <div>
              <div className="mono dim">{artifactModeLabel(run.mode)}</div>
              <h2 id="artifact-run-title">{run.sourceKey}</h2>
              <p>{run.title}</p>
            </div>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>

          <div className="artifact-run-metrics">
            <div>
              <span className="meta-chip-label">status</span>
              <strong>{artifactStatusLabel(run.status)}</strong>
            </div>
            <div>
              <span className="meta-chip-label">generated</span>
              <strong>{run.generatedCount}</strong>
            </div>
            <div>
              <span className="meta-chip-label">oneshot runs</span>
              <strong>{run.oneshotRunCount}</strong>
            </div>
            <div>
              <span className="meta-chip-label">human review</span>
              <strong>{artifactReviewLabel(run)}</strong>
            </div>
          </div>

          <section>
            <h3>Generated Tickets</h3>
            {run.generatedTickets.length > 0 ? (
              <div className="artifact-ticket-list">
                {run.generatedTickets.map((ticket) => (
                  <div key={ticket.key} className="artifact-ticket-row">
                    <div>
                      <strong className="mono">{ticket.key}</strong>
                      {ticket.title && <span>{ticket.title}</span>}
                    </div>
                    <div className="artifact-ticket-actions">
                      {ticket.jiraUrl && (
                        <a
                          href={ticket.jiraUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Jira
                        </a>
                      )}
                      {ticket.currentPrUrl && (
                        <a
                          href={ticket.currentPrUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PR
                        </a>
                      )}
                      {ticket.oneshotRunDashboardId && (
                        <span className="mono">
                          {ticket.oneshotRunDashboardId}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim">No generated ticket keys recorded yet.</p>
            )}
          </section>

          {run.reviewItems.length > 0 && (
            <section>
              <h3>Human Review</h3>
              <ul>
                {run.reviewItems.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            </section>
          )}

          {run.jiraSummary && (
            <section>
              <h3>Jira Summary</h3>
              <pre className="artifact-run-summary">{run.jiraSummary}</pre>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function RunsPager({
  ariaLabel,
  total,
  page,
  pageSize,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: {
  ariaLabel: string;
  total: number;
  page: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageChange: (n: number) => void;
  onPageSizeChange: (n: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <nav className="inline-pager" aria-label={ariaLabel}>
      <span className="mono dim">
        Showing {start}–{end} of {total}
      </span>
      <div className="inline-pager-controls">
        <select
          className="select-field mono"
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-ghost mono"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn-ghost mono"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

export function RunsView({
  rows,
  artifactRuns = [],
  onOpenDetail,
  searchFocusToken = 0,
  bucketFilter = null,
  onSearch,
  onNewRun,
  theme,
  onThemeChange,
}: {
  rows: ReadonlyArray<OneShotDashboardRow>;
  artifactRuns?: ReadonlyArray<OneShotArtifactRun>;
  onOpenDetail: (row: OneShotDashboardRow) => void;
  searchFocusToken?: number;
  bucketFilter?: ViewMode | null;
  onSearch?: () => void;
  onNewRun?: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (next: "light" | "dark") => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const [stageFilter, setStageFilter] = useState("any");
  const [ticketTypeFilter, setTicketTypeFilter] =
    useState<TicketTypeFilter>("all");
  const [section, setSection] = useState<RunsSection>("pipeline");
  const [artifactMode, setArtifactMode] = useState<ArtifactModeFilter>("all");
  const [selectedArtifactRun, setSelectedArtifactRun] =
    useState<OneShotArtifactRun | null>(null);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [pipelinePage, setPipelinePage] = useState(1);
  const [artifactPage, setArtifactPage] = useState(1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (searchFocusToken <= 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocusToken]);

  const scopedRows = useMemo(
    () => rows.filter((row) => matchesBucketFilter(row, bucketFilter)),
    [bucketFilter, rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...scopedRows]
      .sort(
        // Order by creation time (not last activity) so newly added runs
        // stay pinned to the top and the list doesn't reshuffle whenever an
        // older run changes state. Matches the "started" column.
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .filter((row) => {
        if (filter === "active" && !isRunsActive(row)) {
          return false;
        }
        if (
          filter === "failed" &&
          !ERROR_DISPLAY_STATES.includes(row.displayState)
        ) {
          return false;
        }
        if (filter === "completed" && !isRunsCompleted(row)) {
          return false;
        }
        if (stageFilter !== "any" && row.progressStage !== stageFilter) {
          return false;
        }
        if (ticketTypeFilter !== "all" && row.ticketType !== ticketTypeFilter) {
          return false;
        }
        if (bucketFilter !== "history" && row.staleRouter) {
          return false;
        }
        if (!q) return true;
        return [
          row.jiraKey,
          row.title,
          row.ticketType,
          row.jiraIssueType,
          row.customerName,
          row.repoName,
          row.implementationBranch,
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(q));
      });
  }, [bucketFilter, filter, query, scopedRows, stageFilter, ticketTypeFilter]);

  const filteredArtifacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...artifactRuns]
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      .filter((run) => {
        if (artifactMode !== "all" && run.mode !== artifactMode) {
          return false;
        }
        if (!q) return true;
        return [
          run.sourceKey,
          run.sourceParentKey,
          run.title,
          run.status,
          artifactModeLabel(run.mode),
          ...run.generatedTickets.flatMap((ticket) => [
            ticket.key,
            ticket.title,
          ]),
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(q));
      });
  }, [artifactMode, artifactRuns, query]);

  const hasScopedRuns =
    bucketFilter !== null ||
    filter !== "all" ||
    stageFilter !== "any" ||
    ticketTypeFilter !== "all" ||
    artifactMode !== "all" ||
    query.trim().length > 0;

  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(
    () => new Set(),
  );

  const renderedItems = useMemo((): RunItem[] => {
    const groups = new Map<number, OneShotDashboardRow[]>();
    const ungrouped: OneShotDashboardRow[] = [];
    for (const row of filtered) {
      if (row.runGroupId) {
        const existing = groups.get(row.runGroupId);
        if (existing) {
          existing.push(row);
        } else {
          groups.set(row.runGroupId, [row]);
        }
      } else {
        ungrouped.push(row);
      }
    }
    const items: RunItem[] = [...ungrouped];
    for (const [groupId, groupRows] of groups.entries()) {
      const groupMetadata = groupRows[0].groupMetadata;
      items.push({
        groupId,
        rows: sortRunGroupRows(groupRows, groupMetadata),
        groupMetadata,
      });
    }
    return items.sort((a, b) => {
      const aTime = "groupId" in a
        ? new Date(a.rows[0].createdAt).getTime()
        : new Date(a.createdAt).getTime();
      const bTime = "groupId" in b
        ? new Date(b.rows[0].createdAt).getTime()
        : new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [filtered]);

  const pipelineTotal = renderedItems.length;
  const artifactTotal = filteredArtifacts.length;
  const pipelineTotalPages = Math.max(1, Math.ceil(pipelineTotal / pageSize));
  const artifactTotalPages = Math.max(1, Math.ceil(artifactTotal / pageSize));
  const effectivePipelinePage = Math.min(pipelinePage, pipelineTotalPages);
  const effectiveArtifactPage = Math.min(artifactPage, artifactTotalPages);
  const showPipelinePager = pipelineTotal > DEFAULT_PAGE_SIZE;
  const showArtifactPager = artifactTotal > DEFAULT_PAGE_SIZE;

  const pagedPipelineItems = useMemo(
    () =>
      renderedItems.slice(
        (effectivePipelinePage - 1) * pageSize,
        (effectivePipelinePage - 1) * pageSize + pageSize,
      ),
    [effectivePipelinePage, renderedItems, pageSize],
  );
  const pagedArtifacts = useMemo(
    () =>
      filteredArtifacts.slice(
        (effectiveArtifactPage - 1) * pageSize,
        (effectiveArtifactPage - 1) * pageSize + pageSize,
      ),
    [effectiveArtifactPage, filteredArtifacts, pageSize],
  );

  // Reset: shared search resets both pagers.
  useEffect(() => {
    setPipelinePage(1);
    setArtifactPage(1);
  }, [query]);

  // Reset: pipeline-only filters reset just the pipeline pager.
  useEffect(() => {
    setPipelinePage(1);
  }, [filter, stageFilter, ticketTypeFilter, bucketFilter]);

  // Reset: artifact mode resets just the artifact pager.
  useEffect(() => {
    setArtifactPage(1);
  }, [artifactMode]);

  // Clamp when results shrink (polling / filter changes).
  useEffect(() => {
    if (pipelinePage > pipelineTotalPages) setPipelinePage(pipelineTotalPages);
  }, [pipelinePage, pipelineTotalPages]);
  useEffect(() => {
    if (artifactPage > artifactTotalPages) setArtifactPage(artifactTotalPages);
  }, [artifactPage, artifactTotalPages]);

  function handlePageSizeChange(next: number) {
    setPageSize(next);
    setPipelinePage(1);
    setArtifactPage(1);
  }

  function toggleRunGroup(groupId: number) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function renderRunGroup(item: RunGroup) {
    const expanded = expandedGroups.has(item.groupId);
    const primaryRow = item.rows[0];
    const groupSummary = getRunGroupSummary(item.rows);
    const groupTone = deriveRunGroupStatusTone(item.rows);
    const isMultiBranchRetrofit = isMultiBranchRetrofitGroup(item.groupMetadata);
    const groupKindLabel = isMultiBranchRetrofit
      ? "Multi-branch retrofit group"
      : "Multi-repo group";
    const countLabel = isMultiBranchRetrofit
      ? `${item.rows.length} target${item.rows.length === 1 ? "" : "s"}`
      : `${item.rows.length} repo${item.rows.length === 1 ? "" : "s"}`;
    const completedLabel = `${groupSummary.completedCount}/${item.rows.length} ${
      isMultiBranchRetrofit ? "retrofits" : "pipelines"
    } done`;
    const groupHasPrOpen = item.rows.some((row) => row.displayState === "pr_open");

    return (
      <div
        key={`group-${item.groupId}`}
        className={`run-group${expanded ? " is-expanded" : ""}`}
      >
        <button
          type="button"
          className="table-row run-group-header"
          onClick={() => toggleRunGroup(item.groupId)}
          aria-expanded={expanded}
          aria-label={`${groupKindLabel} ${item.groupId}: ${primaryRow.jiraKey}, ${primaryRow.title}${
            groupHasPrOpen ? " — PR Open" : ""
          }, ${countLabel}, ${completedLabel}`}
        >
          <div className="col-status">
            <span
              className={`run-group-toggle-tri status-${groupTone}`}
              aria-hidden="true"
            />
          </div>
          <div className="col-ticket mono run-group-ticket">
            {primaryRow.jiraKey}
          </div>
          <div
            className="col-title run-title-cell"
            title={primaryRow.title}
          >
            <span className="run-title-text">
              {primaryRow.title}
            </span>
            <span
              className={`run-ticket-type-chip ticket-type-${primaryRow.ticketType} mono`}
              title={
                primaryRow.jiraIssueType
                  ? `Jira type: ${primaryRow.jiraIssueType}`
                  : undefined
              }
            >
              {ticketTypeLabel(primaryRow.ticketType)}
            </span>
            {groupHasPrOpen && (
              <span className="run-status-chip mono">PR Open</span>
            )}
            {shouldShowFailureAttributionChip(primaryRow) && (
              <span
                className={`run-attribution-chip ${failureAttributionChipClass(primaryRow)} mono`}
              >
                {primaryRow.failureAttribution.label}
              </span>
            )}
            {readinessLabel(primaryRow) && primaryRow.readiness !== "ready" && (
              <span
                className={`run-readiness-chip readiness-${primaryRow.readiness} mono`}
              >
                {readinessLabel(primaryRow)}
              </span>
            )}
          </div>
          <div className="col-pipe run-group-pipelines">
            {/* Both multi-repo and multi-branch retrofit groups render the same compact
                stage-ring cluster; the aggregate count stays in the header aria-label. */}
            <div className="stage-rings" aria-hidden="true">
              {item.rows.map((row) => (
                <StageRing key={row.dashboardId} row={row} />
              ))}
              {Array.from({
                length: Math.max(0, PIPELINE_STAGES.length - item.rows.length),
              }).map((_, i) => (
                <StageRing key={`ghost-${i}`} row={null} />
              ))}
            </div>
          </div>
          <div
            className="col-time mono dim"
            title={`Group window: ${formatDateTime(groupSummary.earliestCreatedAt)} to ${formatDateTime(groupSummary.latestUpdatedAt)}`}
          >
            {groupSummary.elapsed}
          </div>
          <div className="col-tok mono dim">
            {formatTokens(groupSummary.totalTokensUsed)}
          </div>
          <div
            className="col-cost mono dim"
            title={formatUsd(groupSummary.estimatedCostUsd)}
          >
            {formatUsd(groupSummary.estimatedCostUsd)}
          </div>
          <div
            className="col-when mono dim"
            title={formatDateTime(groupSummary.earliestCreatedAt)}
          >
            {formatRelTime(groupSummary.earliestCreatedAt)}
          </div>
        </button>

        {expanded &&
          item.rows.map((row, index) => {
            const mergeOrder = getRepoMergeOrder(row, item.groupMetadata);
            const retrofitTargetOrder = getRetrofitTargetOrder(row, item.groupMetadata);
            const repoBranch = getRepoBranch(row, item.groupMetadata);
            const repoLabel = row.repoName ?? "Unknown repo";
            const childOrderLabel = isMultiBranchRetrofit
              ? `target ${retrofitTargetOrder ?? index + 1}`
              : `repo ${mergeOrder ?? index + 1}`;
            const childIdentity = isMultiBranchRetrofit
              ? repoBranch ?? repoLabel
              : repoLabel;
            const childTitle = isMultiBranchRetrofit && repoBranch
              ? `${repoBranch} (${repoLabel})`
              : repoLabel;

            return (
              <button
                key={row.dashboardId}
                type="button"
                className="table-row run-group-child"
                onClick={() => onOpenDetail(row)}
                aria-label={`Open details for ${childIdentity} in ${row.jiraKey}: ${displayStateLabel(row)}`}
              >
                <div className="col-status" aria-hidden="true" />
                <div className="col-ticket mono run-group-child-order">
                  {childOrderLabel}
                </div>
                <div
                  className="col-title run-title-cell run-group-child-title-cell"
                  title={childTitle}
                >
                  <span className="run-group-repo-name">{childIdentity}</span>
                  {isMultiBranchRetrofit && repoLabel !== childIdentity && (
                    <span className="run-group-branch-chip mono">
                      {repoLabel}
                    </span>
                  )}
                  {!isMultiBranchRetrofit && repoBranch && (
                    <span className="run-group-branch-chip mono">
                      <GitBranch
                        size={ICON_SIZE.xs}
                        strokeWidth={ICON_STROKE}
                        aria-hidden="true"
                      />
                      {repoBranch}
                    </span>
                  )}
                </div>
                <div className="col-pipe">
                  <MiniPipeline row={row} width={180} />
                </div>
                <div className="col-time mono dim">{formatRunElapsed(row)}</div>
                <div className="col-tok mono dim">
                  {formatTokens(row.totalTokensUsed)}
                </div>
                <div className="col-cost mono dim">
                  {formatUsd(row.estimatedCostUsd)}
                </div>
                <div
                  className="col-when mono dim"
                  title={formatDateTime(row.createdAt)}
                >
                  {formatRelTime(row.createdAt)}
                </div>
              </button>
            );
          })}
      </div>
    );
  }

  return (
    <div className="view">
      <PageHeader
        title="Runs"
        metrics={[
          { label: "total", value: rows.length },
          { label: "artifacts", value: artifactRuns.length },
          ...(hasScopedRuns
            ? [
                {
                  label: "matching",
                  value:
                    section === "pipeline"
                      ? filtered.length
                      : filteredArtifacts.length,
                },
              ]
            : []),
        ]}
        actions={
          <PageHeaderActions
            onSearch={onSearch}
            onNewRun={onNewRun}
            theme={theme}
            onThemeChange={onThemeChange}
          />
        }
      />

      <div
        className="runs-toolbar glass-place-block"
        style={glassPlaceStyle(0)}
      >
        <div
          className="runs-section-tabs filter-tabs"
          role="tablist"
          aria-label="Runs scope"
        >
          {(["pipeline", "artifacts"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`filter-tab${section === value ? " active" : ""}`}
              onClick={() => setSection(value)}
              role="tab"
              aria-selected={section === value}
            >
              {value === "pipeline" ? "Pipeline Runs" : "Artifact Runs"}
            </button>
          ))}
        </div>

        <label className="search-field" aria-label="Search runs">
          <span className="search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              section === "pipeline"
                ? "Search by ticket, title, customer, or repo…"
                : "Search by ticket, mode, status, or generated child…"
            }
            className="search-input"
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </label>

        {section === "pipeline" ? (
          <div className="runs-filters">
            <div
              className="filter-tabs"
              role="tablist"
              aria-label="Run filters"
            >
              {(["all", "active", "failed", "completed"] as const).map(
                (value) => (
                  <button
                    key={value}
                    type="button"
                    className={`filter-tab${filter === value ? " active" : ""}`}
                    onClick={() => setFilter(value)}
                    role="tab"
                    aria-selected={filter === value}
                  >
                    {value}
                  </button>
                ),
              )}
            </div>

            <select
              className="select-field mono"
              value={stageFilter}
              onChange={(event) => setStageFilter(event.target.value)}
              aria-label="Filter by stage"
            >
              <option value="any">any stage</option>
              {PIPELINE_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage].toLowerCase()}
                </option>
              ))}
            </select>

            <select
              className="select-field mono"
              value={ticketTypeFilter}
              onChange={(event) =>
                setTicketTypeFilter(event.target.value as TicketTypeFilter)
              }
              aria-label="Filter by ticket type"
            >
              {TICKET_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {type === "all" ? "all types" : ticketTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="runs-filters">
            <select
              className="select-field mono"
              value={artifactMode}
              onChange={(event) =>
                setArtifactMode(event.target.value as ArtifactModeFilter)
              }
              aria-label="Filter artifact mode"
            >
              <option value="all">all modes</option>
              <option value="wiz">wiz</option>
              <option value="sonar">sonarqube</option>
              <option value="wiz_sast">wiz sast</option>
              <option value="documentation">documentation</option>
            </select>
          </div>
        )}
      </div>

      <div
        className="run-list glass-place-block"
        aria-label="Runs explorer"
        style={glassPlaceStyle(80)}
      >
        {section === "pipeline" ? (
          <>
          <div className="table">
            <div className="table-head mono">
              <div className="col-status" />
              <div className="col-ticket">ticket</div>
              <div className="col-title">title</div>
              <div className="col-pipe">pipeline</div>
              <div className="col-time">duration</div>
              <div className="col-tok">tokens</div>
              <div className="col-cost">cost</div>
              <div className="col-when">started</div>
            </div>

            {pagedPipelineItems.map((item) =>
              "groupId" in item ? (
                renderRunGroup(item)
              ) : (
              <button
                key={item.dashboardId}
                type="button"
                className="table-row"
                onClick={() => onOpenDetail(item)}
                aria-label={`Open details for ${item.jiraKey}: ${item.title}${
                  item.displayState === "pr_open" ? " — PR Open" : ""
                }${
                  item.failureAttribution
                    ? ` — ${item.failureAttribution.label}`
                    : ""
                } — ${formatUsd(item.estimatedCostUsd)} (${formatCostSource(item.costSource)} cost)`}
              >
                <div className="col-status">
                  <StatusPill
                    tone={deriveStatusTone(item)}
                    label={displayStateLabel(item)}
                    compact
                  />
                </div>
                <div className="col-ticket mono">{item.jiraKey}</div>
                <div className="col-title run-title-cell" title={item.title}>
                  <span className="run-title-text">{item.title}</span>
                  <span
                    className={`run-ticket-type-chip ticket-type-${item.ticketType} mono`}
                    title={
                      item.jiraIssueType
                        ? `Jira type: ${item.jiraIssueType}`
                        : undefined
                    }
                  >
                    {ticketTypeLabel(item.ticketType)}
                  </span>
                  {item.displayState === "pr_open" && (
                    <span className="run-status-chip mono">PR Open</span>
                  )}
                  {shouldShowFailureAttributionChip(item) && (
                    <span
                      className={`run-attribution-chip ${failureAttributionChipClass(item)} mono`}
                    >
                      {item.failureAttribution.label}
                    </span>
                  )}
                  {readinessLabel(item) && item.readiness !== "ready" && (
                    <span
                      className={`run-readiness-chip readiness-${item.readiness} mono`}
                    >
                      {readinessLabel(item)}
                    </span>
                  )}
                </div>
                <div className="col-pipe">
                  <MiniPipeline row={item} width={180} />
                </div>
                <div
                  className="col-time mono dim"
                  title={
                    hasManualRestart(item) ? "elapsed since restart" : undefined
                  }
                >
                  {formatRunElapsed(item)}
                </div>
                <div className="col-tok mono dim">
                  {formatTokens(item.totalTokensUsed)}
                </div>
                <div
                  className="col-cost mono dim"
                  title={`${formatUsd(item.estimatedCostUsd)} · ${formatCostSource(item.costSource)}`}
                >
                  {formatUsd(item.estimatedCostUsd)}
                </div>
                <div
                  className="col-when mono dim"
                  title={formatDateTime(item.createdAt)}
                >
                  {formatRelTime(item.createdAt)}
                </div>
              </button>
            )
            )}

            {renderedItems.length === 0 && (
              <div className="table-empty dim">no runs match your filters</div>
            )}
          </div>
          {showPipelinePager && (
            <RunsPager
              ariaLabel="Pipeline runs pagination"
              total={pipelineTotal}
              page={effectivePipelinePage}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setPipelinePage}
              onPageSizeChange={handlePageSizeChange}
            />
          )}
          </>
        ) : (
          <>
          <div className="table artifact-table">
            <div className="table-head mono">
              <div className="col-ticket">ticket</div>
              <div>mode</div>
              <div className="col-title">title</div>
              <div>status</div>
              <div>generated</div>
              <div>oneshot runs</div>
              <div>human review</div>
              <div className="col-when">updated</div>
            </div>

            {pagedArtifacts.map((run) => (
              <button
                key={run.id}
                type="button"
                className="table-row"
                onClick={() => setSelectedArtifactRun(run)}
                aria-label={`Open artifact run for ${run.sourceKey}: ${run.title}`}
              >
                <div className="col-ticket mono">{run.sourceKey}</div>
                <div className="mono">{artifactModeLabel(run.mode)}</div>
                <div className="col-title run-title-cell" title={run.title}>
                  <span className="run-title-text">{run.title}</span>
                  {run.sourceParentKey && (
                    <span className="run-status-chip mono">
                      {run.sourceParentKey}
                    </span>
                  )}
                </div>
                <div className="mono dim">
                  {artifactStatusLabel(run.status)}
                </div>
                <div className="mono dim">{run.generatedCount}</div>
                <div className="mono dim">{run.oneshotRunCount}</div>
                <div
                  className={`mono ${run.humanReviewRequired ? "warn-text" : "dim"}`}
                >
                  {artifactReviewLabel(run)}
                </div>
                <div
                  className="col-when mono dim"
                  title={formatDateTime(run.updatedAt)}
                >
                  {formatRelTime(run.updatedAt)}
                </div>
              </button>
            ))}

            {filteredArtifacts.length === 0 && (
              <div className="table-empty dim">
                no artifact runs match your filters
              </div>
            )}
          </div>
          {showArtifactPager && (
            <RunsPager
              ariaLabel="Artifact runs pagination"
              total={artifactTotal}
              page={effectiveArtifactPage}
              pageSize={pageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setArtifactPage}
              onPageSizeChange={handlePageSizeChange}
            />
          )}
          </>
        )}
      </div>

      {selectedArtifactRun && (
        <ArtifactRunDetailModal
          run={selectedArtifactRun}
          onClose={() => setSelectedArtifactRun(null)}
        />
      )}
    </div>
  );
}
