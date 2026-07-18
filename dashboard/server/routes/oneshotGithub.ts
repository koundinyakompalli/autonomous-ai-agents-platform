import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
  processOneShotGithubCommand,
} from "../services/oneshotGithubCommands.js";

const router = express.Router();

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const githubWebhookRateLimit = rateLimit({
  legacyHeaders: false,
  limit: positiveIntegerFromEnv("ONESHOT_GITHUB_WEBHOOK_RATE_LIMIT_MAX", 300),
  message: { error: "rate_limited" },
  standardHeaders: true,
  windowMs: positiveIntegerFromEnv("ONESHOT_GITHUB_WEBHOOK_RATE_LIMIT_WINDOW_MS", 60_000),
});

function headerValue(req: Request, name: string): string | undefined {
  const value = req.header(name);
  return Array.isArray(value) ? value[0] : value;
}

export function verifyGitHubWebhookSignature(input: {
  body: Buffer;
  signatureHeader?: string;
  secret?: string;
}): boolean {
  if (!input.secret || !input.signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", input.secret)
    .update(input.body)
    .digest("hex");
  const provided = input.signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function requestBodyBuffer(req: Request): Buffer | null {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }
  return null;
}

function shouldIgnorePayload(event: string, payload: Record<string, unknown>): boolean {
  if (event !== "issue_comment") {
    return true;
  }
  if (payload.action !== "created") {
    return true;
  }
  const comment = payload.comment && typeof payload.comment === "object"
    ? payload.comment as Record<string, unknown>
    : {};
  return !isOneShotCommand(comment.body);
}

function isOneShotCommand(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /^\/oneshot(?:\s|$)/i.test(value.trim());
}

export async function postOneShotGithubWebhook(req: Request, res: Response): Promise<void> {
  const body = requestBodyBuffer(req);
  if (!body) {
    res.status(400).json({ error: "raw_body_required" });
    return;
  }

  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  if (!secret) {
    res.status(503).json({ error: "webhook_secret_unconfigured" });
    return;
  }

  const signatureHeader = headerValue(req, "x-hub-signature-256");
  if (!verifyGitHubWebhookSignature({ body, signatureHeader, secret })) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  const event = headerValue(req, "x-github-event") ?? "";
  const deliveryId = headerValue(req, "x-github-delivery") ?? "";
  if (!deliveryId) {
    res.status(400).json({ error: "missing_delivery_id" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  if (shouldIgnorePayload(event, payload)) {
    res.status(202).json({ ignored: true });
    return;
  }

  const result = await processOneShotGithubCommand({
    deliveryId,
    event,
    payload,
  });
  res.status(202).json(result);
}

router.post(
  "/webhook",
  githubWebhookRateLimit,
  express.raw({ type: "application/json", limit: "1mb" }),
  postOneShotGithubWebhook,
);

export default router;
