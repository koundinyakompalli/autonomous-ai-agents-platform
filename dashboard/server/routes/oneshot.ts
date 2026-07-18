import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  hasTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import {
  getOneShotRowByDashboardId,
  getOneShotRuns,
  OneShotTicketTypeUpdateError,
  updateOneShotRunTicketType,
} from "../services/oneshot.js";
import { normalizeOneShotAnalyticsRange } from "../services/oneshotAnalytics.js";
import {
  generateOneShotCostReport,
  normalizeOneShotCostReportQuery,
  oneShotCostReportFilename,
  renderOneShotCostReportCsv,
  renderOneShotCostReportHtml,
} from "../services/oneshotCostReports.js";
import { isOneShotDeploymentRequestSupported } from "../services/oneshotDeployments.js";
import {
  createMockRun,
  getMockData,
  getMockRow,
} from "../services/oneshotMockData.js";
import {
  isOneShotRunRequestSupported,
  isQualifierAgentAvailable,
} from "../services/oneshotRunRequests.js";
import {
  OneShotRunRetryError,
  retryOneShotRunStage,
} from "../services/oneshotRunRetries.js";
import {
  hardDeleteOneShotRun,
  OneShotRunControlError,
  restartOneShotRunStage,
  stopOneShotRun,
} from "../services/oneshotRunControls.js";
import { getPool } from "../db.js";
import { isOneShotJiraValidationConfigured } from "../services/oneshotJiraLookup.js";
import { bucketForView } from "../services/oneshotRowHelpers.js";
import { normalizeOneShotTicketType } from "../shared/ticketType.js";
import {
  buildFallbackTimeline,
  getOneShotRunTimeline,
} from "../services/oneshotTimeline.js";
import {
  buildMockOneShotStatistics,
  getOneShotStatistics,
  runStatisticsLlmOverDeterministic,
} from "../services/oneshotStatistics.js";
import {
  createOneShotSelfFixTicket,
  normalizeSelfFixTicketError,
} from "../services/oneshotSelfFixTickets.js";
import type {
  OneShotDashboardCapabilities,
  OneShotRunsQuery,
} from "../types/oneshot.js";

const router = Router();

function applyMockFilters(
  mock: ReturnType<typeof getMockData>,
  query: {
    state?: string;
    deployment?: string;
    ticketType?: string;
    search?: string;
    view?: OneShotRunsQuery["view"];
  },
) {
  let rows = mock.runs;
  if (query.view && query.view !== "all") {
    rows = rows.filter((r) => bucketForView(r.displayState) === query.view);
  }
  const search = query.search?.trim().toLowerCase();
  if (search) {
    rows = rows.filter((r) =>
      [r.jiraKey, r.title, r.ticketType, r.jiraIssueType, r.repoName, r.implementationBranch]
        .filter((v): v is string => typeof v === "string")
        .some((v) => v.toLowerCase().includes(search)),
    );
  }
  if (query.state && query.state !== "all") {
    rows = rows.filter((r) => r.displayState === query.state);
  }
  if (query.deployment && query.deployment !== "all") {
    rows = rows.filter((r) => {
      if (query.deployment === "eligible") return r.deployment.ready;
      if (query.deployment === "active") return r.deployment.active;
      if (query.deployment === "inflight")
        return r.deployment.light === "amber";
      return true;
    });
  }
  if (query.ticketType && query.ticketType !== "all") {
    rows = rows.filter((r) => r.ticketType === query.ticketType);
  }
  return {
    ...mock,
    runs: rows,
    pagination: { ...mock.pagination, total: rows.length },
  };
}

const VALID_VIEWS = new Set(["running", "queued", "waiting", "history", "all"]);
const SHOULD_USE_DEV_MOCK = process.env.ONESHOT_DASHBOARD_USE_DEV_MOCK === "1";
const SHOULD_RUN_LLM_OVER_MOCK =
  process.env.ONESHOT_DASHBOARD_DEV_MOCK_RUN_LLM === "1";

function normalizeLegacyAnalyticsView(value: string): string {
  return value === "failures" || value === "statistics" ? "all" : value;
}

