import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import { getOneShotRowByDashboardId } from "../services/oneshot.js";
import {
  OneShotRunTerminationError,
  terminateOneShotRun,
} from "../services/oneshotRunTerminations.js";

const router = Router();

export async function postOneShotRunTermination(req: Request, res: Response) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const oneshotRunId = Number(req.body?.oneshotRunId);
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;

    if (!Number.isInteger(oneshotRunId) || oneshotRunId <= 0) {
      res.status(400).json({ error: "oneshotRunId must be a positive integer" });
      return;
    }

    const termination = await terminateOneShotRun({
      oneshotRunId,
      operator,
      reason,
    });
    const row = await getOneShotRowByDashboardId(`run-${termination.oneshotRunId}`);

    if (!row) {
      res.status(500).json({ error: "Failed to load terminated OneShot run" });
      return;
    }

    res.status(200).json({
      row,
      workspaceCleanupStatus: termination.workspaceCleanupStatus,
      workspaceCleanupSucceeded: termination.workspaceCleanupSucceeded,
    });
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunTerminationError
    ) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error("[oneshot-run-terminations] failed to terminate run:", error);
    res.status(500).json({ error: "Failed to terminate OneShot run" });
  }
}

router.post("/", postOneShotRunTermination);

export default router;
