import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import {
  deactivateBlockedClient,
  listBlockedClients,
  OneShotBlockedClientPolicyError,
  reactivateBlockedClient,
  upsertBlockedClient,
} from "../services/oneshotBlockedClients.js";

const router = Router();

function errorPayload(
  error: OperatorIdentityError | OneShotBlockedClientPolicyError,
): { error: string; code?: string; details?: unknown } {
  const includeDetails =
    error instanceof OneShotBlockedClientPolicyError &&
    error.code !== "policy_store_unavailable" &&
    error.details !== undefined;

  return {
    error: error.message,
    ...(error instanceof OneShotBlockedClientPolicyError
      ? { code: error.code }
      : {}),
    ...(includeDetails ? { details: error.details } : {}),
  };
}

function readClientKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function reasonFromBody(req: Request): string {
  return typeof req.body?.reason === "string" ? req.body.reason : "";
}

export async function getBlockedClients(req: Request, res: Response) {
  try {
    getTrustedOperatorIdentity(req);
    const includeInactive = req.query.includeInactive === "true";
    const clients = await listBlockedClients({ includeInactive });
    res.status(200).json({ clients });
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotBlockedClientPolicyError
    ) {
      res.status(error.statusCode).json(errorPayload(error));
      return;
    }

    console.error("[oneshot-blocked-clients] failed to list clients:", error);
    res.status(500).json({ error: "Failed to list blocked clients" });
  }
}

export async function postBlockedClient(req: Request, res: Response) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const result = await upsertBlockedClient({
      displayName:
        typeof req.body?.displayName === "string" ? req.body.displayName : "",
      reason: reasonFromBody(req),
      operator,
    });
    res.status(200).json(result);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotBlockedClientPolicyError
    ) {
      res.status(error.statusCode).json(errorPayload(error));
      return;
    }

    console.error("[oneshot-blocked-clients] failed to upsert client:", error);
    res.status(500).json({ error: "Failed to save blocked client" });
  }
}

export async function postBlockedClientDeactivate(
  req: Request,
  res: Response,
) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const result = await deactivateBlockedClient({
      clientKey: readClientKey(req.params.clientKey),
      reason: reasonFromBody(req),
      operator,
    });
    res.status(200).json(result);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotBlockedClientPolicyError
    ) {
      res.status(error.statusCode).json(errorPayload(error));
      return;
    }

    console.error(
      "[oneshot-blocked-clients] failed to deactivate client:",
      error,
    );
    res.status(500).json({ error: "Failed to deactivate blocked client" });
  }
}

export async function postBlockedClientReactivate(
  req: Request,
  res: Response,
) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const result = await reactivateBlockedClient({
      clientKey: readClientKey(req.params.clientKey),
      reason: reasonFromBody(req),
      operator,
    });
    res.status(200).json(result);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotBlockedClientPolicyError
    ) {
      res.status(error.statusCode).json(errorPayload(error));
      return;
    }

    console.error(
      "[oneshot-blocked-clients] failed to reactivate client:",
      error,
    );
    res.status(500).json({ error: "Failed to reactivate blocked client" });
  }
}

router.get("/", getBlockedClients);
router.post("/", postBlockedClient);
router.post("/:clientKey/deactivate", postBlockedClientDeactivate);
router.post("/:clientKey/reactivate", postBlockedClientReactivate);

export default router;
