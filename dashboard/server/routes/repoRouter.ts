import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import {
  getPendingRepoRouterConfirmations,
  getRecentRepoRouterDecisions,
  RepoRouterDashboardError,
  resolveRepoRouterConfirmation,
} from "../services/repoRouter.js";

const router = Router();

function readPositiveInteger(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return Number.NaN;
}

function handleRepoRouterError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
) {
  if (
    error instanceof RepoRouterDashboardError ||
    error instanceof OperatorIdentityError
  ) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  console.error("[repo-router] request failed:", error);
  res.status(500).json({ error: fallbackMessage });
}

export async function getRepoRouterDecisions(req: Request, res: Response) {
  try {
    const response = await getRecentRepoRouterDecisions({
      limit: req.query.limit,
      outcome: req.query.outcome,
    });
    res.setHeader("Cache-Control", "no-cache");
    res.json(response);
  } catch (error) {
    handleRepoRouterError(res, error, "Failed to load RepoRouter decisions");
  }
}

export async function getRepoRouterConfirmations(req: Request, res: Response) {
  try {
    const response = await getPendingRepoRouterConfirmations({
      limit: req.query.limit,
    });
    res.setHeader("Cache-Control", "no-cache");
    res.json(response);
  } catch (error) {
    handleRepoRouterError(res, error, "Failed to load RepoRouter confirmations");
  }
}

export async function postRepoRouterConfirmation(req: Request, res: Response) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const confirmationId = readPositiveInteger(req.params.confirmationId);
    const repoId = readPositiveInteger(req.body?.repoId);

    const response = await resolveRepoRouterConfirmation({
      confirmationId,
      repoId,
      operator,
    });
    res.status(200).json(response);
  } catch (error) {
    handleRepoRouterError(res, error, "Failed to resolve RepoRouter confirmation");
  }
}

router.get("/decisions", getRepoRouterDecisions);
router.get("/confirmations", getRepoRouterConfirmations);
router.post("/confirmations/:confirmationId/resolve", postRepoRouterConfirmation);

export default router;
