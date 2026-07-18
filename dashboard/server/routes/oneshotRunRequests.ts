import { Router, type Request, type Response } from "express";
import {
  getTrustedOperatorIdentity,
  OperatorIdentityError,
} from "../auth/operatorIdentity.js";
import { validateOneShotRunRequestJiraKey } from "../services/oneshotJiraLookup.js";
import {
  createOneShotRunRequest,
  getOneShotRunRequestById,
} from "../services/oneshotRunRequests.js";
import { OneShotRunRequestError } from "../services/oneshotRunRequestSupport.js";

const router = Router();

function runRequestErrorPayload(
  error: OperatorIdentityError | OneShotRunRequestError,
): { error: string; code?: string; details?: unknown } {
  return {
    error: error.message,
    ...(error instanceof OneShotRunRequestError && error.code
      ? { code: error.code }
      : {}),
    ...(error instanceof OneShotRunRequestError && error.details !== undefined
      ? { details: error.details }
      : {}),
  };
}

export async function postOneShotRunRequest(
  req: Request,
  res: Response,
) {
  try {
    const operator = getTrustedOperatorIdentity(req);
    const jiraKey =
      typeof req.body?.jiraKey === "string" ? req.body.jiraKey : "";
    const validation = await validateOneShotRunRequestJiraKey({ jiraKey });

    const request = await createOneShotRunRequest({
      jiraKey: validation.jiraKey,
      operator,
    });

    res.status(202).json(request);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunRequestError
    ) {
      res.status(error.statusCode).json(runRequestErrorPayload(error));
      return;
    }

    console.error(
      "[oneshot-run-requests] failed to create run request:",
      error,
    );
    res.status(500).json({ error: "Failed to create OneShot run request" });
  }
}

export async function postOneShotRunRequestValidation(
  req: Request,
  res: Response,
) {
  try {
    getTrustedOperatorIdentity(req);
    const jiraKey =
      typeof req.body?.jiraKey === "string" ? req.body.jiraKey : "";

    const validation = await validateOneShotRunRequestJiraKey({ jiraKey });
    res.status(200).json(validation);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunRequestError
    ) {
      res.status(error.statusCode).json(runRequestErrorPayload(error));
      return;
    }

    console.error(
      "[oneshot-run-requests] failed to validate Jira issue:",
      error,
    );
    res.status(500).json({ error: "Failed to validate Jira issue" });
  }
}

export async function getOneShotRunRequest(
  req: Request,
  res: Response,
) {
  try {
    getTrustedOperatorIdentity(req);
    const requestId = Number(req.params.requestId);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      res.status(400).json({ error: "requestId must be a positive integer" });
      return;
    }

    const request = await getOneShotRunRequestById(requestId);
    if (!request) {
      res.status(404).json({ error: "OneShot run request not found" });
      return;
    }

    res.json(request);
  } catch (error) {
    if (
      error instanceof OperatorIdentityError ||
      error instanceof OneShotRunRequestError
    ) {
      res.status(error.statusCode).json(runRequestErrorPayload(error));
      return;
    }

    console.error("[oneshot-run-requests] failed to load run request:", error);
    res.status(500).json({ error: "Failed to load OneShot run request" });
  }
}

router.post("/validate", postOneShotRunRequestValidation);
router.post("/", postOneShotRunRequest);
router.get("/:requestId", getOneShotRunRequest);

export default router;
