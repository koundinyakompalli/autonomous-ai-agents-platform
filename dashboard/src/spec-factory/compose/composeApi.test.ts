// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./composeApi.js";

function ok(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("composeApi", () => {
  it("createSession POSTs name+userName+password", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({
        id: 7,
        name: "X",
        status: "draft",
        sourceId: null,
        readiness: null,
        sourceCount: 0,
        passwordProtected: true,
        createdAt: "t",
        updatedAt: "t",
      }),
    );
    const s = await api.createSession({
      name: "X",
      userName: "kk",
      password: "secret",
    });
    expect(s.id).toBe(7);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "X",
      userName: "kk",
      password: "secret",
    });
  });

  it("resumeSession POSTs password to the resume endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({
        id: 7,
        name: "X",
        status: "draft",
        sourceId: null,
        readiness: null,
        sourceCount: 0,
        passwordProtected: true,
        createdAt: "t",
        updatedAt: "t",
      }),
    );
    const s = await api.resumeSession(7, "secret");
    expect(s.id).toBe(7);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions/7/resume");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ password: "secret" });
  });

  it("deleteSession sends password when supplied", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ deleted: true }, 202));
    await api.deleteSession(7, "secret");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions/7");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ password: "secret" });
  });

  it("exportSession and importSession POST portable bundles", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok({
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
        }),
      )
      .mockResolvedValueOnce(
        ok(
          {
            session: {
              id: 9,
              name: "Billing export",
              status: "draft",
              sourceId: null,
              readiness: null,
              sourceCount: 0,
              passwordProtected: false,
              createdAt: "t",
              updatedAt: "t",
            },
            importedSources: 0,
            importedMessages: 0,
          },
          201,
        ),
      );
    const bundle = await api.exportSession(7, "secret");
    const result = await api.importSession(bundle);

    expect(result.session.id).toBe(9);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("/api/spec-factory/compose/sessions/7/export");
    expect(calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      password: "secret",
    });
    expect(calls[1][0]).toBe("/api/spec-factory/compose/sessions/import");
    expect(calls[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ bundle });
  });

  it("listSessions / listSources / listMessages / listRepositories GET the right urls", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok([{ id: 1, markdownContent: "# Spec" }]),
    );
    await api.listSessions();
    const sources = await api.listSources(7);
    await api.listMessages(7);
    await api.listRepositories();
    const urls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
    expect(urls).toContain("/api/spec-factory/compose/sessions");
    expect(urls).toContain("/api/spec-factory/compose/sessions/7/sources");
    expect(urls).toContain("/api/spec-factory/compose/sessions/7/messages");
    expect(urls).toContain("/api/spec-factory/compose/repositories");
    expect(sources[0].markdownContent).toBe("# Spec");
  });

  it("analyze posts selected repository IDs and postMessage accepts async turns", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true }, 202));
    const r1 = await api.analyze(7, [3, 5]);
    const r2 = await api.postMessage(7, "hello");
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/api/spec-factory/compose/sessions/7/analyze",
    );
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual(
      { repositoryIds: [3, 5], reset: false },
    );
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual(
      { content: "hello" },
    );
    const analyzeHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    const messageHeaders = vi.mocked(fetch).mock.calls[1][1]?.headers as Record<
      string,
      string
    >;
    expect(analyzeHeaders["Idempotency-Key"]).toMatch(
      /^[A-Za-z0-9._~+/-]{1,128}$/,
    );
    expect(messageHeaders["Idempotency-Key"]).toMatch(
      /^[A-Za-z0-9._~+/-]{1,128}$/,
    );
    expect(messageHeaders["Idempotency-Key"]).not.toBe(
      analyzeHeaders["Idempotency-Key"],
    );
  });

  it("analyze sends reset flag in the body (default false)", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true }));
    await api.analyze(7, [3], true);
    let [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      repositoryIds: [3],
      reset: true,
    });

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true }));
    await api.analyze(7, [3]);
    [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      repositoryIds: [3],
      reset: false,
    });
  });

  it("postMessage surfaces a readable error when the turn queue is full (429)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({ accepted: false, reason: "queue_full" }, 429),
    );
    await expect(api.postMessage(7, "too many")).rejects.toThrow(
      /too many|in progress|wait|queue/i,
    );
  });

  it("postMessage surfaces a readable error when durable workers are required", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({ accepted: false, reason: "durable_turn_required" }, 503),
    );
    await expect(api.postMessage(7, "hello")).rejects.toThrow(
      /durable turn workers|required|try again/i,
    );
  });

  it("postMessage translates an idempotency conflict into actionable copy", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      ok({ error: { message: "idempotency_key_reused" } }, 409),
    );

    await expect(api.postMessage(7, "core-app")).rejects.toThrow(
      "This reply conflicted with an earlier retry and was not submitted. Please send it again.",
    );
  });

  it("addJira and addConfluence POST source inputs", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true }, 202));

    await api.addJira(7, "CPDEV-123");
    await api.addConfluence(7, "https://wiki.example.com/x");

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("/api/spec-factory/compose/sessions/7/jira");
    expect(calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      jiraKey: "CPDEV-123",
    });
    expect(calls[1][0]).toBe("/api/spec-factory/compose/sessions/7/confluence");
    expect(calls[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
      url: "https://wiki.example.com/x",
    });
  });

  it("deleteSource DELETEs the session source", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({ id: 801, sessionId: 7, sourceId: 9, status: "undoable" }, 202),
    );

    await expect(api.deleteSource(7, 9)).resolves.toEqual(
      expect.objectContaining({ id: 801, status: "undoable" }),
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions/7/sources/9");
    expect(init?.method).toBe("DELETE");
  });

  it("lists and restores recoverable source deletions", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok([{ id: 801, sessionId: 7, sourceId: 9, status: "undoable" }]),
      )
      .mockResolvedValueOnce(
        ok({ id: 801, sessionId: 7, sourceId: 9, status: "restored" }, 202),
      );

    await api.listSourceDeletions(7, "tok-123");
    await api.restoreSource(7, 9, "tok-123");

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe(
      "/api/spec-factory/compose/sessions/7/source-deletions",
    );
    expect(calls[1][0]).toBe(
      "/api/spec-factory/compose/sessions/7/sources/9/restore",
    );
    expect(calls[1][1]?.method).toBe("POST");
    for (const [, init] of calls) {
      expect((init?.headers as Record<string, string>)["x-compose-token"]).toBe(
        "tok-123",
      );
    }
  });

  it("getSourcePreview fetches a source preview with the stream token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({
        url: "https://s3/get",
        mimeType: "image/png",
        filename: "screen.png",
      }),
    );

    const preview = await api.getSourcePreview(7, 9, "token-1");

    expect(preview.url).toBe("https://s3/get");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions/7/sources/9/preview");
    expect(init?.headers).toMatchObject({ "x-compose-token": "token-1" });
  });

  it("reconvert and reconvertFailed POST retry requests", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ queued: 2 }, 202));

    await api.reconvert(7, 9);
    const result = await api.reconvertFailed(7);

    expect(result).toEqual({ queued: 2 });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      "/api/spec-factory/compose/sessions/7/sources/9/reconvert",
    );
    expect(vi.mocked(fetch).mock.calls[0][1]?.method).toBe("POST");
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      "/api/spec-factory/compose/sessions/7/sources/reconvert-failed",
    );
    expect(vi.mocked(fetch).mock.calls[1][1]?.method).toBe("POST");
  });

  it("uploadFile requests a target, PUTs to S3 with Content-Type, then confirms", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok({
          sourceId: 9,
          uploadUrl: "https://s3/put",
          s3KeyRaw: "k",
          expiresInSeconds: 900,
        }),
      )
      .mockResolvedValueOnce(ok({}, 200))
      .mockResolvedValueOnce(ok({ accepted: true }, 202));
    const file = new File([new Uint8Array([1, 2, 3])], "spec.pdf", {
      type: "application/pdf",
    });
    const sourceId = await api.uploadFile(7, file);
    expect(sourceId).toBe(9);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("/api/spec-factory/compose/sessions/7/uploads");
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
    });
    expect(calls[1][0]).toBe("https://s3/put");
    expect((calls[1][1] as RequestInit)?.method).toBe("PUT");
    expect(
      ((calls[1][1] as RequestInit)?.headers as Record<string, string>)[
        "Content-Type"
      ],
    ).toBe("application/pdf");
    expect(calls[2][0]).toBe(
      "/api/spec-factory/compose/sessions/7/sources/9/uploaded",
    );
  });

  it("throws on non-OK json with error message", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ error: { message: "nope" } }, 500));
    await expect(api.analyze(7)).rejects.toThrow("nope");
  });

  it("listSources sends x-compose-token when a token is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(ok([]));
    await api.listSources(7, "tok-123");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions/7/sources");
    expect((init?.headers as Record<string, string>)["x-compose-token"]).toBe(
      "tok-123",
    );
  });

  it("listSources omits the token header when none is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(ok([]));
    await api.listSources(7);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(
      (init?.headers as Record<string, string>)["x-compose-token"],
    ).toBeUndefined();
  });

  it("sends x-compose-token on protected mutation helpers", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true, queued: 0 }));

    await api.addNote(7, "note", "tok-123");
    await api.addYoutube(7, "https://youtu.be/x", "tok-123");
    await api.addJira(7, "CPDEV-123", "tok-123");
    await api.addConfluence(7, "https://wiki.example.com/x", "tok-123");
    await api.deleteSource(7, 9, "tok-123");
    await api.restoreSource(7, 9, "tok-123");
    await api.reconvert(7, 9, "tok-123");
    await api.reconvertFailed(7, "tok-123");
    await api.analyze(7, [3], false, "tok-123");
    await api.postMessage(7, "hello", "tok-123");
    await api.handoff(7, "tok-123");

    for (const [, init] of vi.mocked(fetch).mock.calls) {
      expect((init?.headers as Record<string, string>)["x-compose-token"]).toBe(
        "tok-123",
      );
    }
  });

  it("uploadFile sends x-compose-token only to Compose request and confirm", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        ok({
          sourceId: 9,
          uploadUrl: "https://s3/put",
          s3KeyRaw: "k",
          expiresInSeconds: 900,
        }),
      )
      .mockResolvedValueOnce(ok({}, 200))
      .mockResolvedValueOnce(ok({ accepted: true }, 202));
    const file = new File([new Uint8Array([1, 2, 3])], "spec.pdf", {
      type: "application/pdf",
    });

    await api.uploadFile(7, file, "tok-123");

    const calls = vi.mocked(fetch).mock.calls;
    expect(
      (calls[0][1]?.headers as Record<string, string>)["x-compose-token"],
    ).toBe("tok-123");
    expect(
      (calls[1][1]?.headers as Record<string, string>)["x-compose-token"],
    ).toBeUndefined();
    expect(
      (calls[2][1]?.headers as Record<string, string>)["x-compose-token"],
    ).toBe("tok-123");
  });

  it("resumeSession surfaces the minted streamToken", async () => {
    vi.mocked(fetch).mockResolvedValue(
      ok({
        id: 7,
        name: "X",
        status: "draft",
        sourceId: null,
        readiness: null,
        sourceCount: 0,
        passwordProtected: true,
        createdAt: "t",
        updatedAt: "t",
        streamToken: "tok-abc",
      }),
    );
    const session = await api.resumeSession(7, "secret");
    expect(session.streamToken).toBe("tok-abc");
  });
});
