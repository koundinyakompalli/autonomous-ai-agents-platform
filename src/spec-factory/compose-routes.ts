import { Router } from "express";
import type { Request, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { ComposeService } from "./compose-service.js";
import { formatCanonicalSseEvent } from "./compose-sse.js";
import type { ComposeTurnAccepted } from "./compose-types.js";
import { createCanonicalSessionEvent } from "./events/canonical-event.js";
import {
  IdempotencyConflictError,
  ResearchBudgetError,
  SourceRestoreUnavailableError,
} from "./errors.js";
import { positiveInt, actorFromRequest } from "./routes.js";

/** 202 when accepted, 429 for local queue saturation, 503 for unavailable execution mode. */
function turnAcceptStatus(result: ComposeTurnAccepted): number {
  if (!("reason" in result)) return 202;
  return result.reason === "queue_full" ? 429 : 503;
}

interface SseHubForRoutes {
  subscribe(
    sessionId: number,
    res: Response,
    options?: { replay?: boolean; afterEventId?: number },
  ): void;
  unsubscribe(sessionId: number, res: Response): void;
  setSubscriberAfterEventId?(
    sessionId: number,
    res: Response,
    afterEventId: number,
  ): void;
  advanceSubscriberAfterEventId?(
    sessionId: number,
    res: Response,
    afterEventId: number,
  ): void;
  getSubscriberAfterEventId?(
    sessionId: number,
    res: Response,
  ): number | undefined;
  recordReplayedEvents?(count: number): void;
}

interface ComposeRouteSessionEvent {
  id: number;
  sessionId: number;
  eventType: string;
  payload: unknown;
  createdAt?: string;
  requestId?: string | null;
  turnJobId?: number | null;
  agentTaskId?: number | null;
  contextVersion?: number | null;
}

interface ComposeRouteEventStore {
  getLatestSessionEventId(sessionId: number): Promise<number>;
  listSessionEventsAfter(
    sessionId: number,
    afterEventId?: number,
    limit?: number,
  ): Promise<ComposeRouteSessionEvent[]>;
}

type ComposeRouteService = Pick<
  ComposeService,
  | "createSession"
  | "listSessions"
  | "getSession"
  | "resumeSession"
  | "deleteSession"
  | "cancelTurn"
  | "exportSession"
  | "getContextProjection"
  | "importSession"
  | "addNote"
  | "handoff"
  | "requestUpload"
  | "confirmUpload"
  | "getSourcePreview"
  | "addYoutube"
  | "addJira"
  | "addConfluence"
  | "deleteSource"
  | "listUndoableSourceDeletions"
  | "restoreDeletedSource"
  | "listSources"
  | "reconvert"
  | "reconvertFailedSources"
  | "listRepositories"
  | "requestCodeResearch"
  | "analyze"
  | "postMessage"
  | "listMessages"
  | "getWorkflowState"
  | "isSessionPasswordProtected"
  | "verifyStreamToken"
>;

function errorPayload(message: string): { error: { message: string } } {
  return { error: { message } };
}

const DEFAULT_WORKFLOW_STATE_RATE_LIMIT_MAX = 120;

function researchExecutionUnavailable(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message === "code_research_enqueue_disabled" ||
    (message.includes("research") &&
      (message.includes("disabled") || message.includes("unavailable")))
  );
}

