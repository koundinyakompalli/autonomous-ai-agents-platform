import { Router } from "express";
import type { Request, Response } from "express";
import type { SpecFactoryActor } from "./oneshot-submitter.js";
import type { SpecFactoryService } from "./service.js";
import { updateSpecFactoryCorrelation } from "./telemetry/correlation.js";

type SpecFactoryRouteService = Pick<
  SpecFactoryService,
  | "listBoardSources"
  | "getSource"
  | "getStatus"
  | "requestBoardRefresh"
  | "requestDraftGeneration"
  | "getLatestDraft"
  | "listSourceEvents"
  | "listSourceAttachments"
  | "retrySourceAttachments"
  | "updateDraft"
  | "approveDraft"
  | "oneShotNow"
  | "listOneShotSubmissions"
  | "listArchivedSources"
  | "discardSource"
  | "restoreSource"
>;

class PositiveIntegerError extends Error {
  constructor(label: string, value: unknown) {
    super(`${label} must be a positive integer`);
    this.name = "PositiveIntegerError";
    if (value !== undefined) {
      this.message = `${label} must be a positive integer: ${String(value)}`;
    }
  }
}

function errorPayload(message: string): { error: { message: string } } {
  return { error: { message } };
}

export function positiveInt(value: unknown, label: string): number {
  const normalized = typeof value === "string" ? value.trim() : value;
  const numeric =
    typeof normalized === "number" || typeof normalized === "string"
      ? Number(normalized)
      : NaN;

  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new PositiveIntegerError(label, value);
  }

  return numeric;
}

export function actorFromRequest(req: Request): SpecFactoryActor {
  const headerValue =
    req.header("x-amzn-oidc-identity") ||
    req.header("x-forwarded-user") ||
    "spec-factory-operator";
  const actorId = headerValue.trim() || "spec-factory-operator";
  updateSpecFactoryCorrelation({ actorId });

  return { id: actorId, display: actorId };
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof PositiveIntegerError) {
    res.status(400).json(errorPayload(error.message));
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  if (/failed validation/i.test(message)) {
    res.status(400).json(errorPayload(message));
    return;
  }
  if (
    /is not the latest draft|must be ready|unpublished child tickets?/i.test(
      message,
    )
  ) {
    res.status(409).json(errorPayload(message));
    return;
  }
  if (/Retry priority attachments before generating a draft/i.test(message)) {
    res.status(409).json(errorPayload(message));
    return;
  }
  if (/only supported for Louise sources/i.test(message)) {
    res.status(409).json(errorPayload(message));
    return;
  }
  res.status(500).json(errorPayload(message));
}

function booleanParam(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

export function createSpecFactoryRouter(
  service: SpecFactoryRouteService,
): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.getStatus());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sources", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listBoardSources());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/refresh", async (req, res) => {
    try {
      const force =
        booleanParam(req.body?.force) || booleanParam(req.query.force);
      res.json(await service.requestBoardRefresh({ force }));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sources/:sourceId", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const source = await service.getSource(sourceId);
      if (!source) {
        res
          .status(404)
          .json(errorPayload(`Spec Factory source ${sourceId} was not found`));
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.json(source);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/louise/candidates", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listBoardSources());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/louise/refresh", async (req, res) => {
    try {
      const force =
        booleanParam(req.body?.force) || booleanParam(req.query.force);
      res.json(await service.requestBoardRefresh({ force }));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/drafts", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const result = await service.requestDraftGeneration({
        sourceId,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sources/:sourceId/drafts/latest", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const draft = await service.getLatestDraft(sourceId);
      if (!draft) {
        res.status(404).json(errorPayload("Latest draft was not found"));
        return;
      }
      res.json(draft);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sources/:sourceId/events", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listSourceEvents(sourceId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/sources/:sourceId/attachments", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      res.setHeader("Cache-Control", "no-cache");
      res.json(await service.listSourceAttachments(sourceId));
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/attachments/retry", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const result = await service.retrySourceAttachments({
        sourceId,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.put("/drafts/:draftId", async (req, res) => {
    try {
      const draftId = positiveInt(req.params.draftId, "draftId");
      const sourceId = positiveInt(req.body?.sourceId, "sourceId");
      const draft = await service.updateDraft({
        sourceId,
        draftId,
        draft: req.body?.draft,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json(draft);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/drafts/:draftId/approve", async (req, res) => {
    try {
      const draftId = positiveInt(req.params.draftId, "draftId");
      const sourceId = positiveInt(req.body?.sourceId, "sourceId");
      const actor = actorFromRequest(req);
      const draft = await service.approveDraft({
        sourceId,
        draftId,
        actor: actor.id,
      });
      res.status(202).json(draft);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/oneshot", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const result = await service.oneShotNow({
        sourceId,
        actor: actorFromRequest(req),
      });
      res.status(202).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/discard", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const source = await service.discardSource({
        sourceId,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json(source);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.post("/sources/:sourceId/restore", async (req, res) => {
    try {
      const sourceId = positiveInt(req.params.sourceId, "sourceId");
      const source = await service.restoreSource({
        sourceId,
        actor: actorFromRequest(req).id,
      });
      res.status(202).json(source);
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/oneshot/submissions", async (_req, res) => {
    try {
      res.json(await service.listOneShotSubmissions());
    } catch (error) {
      handleError(res, error);
    }
  });

  router.get("/archive/sources", async (_req, res) => {
    try {
      res.json(await service.listArchivedSources());
    } catch (error) {
      handleError(res, error);
    }
  });

  return router;
}
