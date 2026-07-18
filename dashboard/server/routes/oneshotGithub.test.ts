import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const processOneShotGithubCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../services/oneshotGithubCommands.js", () => ({
  processOneShotGithubCommand: processOneShotGithubCommandMock,
}));

async function loadModule() {
  vi.resetModules();
  return import("./oneshotGithub.js");
}

function createResponseRecorder() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  return response;
}

function signatureFor(secret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("oneshot GitHub webhook route", () => {
  beforeEach(() => {
    processOneShotGithubCommandMock.mockReset();
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    delete process.env.ONESHOT_GITHUB_WEBHOOK_RATE_LIMIT_MAX;
    delete process.env.ONESHOT_GITHUB_WEBHOOK_RATE_LIMIT_WINDOW_MS;
  });

  it("accepts a valid signature and forwards issue_comment.created events", async () => {
    processOneShotGithubCommandMock.mockResolvedValue({
      status: "accepted",
      ignored: false,
    });
    const payload = Buffer.from(JSON.stringify({
      action: "created",
      issue: { number: 2454, pull_request: {} },
      comment: { body: "/oneshot fix the build", id: 99, user: { login: "rmadhukar" } },
      repository: { full_name: "mhk-repos/cp-medhok-monorepo" },
    }));
    const { postOneShotGithubWebhook } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotGithubWebhook({
      body: payload,
      header(name: string) {
        const headers: Record<string, string> = {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": signatureFor("test-secret", payload),
        };
        return headers[name.toLowerCase()];
      },
    } as any, response as any);

    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual({
      status: "accepted",
      ignored: false,
    });
    expect(processOneShotGithubCommandMock).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      event: "issue_comment",
      payload: expect.objectContaining({ action: "created" }),
    });
  });

  it("rejects an invalid signature before parsing the command", async () => {
    const payload = Buffer.from(JSON.stringify({
      action: "created",
      comment: { body: "/oneshot fix the build" },
    }));
    const { postOneShotGithubWebhook } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotGithubWebhook({
      body: payload,
      header(name: string) {
        const headers: Record<string, string> = {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": "sha256=bad",
        };
        return headers[name.toLowerCase()];
      },
    } as any, response as any);

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "invalid_signature" });
    expect(processOneShotGithubCommandMock).not.toHaveBeenCalled();
  });

  it("ignores edited and non-/oneshot comments without invoking the service", async () => {
    const { postOneShotGithubWebhook } = await loadModule();

    for (const payloadObject of [
      { action: "edited", comment: { body: "/oneshot fix the build" } },
      { action: "created", comment: { body: "please fix the build" } },
    ]) {
      const payload = Buffer.from(JSON.stringify(payloadObject));
      const response = createResponseRecorder();
      await postOneShotGithubWebhook({
        body: payload,
        header(name: string) {
          const headers: Record<string, string> = {
            "x-github-event": "issue_comment",
            "x-github-delivery": "delivery-1",
            "x-hub-signature-256": signatureFor("test-secret", payload),
          };
          return headers[name.toLowerCase()];
        },
      } as any, response as any);

      expect(response.statusCode).toBe(202);
      expect(response.body).toEqual({ ignored: true });
    }

    expect(processOneShotGithubCommandMock).not.toHaveBeenCalled();
  });

  it("registers rate limiting before raw body parsing", async () => {
    const module = await loadModule();
    const router = module.default as any;
    const routeLayer = router.stack.find(
      (layer: any) => layer.route?.path === "/webhook",
    );
    const handlers = routeLayer.route.stack.map((layer: any) => layer.handle);

    expect(handlers).toHaveLength(3);
    expect(handlers[0]).toBe((module as any).githubWebhookRateLimit);
    expect(handlers[1].name).toBe("rawParser");
    expect(handlers[2]).toBe(module.postOneShotGithubWebhook);
  });
});