function handleError(res: Response, error: unknown): void {
  if (
    error instanceof Error &&
    /must be a positive integer/.test(error.message)
  ) {
    res.status(400).json(errorPayload(error.message));
    return;
  }
  if (error instanceof Error && /was not found/i.test(error.message)) {
    res.status(404).json(errorPayload(error.message));
    return;
  }
  if (error instanceof Error && /password/i.test(error.message)) {
    res.status(401).json(errorPayload(error.message));
    return;
  }
  if (
    error instanceof IdempotencyConflictError ||
    (error instanceof Error && error.message === "idempotency_key_reused")
  ) {
    res.status(409).json(errorPayload("idempotency_key_reused"));
    return;
  }
  if (error instanceof ResearchBudgetError) {
    res.status(429).json({ accepted: false, reason: error.reason });
    return;
  }
  if (error instanceof SourceRestoreUnavailableError) {
    res.status(410).json(errorPayload(error.message));
    return;
  }
  if (researchExecutionUnavailable(error)) {
    res.status(503).json(errorPayload(error.message));
    return;
  }
  if (
    error instanceof Error &&
    /(is required|Jira key|Invalid Compose session bundle|not previewable|no uploaded object|blocked sources)/i.test(
      error.message,
    )
  ) {
    res.status(400).json(errorPayload(error.message));
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json(errorPayload(message));
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function repositoryIdsFromBody(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<number>();
  for (const item of value) {
    if (typeof item !== "number") continue;
    if (!Number.isInteger(item) || item <= 0) continue;
    ids.add(item);
  }
  return [...ids].slice(0, 25);
}

function optionalPositiveInt(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isInteger(value) && value > 0 ? value : null;
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~+/-]{1,128}$/;

function idempotencyKeyFromRequest(
  req: Request,
  res: Response,
): string | null | undefined {
  const header = req.header("idempotency-key");
  const key = typeof header === "string" ? header.trim() : "";
  if (!key) {
    res.status(400).json(errorPayload("idempotency_key_required"));
    return undefined;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    res.status(400).json(errorPayload("idempotency_key_invalid"));
    return undefined;
  }
  return key;
}

/**
 * Pull a stream token off either the ?token= query (used by EventSource which
 * cannot send headers) or the x-compose-token header (used by GET /messages
 * + GET /sources). Returns null when no token was provided.
 */
function streamTokenFromRequest(req: Request): string | null {
  const headerValue = req.headers["x-compose-token"];
  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.trim();
  }
  const queryToken = req.query?.token;
  if (typeof queryToken === "string" && queryToken.trim().length > 0) {
    return queryToken.trim();
  }
  return null;
}

function streamEventCursorFromRequest(req: Request): number | null {
  const headerValue = req.header("last-event-id");
  const queryValue = req.query?.after;
  const raw =
    typeof headerValue === "string" && headerValue.trim()
      ? headerValue
      : typeof queryValue === "string"
        ? queryValue
        : null;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function actorIdFromRequest(req: Request): string {
  return actorFromRequest(req).id;
}

function createSessionActor(req: Request): {
  createdBy: string | null;
  createdByDisplay: string | null;
} {
  const actor = actorFromRequest(req);
  const bodyUserName = optionalString(req.body?.userName);
  if (actor.id === "spec-factory-operator") {
    return {
      createdBy: bodyUserName,
      createdByDisplay: bodyUserName,
    };
  }
  return {
    createdBy: actor.id,
    createdByDisplay: actor.display,
  };
}

function writeDurableEvent(
  res: Response,
  event: ComposeRouteSessionEvent,
): boolean {
  res.write(
    formatCanonicalSseEvent(
      createCanonicalSessionEvent({
        id: event.id,
        eventType: event.eventType,
        occurredAt: event.createdAt ?? new Date().toISOString(),
        sessionId: event.sessionId,
        requestId: event.requestId ?? null,
        turnJobId: event.turnJobId ?? null,
        agentTaskId: event.agentTaskId ?? null,
        contextVersion: event.contextVersion ?? null,
        data: event.payload,
      }),
    ),
  );
  return true;
}

/**
 * Authorize a content-read or stream subscription. For unprotected sessions
 * we preserve the prior behavior (no token required) so the existing
 * dashboard keeps working without changes; for protected sessions we require
 * a valid stream token minted by /resume.
 *
 * Returns true when the request may proceed; otherwise writes the 401 and
 * returns false so the caller short-circuits.
 */
async function authorizeProtectedRead(
  service: ComposeRouteService,
  sessionId: number,
  req: Request,
  res: Response,
): Promise<boolean> {
  const protectedSession = await service.isSessionPasswordProtected(
    sessionId,
    actorIdFromRequest(req),
  );
  if (!protectedSession) return true;
  const token = streamTokenFromRequest(req);
  if (!(await service.verifyStreamToken(sessionId, token))) {
    res.status(401).json(errorPayload("A valid stream token is required"));
    return false;
  }
  return true;
}

async function authorizeProtectedMutation(
  service: ComposeRouteService,
  sessionId: number,
  req: Request,
  res: Response,
): Promise<boolean> {
  return authorizeProtectedRead(service, sessionId, req, res);
}

export function createComposeRouter(
  service: ComposeRouteService,
  sseHub: SseHubForRoutes,
  options: {
    eventStore?: ComposeRouteEventStore;
    workflowStateRateLimitMax?: number;
  } = {},
): Router {
  const router = Router();
  const workflowStateRateLimiter = rateLimit({
    windowMs: 60_000,
    limit: positiveInt(
      options.workflowStateRateLimitMax ??
        process.env.SPEC_FACTORY_WORKFLOW_STATE_RATE_LIMIT_MAX ??
        DEFAULT_WORKFLOW_STATE_RATE_LIMIT_MAX,
      "SPEC_FACTORY_WORKFLOW_STATE_RATE_LIMIT_MAX",
    ),
    keyGenerator: (req) =>
      `${actorIdFromRequest(req)}:${req.params.sessionId ?? "unknown"}:${ipKeyGenerator(req.ip)}`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: errorPayload("workflow_state_rate_limit_exceeded"),
  });

  router.get("/repositories", async (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listRepositories());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions", async (req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listSessions(actorIdFromRequest(req)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions", async (req: Request, res: Response) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const actor = createSessionActor(req);
      const session = await service.createSession({
        name,
        createdBy: actor.createdBy,
        createdByDisplay: actor.createdByDisplay,
        password: optionalString(req.body?.password),
      });
      res.status(201).json(session);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/import", async (req: Request, res: Response) => {
    try {
      const actor = actorFromRequest(req);
      const result = await service.importSession({
        bundle: req.body?.bundle ?? req.body,
        createdBy: actor.id,
        createdByDisplay: actor.display,
      });
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      res.json(await service.getSession(sessionId, actorIdFromRequest(req)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(
    "/sessions/:sessionId/context",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        if (!(await authorizeProtectedRead(service, sessionId, req, res)))
          return;
        res.setHeader("Cache-Control", "no-cache");
        res.json(
          await service.getContextProjection(
            sessionId,
            actorIdFromRequest(req),
          ),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/sessions/:sessionId/resume",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        res.json(
          await service.resumeSession({
            sessionId,
            password: optionalString(req.body?.password),
            actor: actorIdFromRequest(req),
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/sessions/:sessionId/export",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const bundle = await service.exportSession({
          sessionId,
          password: optionalString(req.body?.password),
          actor: actorIdFromRequest(req),
        });
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="compose-session-${sessionId}.json"`,
        );
        res.json(bundle);
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.delete("/sessions/:sessionId", async (req: Request, res: Response) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      await service.deleteSession({
        sessionId,
        password: optionalString(req.body?.password),
        actor: actorFromRequest(req).id,
      });
      res.status(202).json({ deleted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/sessions/:sessionId/turns/:turnJobId/cancel",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const turnJobId = positiveInt(req.params.turnJobId, "turnJobId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        res.status(202).json(
          await service.cancelTurn({
            sessionId,
            turnJobId,
            actor: actorFromRequest(req).id,
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/sessions/:sessionId/notes",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        const content =
          typeof req.body?.content === "string" ? req.body.content : "";
        const session = await service.addNote({
          sessionId,
          content,
          actor: actorFromRequest(req).id,
        });
        res.status(202).json(session);
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/sessions/:sessionId/handoff",
    async (req: Request, res: Response) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        const idempotencyKey = idempotencyKeyFromRequest(req, res);
        if (idempotencyKey === undefined || idempotencyKey === null) return;
        const result = await service.handoff({
          sessionId,
          actor: actorFromRequest(req).id,
          idempotencyKey,
        });
        res.status(202).json(result);
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.get("/sessions/:sessionId/sources", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedRead(service, sessionId, req, res))) return;
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listSources(sessionId, actorIdFromRequest(req)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(
    "/sessions/:sessionId/sources/:sourceId/preview",
    async (req, res) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const sourceId = positiveInt(req.params.sourceId, "sourceId");
        if (!(await authorizeProtectedRead(service, sessionId, req, res)))
          return;
        res.setHeader("Cache-Control", "no-cache");
        res.json(
          await service.getSourcePreview({
            sessionId,
            sourceId,
            actor: actorIdFromRequest(req),
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post("/sessions/:sessionId/uploads", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const filename =
        typeof req.body?.filename === "string" ? req.body.filename : "";
      const target = await service.requestUpload({
        sessionId,
        filename,
        mimeType: optionalString(req.body?.mimeType),
        sizeBytes:
          typeof req.body?.sizeBytes === "number" ? req.body.sizeBytes : null,
        actor: actorFromRequest(req).id,
      });
      res.status(201).json(target);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/sessions/:sessionId/sources/:sourceId/uploaded",
    async (req, res) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const sourceId = positiveInt(req.params.sourceId, "sourceId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        await service.confirmUpload({
          sessionId,
          sourceId,
          actor: actorFromRequest(req).id,
        });
        res.status(202).json({ accepted: true });
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post("/sessions/:sessionId/youtube", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      await service.addYoutube({
        sessionId,
        url,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json({ accepted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/jira", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const jiraKey =
        typeof req.body?.jiraKey === "string" ? req.body.jiraKey : "";
      await service.addJira({
        sessionId,
        jiraKey,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json({ accepted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/confluence", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      await service.addConfluence({
        sessionId,
        url,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json({ accepted: true });
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/sessions/:sessionId/sources/reconvert-failed",
    async (req, res) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        res.status(202).json(
          await service.reconvertFailedSources({
            sessionId,
            actor: actorFromRequest(req).id,
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.delete("/sessions/:sessionId/sources/:sourceId", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      res.status(202).json(
        await service.deleteSource({
          sessionId,
          sourceId,
          actor: actorFromRequest(req).id,
        }),
      );
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions/:sessionId/source-deletions", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedRead(service, sessionId, req, res))) return;
      res.json(
        await service.listUndoableSourceDeletions({
          sessionId,
          actor: actorFromRequest(req).id,
        }),
      );
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post(
    "/sessions/:sessionId/sources/:sourceId/restore",
    async (req, res) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const sourceId = positiveInt(req.params.sourceId, "sourceId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        res.status(202).json(
          await service.restoreDeletedSource({
            sessionId,
            sourceId,
            actor: actorFromRequest(req).id,
          }),
        );
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post(
    "/sessions/:sessionId/sources/:sourceId/reconvert",
    async (req, res) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        const sourceId = positiveInt(req.params.sourceId, "sourceId");
        if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
          return;
        await service.reconvert({
          sessionId,
          sourceId,
          actor: actorFromRequest(req).id,
        });
        res.status(202).json({ accepted: true });
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.post("/sessions/:sessionId/research/code", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const question =
        typeof req.body?.question === "string" ? req.body.question : "";
      const result = await service.requestCodeResearch({
        sessionId,
        question,
        parentSourceIds: repositoryIdsFromBody(req.body?.parentSourceIds),
        contextVersionUsed: optionalPositiveInt(req.body?.contextVersionUsed),
        actor: actorIdFromRequest(req),
      });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/analyze", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const idempotencyKey = idempotencyKeyFromRequest(req, res);
      if (idempotencyKey === undefined) return;
      const repositoryIds = repositoryIdsFromBody(req.body?.repositoryIds);
      const reset = req.body?.reset === true;
      const result = await service.analyze({
        sessionId,
        repositoryIds,
        reset,
        actor: actorIdFromRequest(req),
        idempotencyKey,
      });
      res.status(turnAcceptStatus(result)).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sessions/:sessionId/messages", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedMutation(service, sessionId, req, res)))
        return;
      const idempotencyKey = idempotencyKeyFromRequest(req, res);
      if (idempotencyKey === undefined) return;
      const content =
        typeof req.body?.content === "string" ? req.body.content : "";
      if (!content.trim()) {
        throw new Error("Message content is required");
      }
      const result = await service.postMessage({
        sessionId,
        content,
        actor: actorIdFromRequest(req),
        idempotencyKey,
      });
      res.status(turnAcceptStatus(result)).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sessions/:sessionId/messages", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      if (!(await authorizeProtectedRead(service, sessionId, req, res))) return;
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listMessages(sessionId, actorIdFromRequest(req)));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get(
    "/sessions/:sessionId/workflow-state",
    workflowStateRateLimiter,
    async (req, res) => {
      try {
        const sessionId = positiveInt(req.params.sessionId, "sessionId");
        if (!(await authorizeProtectedRead(service, sessionId, req, res)))
          return;
        res.setHeader("Cache-Control", "no-store");
        const state = await service.getWorkflowState(
          sessionId,
          actorIdFromRequest(req),
        );
        if (!state) {
          res
            .status(404)
            .json(errorPayload("Compose workflow state was not found"));
          return;
        }
        res.json(state);
      } catch (error) {
        handleError(res, error);
      }
    },
  );

  router.get("/sessions/:sessionId/stream", async (req, res) => {
    let sessionId: number;
    try {
      sessionId = positiveInt(req.params.sessionId, "sessionId");
    } catch (error) {
      handleError(res, error);
      return;
    }
    try {
      if (!(await authorizeProtectedRead(service, sessionId, req, res))) {
        return;
      }
    } catch (error) {
      handleError(res, error);
      return;
    }
    const eventStore = options.eventStore;
    const requestedEventId = streamEventCursorFromRequest(req);
    let lastSentEventId = requestedEventId ?? 0;
    if (eventStore && requestedEventId === null) {
      try {
        lastSentEventId = await eventStore.getLatestSessionEventId(sessionId);
      } catch (error) {
        handleError(res, error);
        return;
      }
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    if (eventStore && requestedEventId === null) {
      res.write(
        `id: ${lastSentEventId}\nevent: cursor\ndata: {"type":"cursor"}\n\n`,
      );
    }
    if (eventStore) {
      let replayedEvents = 0;
      const replay = await eventStore.listSessionEventsAfter(
        sessionId,
        lastSentEventId,
      );
      for (const event of replay) {
        if (writeDurableEvent(res, event)) {
          lastSentEventId = event.id;
          replayedEvents += 1;
        }
      }
      sseHub.subscribe(sessionId, res, {
        replay: false,
        afterEventId: Number.MAX_SAFE_INTEGER,
      });
      const gapReplay = await eventStore.listSessionEventsAfter(
        sessionId,
        lastSentEventId,
      );
      for (const event of gapReplay) {
        if (writeDurableEvent(res, event)) {
          lastSentEventId = event.id;
          replayedEvents += 1;
        }
      }
      sseHub.setSubscriberAfterEventId?.(sessionId, res, lastSentEventId);
      const postBridgeReplay = await eventStore.listSessionEventsAfter(
        sessionId,
        lastSentEventId,
      );
      for (const event of postBridgeReplay) {
        const liveCursor = sseHub.getSubscriberAfterEventId?.(sessionId, res);
        if (
          liveCursor !== undefined &&
          Number.isFinite(liveCursor) &&
          event.id <= liveCursor
        ) {
          lastSentEventId = Math.max(lastSentEventId, event.id);
          continue;
        }
        if (writeDurableEvent(res, event)) {
          lastSentEventId = event.id;
          replayedEvents += 1;
        }
      }
      if (postBridgeReplay.length > 0) {
        if (sseHub.advanceSubscriberAfterEventId) {
          sseHub.advanceSubscriberAfterEventId(sessionId, res, lastSentEventId);
        } else {
          sseHub.setSubscriberAfterEventId?.(sessionId, res, lastSentEventId);
        }
      }
      sseHub.recordReplayedEvents?.(replayedEvents);
    } else {
      sseHub.subscribe(sessionId, res);
    }
    req.on("close", () => {
      sseHub.unsubscribe(sessionId, res);
    });
  });

  return router;
}
