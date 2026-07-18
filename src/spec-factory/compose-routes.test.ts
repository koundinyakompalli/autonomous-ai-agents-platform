import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposeRouter } from "./compose-routes.js";
import {
  ResearchBudgetError,
  SourceRestoreUnavailableError,
} from "./errors.js";

function makeService() {
  return {
    createSession: vi.fn(),
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getContextProjection: vi.fn(),
    resumeSession: vi.fn(),
    deleteSession: vi.fn(),
    cancelTurn: vi.fn(),
    exportSession: vi.fn(),
    importSession: vi.fn(),
    addNote: vi.fn(),
    handoff: vi.fn(),
    requestUpload: vi.fn(),
    confirmUpload: vi.fn(),
    getSourcePreview: vi.fn(),
    addYoutube: vi.fn(),
    addJira: vi.fn(),
    addConfluence: vi.fn(),
    deleteSource: vi.fn(),
    listUndoableSourceDeletions: vi.fn(),
    restoreDeletedSource: vi.fn(),
    listSources: vi.fn(),
    reconvert: vi.fn(),
    reconvertFailedSources: vi.fn(),
    listRepositories: vi.fn(),
    requestCodeResearch: vi.fn(),
    analyze: vi.fn(),
    postMessage: vi.fn(),
    listMessages: vi.fn(),
    getWorkflowState: vi.fn(),
    isSessionPasswordProtected: vi.fn().mockResolvedValue(false),
    verifyStreamToken: vi.fn().mockReturnValue(true),
  };
}

