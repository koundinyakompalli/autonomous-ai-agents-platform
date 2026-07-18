import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  OneShotDashboardRow,
  OneShotProgressStage,
  OneShotRunTimelineResponse,
  OneShotTicketType,
} from "./types.js";
import {
  listRepoRouterConfirmations,
  resolveRepoRouterConfirmation,
  type RepoRouterConfirmationSummary,
} from "./repoRouterApi.js";
import { requestOneShotCiRefresh } from "./runCiRefreshApi.js";
import { retryOneShotRun } from "./runRetryApi.js";
import { updateOneShotTicketType } from "./ticketTypeApi.js";
import { TICKET_TYPE_OPTIONS, ticketTypeLabel } from "./ticketTypes.js";
import { useOneShotRunTimeline } from "../hooks/useOneShotRunTimeline.js";
import { PipelineDiagram } from "./PipelineDiagram.js";
import { StagePanel } from "./StagePanel.js";
import {
  COLORS,
  ERROR_DISPLAY_STATES,
  EXECUTING_STATES,
  QUEUED_STATES,
  STAGE_LABELS,
  WAITING_STATES,
} from "./pipelineStyles.js";
import {
  Copy as CopyIcon,
  ExternalLink,
  ICON_SIZE,
  ICON_STROKE,
  PlayCircle,
  RotateCcw,
  Rocket,
  X as CloseIcon,
} from "./icons.js";
import { StatusPill } from "./StatusPill.js";
import { deriveStatusTone } from "./statusTone.js";
import { displayStateLabel, failureOwnerCopy } from "./failureDisplay.js";
import {
  formatCostSource,
  formatDateTime,
  formatDurationMs,
  formatRunElapsed,
  hasManualRestart,
  formatRelTime,
  formatTokens,
  formatUsd,
} from "./formatters.js";

const CORE_APP_PREVIEW_URL =
  "https://devaccountqa.mhkdevsandbox.com/cas/login?service=https%3A%2F%2Fclient-a-cp-dev-mhk-core.mhkdevsandbox.com%2Fmedhok%2F";

interface DetailModalProps {
  row: OneShotDashboardRow;
  onClose: () => void;
  onDeploy?: (row: OneShotDashboardRow) => void;
  onChanged?: (message?: string, updatedRow?: OneShotDashboardRow) => void;
}