export async function resolveCapabilities(
  req: Parameters<typeof hasTrustedOperatorIdentity>[0],
): Promise<OneShotDashboardCapabilities> {
  const operatorIdentityAvailable = hasTrustedOperatorIdentity(req);
  const [runRequestsSupported, qualifierAvailable, deploymentSupported] =
    await Promise.all([
      isOneShotRunRequestSupported(),
      isQualifierAgentAvailable(),
      isOneShotDeploymentRequestSupported(),
    ]);

  return {
    createRun:
      runRequestsSupported &&
      qualifierAvailable &&
      isOneShotJiraValidationConfigured(),
    createRunMode: "request",
    deployPreviewAvailable: deploymentSupported,
    deployPreview: operatorIdentityAvailable && deploymentSupported,
  };
}

router.get("/runs", async (req, res) => {
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const search =
    typeof req.query.jira_key === "string"
      ? req.query.jira_key
      : typeof req.query.search === "string"
        ? req.query.search
        : undefined;
  const deployment =
    typeof req.query.deployment === "string" ? req.query.deployment : undefined;
  const ticketType =
    typeof req.query.ticketType === "string"
      ? normalizeOneShotTicketType(req.query.ticketType)
      : undefined;
  const rawView =
    typeof req.query.view === "string"
      ? normalizeLegacyAnalyticsView(req.query.view)
      : "all";
  const view = VALID_VIEWS.has(rawView)
    ? (rawView as OneShotRunsQuery["view"])
    : "all";
  const snapshot = req.query.snapshot === "dashboard" ? "dashboard" : undefined;
  const range = normalizeOneShotAnalyticsRange(req.query.range);

  if (SHOULD_USE_DEV_MOCK) {
    return res.json(
      applyMockFilters(getMockData(range), {
        state,
        deployment,
        ticketType: ticketType ?? undefined,
        search,
        view,
      }),
    );
  }

  try {
    const capabilities = await resolveCapabilities(req);
    const response = await getOneShotRuns(
      {
        limit: Number(req.query.limit),
        offset: Number(req.query.offset),
        state,
        jiraKey: search,
        deployment,
        ticketType: ticketType ?? undefined,
        view,
        range,
        snapshot,
      },
      { capabilities },
    );

    // ETag: stable hash of the response payload so unchanged data returns 304.
    const body = JSON.stringify(response);
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;

    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json(response);
  } catch (error) {
    console.error("[oneshot] query failed:", error);
    res.status(500).json({ error: "OneShot query failed" });
  }
});

router.patch("/runs/:dashboardId/ticket-type", async (req, res) => {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const ticketType = normalizeOneShotTicketType(req.body?.ticketType);
    if (!ticketType) {
      res.status(400).json({ error: "ticketType is invalid" });
      return;
    }

    const row = await updateOneShotRunTicketType({
      dashboardId: req.params.dashboardId,
      ticketType,
      operator,
    });
    res.json({ row });
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotTicketTypeUpdateError
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot] ticket type update failed:", error);
    res.status(500).json({ error: "Failed to update OneShot ticket type" });
  }
});

router.get("/reports/costs.csv", async (req, res) => {
  try {
    const query = normalizeOneShotCostReportQuery({
      range: req.query.range,
      ticketType: req.query.ticketType,
    });
    const report = await generateOneShotCostReport(query);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${oneShotCostReportFilename(report, "csv")}"`,
    );
    res.send(renderOneShotCostReportCsv(report));
  } catch (error) {
    console.error("[oneshot] cost CSV report failed:", error);
    res.status(500).json({ error: "OneShot cost report failed" });
  }
});

router.get("/reports/costs.html", async (req, res) => {
  try {
    const query = normalizeOneShotCostReportQuery({
      range: req.query.range,
      ticketType: req.query.ticketType,
    });
    const report = await generateOneShotCostReport(query);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${oneShotCostReportFilename(report, "html")}"`,
    );
    res.send(renderOneShotCostReportHtml(report));
  } catch (error) {
    console.error("[oneshot] cost HTML report failed:", error);
    res.status(500).json({ error: "OneShot cost report failed" });
  }
});