async function start(
  service: ReturnType<typeof makeService>,
  options: {
    sseHub?: {
      subscribe: any;
      unsubscribe: any;
      setSubscriberAfterEventId?: any;
      advanceSubscriberAfterEventId?: any;
      getSubscriberAfterEventId?: any;
    };
    eventStore?: {
      getLatestSessionEventId: any;
      listSessionEventsAfter: any;
    };
    workflowStateRateLimitMax?: number;
  } = {},
): Promise<{
  server: Server;
  request: (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: any }>;
  rawRequest: (path: string, init?: RequestInit) => Promise<Response>;
  sseHub: {
    subscribe: any;
    unsubscribe: any;
    setSubscriberAfterEventId?: any;
    advanceSubscriberAfterEventId?: any;
    getSubscriberAfterEventId?: any;
  };
}> {
  const app = express();
  app.use(express.json());
  const sseHub = options.sseHub ?? {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
  app.use(
    "/api/spec-factory/compose",
    createComposeRouter(service as any, sseHub as any, {
      eventStore: options.eventStore as any,
      workflowStateRateLimitMax: options.workflowStateRateLimitMax,
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  return {
    server,
    sseHub,
    rawRequest: async (path, init) => fetch(url(path), init),
    request: async (path, init) => {
      const response = await fetch(url(path), init);
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
}

describe("compose routes", () => {
  let server: Server | undefined;
  afterEach(async () => {
    const current = server;
    server = undefined;
    if (!current?.listening) return;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("POST /sessions creates a session (201)", async () => {
    const service = makeService();
    service.createSession.mockResolvedValue({ id: 7, name: "X" });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X", password: "secret" }),
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(7);
    expect(service.createSession).toHaveBeenCalledWith({
      name: "X",
      createdBy: null,
      createdByDisplay: null,
      password: "secret",
    });
  });

  it("POST /sessions stores the OIDC actor as the session owner", async () => {
    const service = makeService();
    service.createSession.mockResolvedValue({ id: 7, name: "X" });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-user": "owner@example.com",
      },
      body: JSON.stringify({ name: "X", userName: "body-user" }),
    });

    expect(res.status).toBe(201);
    expect(service.createSession).toHaveBeenCalledWith({
      name: "X",
      createdBy: "owner@example.com",
      createdByDisplay: "owner@example.com",
      password: null,
    });
  });

  it("GET /sessions lists sessions (200)", async () => {
    const service = makeService();
    service.listSessions.mockResolvedValue([]);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /repositories lists code repositories for Compose selection", async () => {
    const service = makeService();
    service.listRepositories.mockResolvedValue([
      {
        id: 3,
        repoName: "medhok-monorepo",
        repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        defaultBranch: "master",
        description: "Core app",
      },
    ]);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/repositories");
    expect(res.status).toBe(200);
    expect(res.body[0].repoName).toBe("medhok-monorepo");
    expect(service.listRepositories).toHaveBeenCalled();
  });

  it("GET /sessions/:id returns a session (200)", async () => {
    const service = makeService();
    service.getSession.mockResolvedValue({ id: 7 });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions/7");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(service.getSession).toHaveBeenCalledWith(7, "spec-factory-operator");
  });

  it("GET /sessions/:id/context returns the latest context projection (200)", async () => {
    const service = makeService();
    service.getContextProjection.mockResolvedValue({
      sessionId: 7,
      version: 4,
      artifactUri: "s3://bucket/compose/7/context/working-context-v4.md",
      structuredArtifactUri:
        "s3://bucket/compose/7/context/working-context-v4.json",
      summary: {
        objective: "Build invoice export",
        problemStatement: "Users need exports for billing audits.",
        recommendedNextActions: ["Inspect billing-service export flow"],
      },
      facts: [],
      openQuestions: [],
      decisions: [],
      sourceIds: [61],
      patchIds: [701],
      committedAt: "2026-07-05T10:30:00.000Z",
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/context",
    );
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(4);
    expect(service.getContextProjection).toHaveBeenCalledWith(
      7,
      "spec-factory-operator",
    );
  });

  it("POST /sessions/:id/resume returns a password-authorized session (200)", async () => {
    const service = makeService();
    service.resumeSession.mockResolvedValue({ id: 7 });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/resume",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret" }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(service.resumeSession).toHaveBeenCalledWith({
      sessionId: 7,
      password: "secret",
      actor: "spec-factory-operator",
    });
  });

  it("DELETE /sessions/:id archives a session after optional password check (202)", async () => {
    const service = makeService();
    service.deleteSession.mockResolvedValue(undefined);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions/7", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret" }),
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ deleted: true });
    expect(service.deleteSession).toHaveBeenCalledWith({
      sessionId: 7,
      password: "secret",
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/turns/:turnJobId/cancel cancels a durable turn (202)", async () => {
    const service = makeService();
    service.cancelTurn.mockResolvedValue({
      cancelled: true,
      turnJobId: 101,
      cancelledAgentTaskIds: [501],
      status: "cancelled",
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/turns/101/cancel",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      cancelled: true,
      turnJobId: 101,
      cancelledAgentTaskIds: [501],
      status: "cancelled",
    });
    expect(service.cancelTurn).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/import creates a restored session (201)", async () => {
    const service = makeService();
    service.importSession.mockResolvedValue({
      session: { id: 9, name: "Imported plan" },
      importedSources: 1,
      importedMessages: 2,
    });
    const bundle = {
      format: "spec-factory.compose-session",
      version: 1,
      exportedAt: "2026-06-02T00:00:00.000Z",
      session: { name: "Imported plan" },
      sources: [],
      messages: [],
    };
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-user": "kompallik",
      },
      body: JSON.stringify({ bundle }),
    });
    expect(res.status).toBe(201);
    expect(res.body.session.id).toBe(9);
    expect(service.importSession).toHaveBeenCalledWith({
      bundle,
      createdBy: "kompallik",
      createdByDisplay: "kompallik",
    });
  });

  it("POST /sessions/:id/export returns a portable bundle (200)", async () => {
    const service = makeService();
    service.exportSession.mockResolvedValue({
      format: "spec-factory.compose-session",
      version: 1,
      exportedAt: "2026-06-02T00:00:00.000Z",
      session: {
        name: "Billing export",
        createdByDisplay: null,
        readiness: null,
      },
      sources: [],
      messages: [],
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/export",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret" }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("spec-factory.compose-session");
    expect(service.exportSession).toHaveBeenCalledWith({
      sessionId: 7,
      password: "secret",
      actor: "spec-factory-operator",
    });
  });

  it("returns 401 when a protected session password is missing or invalid", async () => {
    const service = makeService();
    service.resumeSession.mockRejectedValue(
      new Error("Password is required for Compose session 7"),
    );
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/resume",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(401);
  });

  it("requires a stream token before mutating protected session content", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(false);
    const ctx = await start(service);
    server = ctx.server;

    const protectedMutations: Array<{
      path: string;
      init: RequestInit;
      serviceMethod: keyof ReturnType<typeof makeService>;
    }> = [
      {
        path: "/api/spec-factory/compose/sessions/7/notes",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "hi" }),
        },
        serviceMethod: "addNote",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/handoff",
        init: { method: "POST" },
        serviceMethod: "handoff",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/uploads",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: "spec.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
          }),
        },
        serviceMethod: "requestUpload",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/sources/9/uploaded",
        init: { method: "POST" },
        serviceMethod: "confirmUpload",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/youtube",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://youtu.be/x" }),
        },
        serviceMethod: "addYoutube",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/jira",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jiraKey: "CPDEV-123" }),
        },
        serviceMethod: "addJira",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/confluence",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://wiki.example.com/display/PROJ/Page",
          }),
        },
        serviceMethod: "addConfluence",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/sources/reconvert-failed",
        init: { method: "POST" },
        serviceMethod: "reconvertFailedSources",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/sources/9",
        init: { method: "DELETE" },
        serviceMethod: "deleteSource",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/sources/9/reconvert",
        init: { method: "POST" },
        serviceMethod: "reconvert",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/research/code",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: "Where is retry logic?" }),
        },
        serviceMethod: "requestCodeResearch",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/analyze",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryIds: [3] }),
        },
        serviceMethod: "analyze",
      },
      {
        path: "/api/spec-factory/compose/sessions/7/messages",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "billing-service" }),
        },
        serviceMethod: "postMessage",
      },
    ];

    for (const mutation of protectedMutations) {
      const res = await ctx.request(mutation.path, mutation.init);
      expect(res.status, mutation.path).toBe(401);
      expect(service[mutation.serviceMethod]).not.toHaveBeenCalled();
    }
  });

  it("allows a protected mutation with a valid stream token", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(true);
    service.addNote.mockResolvedValue({ id: 7 });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/notes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-compose-token": "abc",
        },
        body: JSON.stringify({ content: "hi" }),
      },
    );
    expect(res.status).toBe(202);
    expect(service.verifyStreamToken).toHaveBeenCalledWith(7, "abc");
    expect(service.addNote).toHaveBeenCalledWith({
      sessionId: 7,
      content: "hi",
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/notes adds a note (202)", async () => {
    const service = makeService();
    service.addNote.mockResolvedValue({ id: 7 });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/notes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hi" }),
      },
    );
    expect(res.status).toBe(202);
    expect(service.addNote).toHaveBeenCalledWith({
      sessionId: 7,
      content: "hi",
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/handoff returns the minted source (202)", async () => {
    const service = makeService();
    service.handoff.mockResolvedValue({ sourceId: 88, session: { id: 7 } });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/handoff",
      {
        method: "POST",
        headers: { "Idempotency-Key": "handoff-session-7" },
      },
    );
    expect(res.status).toBe(202);
    expect(res.body.sourceId).toBe(88);
    expect(service.handoff).toHaveBeenCalledWith({
      sessionId: 7,
      actor: "spec-factory-operator",
      idempotencyKey: "handoff-session-7",
    });
  });

  it("POST /sessions/:id/handoff returns 400 when sources block handoff", async () => {
    const service = makeService();
    service.handoff.mockRejectedValue(
      new Error(
        "Cannot hand off Compose session 7 until blocked sources are resolved: requirements.docx (failed)",
      ),
    );
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/handoff",
      {
        method: "POST",
        headers: { "Idempotency-Key": "handoff-session-7" },
      },
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("blocked sources");
  });

  it("rejects a non-positive session id (400)", async () => {
    const service = makeService();
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions/abc");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the session is not found", async () => {
    const service = makeService();
    service.getSession.mockRejectedValue(
      new Error("Compose session 999 was not found"),
    );
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions/999");
    expect(res.status).toBe(404);
    expect(service.getSession).toHaveBeenCalledWith(
      999,
      "spec-factory-operator",
    );
  });

  it("POST /sessions/:id/uploads returns a presigned target (201)", async () => {
    const service = makeService();
    service.requestUpload.mockResolvedValue({
      sourceId: 9,
      uploadUrl: "https://s3/put",
      s3KeyRaw: "k",
      expiresInSeconds: 900,
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/uploads",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "spec.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.uploadUrl).toBe("https://s3/put");
  });

  it("POST /sessions/:id/sources/:sid/uploaded accepts (202)", async () => {
    const service = makeService();
    service.confirmUpload.mockResolvedValue(undefined);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/uploaded",
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    expect(service.confirmUpload).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 9,
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/sources/:sid/uploaded returns 404 for a session/source mismatch", async () => {
    const service = makeService();
    service.confirmUpload.mockRejectedValue(
      new Error("Compose source 9 was not found in session 7"),
    );
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/uploaded",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("POST /sessions/:id/youtube accepts (202)", async () => {
    const service = makeService();
    service.addYoutube.mockResolvedValue(undefined);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/youtube",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/x" }),
      },
    );
    expect(res.status).toBe(202);
  });

  it("POST /sessions/:id/jira accepts a Jira key (202)", async () => {
    const service = makeService();
    service.addJira.mockResolvedValue(undefined);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request("/api/spec-factory/compose/sessions/7/jira", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jiraKey: "CPDEV-123" }),
    });
    expect(res.status).toBe(202);
    expect(service.addJira).toHaveBeenCalledWith({
      sessionId: 7,
      jiraKey: "CPDEV-123",
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/confluence accepts a page url (202)", async () => {
    const service = makeService();
    service.addConfluence.mockResolvedValue(undefined);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/confluence",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://wiki.example.com/display/PROJ/Page",
        }),
      },
    );
    expect(res.status).toBe(202);
    expect(service.addConfluence).toHaveBeenCalledWith({
      sessionId: 7,
      url: "https://wiki.example.com/display/PROJ/Page",
      actor: "spec-factory-operator",
    });
  });

  it("GET /sessions/:id/sources lists (200)", async () => {
    const service = makeService();
    service.listSources.mockResolvedValue([]);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /sessions/:id/sources/:sid/preview returns a protected image preview url", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(true);
    service.getSourcePreview.mockResolvedValue({
      url: "https://s3/get",
      mimeType: "image/png",
      filename: "screen.png",
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/preview",
      { headers: { "x-compose-token": "abc" } },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://s3/get",
      mimeType: "image/png",
      filename: "screen.png",
    });
    expect(service.verifyStreamToken).toHaveBeenCalledWith(7, "abc");
    expect(service.getSourcePreview).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 9,
      actor: "spec-factory-operator",
    });
  });

  it("DELETE /sessions/:id/sources/:sid deletes a source (202)", async () => {
    const service = makeService();
    const deletion = {
      id: 801,
      sessionId: 7,
      sourceId: 9,
      sourceTitle: "requirements.md",
      status: "undoable",
      undoUntil: "2026-07-11T12:10:00.000Z",
      invalidatedSourceIds: [9, 10],
      invalidatedHandoffIds: [91],
      dependentSourceCount: 1,
      createdAt: "2026-07-11T12:00:00.000Z",
    };
    service.deleteSource.mockResolvedValue(deletion);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9",
      {
        method: "DELETE",
      },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual(deletion);
    expect(service.deleteSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 9,
      actor: "spec-factory-operator",
    });
  });

  it("GET /sessions/:id/source-deletions lists undoable removals", async () => {
    const service = makeService();
    service.listUndoableSourceDeletions.mockResolvedValue([
      { id: 801, sessionId: 7, sourceId: 9, status: "undoable" },
    ]);
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/source-deletions",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 801, sessionId: 7, sourceId: 9, status: "undoable" },
    ]);
    expect(service.listUndoableSourceDeletions).toHaveBeenCalledWith({
      sessionId: 7,
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/sources/:sid/restore restores a source (202)", async () => {
    const service = makeService();
    service.restoreDeletedSource.mockResolvedValue({
      id: 801,
      sessionId: 7,
      sourceId: 9,
      status: "restored",
    });
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/restore",
      { method: "POST" },
    );

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("restored");
    expect(service.restoreDeletedSource).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 9,
      actor: "spec-factory-operator",
    });
  });

  it("POST source restore returns 410 after the undo window", async () => {
    const service = makeService();
    service.restoreDeletedSource.mockRejectedValue(
      new SourceRestoreUnavailableError("restore expired"),
    );
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/restore",
      { method: "POST" },
    );

    expect(res.status).toBe(410);
    expect(res.body.error).toEqual({ message: "restore expired" });
  });

  it("POST /sessions/:id/sources/:sid/reconvert accepts (202)", async () => {
    const service = makeService();
    service.reconvert.mockResolvedValue(undefined);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/reconvert",
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    expect(service.reconvert).toHaveBeenCalledWith({
      sessionId: 7,
      sourceId: 9,
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/sources/reconvert-failed queues all failed sources (202)", async () => {
    const service = makeService();
    service.reconvertFailedSources.mockResolvedValue({ queued: 3 });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/reconvert-failed",
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: 3 });
    expect(service.reconvertFailedSources).toHaveBeenCalledWith({
      sessionId: 7,
      actor: "spec-factory-operator",
    });
  });

  it("POST /sessions/:id/sources/:sid/reconvert returns 404 for a session/source mismatch", async () => {
    const service = makeService();
    service.reconvert.mockRejectedValue(
      new Error("Compose source 9 was not found in session 7"),
    );
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources/9/reconvert",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("POST /sessions/:id/analyze accepts the turn without waiting for readiness (202)", async () => {
    const service = makeService();
    service.analyze.mockResolvedValue({ accepted: true });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/analyze",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "analyze-abc",
        },
        body: JSON.stringify({ repositoryIds: [3, 5, "bad", 3] }),
      },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(service.analyze).toHaveBeenCalledWith({
      sessionId: 7,
      repositoryIds: [3, 5],
      reset: false,
      actor: "spec-factory-operator",
      idempotencyKey: "analyze-abc",
    });
  });

  it("POST /sessions/:id/research/code queues a code research task (202)", async () => {
    const service = makeService();
    service.requestCodeResearch.mockResolvedValue({
      accepted: true,
      agentTaskId: 501,
      capability: "code_research",
      status: "queued",
    });
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/research/code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-user": "kompallik",
        },
        body: JSON.stringify({
          question: "Where is retry logic implemented?",
          parentSourceIds: [11, "bad", 12, 11],
          contextVersionUsed: 4,
        }),
      },
    );

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      accepted: true,
      agentTaskId: 501,
      capability: "code_research",
      status: "queued",
    });
    expect(service.requestCodeResearch).toHaveBeenCalledWith({
      sessionId: 7,
      question: "Where is retry logic implemented?",
      parentSourceIds: [11, 12],
      contextVersionUsed: 4,
      actor: "kompallik",
    });
  });

  it("POST /sessions/:id/research/code maps disabled research enqueue to 503", async () => {
    const service = makeService();
    service.requestCodeResearch.mockRejectedValue(
      new Error("code_research_enqueue_disabled"),
    );
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/research/code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Where is retry logic?" }),
      },
    );

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { message: "code_research_enqueue_disabled" },
    });
  });

  it("GET /sessions/:id/workflow-state rate limits repeated actor-session reads", async () => {
    const service = makeService();
    service.getWorkflowState.mockResolvedValue({
      sessionId: 7,
      activeTurn: null,
      draftWorkflow: null,
    });
    const ctx = await start(service, { workflowStateRateLimitMax: 2 });
    server = ctx.server;
    const request = () =>
      ctx.request("/api/spec-factory/compose/sessions/7/workflow-state", {
        headers: { "x-forwarded-user": "viewer@example.com" },
      });

    await expect(request()).resolves.toMatchObject({ status: 200 });
    await expect(request()).resolves.toMatchObject({ status: 200 });
    await expect(request()).resolves.toEqual({
      status: 429,
      body: { error: { message: "workflow_state_rate_limit_exceeded" } },
    });
    expect(service.getWorkflowState).toHaveBeenCalledTimes(2);
  });

  it("POST /sessions/:id/research/code maps research budget rejection to 429", async () => {
    const service = makeService();
    service.requestCodeResearch.mockRejectedValue(
      new ResearchBudgetError("budget_exceeded"),
    );
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/research/code",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Where is retry logic?" }),
      },
    );

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      accepted: false,
      reason: "budget_exceeded",
    });
  });

  it("POST /sessions/:id/analyze forwards reset=true from the body", async () => {
    const service = makeService();
    service.analyze.mockResolvedValue({ accepted: true });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/analyze",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "analyze-reset-abc",
        },
        body: JSON.stringify({ repositoryIds: [3], reset: true }),
      },
    );
    expect(res.status).toBe(202);
    expect(service.analyze).toHaveBeenCalledWith({
      sessionId: 7,
      repositoryIds: [3],
      reset: true,
      actor: "spec-factory-operator",
      idempotencyKey: "analyze-reset-abc",
    });
  });

  it("POST /sessions/:id/analyze returns 409 when an idempotency key is reused with a different body", async () => {
    const service = makeService();
    service.analyze.mockRejectedValue(new Error("idempotency_key_reused"));
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/analyze",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "analyze-abc",
        },
        body: JSON.stringify({ repositoryIds: [3] }),
      },
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { message: "idempotency_key_reused" },
    });
  });

  it("POST /sessions/:id/messages accepts the turn without waiting for readiness (202)", async () => {
    const service = makeService();
    service.postMessage.mockResolvedValue({ accepted: true });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "msg-abc",
        },
        body: JSON.stringify({ content: "billing-service" }),
      },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(service.postMessage).toHaveBeenCalledWith({
      sessionId: 7,
      content: "billing-service",
      actor: "spec-factory-operator",
      idempotencyKey: "msg-abc",
    });
  });

  it("POST /sessions/:id/messages returns 409 when an idempotency key is reused with a different body", async () => {
    const service = makeService();
    service.postMessage.mockRejectedValue(new Error("idempotency_key_reused"));
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "msg-abc",
        },
        body: JSON.stringify({ content: "billing-service" }),
      },
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { message: "idempotency_key_reused" },
    });
  });

  it("POST /sessions/:id/messages requires an Idempotency-Key", async () => {
    const service = makeService();
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "billing-service" }),
      },
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: "idempotency_key_required" },
    });
    expect(service.postMessage).not.toHaveBeenCalled();
  });

  it("POST /sessions/:id/messages requires an Idempotency-Key even if the legacy bridge flag is set", async () => {
    vi.stubEnv("SPEC_FACTORY_IDEMPOTENCY_KEY_OPTIONAL", "true");
    const service = makeService();
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "billing-service" }),
      },
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: "idempotency_key_required" },
    });
    expect(service.postMessage).not.toHaveBeenCalled();
  });

  it("POST /sessions/:id/analyze rejects malformed Idempotency-Key values", async () => {
    const service = makeService();
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/analyze",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "bad key",
        },
        body: JSON.stringify({}),
      },
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { message: "idempotency_key_invalid" },
    });
    expect(service.analyze).not.toHaveBeenCalled();
  });

  it("POST /sessions/:id/analyze returns 429 when the turn queue is full", async () => {
    const service = makeService();
    service.analyze.mockResolvedValue({
      accepted: false,
      reason: "queue_full",
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/analyze",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "analyze-full",
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ accepted: false, reason: "queue_full" });
  });

  it("POST /sessions/:id/messages returns 429 when the turn queue is full", async () => {
    const service = makeService();
    service.postMessage.mockResolvedValue({
      accepted: false,
      reason: "queue_full",
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "msg-full",
        },
        body: JSON.stringify({ content: "another message" }),
      },
    );
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ accepted: false, reason: "queue_full" });
  });

  it("POST /sessions/:id/messages returns 503 when durable turn execution is required", async () => {
    const service = makeService();
    service.postMessage.mockResolvedValue({
      accepted: false,
      reason: "durable_turn_required",
    });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "msg-drain",
        },
        body: JSON.stringify({ content: "another message" }),
      },
    );
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      accepted: false,
      reason: "durable_turn_required",
    });
  });

  it("GET /sessions/:id/messages lists messages (200)", async () => {
    const service = makeService();
    service.listMessages.mockResolvedValue([
      { id: 1, sessionId: 7, role: "user", content: "hi", createdAt: "t" },
    ]);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("GET /sessions/:id/stream sets SSE headers, subscribes, and unsubscribes on close", async () => {
    const service = makeService();
    const ctx = await start(service);
    server = ctx.server;
    const controller = new AbortController();
    const p = ctx
      .request("/api/spec-factory/compose/sessions/7/stream", {
        signal: controller.signal,
      })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.sseHub.subscribe).toHaveBeenCalled();
    controller.abort();
    await p;
    await new Promise((r) => setTimeout(r, 50)); // let the server observe the close
    expect(ctx.sseHub.unsubscribe).toHaveBeenCalled();
  });

  it("GET /sessions/:id/stream rejects a protected session with no token (401)", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(false);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/stream",
    );
    expect(res.status).toBe(401);
    expect(ctx.sseHub.subscribe).not.toHaveBeenCalled();
  });

  it("GET /sessions/:id/stream rejects archived sessions before subscribing", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockRejectedValue(
      new Error("Compose session 7 was not found"),
    );
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/stream",
    );

    expect(res.status).toBe(404);
    expect(ctx.sseHub.subscribe).not.toHaveBeenCalled();
  });

  it("GET /sessions/:id/stream subscribes when a protected session presents a valid token", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(true);
    const ctx = await start(service);
    server = ctx.server;
    const controller = new AbortController();
    const p = ctx
      .request("/api/spec-factory/compose/sessions/7/stream?token=abc", {
        signal: controller.signal,
      })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.sseHub.subscribe).toHaveBeenCalled();
    expect(service.verifyStreamToken).toHaveBeenCalledWith(7, "abc");
    controller.abort();
    await p;
    await new Promise((r) => setTimeout(r, 50));
  });

  it("GET /sessions/:id/stream starts a fresh connection at the durable high-water mark", async () => {
    const service = makeService();
    const eventStore = {
      getLatestSessionEventId: vi.fn().mockResolvedValue(900),
      listSessionEventsAfter: vi.fn().mockResolvedValue([]),
    };
    const ctx = await start(service, { eventStore });
    server = ctx.server;
    const controller = new AbortController();

    const response = await ctx.rawRequest(
      "/api/spec-factory/compose/sessions/7/stream",
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(response.status).toBe(200);
    expect(eventStore.getLatestSessionEventId).toHaveBeenCalledWith(7);
    expect(eventStore.listSessionEventsAfter).toHaveBeenNthCalledWith(
      1,
      7,
      900,
    );
    expect(ctx.sseHub.subscribe).toHaveBeenCalledWith(
      7,
      expect.anything(),
      expect.objectContaining({
        replay: false,
        afterEventId: Number.MAX_SAFE_INTEGER,
      }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let initialFrames = "";
    for (
      let index = 0;
      index < 2 && !initialFrames.includes("event: cursor");
      index += 1
    ) {
      const chunk = await reader!.read();
      if (chunk.value) {
        initialFrames += new TextDecoder().decode(chunk.value);
      }
    }
    expect(initialFrames).toContain("id: 900");
    expect(initialFrames).toContain("event: cursor");

    controller.abort();
    await reader?.cancel().catch(() => undefined);
  });

  it("GET /sessions/:id/stream replays durable events from Last-Event-ID before live subscribe", async () => {
    const service = makeService();
    const eventStore = {
      getLatestSessionEventId: vi.fn(),
      listSessionEventsAfter: vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 91,
            sessionId: 7,
            eventType: "turn.status",
            payload: { type: "status", status: "thinking", message: "Reading" },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 92,
            sessionId: 7,
            eventType: "turn.status",
            payload: {
              type: "status",
              status: "thinking",
              message: "Gap event",
            },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 93,
            sessionId: 7,
            eventType: "turn.status",
            payload: {
              type: "status",
              status: "thinking",
              message: "Post-bridge durable event",
            },
          },
        ]),
    };
    const sseHub = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      setSubscriberAfterEventId: vi.fn(),
      advanceSubscriberAfterEventId: vi.fn(),
      getSubscriberAfterEventId: vi.fn().mockReturnValue(92),
    };
    const ctx = await start(service, { eventStore, sseHub });
    server = ctx.server;
    const controller = new AbortController();

    const response = await ctx.rawRequest(
      "/api/spec-factory/compose/sessions/7/stream",
      {
        headers: { "Last-Event-ID": "90" },
        signal: controller.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(response.status).toBe(200);
    expect(eventStore.getLatestSessionEventId).not.toHaveBeenCalled();
    expect(eventStore.listSessionEventsAfter).toHaveBeenNthCalledWith(1, 7, 90);
    expect(sseHub.subscribe).toHaveBeenCalledWith(
      7,
      expect.anything(),
      expect.objectContaining({
        replay: false,
        afterEventId: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(eventStore.listSessionEventsAfter).toHaveBeenNthCalledWith(2, 7, 91);
    expect(sseHub.setSubscriberAfterEventId).toHaveBeenCalledWith(
      7,
      expect.anything(),
      92,
    );
    expect(eventStore.listSessionEventsAfter).toHaveBeenNthCalledWith(3, 7, 92);
    expect(sseHub.advanceSubscriberAfterEventId).toHaveBeenCalledWith(
      7,
      expect.anything(),
      93,
    );

    controller.abort();
  });

  it("GET /sessions/:id/messages rejects a protected session with no token (401)", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(false);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
    );
    expect(res.status).toBe(401);
    expect(service.listMessages).not.toHaveBeenCalled();
  });

  it("GET /sessions/:id/messages rejects archived sessions before reading content", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockRejectedValue(
      new Error("Compose session 7 was not found"),
    );
    const ctx = await start(service);
    server = ctx.server;

    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
    );

    expect(res.status).toBe(404);
    expect(service.listMessages).not.toHaveBeenCalled();
  });

  it("GET /sessions/:id/messages accepts an x-compose-token header for a protected session", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(true);
    service.listMessages.mockResolvedValue([]);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
      { headers: { "x-compose-token": "tok" } },
    );
    expect(res.status).toBe(200);
    expect(service.verifyStreamToken).toHaveBeenCalledWith(7, "tok");
  });

  it("GET /sessions/:id/sources rejects a protected session with no token (401)", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(true);
    service.verifyStreamToken.mockReturnValue(false);
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources",
    );
    expect(res.status).toBe(401);
    expect(service.listSources).not.toHaveBeenCalled();
  });

  it("unprotected sessions still serve stream/messages/sources without a token (regression guard)", async () => {
    const service = makeService();
    service.isSessionPasswordProtected.mockResolvedValue(false);
    service.listMessages.mockResolvedValue([]);
    service.listSources.mockResolvedValue([]);
    const ctx = await start(service);
    server = ctx.server;

    const messages = await ctx.request(
      "/api/spec-factory/compose/sessions/7/messages",
    );
    expect(messages.status).toBe(200);

    const sources = await ctx.request(
      "/api/spec-factory/compose/sessions/7/sources",
    );
    expect(sources.status).toBe(200);

    const controller = new AbortController();
    const streamP = ctx
      .request("/api/spec-factory/compose/sessions/7/stream", {
        signal: controller.signal,
      })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.sseHub.subscribe).toHaveBeenCalled();
    controller.abort();
    await streamP;
  });
});