function MetaChip({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="meta-chip" title={title}>
      <span className="meta-chip-label">{label}</span>
      <span className={`meta-chip-value${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
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
      return "With risks";
    case "no_action":
      return "No action";
    default:
      return null;
  }
}

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatRiskSummary(value: unknown): string | null {
  const plan = recordValue(value, "planRiskAssessment");
  const qualification = recordValue(value, "qualificationRiskAssessment");
  const categories = [
    ...stringList(recordValue(value, "categories")),
    ...stringList(recordValue(plan, "categories")),
    ...stringList(recordValue(qualification, "categories")),
  ];
  const planCount = recordValue(plan, "blockingCandidateCount");
  const qualificationCount = recordValue(qualification, "promotedWarningCount");
  const parts = [
    typeof planCount === "number"
      ? `${planCount} plan blocker candidate(s)`
      : null,
    typeof qualificationCount === "number"
      ? `${qualificationCount} qualifier warning(s)`
      : null,
    categories.length > 0
      ? `categories: ${[...new Set(categories)].join(", ")}`
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatExternalSpecSummary(value: unknown): string | null {
  const urls = recordValue(value, "urls");
  if (!Array.isArray(urls)) return null;
  const statusCounts = new Map<string, number>();
  for (const entry of urls) {
    const status = recordValue(entry, "status");
    if (typeof status === "string") {
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
  }
  return (
    Array.from(statusCounts.entries())
      .map(([status, count]) => `${status}: ${count}`)
      .join(" · ") || null
  );
}

function formatCiSummary(value: unknown): {
  state: string | null;
  description: string | null;
  details: string | null;
} {
  const state = recordValue(value, "state");
  const description = recordValue(value, "description");
  const details = stringList(recordValue(value, "details"))
    .slice(0, 4)
    .join(" · ");
  return {
    state: typeof state === "string" ? state : null,
    description: typeof description === "string" ? description : null,
    details: details || null,
  };
}

function formatPlannerDiagnostics(value: unknown): {
  summary: string | null;
  schemaRepair: string | null;
  toolBudget: string | null;
} {
  const reason = recordValue(value, "reason");
  const failureKind = recordValue(value, "failureKind");
  const failureCategory = recordValue(value, "failureCategory");
  const version = recordValue(value, "version");
  const revision = recordValue(value, "revision");
  const repair = recordValue(value, "schemaRepair");
  const toolBudgetUsed = recordValue(value, "toolBudgetUsed");
  const toolBudgetLimit = recordValue(value, "toolBudgetLimit");
  const toolBudgetDenials = recordValue(value, "toolBudgetDenials");
  const summary = [
    typeof reason === "string" ? reason : null,
    typeof failureKind === "string" ? failureKind : null,
    typeof failureCategory === "string" ? failureCategory : null,
    typeof version === "number" ? `v${version}` : null,
    typeof revision === "boolean" ? `revision=${revision}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const repairRecord =
    repair && typeof repair === "object" && !Array.isArray(repair)
      ? (repair as Record<string, unknown>)
      : null;
  const schemaRepair = repairRecord
    ? [
        repairRecord.repaired === true ? "repaired" : "no repair",
        typeof repairRecord.trimmedStrings === "number"
          ? `trimmed=${repairRecord.trimmedStrings}`
          : null,
        typeof repairRecord.promotedTargetFiles === "number"
          ? `promoted=${repairRecord.promotedTargetFiles}`
          : null,
        typeof repairRecord.droppedSpecs === "number"
          ? `dropped specs=${repairRecord.droppedSpecs}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : null;
  const toolBudget =
    typeof toolBudgetUsed === "number" || typeof toolBudgetLimit === "number"
      ? `${toolBudgetUsed ?? "?"}/${toolBudgetLimit ?? "?"} tool calls` +
        (typeof toolBudgetDenials === "number" && toolBudgetDenials > 0
          ? ` · denials=${toolBudgetDenials}`
          : "")
      : null;
  return {
    summary: summary || null,
    schemaRepair,
    toolBudget,
  };
}

function formatSdkLifecycleSummary(value: unknown): {
  result: string | null;
  providerSignals: string | null;
  lifecycle: string | null;
} {
  const subtype = recordValue(value, "sdkResultSubtype");
  const apiDurationMs = recordValue(value, "apiDurationMs");
  const numTurns = recordValue(value, "numTurns");
  const stopReason = recordValue(value, "stopReason");
  const apiRetryCount = recordValue(value, "apiRetryCount");
  const rateLimitCount = recordValue(value, "rateLimitCount");
  const compactBoundaryCount = recordValue(value, "compactBoundaryCount");
  const compactDurationMs = recordValue(value, "compactDurationMs");
  const permissionDenials = recordValue(value, "permissionDenials");
  const taskStartedCount = recordValue(value, "taskStartedCount");
  const subagentStartCount = recordValue(value, "subagentStartCount");
  const hookFailureCount = recordValue(value, "hookFailureCount");
  const rawTraceTruncated = recordValue(value, "rawTraceTruncated");
  return {
    result:
      [
        typeof subtype === "string" && subtype.length > 0 ? subtype : null,
        typeof stopReason === "string" && stopReason.length > 0
          ? `stop=${stopReason}`
          : null,
        typeof numTurns === "number" && numTurns > 0
          ? `${numTurns} turn(s)`
          : null,
        typeof apiDurationMs === "number" && apiDurationMs > 0
          ? `api=${formatDurationMs(apiDurationMs)}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ") || null,
    providerSignals:
      [
        typeof apiRetryCount === "number" && apiRetryCount > 0
          ? `api retries=${apiRetryCount}`
          : null,
        typeof rateLimitCount === "number" && rateLimitCount > 0
          ? `rate limits=${rateLimitCount}`
          : null,
        Array.isArray(permissionDenials) && permissionDenials.length > 0
          ? `permission denials=${permissionDenials.length}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ") || null,
    lifecycle:
      [
        typeof compactBoundaryCount === "number" && compactBoundaryCount > 0
          ? `compactions=${compactBoundaryCount}`
          : null,
        typeof compactDurationMs === "number" && compactDurationMs > 0
          ? `compact time=${formatDurationMs(compactDurationMs)}`
          : null,
        typeof taskStartedCount === "number" && taskStartedCount > 0
          ? `tasks=${taskStartedCount}`
          : null,
        typeof subagentStartCount === "number" && subagentStartCount > 0
          ? `subagents=${subagentStartCount}`
          : null,
        typeof hookFailureCount === "number" && hookFailureCount > 0
          ? `hook failures=${hookFailureCount}`
          : null,
        rawTraceTruncated === true ? "raw trace truncated" : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ") || null,
  };
}

function parseErrorSummary(summary: string): {
  code: string | null;
  heading: string;
  body: string;
} {
  const match = summary.match(/^(\d{3})\s+(.+)$/s);
  if (!match) {
    const firstSentence = summary.split(/(?<=\.)\s+/, 1)[0]?.replace(/\.$/, "");
    return {
      code: null,
      heading: firstSentence || "Error",
      body: summary,
    };
  }
  const [, code, rest] = match;
  const firstSentence = rest.split(/(?<=\.)\s+/, 1)[0]?.replace(/\.$/, "");
  return {
    code,
    heading: firstSentence || rest,
    body: rest,
  };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => navigator.clipboard.writeText(text)}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      style={{ padding: "6px 8px" }}
    >
      <CopyIcon
        size={ICON_SIZE.xs}
        strokeWidth={ICON_STROKE}
        aria-hidden="true"
      />
    </button>
  );
}

function InfoRow({
  label,
  value,
  copyable,
  mono,
  color,
}: {
  label: string;
  value: string | null | undefined;
  copyable?: boolean;
  mono?: boolean;
  color?: string;
}) {
  if (!value) return null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid var(--glass-stroke)",
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: "var(--muted)",
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontFamily: mono ? "var(--mono)" : "var(--sans)",
            fontSize: 12,
            color: color ?? "var(--text)",
            textAlign: "right",
            wordBreak: "break-word",
          }}
        >
          {value}
        </span>
        {copyable && <CopyButton text={value} label={label} />}
      </div>
    </div>
  );
}

function ErrorSurface({
  row,
  onRetried,
}: {
  row: OneShotDashboardRow;
  onRetried?: (message: string, updatedRow: OneShotDashboardRow) => void;
}) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const isErrorState = ERROR_DISPLAY_STATES.includes(row.displayState);
  const summary =
    row.lastErrorSummary ?? (isErrorState ? row.qualificationSummary : null);
  if (!summary && !row.lastError) return null;

  const parsed = parseErrorSummary(summary ?? row.lastError ?? "");
  const stageLabel = STAGE_LABELS[row.progressStage];
  const attribution = row.failureAttribution;
  const ownerCopy = failureOwnerCopy(row);
  const retryPendingStageLabel = row.retryPendingStage
    ? STAGE_LABELS[row.retryPendingStage]
    : stageLabel;
  const hasReviewProgress =
    (row.maxPlanReviewLoops ?? row.maxReviewLoops) > 0 ||
    (row.maxVerificationLoops ?? 0) > 0 ||
    row.progressPercent > 0;
  const retryStageLabel = row.retry ? STAGE_LABELS[row.retry.stage] : null;
  const retryRemainingText = row.retry
    ? row.retry.attemptsRemaining === 1
      ? "1 retry left"
      : `${row.retry.attemptsRemaining} retries left`
    : null;

  const handleRetry = async () => {
    if (!row.retry?.eligible || isRetrying) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      const result = await retryOneShotRun(row.dashboardId);
      const message = result.publishError
        ? `${retryStageLabel} retry queued; publish failed and reconciliation will retry.`
        : `${retryStageLabel} retry queued.`;
      onRetried?.(message, result.row);
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRetrying(false);
    }
  };

  if (row.retryPending) {
    return (
      <section
        className="retry-pending-surface"
        aria-label={`Last ${retryPendingStageLabel} attempt pending retry`}
      >
        <div className="retry-pending-head">
          <div>
            <div className="retry-pending-kicker">Retry pending</div>
            <h2 className="retry-pending-heading">
              Last {retryPendingStageLabel.toLowerCase()} attempt timed out,
              waiting for retry
            </h2>
          </div>
          <div className="error-surface-timing">
            <span
              title={
                hasManualRestart(row) ? "elapsed since restart" : undefined
              }
            >
              {formatRunElapsed(row)}
            </span>
          </div>
        </div>
        {row.retryPendingAttempt != null &&
          row.retryPendingNextRetryAt != null &&
          row.retryPendingVisibilityStatus === "success" &&
          new Date(row.retryPendingNextRetryAt).getTime() > Date.now() && (
          <p className="retry-pending-eta">
            Retry {row.retryPendingAttempt} of {row.retryPendingMaxAttempts ?? 3} expected around{" "}
            {new Date(row.retryPendingNextRetryAt).toLocaleTimeString()}
          </p>
        )}
        <p className="retry-pending-body">
          {parsed.heading}
          {parsed.body && parsed.body !== parsed.heading
            ? ` - ${parsed.body}`
            : ""}
        </p>
        <div className="error-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              navigator.clipboard.writeText(row.lastError ?? summary ?? "")
            }
          >
            <CopyIcon
              size={ICON_SIZE.xs}
              strokeWidth={ICON_STROKE}
              aria-hidden="true"
            />
            <span>Copy error</span>
          </button>
        </div>
        {row.lastError && row.lastError !== summary && (
          <details className="raw-toggle">
            <summary>Show raw error response</summary>
            <pre>{row.lastError}</pre>
          </details>
        )}
      </section>
    );
  }

  return (
    <section
      className={`error-surface${
        attribution ? ` attribution-${attribution.attribution}` : ""
      }`}
      aria-label={`${attribution?.label ?? "Failure"} in ${stageLabel}`}
    >
      <div className="error-surface-head">
        <div className="error-surface-titlebar">
          <div className="error-surface-kicker">
            {attribution?.attribution === "ticket"
              ? "Ticket author action"
              : attribution?.attribution === "mixed"
                ? "Shared action"
                : "Failure in"}{" "}
            {stageLabel}
          </div>
          <div className="error-surface-timing">
            <span
              title={
                hasManualRestart(row) ? "elapsed since restart" : undefined
              }
            >
              {formatRunElapsed(row)}
            </span>
          </div>
        </div>
        {row.retry && retryStageLabel && (
          <div className="error-retry-group">
            <button
              type="button"
              className="error-retry-button"
              onClick={handleRetry}
              disabled={!row.retry.eligible || isRetrying}
              title={row.retry.disabledReason ?? undefined}
            >
              <RotateCcw
                size={ICON_SIZE.xs}
                strokeWidth={ICON_STROKE}
                aria-hidden="true"
              />
              <span>
                {isRetrying
                  ? "Queueing..."
                  : row.retry.eligible
                    ? `Retry ${retryStageLabel}`
                    : "Retry limit reached"}
              </span>
            </button>
            <span className="error-retry-meta">
              {row.retry.eligible
                ? retryRemainingText
                : (row.retry.disabledReason ?? "Retry limit reached")}
            </span>
          </div>
        )}
      </div>

      <div className="error-heading-row">
        {parsed.code && <span className="error-code-pill">{parsed.code}</span>}
        <h2 className="error-heading">
          {attribution?.label ?? parsed.heading}
        </h2>
      </div>

      {ownerCopy && <p className="error-owner-copy">{ownerCopy}</p>}

      {attribution?.label && parsed.heading !== attribution.label && (
        <p className="error-body">{parsed.heading}</p>
      )}

      {parsed.body && parsed.body !== parsed.heading && (
        <p className="error-body">{parsed.body}</p>
      )}

      {hasReviewProgress && (
        <div className="error-context">
          Plan review loops {row.planReviewLoopCount ?? row.reviewLoopCount} /{" "}
          {row.maxPlanReviewLoops ?? row.maxReviewLoops} · Verification loops{" "}
          {row.verificationLoopCount ?? 0} / {row.maxVerificationLoops ?? 0} ·{" "}
          {row.progressPercent}% progress at failure
        </div>
      )}

      <div className="error-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() =>
            navigator.clipboard.writeText(row.lastError ?? summary ?? "")
          }
        >
          <CopyIcon
            size={ICON_SIZE.xs}
            strokeWidth={ICON_STROKE}
            aria-hidden="true"
          />
          <span>Copy error</span>
        </button>
      </div>

      {retryError && <div className="error-retry-message">{retryError}</div>}

      {row.lastError && row.lastError !== summary && (
        <details className="raw-toggle">
          <summary>Show raw error response</summary>
          <pre>{row.lastError}</pre>
        </details>
      )}
    </section>
  );
}

function DetailCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="os-card-glass"
      style={{
        padding: "20px 20px 16px",
        borderRadius: "var(--r-lg)",
      }}
    >
      <h2
        style={{
          margin: "0 0 8px",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--text-2)",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const REPO_CONFIRM_PARAM = "repoConfirm";
const REPO_CONFIRMATION_ID_PARAM = "repoConfirmationId";
const REPO_CONFIRMATION_REPO_ID_PARAM = "repoId";
const MISSING_OPERATOR_IDENTITY_MESSAGE =
  "Trusted operator identity headers are missing";

function readPositiveSearchInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readRepoConfirmationReturnParams(): {
  confirmationId: number;
  repoId: number;
} | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get(REPO_CONFIRM_PARAM) !== "1") return null;

  const confirmationId = readPositiveSearchInteger(
    params.get(REPO_CONFIRMATION_ID_PARAM),
  );
  const repoId = readPositiveSearchInteger(
    params.get(REPO_CONFIRMATION_REPO_ID_PARAM),
  );

  return confirmationId && repoId ? { confirmationId, repoId } : null;
}

function clearRepoConfirmationReturnParams() {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.delete(REPO_CONFIRM_PARAM);
  params.delete(REPO_CONFIRMATION_ID_PARAM);
  params.delete(REPO_CONFIRMATION_REPO_ID_PARAM);
  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

function repoConfirmationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === MISSING_OPERATOR_IDENTITY_MESSAGE) {
    return "Sign in is required to select a repo. Click Select Repo to authenticate and try again.";
  }
  return message;
}

export function buildRepoRouterAuthStartUrl(
  confirmationId: number,
  repoId: number,
  pathname = window.location.pathname,
  search = window.location.search,
): string {
  const returnParams = new URLSearchParams(search);
  returnParams.set(REPO_CONFIRM_PARAM, "1");
  returnParams.set(REPO_CONFIRMATION_ID_PARAM, String(confirmationId));
  returnParams.set(REPO_CONFIRMATION_REPO_ID_PARAM, String(repoId));
  const query = returnParams.toString();
  const returnTo = `${pathname}${query ? `?${query}` : ""}`;
  return `/auth/repo-router/start?${new URLSearchParams({ returnTo }).toString()}`;
}

function RepoConfirmationPanel({
  row,
  onResolved,
}: {
  row: OneShotDashboardRow;
  onResolved?: (message?: string) => void;
}) {
  const [confirmation, setConfirmation] =
    useState<RepoRouterConfirmationSummary | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoResolveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (row.displayState !== "repo_confirmation_pending") {
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void listRepoRouterConfirmations()
      .then((confirmations) => {
        if (cancelled) return;
        const match =
          confirmations.find(
            (item) => item.taskManagementId === row.sourceTaskManagementId,
          ) ??
          confirmations.find(
            (item) => item.ticketId.toUpperCase() === row.jiraKey.toUpperCase(),
          ) ??
          null;
        setConfirmation(match);
        setSelectedRepoId(
          match?.resolvedRepo?.repoId ?? match?.candidates[0]?.repoId ?? null,
        );
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.displayState, row.jiraKey, row.sourceTaskManagementId]);

  const resolveSelectedRepo = useCallback(
    async (repoId: number) => {
      if (!confirmation || isResolving) return;
      setIsResolving(true);
      setError(null);
      try {
        await resolveRepoRouterConfirmation(confirmation.id, repoId);
        onResolved?.("Repo confirmed; QUALIFIER will resume.");
      } catch (resolveError) {
        setError(repoConfirmationErrorMessage(resolveError));
      } finally {
        setIsResolving(false);
      }
    },
    [confirmation, isResolving, onResolved],
  );

  useEffect(() => {
    if (!confirmation) return;
    const pending = readRepoConfirmationReturnParams();
    if (!pending || pending.confirmationId !== confirmation.id) return;

    const resolveKey = `${pending.confirmationId}:${pending.repoId}`;
    if (autoResolveKeyRef.current === resolveKey) return;
    autoResolveKeyRef.current = resolveKey;
    clearRepoConfirmationReturnParams();

    const selectedCandidate = confirmation.candidates.find(
      (candidate) => candidate.repoId === pending.repoId,
    );
    if (!selectedCandidate) {
      setError("Selected repo is no longer available for this confirmation.");
      return;
    }

    setSelectedRepoId(pending.repoId);
    void resolveSelectedRepo(pending.repoId);
  }, [confirmation, resolveSelectedRepo]);

  if (row.displayState !== "repo_confirmation_pending") {
    return null;
  }

  const handleResolve = () => {
    if (!confirmation || !selectedRepoId || isResolving) return;
    window.location.assign(
      buildRepoRouterAuthStartUrl(confirmation.id, selectedRepoId),
    );
  };

  return (
    <DetailCard title="Repo Confirmation">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
          QUALIFIER is parked until a target repo is selected.
        </p>

        {(row.lastErrorSummary || row.lastError) && (
          <div
            style={{
              border: "1px solid var(--warn)",
              borderRadius: 6,
              color: "var(--text)",
              fontSize: 13,
              padding: "8px 10px",
            }}
          >
            Qualification attempt failed:{" "}
            {row.lastErrorSummary ?? row.lastError}
          </div>
        )}

        {isLoading && (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            Loading confirmation candidates...
          </div>
        )}

        {!isLoading && !confirmation && (
          <div style={{ color: "var(--warn)", fontSize: 13 }}>
            No pending confirmation row was found for this task.
          </div>
        )}

        {confirmation && (
          <>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                fontSize: 12,
                color: "var(--muted)",
              }}
            >
              Repository
              <select
                value={selectedRepoId ?? ""}
                onChange={(event) =>
                  setSelectedRepoId(Number(event.currentTarget.value))
                }
                style={{
                  minHeight: 40,
                  borderRadius: 6,
                  border: "1px solid var(--glass-stroke)",
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  padding: "0 10px",
                }}
              >
                {confirmation.candidates.map((candidate) => (
                  <option key={candidate.repoId} value={candidate.repoId}>
                    {candidate.repoName}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="btn-primary"
              onClick={handleResolve}
              disabled={!selectedRepoId || isResolving}
              style={{ alignSelf: "flex-start" }}
            >
              {isResolving ? "Selecting..." : "Select Repo"}
            </button>
          </>
        )}

        {error && (
          <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>
        )}
      </div>
    </DetailCard>
  );
}

const MODAL_EXIT_MS = 180;

function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const WORKER_HEARTBEAT_STALE_MS = 6 * 60 * 1000;

function workerHeartbeatText(
  row: OneShotDashboardRow,
  timeline: OneShotRunTimelineResponse | null,
): { text: string; tone: "ok" | "warn"; title: string } | null {
  if (!row.oneshotRunId || !EXECUTING_STATES.includes(row.displayState)) {
    return null;
  }

  const heartbeatAt = timeline?.updatedAt ?? row.updatedAt;
  const heartbeatMs = new Date(heartbeatAt).getTime();
  const ageMs = Date.now() - heartbeatMs;
  const stale = Number.isFinite(ageMs) && ageMs > WORKER_HEARTBEAT_STALE_MS;

  return {
    text: stale
      ? `worker heartbeat stale · ${formatRelTime(heartbeatAt)}`
      : `worker active · heartbeat ${formatRelTime(heartbeatAt)}`,
    tone: stale ? "warn" : "ok",
    title: `Last worker heartbeat: ${formatDateTime(heartbeatAt)}`,
  };
}

export function DetailModal({
  row,
  onClose,
  onChanged,
}: DetailModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isRefreshingCi, setIsRefreshingCi] = useState(false);
  const [ciRefreshError, setCiRefreshError] = useState<string | null>(null);
  const [isUpdatingTicketType, setIsUpdatingTicketType] = useState(false);
  const [ticketTypeError, setTicketTypeError] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<OneShotProgressStage>(
    row.progressStage,
  );
  const tone = deriveStatusTone(row);
  const shouldPollTimeline =
    EXECUTING_STATES.includes(row.displayState) ||
    QUEUED_STATES.includes(row.displayState) ||
    WAITING_STATES.includes(row.displayState);
  const {
    data: timeline,
    isLoading: isTimelineLoading,
    error: timelineError,
  } = useOneShotRunTimeline(row.dashboardId, shouldPollTimeline);
  const heartbeat = workerHeartbeatText(row, timeline);
  const canRequestCiRefresh =
    row.displayState === "pr_open" && !!row.currentPrUrl;

  const handleTicketTypeChange = async (
    nextTicketType: OneShotTicketType,
  ) => {
    if (nextTicketType === row.ticketType || isUpdatingTicketType) return;
    setIsUpdatingTicketType(true);
    setTicketTypeError(null);
    try {
      const updatedRow = await updateOneShotTicketType(
        row.dashboardId,
        nextTicketType,
      );
      onChanged?.("Ticket type updated.", updatedRow);
    } catch (error) {
      setTicketTypeError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsUpdatingTicketType(false);
    }
  };

  const handleCiRefresh = async () => {
    if (!canRequestCiRefresh || isRefreshingCi) return;
    setIsRefreshingCi(true);
    setCiRefreshError(null);
    try {
      const result = await requestOneShotCiRefresh(row.dashboardId);
      onChanged?.("CI readiness refresh requested.", result.row);
    } catch (error) {
      setCiRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRefreshingCi(false);
    }
  };

  /**
   * Play the exit animation before unmounting. Double-invocation guard
   * so spamming Escape or clicking the backdrop during the animation
   * doesn't stack timers. Reduced-motion users skip the wait entirely —
   * the global 0.01ms rule in liquid-glass.css would make the wait dead
   * air for them.
   */
  const requestClose = useCallback(() => {
    if (closeTimerRef.current != null) return;
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, MODAL_EXIT_MS);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setSelectedStage(row.progressStage);
  }, [row.dashboardId, row.progressStage]);

  useEffect(() => {
    setTicketTypeError(null);
  }, [row.dashboardId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [requestClose]);

  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  const ciSummary = formatCiSummary(row.ciStatus);
  const riskSummary = formatRiskSummary(row.riskAssessment);
  const externalSpecSummary = formatExternalSpecSummary(
    row.externalSpecEvidence,
  );
  const plannerDiagnostics = formatPlannerDiagnostics(
    row.plannerAttemptDiagnostics,
  );
  const sdkLifecycle = formatSdkLifecycleSummary(row.sdkLifecycleSummary);
  const hasReadinessDetail =
    canRequestCiRefresh ||
    (row.readinessReasons?.length ?? 0) > 0 ||
    Boolean(ciSummary.state || ciSummary.description || ciSummary.details) ||
    Boolean(riskSummary) ||
    Boolean(externalSpecSummary) ||
    (row.unverifiedTests?.length ?? 0) > 0;
  const hasPlannerDiagnostics = Boolean(
    plannerDiagnostics.summary ||
    plannerDiagnostics.schemaRepair ||
    plannerDiagnostics.toolBudget,
  );
  const hasSdkLifecycle = Boolean(
    sdkLifecycle.result ||
    sdkLifecycle.providerSignals ||
    sdkLifecycle.lifecycle,
  );

  // Anchor the failure surface to the stage where the failure happened so it
  // only renders under that stage tile, not whichever tile the user clicks.
  // Retry-pending rows live in a queued state, not an error state, so they
  // need their own branch.
  const failureAnchorStage: OneShotProgressStage | null = row.retryPending
    ? (row.retryPendingStage ?? row.progressStage)
    : ERROR_DISPLAY_STATES.includes(row.displayState)
      ? row.progressStage
      : null;

  return (
    <div
      onClick={requestClose}
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
        ref={modalRef}
        className={`oneshot-modal-scroll${isClosing ? " closing" : ""}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        style={{
          width: "min(1120px, 100%)",
          maxHeight:
            "min(92dvh, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)))",
          overflow: "auto",
          outline: "none",
          paddingBottom: "calc(16px + env(safe-area-inset-bottom))",
        }}
      >
        <div className="detail">
          <div className="detail-hero">
            <div className="detail-hero-actions">
              {row.currentPrUrl && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    window.open(
                      row.currentPrUrl!,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <span className="mono">PR</span>
                  <ExternalLink
                    size={ICON_SIZE.xs}
                    strokeWidth={ICON_STROKE}
                    aria-hidden="true"
                  />
                </button>
              )}

              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  window.open(
                    CORE_APP_PREVIEW_URL,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <Rocket
                  size={ICON_SIZE.xs}
                  strokeWidth={ICON_STROKE}
                  aria-hidden="true"
                />
                <span>Preview Deployment</span>
              </button>

              {row.deployment.workflowUrl && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    window.open(
                      row.deployment.workflowUrl!,
                      "_blank",
                      "noopener,noreferrer",
                    )
                  }
                >
                  <span className="mono">Workflow</span>
                  <PlayCircle
                    size={ICON_SIZE.xs}
                    strokeWidth={ICON_STROKE}
                    aria-hidden="true"
                  />
                </button>
              )}

              <button
                type="button"
                className="btn-ghost"
                onClick={requestClose}
                aria-label="Close detail"
                style={{ padding: "7px 10px" }}
              >
                <CloseIcon
                  size={ICON_SIZE.sm}
                  strokeWidth={ICON_STROKE}
                  aria-hidden="true"
                />
              </button>
            </div>

            <div className="detail-kicker">
              <StatusPill tone={tone} label={displayStateLabel(row)} />
              <button
                type="button"
                className="btn-ghost cpdev-copy"
                onClick={() => navigator.clipboard.writeText(row.jiraKey)}
                aria-label={`Copy ${row.jiraKey}`}
              >
                <span className="mono">{row.jiraKey}</span>
                <CopyIcon
                  size={ICON_SIZE.xs}
                  strokeWidth={ICON_STROKE}
                  aria-hidden="true"
                />
              </button>
              <span className="dim">·</span>
              <span className="dim">{formatRelTime(row.createdAt)}</span>
              {row.customerName && (
                <>
                  <span className="dim">·</span>
                  <span className="dim">{row.customerName}</span>
                </>
              )}
            </div>

            <h1 id="detail-title" className="detail-title">
              {row.title}
            </h1>

            <div className="detail-meta-row">
              <MetaChip label="repo" value={row.repoName ?? "Unknown"} />
              <MetaChip
                label="branch"
                value={row.implementationBranch ?? row.baseBranch ?? "n/a"}
                mono
              />
              <MetaChip label="stage" value={displayStateLabel(row)} />
              <label className="meta-chip ticket-type-editor">
                <span className="meta-chip-label">type</span>
                <select
                  className="ticket-type-select mono"
                  value={row.ticketType}
                  disabled={row.oneshotRunId === null || isUpdatingTicketType}
                  onChange={(event) =>
                    void handleTicketTypeChange(
                      event.target.value as OneShotTicketType,
                    )
                  }
                  aria-label={`Ticket type for ${row.jiraKey}`}
                >
                  {TICKET_TYPE_OPTIONS.filter(
                    (type): type is OneShotTicketType => type !== "all",
                  ).map((type) => (
                    <option key={type} value={type}>
                      {ticketTypeLabel(type)}
                    </option>
                  ))}
                </select>
                {row.jiraIssueType && (
                  <span className="ticket-type-jira mono">
                    Jira {row.jiraIssueType}
                  </span>
                )}
              </label>
              {readinessLabel(row) && (
                <MetaChip label="readiness" value={readinessLabel(row)!} />
              )}
              <MetaChip
                label="elapsed"
                value={formatRunElapsed(row)}
                title={
                  hasManualRestart(row) ? "elapsed since restart" : undefined
                }
              />
              <MetaChip
                label="tokens"
                value={formatTokens(row.totalTokensUsed)}
                mono
              />
              <MetaChip
                label="cost"
                value={`${formatUsd(row.estimatedCostUsd)} · ${formatCostSource(row.costSource)}`}
              />
            </div>
            {ticketTypeError && (
              <div className="error-retry-message">{ticketTypeError}</div>
            )}
          </div>

          <div className="pipeline-section">
            <div className="section-label">
              <span>Pipeline</span>
              <span className={heartbeat ? heartbeat.tone : "dim"}>
                7 stages ·{" "}
                {heartbeat ? (
                  <span title={heartbeat.title}>{heartbeat.text}</span>
                ) : (
                  <>
                    last updated{" "}
                    {formatRelTime(timeline?.updatedAt ?? row.updatedAt)}
                  </>
                )}
                {isTimelineLoading ? " · syncing evidence" : ""}
              </span>
            </div>
            <PipelineDiagram
              row={row}
              selectedStage={selectedStage}
              onSelectStage={setSelectedStage}
              stages={timeline?.stages}
            />
          </div>

          <StagePanel
            row={row}
            stage={selectedStage}
            timeline={timeline}
            isTimelineLoading={isTimelineLoading}
            timelineError={timelineError}
          />

          <RepoConfirmationPanel row={row} onResolved={onChanged} />

          {failureAnchorStage && selectedStage === failureAnchorStage && (
            <ErrorSurface
              row={row}
              onRetried={(message, updatedRow) =>
                onChanged?.(message, updatedRow)
              }
            />
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 16,
              alignItems: "start",
            }}
          >
            <DetailCard title="Overview">
              <InfoRow label="Customer" value={row.customerName} />
              <InfoRow label="Created" value={formatDateTime(row.createdAt)} />
              <InfoRow label="Updated" value={formatDateTime(row.updatedAt)} />
              <InfoRow
                label="Plan review loops"
                value={`${row.planReviewLoopCount ?? row.reviewLoopCount} / ${row.maxPlanReviewLoops ?? row.maxReviewLoops}`}
              />
              <InfoRow
                label="Verification loops"
                value={`${row.verificationLoopCount ?? 0} / ${row.maxVerificationLoops ?? 0}`}
              />
              <InfoRow
                label="Source task"
                value={String(row.sourceTaskManagementId)}
                mono
              />
            </DetailCard>

            {(row.repoName || row.baseBranch || row.implementationBranch) && (
              <DetailCard title="Git">
                <InfoRow label="Repository" value={row.repoName} mono />
                <InfoRow
                  label="Base branch"
                  value={row.baseBranch}
                  mono
                  copyable
                />
                <InfoRow
                  label="Base commit"
                  value={row.baseCommitSha?.slice(0, 12)}
                  mono
                  copyable
                />
                <InfoRow
                  label="Implementation branch"
                  value={row.implementationBranch}
                  mono
                  copyable
                />
                <InfoRow
                  label="Implementation commit"
                  value={row.implementationCommitSha?.slice(0, 12)}
                  mono
                  copyable
                />
              </DetailCard>
            )}

            <DetailCard title="Deployment">
              <InfoRow
                label="Status"
                value={row.deployment.status}
                color={
                  row.deployment.active
                    ? COLORS.secondary
                    : row.deployment.light === "amber"
                      ? COLORS.tertiary
                      : row.deployment.light === "red"
                        ? COLORS.error
                        : undefined
                }
              />
              <InfoRow
                label="Eligible"
                value={row.deployment.eligible ? "Yes" : "No"}
              />
              <InfoRow
                label="Preview URL"
                value={row.deployment.previewUrl}
                mono
                copyable
              />
              <InfoRow
                label="Workflow"
                value={row.deployment.workflowUrl}
                mono
                copyable
              />
              <InfoRow
                label="Deployed commit"
                value={row.deployment.deployedCommitSha?.slice(0, 12)}
                mono
                copyable
              />
            </DetailCard>

            {hasReadinessDetail && (
              <DetailCard title="Autonomous Readiness">
                {row.readinessReasons?.map((reason, index) => (
                  <InfoRow
                    key={`${reason}-${index}`}
                    label={index === 0 ? "Reason" : "Also"}
                    value={reason}
                  />
                ))}
                <InfoRow label="CI" value={ciSummary.state} mono />
                <InfoRow label="CI detail" value={ciSummary.description} />
                <InfoRow label="CI checks" value={ciSummary.details} />
                <InfoRow
                  label="Unverified tests"
                  value={row.unverifiedTests?.join(" · ")}
                />
                <InfoRow label="Risk evidence" value={riskSummary} />
                <InfoRow label="External specs" value={externalSpecSummary} />
                {canRequestCiRefresh && (
                  <div className="error-actions" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={handleCiRefresh}
                      disabled={isRefreshingCi}
                    >
                      <RotateCcw
                        size={ICON_SIZE.xs}
                        strokeWidth={ICON_STROKE}
                        aria-hidden="true"
                      />
                      <span>
                        {isRefreshingCi ? "Requesting..." : "Refresh CI"}
                      </span>
                    </button>
                  </div>
                )}
                {ciRefreshError && (
                  <div className="error-retry-message">{ciRefreshError}</div>
                )}
              </DetailCard>
            )}

            {(hasPlannerDiagnostics || hasSdkLifecycle) && (
              <DetailCard title="Planner Diagnostics">
                <InfoRow label="Attempt" value={plannerDiagnostics.summary} />
                <InfoRow
                  label="Tool budget"
                  value={plannerDiagnostics.toolBudget}
                  mono
                />
                <InfoRow
                  label="Schema repair"
                  value={plannerDiagnostics.schemaRepair}
                />
                <InfoRow label="SDK result" value={sdkLifecycle.result} />
                <InfoRow
                  label="Provider signals"
                  value={sdkLifecycle.providerSignals}
                />
                <InfoRow label="SDK lifecycle" value={sdkLifecycle.lifecycle} />
              </DetailCard>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
