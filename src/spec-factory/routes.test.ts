import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpecFactoryRouter } from "./routes.js";

function makeService() {
  return {
    listBoardSources: vi.fn(),
    getSource: vi.fn(),
    getStatus: vi.fn(),
    requestBoardRefresh: vi.fn(),
    requestDraftGeneration: vi.fn(),
    getLatestDraft: vi.fn(),
    listSourceEvents: vi.fn(),
    listSourceAttachments: vi.fn(),
    retrySourceAttachments: vi.fn(),
    updateDraft: vi.fn(),
    approveDraft: vi.fn(),
    oneShotNow: vi.fn(),
    listOneShotSubmissions: vi.fn(),
    listArchivedSources: vi.fn(),
    discardSource: vi.fn(),
    restoreSource: vi.fn(),
  };
}

async function start(service: ReturnType<typeof makeService>): Promise<{
  server: Server;
  request: (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; headers: Headers; body: any }>;
}> {
  const app = express();
  app.use(express.json());
  app.use(createSpecFactoryRouter(service as any));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    request: async (path, init) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
      const body = await response.json();
      return { status: response.status, headers: response.headers, body };
    },
  };
}

describe("createSpecFactoryRouter", () => {
  let service: ReturnType<typeof makeService>;
  let server: Server;
  let request: Awaited<ReturnType<typeof start>>["request"];

  beforeEach(async () => {
    service = makeService();
    const started = await start(service);
    server = started.server;
    request = started.request;
  });

  afterEach(async () => {
    vi.resetAllMocks();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("GET /louise/candidates returns board payload and sets no-cache", async () => {
    const sources = [{ id: 12, sourceJiraKey: "CPDEV-22410" }];
    service.listBoardSources.mockResolvedValueOnce(sources);

    const response = await request("/louise/candidates");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(sources);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(service.listBoardSources).toHaveBeenCalledTimes(1);
  });

  it("GET /sources returns the neutral board payload and sets no-cache", async () => {
    const sources = [{ id: 12, sourceJiraKey: "COMPOSE-7", origin: "compose" }];
    service.listBoardSources.mockResolvedValueOnce(sources);

    const response = await request("/sources");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(sources);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(service.listBoardSources).toHaveBeenCalledTimes(1);
  });

  it("GET /sources/:sourceId returns a source outside the capped board list", async () => {
    const source = {
      id: 1671,
      sourceJiraKey: "COMPOSE-63",
      sourceSummary: "PCU New Fields for 4.3",
      origin: "compose",
      state: "oneshot_submitted",
      approvedEpicKey: "CPDEV-26321",
    };
    service.getSource.mockResolvedValueOnce(source);

    const response = await request("/sources/1671");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(source);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(service.getSource).toHaveBeenCalledWith(1671);
  });

  it("GET /sources/:sourceId returns 404 when the source does not exist", async () => {
    service.getSource.mockResolvedValueOnce(null);

    const response = await request("/sources/1671");

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe(
      "Spec Factory source 1671 was not found",
    );
  });

  it("GET /status returns health summary and sets no-cache", async () => {
    const status = {
      generatedAt: "2026-06-08T12:00:00.000Z",
      board: {
        activeSourceCount: 2,
        latestRefreshAt: "2026-06-08T11:55:00.000Z",
        byState: { candidate: 1, draft_ready: 1 },
        byOrigin: { louise: 1, compose: 1 },
      },
      processing: {
        byStatus: { queued: 1, running: 0, succeeded: 8, failed: 1 },
        staleRunning: 0,
        oldestQueuedAt: "2026-06-08T11:58:00.000Z",
        oldestRunningAt: null,
      },
      composeConversion: {
        byStatus: { pending: 1, converted: 3, failed: 1 },
        inFlight: 1,
        retryable: 1,
        oldestPendingAt: "2026-06-08T11:59:00.000Z",
        oldestConvertingAt: null,
      },
    };
    service.getStatus.mockResolvedValueOnce(status);

    const response = await request("/status");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(status);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(service.getStatus).toHaveBeenCalledTimes(1);
  });

  it("POST /louise/refresh starts or skips a board refresh", async () => {
    const payload = { refresh: { status: "started" }, sources: [] };
    service.requestBoardRefresh.mockResolvedValueOnce(payload);

    const response = await request("/louise/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
    expect(service.requestBoardRefresh).toHaveBeenCalledWith({
      force: true,
    });
  });

  it("POST /sources/refresh starts or skips a neutral board refresh", async () => {
    const payload = { refresh: { status: "started" }, sources: [] };
    service.requestBoardRefresh.mockResolvedValueOnce(payload);

    const response = await request("/sources/refresh?force=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: false }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
    expect(service.requestBoardRefresh).toHaveBeenCalledWith({
      force: true,
    });
  });

  it("POST /sources/:sourceId/drafts returns 202 and generates a draft", async () => {
    const payload = { queued: true, source: { id: 12 }, draft: null };
    service.requestDraftGeneration.mockResolvedValueOnce(payload);

    const response = await request("/sources/12/drafts", { method: "POST" });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(payload);
    expect(service.requestDraftGeneration).toHaveBeenCalledWith({
      sourceId: 12,
      actor: "spec-factory-operator",
    });
  });

  it("POST /sources/:sourceId/drafts returns 409 when priority attachments need retry", async () => {
    service.requestDraftGeneration.mockRejectedValueOnce(
      new Error(
        "Retry priority attachments before generating a draft: Development-Plan.md (failed).",
      ),
    );

    const response = await request("/sources/12/drafts", { method: "POST" });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/Retry priority attachments/);
  });

  it("GET /sources/:sourceId/drafts/latest returns latest draft", async () => {
    const draft = { id: 44, sourceId: 12 };
    service.getLatestDraft.mockResolvedValueOnce(draft);

    const response = await request("/sources/12/drafts/latest");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(draft);
    expect(service.getLatestDraft).toHaveBeenCalledWith(12);
  });

  it("GET /sources/:sourceId/events returns source activity and sets no-cache", async () => {
    const events = [
      {
        id: 701,
        sourceId: 12,
        eventType: "draft_generation_queued",
        actor: "kkompalli",
        metadata: { jobId: 44 },
        createdAt: "2026-06-01T12:01:00.000Z",
      },
    ];
    service.listSourceEvents.mockResolvedValueOnce(events);

    const response = await request("/sources/12/events");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(events);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(service.listSourceEvents).toHaveBeenCalledWith(12);
  });

  it("GET /sources/:sourceId/attachments returns attachment archive rows and sets no-cache", async () => {
    const attachments = [
      {
        id: 301,
        sourceId: 12,
        jiraAttachmentId: "att-1",
        filename: "Development-Plan.md",
        extractionStatus: "extracted",
      },
    ];
    service.listSourceAttachments.mockResolvedValueOnce(attachments);

    const response = await request("/sources/12/attachments");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(attachments);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(service.listSourceAttachments).toHaveBeenCalledWith(12);
  });

  it("POST /sources/:sourceId/attachments/retry retries the attachment archive", async () => {
    const result = {
      retriedCount: 1,
      beforeAttentionCount: 1,
      afterAttentionCount: 0,
      attachments: [],
    };
    service.retrySourceAttachments.mockResolvedValueOnce(result);

    const response = await request("/sources/12/attachments/retry", {
      method: "POST",
      headers: { "x-forwarded-user": "kkompalli" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(result);
    expect(service.retrySourceAttachments).toHaveBeenCalledWith({
      sourceId: 12,
      actor: "kkompalli",
    });
  });

  it("POST /sources/:sourceId/attachments/retry returns 409 for Compose sources", async () => {
    service.retrySourceAttachments.mockRejectedValueOnce(
      new Error(
        "Attachment archive retry is only supported for Louise sources",
      ),
    );

    const response = await request("/sources/12/attachments/retry", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/only supported for Louise/i);
  });

  it("GET /sources/:sourceId/drafts/latest returns 404 when no draft exists", async () => {
    service.getLatestDraft.mockResolvedValueOnce(null);

    const response = await request("/sources/12/drafts/latest");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { message: "Latest draft was not found" },
    });
  });

  it("PUT /drafts/:draftId saves an edited draft revision", async () => {
    const draft = { id: 45, sourceId: 12, status: "ready" };
    const bundle = { sourceJiraKey: "CPDEV-22410" };
    service.updateDraft.mockResolvedValueOnce(draft);

    const response = await request("/drafts/44", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-forwarded-user": "kkompalli",
      },
      body: JSON.stringify({ sourceId: 12, draft: bundle }),
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(draft);
    expect(service.updateDraft).toHaveBeenCalledWith({
      sourceId: 12,
      draftId: 44,
      draft: bundle,
      actor: "kkompalli",
    });
  });

  it("PUT /drafts/:draftId returns 409 for stale draft edits", async () => {
    service.updateDraft.mockRejectedValueOnce(
      new Error("Draft 44 is not the latest draft for source 12"),
    );

    const response = await request("/drafts/44", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: 12, draft: {} }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/not the latest/i);
  });

  it("POST /drafts/:draftId/approve parses sourceId and actor", async () => {
    const draft = { id: 44, sourceId: 12, status: "approved" };
    service.approveDraft.mockResolvedValueOnce(draft);

    const response = await request("/drafts/44/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-user": "kkompalli",
      },
      body: JSON.stringify({ sourceId: 12 }),
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(draft);
    expect(service.approveDraft).toHaveBeenCalledWith({
      sourceId: 12,
      draftId: 44,
      actor: "kkompalli",
    });
  });

  it("POST /sources/:sourceId/oneshot returns 202 and passes actor object", async () => {
    const result = {
      submittedCount: 1,
      results: [{ childId: 99, requestId: 3 }],
    };
    service.oneShotNow.mockResolvedValueOnce(result);

    const response = await request("/sources/12/oneshot", {
      method: "POST",
      headers: { "x-amzn-oidc-identity": "user-123" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(result);
    expect(service.oneShotNow).toHaveBeenCalledWith({
      sourceId: 12,
      actor: { id: "user-123", display: "user-123" },
    });
  });

  it("POST /sources/:sourceId/oneshot returns 409 while publish is partial", async () => {
    service.oneShotNow.mockRejectedValueOnce(
      new Error(
        "Spec Factory source 12 still has 1 unpublished child ticket; retry Jira publish before OneShot submission",
      ),
    );

    const response = await request("/sources/12/oneshot", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/unpublished child ticket/i);
  });

  it("GET /oneshot/submissions returns submissions", async () => {
    const submissions = [{ source: { id: 12 }, childTickets: [] }];
    service.listOneShotSubmissions.mockResolvedValueOnce(submissions);

    const response = await request("/oneshot/submissions");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(submissions);
    expect(service.listOneShotSubmissions).toHaveBeenCalledTimes(1);
  });

  it("POST /sources/:sourceId/discard archives a source", async () => {
    const archived = {
      id: 12,
      sourceJiraKey: "CPDEV-22410",
      state: "archived",
    };
    service.discardSource.mockResolvedValueOnce(archived);

    const response = await request("/sources/12/discard", {
      method: "POST",
      headers: { "x-forwarded-user": "kkompalli" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(archived);
    expect(service.discardSource).toHaveBeenCalledWith({
      sourceId: 12,
      actor: "kkompalli",
    });
  });

  it("POST /sources/:sourceId/restore restores an archived source", async () => {
    const restored = {
      id: 12,
      sourceJiraKey: "CPDEV-22410",
      state: "draft_ready",
    };
    service.restoreSource.mockResolvedValueOnce(restored);

    const response = await request("/sources/12/restore", {
      method: "POST",
      headers: { "x-forwarded-user": "kkompalli" },
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(restored);
    expect(service.restoreSource).toHaveBeenCalledWith({
      sourceId: 12,
      actor: "kkompalli",
    });
  });

  it("GET /archive/sources returns archived sources", async () => {
    const sources = [
      { id: 12, sourceJiraKey: "CPDEV-22410", state: "archived" },
    ];
    service.listArchivedSources.mockResolvedValueOnce(sources);

    const response = await request("/archive/sources");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(sources);
    expect(service.listArchivedSources).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for invalid ids", async () => {
    const response = await request("/sources/not-a-number/drafts", {
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("sourceId");
    expect(service.requestDraftGeneration).not.toHaveBeenCalled();
  });
});
