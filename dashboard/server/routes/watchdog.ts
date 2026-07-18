import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import {
  approveWatchdogSession,
  answerWatchdogClarification,
  cancelWatchdogSession,
  createWatchdogSession,
  createWatchdogDarciHandoff,
  getWatchdogEvidenceArtifactPayload,
  getWatchdogHealth,
  getWatchdogDarciMappingDiagnostics,
  getWatchdogSession,
  listWatchdogCatalogClients,
  listWatchdogCatalogLogSources,
  listWatchdogClarifications,
  listWatchdogDarciHandoffs,
  listWatchdogEvents,
  listWatchdogEvidence,
  listWatchdogFindings,
  listWatchdogSessions,
  parseLastEventSequence,
  previewJiraTicket,
  previewNaturalLanguageIntent,
  previewNaturalLanguageIntentWithLlm,
  rerunWatchdogSession,
  setWatchdogRuntimeAwsCredentials,
  updateWatchdogDraft,
  WatchdogServiceError,
} from "../services/watchdog.js";
import {
  createDarciTaskForWatchdogHandoff,
  getDarciResultForWatchdogHandoff,
  syncDarciTaskForWatchdogHandoff,
} from "../services/watchdogDarciBridge.js";
import {
  reapStaleWatchdogRunAttempts,
  runNextWatchdogAttemptForSession,
} from "../services/watchdogRunner.js";
import type { WatchdogOperatorIdentity } from "../types/watchdog.js";

const router = Router();

function getOperator(req: Request): WatchdogOperatorIdentity {
  try {
    const operator = getTrustedOperatorIdentity(req);
    return { ...operator, authSource: "alb_oidc" };
  } catch (error) {
    if (process.env.NODE_ENV === "production" && process.env.WATCHDOG_ALLOW_LOCAL_OPERATOR_FALLBACK !== "true") {
      throw error;
    }
    return {
      id: process.env.WATCHDOG_USER_ID || process.env.USER || "local-dev",
      display: process.env.WATCHDOG_USER_DISPLAY || process.env.USER || "Local Developer",
      authSource: "local_dev",
    };
  }
}

function handleRouteError(res: Response, error: unknown) {
  if (error instanceof OperatorIdentityError || error instanceof WatchdogServiceError) {
    res.status(error.statusCode).json({ error: error.message, code: "code" in error ? error.code : "operator_identity_error" });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    /ExpiredTokenException|security token.*expired|token.*expired|credentials.*expired/i.test(message)
  ) {
    res.status(409).json({
      error: "AWS prod credentials are expired. Open Watchdog settings and update the runtime AWS credentials.",
      code: "aws_credentials_expired",
    });
    return;
  }
  if (/Failed to validate runtime AWS credentials|pasted credentials are valid|Resolved AWS account .* does not match|required Watchdog account/i.test(message)) {
    res.status(409).json({
      error: "Watchdog could not validate the AWS PROD credentials. Open Watchdog settings and paste current read-only PROD credentials.",
      code: "aws_credentials_invalid",
    });
    return;
  }
  console.error("[watchdog] route failed:", error);
  res.status(500).json({ error: "Watchdog request failed", code: "watchdog_request_failed" });
}

