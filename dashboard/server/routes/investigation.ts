import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import {
  attachMeridianEvidence,
  approveInvestigationRecommendation,
  createMeridianDbaTicket,
  createInvestigationRunFromJiraWebhook,
  createInvestigationRun,
  createInvestigationRuns,
  escalateInvestigationRun,
  getInvestigationHealth,
  getMeridianSqlArtifact,
  getInvestigationRun,
  InvestigationServiceError,
  listInvestigationAudit,
  listInvestigationEvents,
  listInvestigationEvidence,
  listInvestigationFindings,
  listInvestigationRuns,
  postInvestigationSummary,
  type InvestigationEnvironment,
  type InvestigationMode,
} from "../services/investigation.js";

const router = Router();

function getOperator(req: Request) {
  try {
    return getTrustedOperatorIdentity(req);
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
    return {
      id: "local-dev",
      display: "Local Developer",
    };
  }
}

function handleRouteError(res: Response, error: unknown) {
  if (error instanceof OperatorIdentityError || error instanceof InvestigationServiceError) {
    res.status(error.statusCode).json({ error: error.message, code: "code" in error ? error.code : "operator_identity_error" });
    return;
  }

  console.error("[investigation] route failed:", error);
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message || "Investigation request failed", code: "investigation_request_failed" });
}

function parseLastEventSequence(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") {
    return 0;
  }

  const raw = String(value).trim();
  if (!raw) {
    return 0;
  }

  const sequenceToken = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
  const parsed = Number.parseInt(sequenceToken, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function assertWebhookSecret(req: Request) {
  const expected = process.env.INVESTIGATION_JIRA_WEBHOOK_SECRET?.trim();
  if (!expected) {
    return;
  }

  const provided = req.header("x-investigation-webhook-secret")?.trim();
  if (!provided || provided !== expected) {
    throw new InvestigationServiceError("Invalid investigation webhook secret", 401, "invalid_webhook_secret");
  }
}

router.get("/health", (_req, res) => {
  try {
    res.json(getInvestigationHealth());
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs", (req, res) => {
  try {
    getOperator(req);
    res.json(listInvestigationRuns());
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs", async (req, res) => {
  try {
    const operator = getOperator(req);
    const environment = req.body?.environment;
    const mode = req.body?.mode;
    const run = await createInvestigationRun({
      jiraKey: typeof req.body?.jiraKey === "string" ? req.body.jiraKey : undefined,
      title: typeof req.body?.title === "string" ? req.body.title : undefined,
      client: typeof req.body?.client === "string" ? req.body.client : undefined,
      environment: isEnvironment(environment) ? environment : undefined,
      mode: isMode(mode) ? mode : undefined,
      operatorDisplay: operator.display,
      operatorSshPassword: typeof req.body?.operatorSshPassword === "string" ? req.body.operatorSshPassword : undefined,
      investigationHint: typeof req.body?.investigationHint === "string" ? req.body.investigationHint : undefined,
    });
    res.status(201).json(run);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs/batch", async (req, res) => {
  try {
    const operator = getOperator(req);
    const tickets = Array.isArray(req.body?.tickets) ? req.body.tickets : [];
    const result = await createInvestigationRuns({
      operatorDisplay: operator.display,
      tickets: tickets.map((ticket: Record<string, unknown>) => ({
        jiraKey: typeof ticket?.jiraKey === "string" ? ticket.jiraKey : undefined,
        title: typeof ticket?.title === "string" ? ticket.title : undefined,
        client: typeof ticket?.client === "string" ? ticket.client : undefined,
        environment: isEnvironment(ticket?.environment) ? ticket.environment : undefined,
        mode: isMode(ticket?.mode) ? ticket.mode : undefined,
      })),
    });
    res.status(201).json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/webhooks/jira", async (req, res) => {
  try {
    assertWebhookSecret(req);
    const result = await createInvestigationRunFromJiraWebhook(req.body);
    res.status(result.triggered ? 202 : 200).json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs/:runId", (req, res) => {
  try {
    getOperator(req);
    res.json(getInvestigationRun(req.params.runId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs/:runId/findings", (req, res) => {
  try {
    getOperator(req);
    res.json(listInvestigationFindings(req.params.runId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs/:runId/evidence", (req, res) => {
  try {
    getOperator(req);
    res.json(listInvestigationEvidence(req.params.runId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs/:runId/meridian/evidence", (req, res) => {
  try {
    const operator = getOperator(req);
    res.json(attachMeridianEvidence(req.params.runId, req.body || {}, operator.display));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs/:runId/meridian/sql/:artifactId", (req, res) => {
  try {
    getOperator(req);
    const { artifact, content } = getMeridianSqlArtifact(req.params.runId, req.params.artifactId);
    res.setHeader("Content-Type", "text/sql; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename.replace(/"/g, "")}"`);
    res.send(content);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs/:runId/meridian/dba-ticket", async (req, res) => {
  try {
    const operator = getOperator(req);
    const artifactId = typeof req.body?.artifactId === "string" ? req.body.artifactId : undefined;
    res.json(await createMeridianDbaTicket(req.params.runId, operator, artifactId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs/:runId/events", (req, res) => {
  try {
    getOperator(req);
    const afterSequence = parseLastEventSequence(req.query.afterSequence);
    res.json(listInvestigationEvents(req.params.runId, afterSequence));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/runs/:runId/events/stream", (req, res) => {
  try {
    getOperator(req);
  } catch (error) {
    handleRouteError(res, error);
    return;
  }

  const runId = req.params.runId;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let lastSequence = parseLastEventSequence(req.header("Last-Event-ID") || req.query.last_event_id);

  const writeEvent = (event: ReturnType<typeof listInvestigationEvents>["events"][number]) => {
    lastSequence = event.sequence;
    res.write(`id: ${event.id}:${event.sequence}\n`);
    res.write("event: run.progress\n");
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const poll = async () => {
    try {
      const { events } = listInvestigationEvents(runId, lastSequence);
      events.forEach(writeEvent);
    } catch {
      res.write("event: run.progress\n");
      res.write(`data: ${JSON.stringify({ error: "event_poll_failed" })}\n\n`);
    }
  };

  void poll();
  const pollTimer = setInterval(() => void poll(), 2_000);
  const heartbeatTimer = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);

  req.on("close", () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  });
});

router.get("/runs/:runId/audit", (req, res) => {
  try {
    getOperator(req);
    res.json(listInvestigationAudit(req.params.runId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs/:runId/approve", (req, res) => {
  try {
    const operator = getOperator(req);
    res.json(approveInvestigationRecommendation(req.params.runId, operator.display));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs/:runId/escalate", (req, res) => {
  try {
    const operator = getOperator(req);
    res.json(escalateInvestigationRun(req.params.runId, operator.display));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/runs/:runId/jira/post-summary", async (req, res) => {
  try {
    const operator = getOperator(req);
    res.json(await postInvestigationSummary(req.params.runId, operator.display));
  } catch (error) {
    handleRouteError(res, error);
  }
});

function isEnvironment(value: unknown): value is InvestigationEnvironment {
  return value === "DEV" || value === "INT" || value === "UAT" || value === "STAGE" || value === "PROD-REPLICA";
}

function isMode(value: unknown): value is InvestigationMode {
  return value === "aws-first" || value === "mixed" || value === "data-led";
}

export default router;