router.get("/statistics", async (req, res) => {
  const range = normalizeOneShotAnalyticsRange(req.query.range);

  if (SHOULD_USE_DEV_MOCK) {
    const mock = getMockData(range);
    const deterministic = buildMockOneShotStatistics(mock.runs, range);
    if (!SHOULD_RUN_LLM_OVER_MOCK) {
      return res.json(deterministic);
    }
    try {
      res.setHeader("Cache-Control", "no-cache");
      const enriched = await runStatisticsLlmOverDeterministic(deterministic);
      return res.json(enriched);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        "[oneshot] dev-mode LLM-over-mock failed; falling back to deterministic:",
        message,
      );
      return res.json({
        ...deterministic,
        modelInfo: {
          ...deterministic.modelInfo,
          lastError: message,
        },
      });
    }
  }

  try {
    res.setHeader("Cache-Control", "no-cache");
    res.json(await getOneShotStatistics(range));
  } catch (error) {
    console.error("[oneshot] statistics query failed:", error);
    res.status(500).json({ error: "OneShot statistics query failed" });
  }
});

export async function postOneShotSelfFixTicket(req: Request, res: Response) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const range = normalizeOneShotAnalyticsRange(req.body?.range ?? "7d");
    const candidateId =
      typeof req.body?.candidateId === "string"
        ? req.body.candidateId.trim()
        : "";
    const autoRun = req.body?.autoRun === true;

    if (!candidateId) {
      res.status(400).json({ error: "candidateId is required" });
      return;
    }

    const result = await createOneShotSelfFixTicket({
      range,
      candidateId,
      autoRun,
      operator,
    });

    res.status(201).json(result);
  } catch (error) {
    if (error instanceof OperatorIdentityError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    const normalized = normalizeSelfFixTicketError(error);
    console.error("[oneshot] self-fix ticket creation failed:", error);
    res.status(normalized.statusCode).json({ error: normalized.message });
  }
}

router.post("/statistics/self-fix-tickets", postOneShotSelfFixTicket);

router.post("/mock-runs", (req, res) => {
  if (!SHOULD_USE_DEV_MOCK) {
    res
      .status(403)
      .json({ error: "Mock runs are only available in development" });
    return;
  }

  const jiraKey =
    typeof req.body?.jiraKey === "string"
      ? req.body.jiraKey.trim()
      : typeof req.body?.key === "string"
        ? req.body.key.trim()
        : "";
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const priority =
    req.body?.priority === "High" ||
    req.body?.priority === "Medium" ||
    req.body?.priority === "Low"
      ? req.body.priority
      : undefined;

  if (!jiraKey || !title) {
    res.status(400).json({ error: "jiraKey and title are required" });
    return;
  }

  const row = createMockRun({ jiraKey, title, priority });
  res.status(201).json(row);
});

router.get("/runs/:dashboardId/timeline", async (req, res) => {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  if (SHOULD_USE_DEV_MOCK) {
    const row = getMockRow(dashboardId);
    if (!row) {
      res.status(404).json({ error: "OneShot row not found" });
      return;
    }
    res.json(buildFallbackTimeline(row));
    return;
  }

  try {
    const timeline = await getOneShotRunTimeline(dashboardId);
    if (!timeline) {
      res.status(404).json({ error: "OneShot row not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.json(timeline);
  } catch (error) {
    console.error("[oneshot] timeline lookup failed:", error);
    res.status(500).json({ error: "OneShot timeline lookup failed" });
  }
});

export async function postOneShotRunRetry(req: Request, res: Response) {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  try {
    const operator = getTrustedOperatorIdentity(req);
    const retry = await retryOneShotRunStage({ dashboardId, operator });
    const row = await getOneShotRowByDashboardId(dashboardId);
    if (!row) {
      res.status(500).json({ error: "Failed to load retried OneShot run" });
      return;
    }

    res.status(200).json({
      row,
      retry,
      publishError: retry.publishError,
    });
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunRetryError
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot] retry failed:", error);
    res.status(500).json({ error: "Failed to retry OneShot run" });
  }
}

router.post("/runs/:dashboardId/retry", postOneShotRunRetry);

export async function postOneShotRunStop(req: Request, res: Response) {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  try {
    const operator = getTrustedOperatorIdentity(req);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const stop = await stopOneShotRun({ dashboardId, operator, reason });
    const row = await getOneShotRowByDashboardId(`run-${stop.oneshotRunId}`);
    if (!row) {
      res.status(500).json({ error: "Failed to load stopped OneShot run" });
      return;
    }

    res.status(200).json({
      row,
      stop,
      workspaceCleanupSucceeded: stop.workspaceCleanupSucceeded,
    });
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunControlError
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot] stop failed:", error);
    res.status(500).json({ error: "Failed to stop OneShot run" });
  }
}

router.post("/runs/:dashboardId/stop", postOneShotRunStop);

export async function postOneShotRunRestartStage(req: Request, res: Response) {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  try {
    const operator = getTrustedOperatorIdentity(req);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const restart = await restartOneShotRunStage({
      dashboardId,
      stage: req.body?.stage,
      operator,
      reason,
    });
    const row = await getOneShotRowByDashboardId(`run-${restart.oneshotRunId}`);
    if (!row) {
      res.status(500).json({ error: "Failed to load restarted OneShot run" });
      return;
    }

    res.status(200).json({
      row,
      restart,
      publishError: restart.publishError,
    });
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunControlError
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot] restart stage failed:", error);
    res.status(500).json({ error: "Failed to restart OneShot run stage" });
  }
}