router.get("/health", async (_req, res) => {
  try {
    res.json(await getWatchdogHealth());
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/settings/aws-credentials", async (req, res) => {
  try {
    getOperator(req);
    const result = await setWatchdogRuntimeAwsCredentials({
      awsAccessKeyId: req.body?.awsAccessKeyId,
      awsSecretAccessKey: req.body?.awsSecretAccessKey,
      awsSessionToken: req.body?.awsSessionToken,
      awsAccountId: req.body?.awsAccountId,
    });
    res.json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/jira/preview", async (req, res) => {
  try {
    getOperator(req);
    const jiraKey = typeof req.body?.jiraKey === "string" ? req.body.jiraKey : "";
    res.json(await previewJiraTicket(jiraKey));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/intake/preview", async (req, res) => {
  try {
    getOperator(req);
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const catalog = await listWatchdogCatalogClients().catch(() => ({ clients: [] }));
    // Keep the expensive LLM path to one call. This deterministic prepass only  narrows
    // catalog context for the model; the returned controls still come from the LLM.
    const catalogPrepass = previewNaturalLanguageIntent(prompt, catalog.clients);
    const clientId = catalogPrepass.suggestedScope.clientId;
    const logSources = clientId
      ? await listWatchdogCatalogLogSources({ clientCode: clientId }).catch(() => ({ sources: [] }))
      : { sources: [] };
    const environments = Array.from(new Set(
      (logSources.sources || [])
        .map((source) => typeof source.environment === "string" ? source.environment : "")
        .filter(Boolean),
    ));
    const preview = await previewNaturalLanguageIntentWithLlm(prompt, catalog.clients, environments).catch((error) => {
      console.warn("[watchdog] LLM preview failed; returning deterministic fallback", error);
      const fallback = previewNaturalLanguageIntent(prompt, catalog.clients, environments);
      return {
        ...fallback,
        suggestions: {
          ...fallback.suggestions,
          source: "natural_language_fallback",
          needsReview: true,
          warning: "LLM preview was unavailable; review the suggested controls before approval.",
        },
        ambiguities: Array.from(new Set([...fallback.ambiguities, "review"])),
      };
    });
    res.json(preview);
  } catch (error) {
    console.warn("[watchdog] intake preview failed", error);
    handleRouteError(res, error);
  }
});

router.get("/sessions", async (req, res) => {
  try {
    getOperator(req);
    res.json(await listWatchdogSessions({ limit: req.query.limit, offset: req.query.offset }));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/catalog/clients", async (req, res) => {
  try {
    getOperator(req);
    res.json(await listWatchdogCatalogClients());
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/catalog/log-sources", async (req, res) => {
  try {
    getOperator(req);
    const clientCode = typeof req.query.clientCode === "string" ? req.query.clientCode : "";
    const environment = typeof req.query.environment === "string" ? req.query.environment : undefined;
    res.json(await listWatchdogCatalogLogSources({ clientCode, environment }));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions", async (req, res) => {
  try {
    const operator = getOperator(req);
    const session = await createWatchdogSession({
      mode: req.body?.mode,
      jiraKey: req.body?.jiraKey,
      naturalLanguagePrompt: req.body?.naturalLanguagePrompt,
      draftScope: req.body?.draftScope,
      idempotencyKey: req.body?.idempotencyKey,
      operator,
    });
    res.status(201).json(session);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId", async (req, res) => {
  try {
    getOperator(req);
    const session = await getWatchdogSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: "Watchdog session not found", code: "session_not_found" });
      return;
    }
    res.json(session);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.patch("/sessions/:sessionId", async (req, res) => {
  try {
    getOperator(req);
    res.json(await updateWatchdogDraft(req.params.sessionId, req.body?.draftScope));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/approve", async (req, res) => {
  try {
    const operator = getOperator(req);
    const run = await approveWatchdogSession(req.params.sessionId, req.body?.approvedScope, operator);
    res.status(202).json(run);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/run-next", async (req, res) => {
  try {
    getOperator(req);
    const run = await runNextWatchdogAttemptForSession(req.params.sessionId);
    res.status(202).json(run);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/rerun", async (req, res) => {
  try {
    const operator = getOperator(req);
    const run = await rerunWatchdogSession(req.params.sessionId, req.body?.approvedScope, operator);
    res.status(202).json(run);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/cancel", async (req, res) => {
  try {
    const operator = getOperator(req);
    const session = await cancelWatchdogSession(req.params.sessionId, operator);
    res.json(session);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/maintenance/reap-stale-runs", async (req, res) => {
  try {
    getOperator(req);
    const result = await reapStaleWatchdogRunAttempts();
    res.json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/evidence", async (req, res) => {
  try {
    getOperator(req);
    res.json(await listWatchdogEvidence(req.params.sessionId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/evidence/:evidenceId/payload", async (req, res) => {
  try {
    getOperator(req);
    res.json(await getWatchdogEvidenceArtifactPayload(req.params.sessionId, req.params.evidenceId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/clarifications", async (req, res) => {
  try {
    getOperator(req);
    res.json(await listWatchdogClarifications(req.params.sessionId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/clarifications/:clarificationId/answer", async (req, res) => {
  try {
    const operator = getOperator(req);
    const run = await answerWatchdogClarification({
      sessionId: req.params.sessionId,
      clarificationId: req.params.clarificationId,
      answer: req.body?.answer,
      operator,
    });
    res.status(202).json(run);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/findings", async (req, res) => {
  try {
    getOperator(req);
    res.json(await listWatchdogFindings(req.params.sessionId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/darci-handoffs", async (req, res) => {
  try {
    getOperator(req);
    res.json(await listWatchdogDarciHandoffs(req.params.sessionId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/darci-mapping", async (req, res) => {
  try {
    getOperator(req);
    res.json(await getWatchdogDarciMappingDiagnostics(req.params.sessionId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/darci-handoffs", async (req, res) => {
  try {
    const operator = getOperator(req);
    const handoff = await createWatchdogDarciHandoff({
      sessionId: req.params.sessionId,
      findingIds: req.body?.findingIds,
      operator,
    });
    res.status(202).json(handoff);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/darci-handoffs/:handoffId/create-task", async (req, res) => {
  try {
    getOperator(req);
    const result = await createDarciTaskForWatchdogHandoff(req.params.sessionId, req.params.handoffId);
    res.status(202).json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post("/sessions/:sessionId/darci-handoffs/:handoffId/sync", async (req, res) => {
  try {
    getOperator(req);
    const result = await syncDarciTaskForWatchdogHandoff(req.params.sessionId, req.params.handoffId);
    res.json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/darci-handoffs/:handoffId/result", async (req, res) => {
  try {
    getOperator(req);
    const result = await getDarciResultForWatchdogHandoff(req.params.sessionId, req.params.handoffId);
    res.json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get("/sessions/:sessionId/events", async (req, res) => {
  try {
    getOperator(req);
  } catch (error) {
    handleRouteError(res, error);
    return;
  }

  const sessionId = req.params.sessionId;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let lastSequence = parseLastEventSequence(req.header("Last-Event-ID") || req.query.last_event_id);
  const writeEvent = (event: Awaited<ReturnType<typeof listWatchdogEvents>>[number]) => {
    lastSequence = event.sequence;
    res.write(`id: ${event.id}:${event.sequence}\n`);
    res.write(`event: ${event.eventType}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const poll = async () => {
    try {
      const events = await listWatchdogEvents(sessionId, lastSequence);
      events.forEach(writeEvent);
    } catch (error) {
      res.write(`event: run.progress\n`);
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

export default router;
