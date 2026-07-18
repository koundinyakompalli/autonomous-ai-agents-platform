import { Router, type Request, type Response } from "express";

const router = Router();

function sanitizeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "/oneshot";
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/oneshot";
  }

  return trimmed;
}

export function startRepoRouterAuth(req: Request, res: Response) {
  const returnTo = sanitizeReturnTo(req.query.returnTo);
  res.redirect(302, returnTo);
}

router.get("/start", startRepoRouterAuth);

export default router;