router.post("/runs/:dashboardId/restart-stage", postOneShotRunRestartStage);

export async function postOneShotRunHardDelete(req: Request, res: Response) {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  try {
    const operator = getTrustedOperatorIdentity(req);
    const confirmDashboardId =
      typeof req.body?.confirmDashboardId === "string"
        ? req.body.confirmDashboardId
        : "";
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const deletion = await hardDeleteOneShotRun({
      dashboardId,
      confirmDashboardId,
      operator,
      reason,
    });

    res.status(200).json(deletion);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunControlError
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot] hard delete failed:", error);
    res.status(500).json({ error: "Failed to hard delete OneShot run" });
  }
}

router.post("/runs/:dashboardId/hard-delete", postOneShotRunHardDelete);

export async function postOneShotCiRefreshRequest(req: Request, res: Response) {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  try {
    const operator = getTrustedOperatorIdentity(req);
    const row = await getOneShotRowByDashboardId(dashboardId);
    if (!row || !row.oneshotRunId) {
      res.status(404).json({ error: "OneShot row not found" });
      return;
    }
    if (row.displayState !== "pr_open") {
      res.status(409).json({
        error: "CI refresh is only available for PR-open OneShot runs",
      });
      return;
    }

    const pool = getPool();
    await pool.execute(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, 'ci_refresh_requested', 'pr_open', 'pr_open', 'testing', ?, NOW())`,
      [
        row.oneshotRunId,
        JSON.stringify({
          reason: "manual_dashboard_refresh",
          operatorId: operator.id,
          operatorName: operator.display,
        }),
      ],
    );

    const updatedRow = await getOneShotRowByDashboardId(dashboardId);
    res.status(202).json({
      row: updatedRow ?? row,
      refresh: {
        requested: true,
        mode: "scheduled_reconciler",
      },
    });
  } catch (error) {
    if (error instanceof OperatorIdentityError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot] CI refresh request failed:", error);
    res.status(500).json({ error: "Failed to request CI refresh" });
  }
}

router.post("/runs/:dashboardId/refresh-ci", postOneShotCiRefreshRequest);

router.get("/runs/:dashboardId", async (req, res) => {
  const dashboardId =
    typeof req.params.dashboardId === "string" ? req.params.dashboardId : "";

  if (SHOULD_USE_DEV_MOCK) {
    const row = getMockRow(dashboardId);
    if (!row) {
      res.status(404).json({ error: "OneShot row not found" });
      return;
    }
    res.json(row);
    return;
  }

  try {
    const row = await getOneShotRowByDashboardId(dashboardId);
    if (!row) {
      res.status(404).json({ error: "OneShot row not found" });
      return;
    }
    res.json(row);
  } catch (error) {
    console.error("[oneshot] row lookup failed:", error);
    res.status(500).json({ error: "OneShot row lookup failed" });
  }
});

export default router;
