# Compose Sessions — Phase 3b: Dashboard UI (modal, workspace, sources, chat, preview, buttons) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the non-functional Compose mockup with a working operator UI: a New/Load Session modal, a three-panel workspace (Sources / Chat / Preview), live per-source conversion badges, an SSE-driven clarification chat, an **Analyze Sources** button, and a readiness-gated **Generate Draft → Send to Spec Board** button (with confetti + "Draft anyway").

**Architecture:** New React modules under `dashboard/src/spec-factory/compose/` — a typed API client + `EventSource` SSE hook + presigned-upload helper, and presentational/container components. `SpecFactoryPage` swaps its mockup `ComposeWorkspace()` for the new `<ComposeWorkspace />`. State is local React (`useState`/`useEffect`), matching the existing page; data comes from the Phase 1/2/3a backend endpoints. Tests use the existing jsdom + @testing-library/react harness with a mocked global `fetch` and a stubbed `EventSource`.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + @testing-library/react (jsdom), the existing `fetch`-based API style. No new runtime dependencies (confetti is a tiny self-contained DOM/CSS effect — YAGNI on `canvas-confetti`).

**Scope (3b — frontend only):** the Compose operator UI wired to the existing backend (Phase 1 sessions/handoff, Phase 2 uploads/sources/youtube/reconvert, Phase 3a analyze/messages/stream/readiness). **Depends on Phase 3a being merged** (the `/analyze`, `/messages`, `/stream` endpoints). **NOT in scope:** any backend change, audio/voxtral (Phase 4), the Spec Board / Development / Archive tabs (already built).

**Conventions (verified in the codebase):**
- Tests: jsdom via `// @vitest-environment jsdom` at the top of the test file; `render(<Comp/>)` + `screen`/`fireEvent`/`waitFor` from `@testing-library/react`; mock network with `vi.stubGlobal("fetch", vi.fn((url) => Promise.resolve(response(...))))` (see `dashboard/src/spec-factory/SpecFactoryPage.test.tsx`). Run: `npx vitest run src/spec-factory/<file>.test.tsx` from `dashboard/`. `dashboard` has its own `package.json` (`npm run test` = `vitest run`); `jsdom` is a devDependency there.
- API style: thin functions doing `fetch(url, init)` then `.json()`, throwing on `!response.ok` (see `dashboard/src/spec-factory/api.ts` `requestJson`). Routes are under `/api/spec-factory/...` (proxied in dev by `vite.config.ts`, ALB-routed in prod).
- Markdown rendering: reuse the existing `FormattedText` component in `SpecFactoryPage.tsx` (it renders markdown-ish text). Task 1 exports it from a shared module so Compose can import it without circular deps.
- The page's mockup `ComposeWorkspace()` (currently ~`SpecFactoryPage.tsx:849`) and `AddSourcesPanel()` (~`:760`) are self-contained local-state placeholders — they get deleted and replaced by an import of the new `<ComposeWorkspace />`.
- `SpecFactoryPage.tsx` is already ~1618 lines — put all new Compose UI in `dashboard/src/spec-factory/compose/` files, not in the page.
- `EventSource` does not exist in jsdom — tests stub it via `vi.stubGlobal("EventSource", FakeEventSource)`.

---

## Key design decisions (read before starting)

1. **New files, not page bloat.** All Compose UI lives in `dashboard/src/spec-factory/compose/`. `SpecFactoryPage` imports one `<ComposeWorkspace />`.
2. **Backend contract (already shipped in 3a/2/1):**
   - Sessions: `POST /compose/sessions` `{name, userName?}` → session; `GET /compose/sessions`; `GET /compose/sessions/:id`.
   - Sources: `GET /compose/sessions/:id/sources` → `ComposeSourceSummary[]` (with `conversionStatus`); `POST /compose/sessions/:id/uploads` `{filename, mimeType, sizeBytes}` → `{sourceId, uploadUrl, s3KeyRaw, expiresInSeconds}`; PUT to `uploadUrl` (S3) with the `Content-Type` header; `POST /compose/sessions/:id/sources/:sid/uploaded`; `POST /compose/sessions/:id/youtube` `{url}`; `POST /compose/sessions/:id/sources/:sid/reconvert`.
   - Clarify: `POST /compose/sessions/:id/analyze` → readiness; `POST /compose/sessions/:id/messages` `{content}` → readiness; `GET /compose/sessions/:id/messages` → messages; `GET /compose/sessions/:id/stream` (SSE: `status`/`message`/`readiness` events).
   - Handoff: `POST /compose/sessions/:id/handoff` → `{sourceId, session}`.
3. **SSE is the live view; polling is the fallback.** The chat subscribes to `/stream` via `EventSource`. On mount and on reconnect it also `GET`s `/messages` for the durable transcript. Source badges poll `GET /sources` every 3s while any source is `pending`/`converting` (mirrors the board's polling pattern).
4. **Readiness gates the button, not the action.** "Generate Draft" is highlighted (and fires confetti) when readiness `ready === true`, but is always clickable as **"Draft anyway"** — matching the design's override. Clicking calls the existing `/handoff`.
5. **Confetti is dependency-free.** A small component that renders ~40 absolutely-positioned CSS-animated divs for ~2s, then unmounts. No `canvas-confetti`.
6. **Upload `Content-Type`.** The browser PUT to the presigned URL MUST send `Content-Type` matching the `mimeType` sent to `/uploads` (the presigned URL signs ContentType) — else S3 returns 403.

---

## File Structure

**Create (all under `dashboard/src/spec-factory/compose/`):**
- `composeTypes.ts` — TS types for sessions, sources, messages, readiness, upload target, chat events.
- `composeApi.ts` — typed `fetch` client for all compose endpoints + the presigned-upload flow.
- `composeApi.test.ts`
- `useComposeStream.ts` — a hook wrapping `EventSource` for `/stream` (status/message/readiness).
- `useComposeStream.test.ts`
- `SessionModal.tsx` — New/Load Session overlay.
- `SessionModal.test.tsx`
- `SourcesPanel.tsx` — source list with live badges, add-file/note/youtube, reconvert, Analyze button.
- `SourcesPanel.test.tsx`
- `ChatPanel.tsx` — message list + input, driven by stream + send.
- `ChatPanel.test.tsx`
- `PreviewPanel.tsx` — readiness + open-questions + Generate-Draft button (+ "Draft anyway").
- `PreviewPanel.test.tsx`
- `Confetti.tsx` — dependency-free confetti burst.
- `ComposeWorkspace.tsx` — the container: modal → three-panel layout, owns session state + wires panels.
- `ComposeWorkspace.test.tsx`

**Modify:**
- `dashboard/src/spec-factory/SpecFactoryPage.tsx` — export `FormattedText` (Task 1); delete mockup `ComposeWorkspace()`/`AddSourcesPanel()`; import + render `<ComposeWorkspace />` for the compose tab.
- `dashboard/src/spec-factory/SpecFactoryPage.css` — append compose styles (badges, modal, confetti). (Append-only; do not restructure existing CSS.)

---

## Task 1: Export FormattedText for reuse

**Files:**
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.tsx`
- Create: `dashboard/src/spec-factory/compose/composeTypes.ts`
- Test: `dashboard/src/spec-factory/compose/composeTypes.test.ts`

This task makes `FormattedText` importable and lands the shared types.

- [ ] **Step 1: Write the failing test (types)**

Create `dashboard/src/spec-factory/compose/composeTypes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  ComposeSessionSummary,
  ComposeSourceSummary,
  ComposeChatMessage,
  ComposeReadiness,
  ComposeUploadTarget,
} from "./composeTypes.js";

describe("composeTypes", () => {
  it("shapes a session, source, message, readiness, and upload target", () => {
    const session: ComposeSessionSummary = {
      id: 1, name: "X", status: "draft", sourceId: null, readiness: null,
      sourceCount: 0, createdAt: "t", updatedAt: "t",
    };
    const source: ComposeSourceSummary = {
      id: 1, sessionId: 1, kind: "file", originalFilename: "a.pdf",
      conversionStatus: "pending", errorMessage: null,
    };
    const msg: ComposeChatMessage = { id: 1, sessionId: 1, role: "assistant", content: "hi", createdAt: "t" };
    const readiness: ComposeReadiness = { ready: false, openQuestions: ["q"], summary: "s" };
    const target: ComposeUploadTarget = { sourceId: 1, uploadUrl: "u", s3KeyRaw: "k", expiresInSeconds: 900 };
    expect(session.status).toBe("draft");
    expect(source.conversionStatus).toBe("pending");
    expect(msg.role).toBe("assistant");
    expect(readiness.ready).toBe(false);
    expect(target.sourceId).toBe(1);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run (from `dashboard/`): `npx vitest run src/spec-factory/compose/composeTypes.test.ts`

- [ ] **Step 3: Implement composeTypes.ts**

Create `dashboard/src/spec-factory/compose/composeTypes.ts`:

```ts
export type ComposeSessionStatus = "draft" | "ready" | "handed_off" | "archived";
export type ComposeSourceKind = "file" | "youtube" | "chat" | "note";
export type ComposeConversionStatus =
  | "awaiting_upload"
  | "pending"
  | "converting"
  | "converted"
  | "unsupported"
  | "failed";
export type ComposeMessageRole = "user" | "assistant" | "system";

export interface ComposeReadiness {
  ready: boolean;
  openQuestions: string[];
  summary: string;
}

export interface ComposeSessionSummary {
  id: number;
  name: string;
  status: ComposeSessionStatus;
  sourceId: number | null;
  readiness: ComposeReadiness | null;
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeSourceSummary {
  id: number;
  sessionId: number;
  kind: ComposeSourceKind;
  originalFilename: string | null;
  conversionStatus: ComposeConversionStatus;
  errorMessage: string | null;
}

export interface ComposeChatMessage {
  id: number;
  sessionId: number;
  role: ComposeMessageRole;
  content: string;
  createdAt: string;
}

export interface ComposeUploadTarget {
  sourceId: number;
  uploadUrl: string;
  s3KeyRaw: string;
  expiresInSeconds: number;
}

export type ComposeStreamEvent =
  | { type: "status"; status: "thinking" | "idle" | "error"; message?: string }
  | { type: "message"; role: ComposeMessageRole; content: string }
  | { type: "readiness"; readiness: ComposeReadiness };
```

> These mirror the backend read-models. `ComposeSourceSummary` here lists only the fields the UI consumes (the backend returns more, e.g. mimeType/s3KeyRaw — extra fields are fine, TS structural typing ignores them at the fetch boundary).

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/composeTypes.test.ts`

- [ ] **Step 5: Export FormattedText**

In `dashboard/src/spec-factory/SpecFactoryPage.tsx`, find `function FormattedText(` (~line 219) and add `export ` in front of it: `export function FormattedText(`. (No other change in this step.)

- [ ] **Step 6: Typecheck + commit**

Run (from `dashboard/`): `npx tsc --noEmit` (expect clean).

```bash
git add dashboard/src/spec-factory/compose/composeTypes.ts dashboard/src/spec-factory/compose/composeTypes.test.ts dashboard/src/spec-factory/SpecFactoryPage.tsx
git commit -m "feat(compose-ui): add compose UI types + export FormattedText"
```

---

## Task 2: composeApi client

**Files:**
- Create: `dashboard/src/spec-factory/compose/composeApi.ts`
- Test: `dashboard/src/spec-factory/compose/composeApi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/composeApi.test.ts`:

```ts
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
  it("createSession POSTs name+userName", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ id: 7, name: "X", status: "draft", sourceId: null, readiness: null, sourceCount: 0, createdAt: "t", updatedAt: "t" }));
    const s = await api.createSession({ name: "X", userName: "kk" });
    expect(s.id).toBe(7);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "X", userName: "kk" });
  });

  it("listSessions / getSession / listSources / listMessages GET the right urls", async () => {
    vi.mocked(fetch).mockResolvedValue(ok([]));
    await api.listSessions();
    await api.listSources(7);
    await api.listMessages(7);
    const urls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
    expect(urls).toContain("/api/spec-factory/compose/sessions");
    expect(urls).toContain("/api/spec-factory/compose/sessions/7/sources");
    expect(urls).toContain("/api/spec-factory/compose/sessions/7/messages");
  });

  it("analyze + postMessage return readiness", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ ready: false, openQuestions: ["q"], summary: "s" }));
    const r1 = await api.analyze(7);
    const r2 = await api.postMessage(7, "hello");
    expect(r1.ready).toBe(false);
    expect(r2.openQuestions).toEqual(["q"]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/spec-factory/compose/sessions/7/analyze");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body))).toEqual({ content: "hello" });
  });

  it("uploadFile requests a target, PUTs to S3 with Content-Type, then confirms", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(ok({ sourceId: 9, uploadUrl: "https://s3/put", s3KeyRaw: "k", expiresInSeconds: 900 })) // /uploads
      .mockResolvedValueOnce(ok({}, 200)) // S3 PUT
      .mockResolvedValueOnce(ok({ accepted: true }, 202)); // /uploaded
    const file = new File([new Uint8Array([1, 2, 3])], "spec.pdf", { type: "application/pdf" });
    const sourceId = await api.uploadFile(7, file);
    expect(sourceId).toBe(9);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("/api/spec-factory/compose/sessions/7/uploads");
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 3 });
    expect(calls[1][0]).toBe("https://s3/put");
    expect((calls[1][1] as RequestInit)?.method).toBe("PUT");
    expect(((calls[1][1] as RequestInit)?.headers as Record<string,string>)["Content-Type"]).toBe("application/pdf");
    expect(calls[2][0]).toBe("/api/spec-factory/compose/sessions/7/sources/9/uploaded");
  });

  it("throws on non-OK json with error message", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ error: { message: "nope" } }, 500));
    await expect(api.analyze(7)).rejects.toThrow("nope");
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/composeApi.test.ts`

- [ ] **Step 3: Implement composeApi.ts**

Create `dashboard/src/spec-factory/compose/composeApi.ts`:

```ts
import type {
  ComposeChatMessage,
  ComposeReadiness,
  ComposeSessionSummary,
  ComposeSourceSummary,
  ComposeUploadTarget,
} from "./composeTypes.js";

const BASE = "/api/spec-factory/compose";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : typeof body?.error?.message === "string"
          ? body.error.message
          : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function createSession(input: {
  name: string;
  userName?: string;
}): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(`${BASE}/sessions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listSessions(): Promise<ComposeSessionSummary[]> {
  return requestJson<ComposeSessionSummary[]>(`${BASE}/sessions`);
}

export function getSession(sessionId: number): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(`${BASE}/sessions/${sessionId}`);
}

export function listSources(
  sessionId: number,
): Promise<ComposeSourceSummary[]> {
  return requestJson<ComposeSourceSummary[]>(
    `${BASE}/sessions/${sessionId}/sources`,
  );
}

export function listMessages(
  sessionId: number,
): Promise<ComposeChatMessage[]> {
  return requestJson<ComposeChatMessage[]>(
    `${BASE}/sessions/${sessionId}/messages`,
  );
}

export function addNote(
  sessionId: number,
  content: string,
): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(
    `${BASE}/sessions/${sessionId}/notes`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
}

export function addYoutube(sessionId: number, url: string): Promise<unknown> {
  return requestJson(`${BASE}/sessions/${sessionId}/youtube`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function reconvert(
  sessionId: number,
  sourceId: number,
): Promise<unknown> {
  return requestJson(
    `${BASE}/sessions/${sessionId}/sources/${sourceId}/reconvert`,
    { method: "POST" },
  );
}

export function analyze(sessionId: number): Promise<ComposeReadiness> {
  return requestJson<ComposeReadiness>(
    `${BASE}/sessions/${sessionId}/analyze`,
    { method: "POST" },
  );
}

export function postMessage(
  sessionId: number,
  content: string,
): Promise<ComposeReadiness> {
  return requestJson<ComposeReadiness>(
    `${BASE}/sessions/${sessionId}/messages`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
}

export function handoff(
  sessionId: number,
): Promise<{ sourceId: number; session: ComposeSessionSummary }> {
  return requestJson(`${BASE}/sessions/${sessionId}/handoff`, {
    method: "POST",
  });
}

/** Presigned upload flow: request target -> PUT bytes to S3 -> confirm. Returns the sourceId. */
export async function uploadFile(
  sessionId: number,
  file: File,
): Promise<number> {
  const target = await requestJson<ComposeUploadTarget>(
    `${BASE}/sessions/${sessionId}/uploads`,
    {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    },
  );

  const put = await fetch(target.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Upload failed with ${put.status}`);
  }

  await requestJson(
    `${BASE}/sessions/${sessionId}/sources/${target.sourceId}/uploaded`,
    { method: "POST" },
  );
  return target.sourceId;
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/composeApi.test.ts`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/composeApi.ts dashboard/src/spec-factory/compose/composeApi.test.ts
git commit -m "feat(compose-ui): add composeApi client (sessions/sources/chat/upload)"
```

---

## Task 3: useComposeStream (SSE hook)

**Files:**
- Create: `dashboard/src/spec-factory/compose/useComposeStream.ts`
- Test: `dashboard/src/spec-factory/compose/useComposeStream.test.ts`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/useComposeStream.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useComposeStream } from "./useComposeStream.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners: Record<string, (ev: { data: string }) => void> = {};
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    this.listeners[type] = cb;
  }
  emit(type: string, data: unknown) {
    this.listeners[type]?.({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposeStream", () => {
  it("opens an EventSource for the session stream and reports events", () => {
    const onEvent = vi.fn();
    renderHook(() => useComposeStream(7, onEvent));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/spec-factory/compose/sessions/7/stream");

    act(() => {
      FakeEventSource.instances[0].emit("message", { type: "message", role: "assistant", content: "hi" });
      FakeEventSource.instances[0].emit("readiness", { type: "readiness", readiness: { ready: true, openQuestions: [], summary: "ok" } });
      FakeEventSource.instances[0].emit("status", { type: "status", status: "thinking" });
    });

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls[0][0]).toEqual({ type: "message", role: "assistant", content: "hi" });
    expect(onEvent.mock.calls[1][0].type).toBe("readiness");
    expect(onEvent.mock.calls[2][0].status).toBe("thinking");
  });

  it("does not open a stream when sessionId is null", () => {
    renderHook(() => useComposeStream(null, vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() => useComposeStream(7, vi.fn()));
    const es = FakeEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/useComposeStream.test.ts`

- [ ] **Step 3: Implement useComposeStream.ts**

Create `dashboard/src/spec-factory/compose/useComposeStream.ts`:

```ts
import { useEffect, useRef } from "react";
import type { ComposeStreamEvent } from "./composeTypes.js";

const EVENT_TYPES = ["status", "message", "readiness"] as const;

/**
 * Subscribe to a Compose session's SSE stream. Calls `onEvent` for each
 * status/message/readiness event. No-op when sessionId is null. The latest
 * onEvent is held in a ref so the EventSource is only re-created when the
 * session changes.
 */
export function useComposeStream(
  sessionId: number | null,
  onEvent: (event: ComposeStreamEvent) => void,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (sessionId === null) return;
    if (typeof EventSource === "undefined") return;

    const source = new EventSource(
      `/api/spec-factory/compose/sessions/${sessionId}/stream`,
    );
    const listeners: Array<[string, (ev: MessageEvent) => void]> = [];
    for (const type of EVENT_TYPES) {
      const listener = (ev: MessageEvent) => {
        try {
          handlerRef.current(JSON.parse(ev.data) as ComposeStreamEvent);
        } catch {
          // ignore malformed event payloads
        }
      };
      source.addEventListener(type, listener as EventListener);
      listeners.push([type, listener]);
    }

    return () => {
      for (const [type, listener] of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
    };
  }, [sessionId]);
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/useComposeStream.test.ts`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/useComposeStream.ts dashboard/src/spec-factory/compose/useComposeStream.test.ts
git commit -m "feat(compose-ui): add useComposeStream SSE hook"
```

---

## Task 4: SessionModal (New / Load)

**Files:**
- Create: `dashboard/src/spec-factory/compose/SessionModal.tsx`
- Test: `dashboard/src/spec-factory/compose/SessionModal.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/SessionModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionModal } from "./SessionModal.js";

const sessions = [
  { id: 1, name: "Billing export", status: "draft" as const, sourceId: null, readiness: null, sourceCount: 2, createdAt: "t", updatedAt: "t" },
];

describe("SessionModal", () => {
  it("creates a new session with the entered name", () => {
    const onCreate = vi.fn();
    render(<SessionModal sessions={[]} onCreate={onCreate} onLoad={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), { target: { value: "My idea" } });
    fireEvent.change(screen.getByLabelText(/Your name/i), { target: { value: "kk" } });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    expect(onCreate).toHaveBeenCalledWith({ name: "My idea", userName: "kk" });
  });

  it("disables create when the name is blank", () => {
    render(<SessionModal sessions={[]} onCreate={vi.fn()} onLoad={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /New Session/i }));
    expect((screen.getByRole("button", { name: /Create session/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists existing sessions and loads one", () => {
    const onLoad = vi.fn();
    render(<SessionModal sessions={sessions} onCreate={vi.fn()} onLoad={onLoad} />);
    fireEvent.click(screen.getByRole("button", { name: /Load Session/i }));
    fireEvent.click(screen.getByRole("button", { name: /Billing export/i }));
    expect(onLoad).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/SessionModal.test.tsx`

- [ ] **Step 3: Implement SessionModal.tsx**

Create `dashboard/src/spec-factory/compose/SessionModal.tsx`:

```tsx
import { useState } from "react";
import type { ComposeSessionSummary } from "./composeTypes.js";

type Mode = "choose" | "new" | "load";

export function SessionModal({
  sessions,
  onCreate,
  onLoad,
}: {
  sessions: ComposeSessionSummary[];
  onCreate: (input: { name: string; userName?: string }) => void;
  onLoad: (sessionId: number) => void;
}) {
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [userName, setUserName] = useState("");

  return (
    <div className="sf-modal-backdrop">
      <div className="sf-compose-session-modal" role="dialog" aria-modal="true" aria-label="Compose session">
        {mode === "choose" ? (
          <div className="sf-compose-modal-choose">
            <h2>Compose</h2>
            <p>Start a new brainstorming session or continue an existing one.</p>
            <div className="sf-compose-modal-actions">
              <button type="button" onClick={() => setMode("new")}>New Session</button>
              <button type="button" onClick={() => setMode("load")}>Load Session</button>
            </div>
          </div>
        ) : null}

        {mode === "new" ? (
          <form
            className="sf-compose-modal-new"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              onCreate({ name: trimmed, userName: userName.trim() || undefined });
            }}
          >
            <h2>New Session</h2>
            <label>
              Session name
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <label>
              Your name (optional)
              <input value={userName} onChange={(e) => setUserName(e.target.value)} />
            </label>
            <div className="sf-compose-modal-actions">
              <button type="button" onClick={() => setMode("choose")}>Back</button>
              <button type="submit" disabled={name.trim().length === 0}>Create session</button>
            </div>
          </form>
        ) : null}

        {mode === "load" ? (
          <div className="sf-compose-modal-load">
            <h2>Load Session</h2>
            {sessions.length === 0 ? (
              <p>No sessions yet.</p>
            ) : (
              <ul className="sf-compose-session-list">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => onLoad(s.id)}>
                      <strong>{s.name}</strong>
                      <span>{s.status} · {s.sourceCount} sources</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="sf-compose-modal-actions">
              <button type="button" onClick={() => setMode("choose")}>Back</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/SessionModal.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/SessionModal.tsx dashboard/src/spec-factory/compose/SessionModal.test.tsx
git commit -m "feat(compose-ui): add SessionModal (New/Load)"
```

---

## Task 5: SourcesPanel (badges + add + reconvert + Analyze)

**Files:**
- Create: `dashboard/src/spec-factory/compose/SourcesPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/SourcesPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/SourcesPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SourcesPanel } from "./SourcesPanel.js";
import type { ComposeSourceSummary } from "./composeTypes.js";

const sources: ComposeSourceSummary[] = [
  { id: 1, sessionId: 7, kind: "file", originalFilename: "spec.pdf", conversionStatus: "converted", errorMessage: null },
  { id: 2, sessionId: 7, kind: "file", originalFilename: "big.zip", conversionStatus: "converting", errorMessage: null },
  { id: 3, sessionId: 7, kind: "youtube", originalFilename: "https://youtu.be/x", conversionStatus: "failed", errorMessage: "boom" },
];

function noop() {}

describe("SourcesPanel", () => {
  it("renders each source with its status badge", () => {
    render(<SourcesPanel sources={sources} onAddNote={noop} onAddYoutube={noop} onUploadFiles={noop} onReconvert={noop} onAnalyze={noop} analyzing={false} />);
    expect(screen.getByText("spec.pdf")).toBeTruthy();
    expect(screen.getByText(/converted/i)).toBeTruthy();
    expect(screen.getByText(/converting/i)).toBeTruthy();
    expect(screen.getByText(/failed/i)).toBeTruthy();
  });

  it("shows a Retry button only on failed/unsupported sources and calls onReconvert", () => {
    const onReconvert = vi.fn();
    render(<SourcesPanel sources={sources} onAddNote={noop} onAddYoutube={noop} onUploadFiles={noop} onReconvert={onReconvert} onAnalyze={noop} analyzing={false} />);
    const retry = screen.getByRole("button", { name: /Retry/i });
    fireEvent.click(retry);
    expect(onReconvert).toHaveBeenCalledWith(3);
  });

  it("adds a note", () => {
    const onAddNote = vi.fn();
    render(<SourcesPanel sources={[]} onAddNote={onAddNote} onAddYoutube={noop} onUploadFiles={noop} onReconvert={noop} onAnalyze={noop} analyzing={false} />);
    fireEvent.change(screen.getByLabelText(/Add a note/i), { target: { value: "Repo is billing-service" } });
    fireEvent.click(screen.getByRole("button", { name: /Add note/i }));
    expect(onAddNote).toHaveBeenCalledWith("Repo is billing-service");
  });

  it("adds a youtube url", () => {
    const onAddYoutube = vi.fn();
    render(<SourcesPanel sources={[]} onAddNote={noop} onAddYoutube={onAddYoutube} onUploadFiles={noop} onReconvert={noop} onAnalyze={noop} analyzing={false} />);
    fireEvent.change(screen.getByLabelText(/YouTube URL/i), { target: { value: "https://youtu.be/x" } });
    fireEvent.click(screen.getByRole("button", { name: /Add URL/i }));
    expect(onAddYoutube).toHaveBeenCalledWith("https://youtu.be/x");
  });

  it("Analyze Sources is disabled while analyzing and calls onAnalyze otherwise", () => {
    const onAnalyze = vi.fn();
    const { rerender } = render(<SourcesPanel sources={sources} onAddNote={noop} onAddYoutube={noop} onUploadFiles={noop} onReconvert={noop} onAnalyze={onAnalyze} analyzing={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze Sources/i }));
    expect(onAnalyze).toHaveBeenCalled();
    rerender(<SourcesPanel sources={sources} onAddNote={noop} onAddYoutube={noop} onUploadFiles={noop} onReconvert={noop} onAnalyze={onAnalyze} analyzing={true} />);
    expect((screen.getByRole("button", { name: /Analyzing/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/SourcesPanel.test.tsx`

- [ ] **Step 3: Implement SourcesPanel.tsx**

Create `dashboard/src/spec-factory/compose/SourcesPanel.tsx`:

```tsx
import { useRef, useState } from "react";
import type {
  ComposeConversionStatus,
  ComposeSourceSummary,
} from "./composeTypes.js";

const BADGE_LABEL: Record<ComposeConversionStatus, string> = {
  awaiting_upload: "uploading…",
  pending: "queued",
  converting: "converting…",
  converted: "converted",
  unsupported: "unsupported",
  failed: "failed",
};

function isRetryable(status: ComposeConversionStatus): boolean {
  return status === "failed" || status === "unsupported";
}

export function SourcesPanel({
  sources,
  onAddNote,
  onAddYoutube,
  onUploadFiles,
  onReconvert,
  onAnalyze,
  analyzing,
}: {
  sources: ComposeSourceSummary[];
  onAddNote: (content: string) => void;
  onAddYoutube: (url: string) => void;
  onUploadFiles: (files: File[]) => void;
  onReconvert: (sourceId: number) => void;
  onAnalyze: () => void;
  analyzing: boolean;
}) {
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <section className="sf-compose-panel sf-sources-panel" aria-label="Sources">
      <header className="sf-sources-header">
        <h1>Sources</h1>
        <button
          type="button"
          className="sf-button sf-button-primary sf-button-compact"
          onClick={onAnalyze}
          disabled={analyzing || sources.length === 0}
        >
          {analyzing ? "Analyzing…" : "Analyze Sources"}
        </button>
      </header>

      <div className="sf-source-add-row">
        <button type="button" onClick={() => fileInput.current?.click()}>
          Add files
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          aria-label="Upload files"
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) onUploadFiles(files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="sf-source-add-note">
        <label htmlFor="sf-add-note">Add a note</label>
        <textarea
          id="sf-add-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Paste notes, ideas, or directions…"
        />
        <button
          type="button"
          disabled={note.trim().length === 0}
          onClick={() => {
            onAddNote(note.trim());
            setNote("");
          }}
        >
          Add note
        </button>
      </div>

      <div className="sf-source-add-youtube">
        <label htmlFor="sf-add-youtube">YouTube URL</label>
        <input
          id="sf-add-youtube"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://youtu.be/…"
        />
        <button
          type="button"
          disabled={url.trim().length === 0}
          onClick={() => {
            onAddYoutube(url.trim());
            setUrl("");
          }}
        >
          Add URL
        </button>
      </div>

      <ul className="sf-compose-source-list">
        {sources.map((source) => (
          <li key={source.id} className={`sf-compose-source is-${source.conversionStatus}`}>
            <span className="sf-compose-source-name">
              {source.originalFilename ?? `source-${source.id}`}
            </span>
            <span className={`sf-compose-badge is-${source.conversionStatus}`}>
              {BADGE_LABEL[source.conversionStatus]}
            </span>
            {source.errorMessage ? (
              <span className="sf-compose-source-error">{source.errorMessage}</span>
            ) : null}
            {isRetryable(source.conversionStatus) ? (
              <button type="button" onClick={() => onReconvert(source.id)}>
                Retry
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/SourcesPanel.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/SourcesPanel.tsx dashboard/src/spec-factory/compose/SourcesPanel.test.tsx
git commit -m "feat(compose-ui): add SourcesPanel (badges, add note/youtube/file, retry, analyze)"
```

---

## Task 6: ChatPanel

**Files:**
- Create: `dashboard/src/spec-factory/compose/ChatPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel.js";
import type { ComposeChatMessage } from "./composeTypes.js";

const messages: ComposeChatMessage[] = [
  { id: 1, sessionId: 7, role: "assistant", content: "Which repository is this for?", createdAt: "t" },
  { id: 2, sessionId: 7, role: "user", content: "billing-service", createdAt: "t" },
];

describe("ChatPanel", () => {
  it("renders messages by role", () => {
    render(<ChatPanel messages={messages} onSend={vi.fn()} thinking={false} />);
    expect(screen.getByText("Which repository is this for?")).toBeTruthy();
    expect(screen.getByText("billing-service")).toBeTruthy();
  });

  it("sends a message and clears the input", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={messages} onSend={onSend} thinking={false} />);
    const input = screen.getByLabelText(/Message/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "It's billing-service" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));
    expect(onSend).toHaveBeenCalledWith("It's billing-service");
    expect(input.value).toBe("");
  });

  it("disables send while thinking and shows a thinking indicator", () => {
    render(<ChatPanel messages={messages} onSend={vi.fn()} thinking={true} />);
    expect((screen.getByRole("button", { name: /Send/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });

  it("does not send a blank message", () => {
    const onSend = vi.fn();
    render(<ChatPanel messages={messages} onSend={onSend} thinking={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`

- [ ] **Step 3: Implement ChatPanel.tsx**

Create `dashboard/src/spec-factory/compose/ChatPanel.tsx`:

```tsx
import { useState } from "react";
import { FormattedText } from "../SpecFactoryPage.js";
import type { ComposeChatMessage } from "./composeTypes.js";

export function ChatPanel({
  messages,
  onSend,
  thinking,
}: {
  messages: ComposeChatMessage[];
  onSend: (content: string) => void;
  thinking: boolean;
}) {
  const [input, setInput] = useState("");

  function send() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  return (
    <section className="sf-compose-panel sf-chat-panel" aria-label="Clarification chat">
      <div className="sf-chat-window" aria-label="Compose conversation">
        {messages
          .filter((m) => m.role !== "system")
          .map((m) => (
            <div key={m.id} className={`sf-chat-msg is-${m.role}`}>
              <FormattedText text={m.content} />
            </div>
          ))}
        {thinking ? (
          <div className="sf-chat-msg is-assistant sf-chat-thinking" aria-live="polite">
            <em>Assistant is thinking…</em>
          </div>
        ) : null}
      </div>
      <div className="sf-chat-dock">
        <textarea
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Answer the assistant or add new direction…"
        />
        <button
          type="button"
          className="sf-chat-send"
          onClick={send}
          disabled={thinking || input.trim().length === 0}
        >
          Send
        </button>
      </div>
    </section>
  );
}
```

> The `import { FormattedText } from "../SpecFactoryPage.js"` relies on Task 1 having exported it. Importing a single function from the page module does not pull in the page's runtime side effects (it's a named export).

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx
git commit -m "feat(compose-ui): add ChatPanel (message list + send + thinking)"
```

---

## Task 7: Confetti + PreviewPanel (readiness + Generate Draft)

**Files:**
- Create: `dashboard/src/spec-factory/compose/Confetti.tsx`
- Create: `dashboard/src/spec-factory/compose/PreviewPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PreviewPanel } from "./PreviewPanel.js";

describe("PreviewPanel", () => {
  it("shows open questions and a summary when not ready", () => {
    render(<PreviewPanel readiness={{ ready: false, openQuestions: ["Which repo?", "What scope?"], summary: "Need more info." }} handingOff={false} onGenerate={vi.fn()} />);
    expect(screen.getByText("Need more info.")).toBeTruthy();
    expect(screen.getByText("Which repo?")).toBeTruthy();
    expect(screen.getByText("What scope?")).toBeTruthy();
  });

  it("labels the button 'Draft anyway' when not ready, 'Generate Draft' when ready", () => {
    const { rerender } = render(<PreviewPanel readiness={{ ready: false, openQuestions: ["q"], summary: "s" }} handingOff={false} onGenerate={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Draft anyway/i })).toBeTruthy();
    rerender(<PreviewPanel readiness={{ ready: true, openQuestions: [], summary: "Ready." }} handingOff={false} onGenerate={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Generate Draft/i })).toBeTruthy();
  });

  it("calls onGenerate when clicked and disables while handing off", () => {
    const onGenerate = vi.fn();
    const { rerender } = render(<PreviewPanel readiness={{ ready: true, openQuestions: [], summary: "Ready." }} handingOff={false} onGenerate={onGenerate} />);
    fireEvent.click(screen.getByRole("button", { name: /Generate Draft/i }));
    expect(onGenerate).toHaveBeenCalled();
    rerender(<PreviewPanel readiness={{ ready: true, openQuestions: [], summary: "Ready." }} handingOff={true} onGenerate={onGenerate} />);
    expect((screen.getByRole("button", { name: /Sending|Generate Draft/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders confetti only when ready", () => {
    const { rerender, container } = render(<PreviewPanel readiness={{ ready: false, openQuestions: [], summary: "" }} handingOff={false} onGenerate={vi.fn()} />);
    expect(container.querySelector(".sf-confetti")).toBeNull();
    rerender(<PreviewPanel readiness={{ ready: true, openQuestions: [], summary: "ok" }} handingOff={false} onGenerate={vi.fn()} />);
    expect(container.querySelector(".sf-confetti")).not.toBeNull();
  });

  it("shows an empty state when readiness is null", () => {
    render(<PreviewPanel readiness={null} handingOff={false} onGenerate={vi.fn()} />);
    expect(screen.getByText(/Analyze Sources/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`

- [ ] **Step 3: Implement Confetti.tsx**

Create `dashboard/src/spec-factory/compose/Confetti.tsx`:

```tsx
import { useEffect, useState } from "react";

const COLORS = ["#7c5cff", "#22c55e", "#f59e0b", "#ef4444", "#3b82f6"];

/** Dependency-free confetti burst: ~40 CSS-animated pieces for ~2s. */
export function Confetti({ pieces = 40 }: { pieces?: number }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="sf-confetti" aria-hidden="true">
      {Array.from({ length: pieces }).map((_, i) => (
        <span
          key={i}
          className="sf-confetti-piece"
          style={{
            left: `${(i / pieces) * 100}%`,
            background: COLORS[i % COLORS.length],
            animationDelay: `${(i % 10) * 0.06}s`,
          }}
        />
      ))}
    </div>
  );
}
```

> Determinism: positions/delays are derived from the index (no `Math.random()`), so the render is stable and test-friendly.

- [ ] **Step 4: Implement PreviewPanel.tsx**

Create `dashboard/src/spec-factory/compose/PreviewPanel.tsx`:

```tsx
import { Confetti } from "./Confetti.js";
import type { ComposeReadiness } from "./composeTypes.js";

export function PreviewPanel({
  readiness,
  handingOff,
  onGenerate,
}: {
  readiness: ComposeReadiness | null;
  handingOff: boolean;
  onGenerate: () => void;
}) {
  if (!readiness) {
    return (
      <section className="sf-compose-panel sf-preview-panel" aria-label="Readiness">
        <header><h1>Preview</h1></header>
        <p className="sf-compose-empty">
          Add sources, then click <strong>Analyze Sources</strong> to start.
        </p>
      </section>
    );
  }

  return (
    <section className="sf-compose-panel sf-preview-panel" aria-label="Readiness">
      <header><h1>Preview</h1></header>
      {readiness.ready ? <Confetti /> : null}

      <article className="sf-preview-note">
        <span className="sf-section-label">{readiness.ready ? "Ready for preview" : "Open questions"}</span>
        <p>{readiness.summary}</p>
      </article>

      {readiness.openQuestions.length > 0 ? (
        <ul className="sf-compose-open-questions">
          {readiness.openQuestions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        className={`sf-button sf-button-primary ${readiness.ready ? "is-ready" : ""}`}
        onClick={onGenerate}
        disabled={handingOff}
      >
        {handingOff ? "Sending…" : readiness.ready ? "Generate Draft → Send to Spec Board" : "Draft anyway"}
      </button>
    </section>
  );
}
```

- [ ] **Step 5: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/spec-factory/compose/Confetti.tsx dashboard/src/spec-factory/compose/PreviewPanel.tsx dashboard/src/spec-factory/compose/PreviewPanel.test.tsx
git commit -m "feat(compose-ui): add PreviewPanel (readiness + Generate Draft) + Confetti"
```

---

## Task 8: ComposeWorkspace container (wire it all)

**Files:**
- Create: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`
- Test: `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ComposeWorkspace } from "./ComposeWorkspace.js";

function ok(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, (ev: { data: string }) => void> = {};
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(t: string, cb: (ev: { data: string }) => void) { this.listeners[t] = cb; }
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as never);
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/compose/sessions") && init?.method === "POST")
      return Promise.resolve(ok({ id: 7, name: "Idea", status: "draft", sourceId: null, readiness: null, sourceCount: 0, createdAt: "t", updatedAt: "t" }));
    if (url.endsWith("/compose/sessions")) return Promise.resolve(ok([]));
    if (url.endsWith("/sessions/7/sources")) return Promise.resolve(ok([]));
    if (url.endsWith("/sessions/7/messages")) return Promise.resolve(ok([]));
    if (url.endsWith("/sessions/7/notes")) return Promise.resolve(ok({ id: 7, name: "Idea", status: "draft", sourceId: null, readiness: null, sourceCount: 1, createdAt: "t", updatedAt: "t" }));
    if (url.endsWith("/sessions/7/analyze")) return Promise.resolve(ok({ ready: false, openQuestions: ["Which repo?"], summary: "Need repo." }));
    return Promise.resolve(ok({}));
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("ComposeWorkspace", () => {
  it("creates a session from the modal then shows the three panels", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), { target: { value: "Idea" } });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    await screen.findByRole("region", { name: "Sources" });
    expect(screen.getByRole("region", { name: "Clarification chat" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Readiness" })).toBeTruthy();
  });

  it("runs Analyze and surfaces readiness open questions", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), { target: { value: "Idea" } });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });

    // add a note so Analyze is enabled
    fireEvent.change(screen.getByLabelText(/Add a note/i), { target: { value: "Repo is billing-service" } });
    fireEvent.click(screen.getByRole("button", { name: /Add note/i }));

    // sources list re-fetch returns the note; force Analyze
    fireEvent.click(await screen.findByRole("button", { name: /Analyze Sources/i }));
    await waitFor(() => expect(screen.getByText("Which repo?")).toBeTruthy());
  });
});
```

> If the "Analyze enabled" gating depends on `sources.length > 0`, the second test's `/sessions/7/sources` mock should return a note source after add. Adjust the mock so that after the note POST, the next `GET /sources` returns one `converted` source — use a module-level counter in the test's fetch mock (a `let added = false;` flipped in the notes branch, then branch the sources response on it). Keep the test deterministic.

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx`

- [ ] **Step 3: Implement ComposeWorkspace.tsx**

Create `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import * as composeApi from "./composeApi.js";
import { useComposeStream } from "./useComposeStream.js";
import { SessionModal } from "./SessionModal.js";
import { SourcesPanel } from "./SourcesPanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { PreviewPanel } from "./PreviewPanel.js";
import type {
  ComposeChatMessage,
  ComposeReadiness,
  ComposeSessionSummary,
  ComposeSourceSummary,
  ComposeStreamEvent,
} from "./composeTypes.js";

const SOURCE_POLL_MS = 3000;

export function ComposeWorkspace() {
  const [sessions, setSessions] = useState<ComposeSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sources, setSources] = useState<ComposeSourceSummary[]>([]);
  const [messages, setMessages] = useState<ComposeChatMessage[]>([]);
  const [readiness, setReadiness] = useState<ComposeReadiness | null>(null);
  const [thinking, setThinking] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    composeApi.listSessions().then(setSessions).catch(() => undefined);
  }, []);

  const refreshSources = useCallback(async (id: number) => {
    try {
      setSources(await composeApi.listSources(id));
    } catch {
      /* keep last */
    }
  }, []);

  const refreshMessages = useCallback(async (id: number) => {
    try {
      setMessages(await composeApi.listMessages(id));
    } catch {
      /* keep last */
    }
  }, []);

  // poll sources while any are in-flight
  useEffect(() => {
    if (sessionId === null) return;
    const anyInFlight = sources.some(
      (s) => s.conversionStatus === "pending" || s.conversionStatus === "converting",
    );
    if (!anyInFlight) return;
    const t = setInterval(() => void refreshSources(sessionId), SOURCE_POLL_MS);
    return () => clearInterval(t);
  }, [sessionId, sources, refreshSources]);

  const onStreamEvent = useCallback(
    (event: ComposeStreamEvent) => {
      if (event.type === "status") {
        setThinking(event.status === "thinking");
        if (event.status === "error" && event.message) setError(event.message);
      } else if (event.type === "message") {
        if (sessionId !== null) void refreshMessages(sessionId);
      } else if (event.type === "readiness") {
        setReadiness(event.readiness);
      }
    },
    [sessionId, refreshMessages],
  );
  useComposeStream(sessionId, onStreamEvent);

  const openSession = useCallback(
    async (id: number) => {
      setSessionId(id);
      setError(null);
      const session = await composeApi.getSession(id).catch(() => null);
      setReadiness(session?.readiness ?? null);
      await Promise.all([refreshSources(id), refreshMessages(id)]);
    },
    [refreshSources, refreshMessages],
  );

  const handleCreate = useCallback(
    async (input: { name: string; userName?: string }) => {
      try {
        const session = await composeApi.createSession(input);
        setSessions((prev) => [session, ...prev]);
        await openSession(session.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create session");
      }
    },
    [openSession],
  );

  const guarded = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        setError(null);
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed");
      }
    },
    [],
  );

  if (sessionId === null) {
    return (
      <section className="sf-workspace sf-compose" aria-label="Compose workspace">
        <SessionModal sessions={sessions} onCreate={handleCreate} onLoad={openSession} />
      </section>
    );
  }

  return (
    <section className="sf-workspace sf-compose" aria-label="Compose workspace">
      {error ? <div className="sf-compose-error" role="alert">{error}</div> : null}
      <SourcesPanel
        sources={sources}
        analyzing={analyzing}
        onAddNote={(content) =>
          guarded(async () => {
            await composeApi.addNote(sessionId, content);
            await refreshSources(sessionId);
          })
        }
        onAddYoutube={(url) =>
          guarded(async () => {
            await composeApi.addYoutube(sessionId, url);
            await refreshSources(sessionId);
          })
        }
        onUploadFiles={(files) =>
          guarded(async () => {
            for (const file of files) await composeApi.uploadFile(sessionId, file);
            await refreshSources(sessionId);
          })
        }
        onReconvert={(sourceId) =>
          guarded(async () => {
            await composeApi.reconvert(sessionId, sourceId);
            await refreshSources(sessionId);
          })
        }
        onAnalyze={() =>
          guarded(async () => {
            setAnalyzing(true);
            try {
              const r = await composeApi.analyze(sessionId);
              setReadiness(r);
              await refreshMessages(sessionId);
            } finally {
              setAnalyzing(false);
            }
          })
        }
      />
      <ChatPanel
        messages={messages}
        thinking={thinking}
        onSend={(content) =>
          guarded(async () => {
            // optimistic: the SSE stream + refetch will reconcile
            const r = await composeApi.postMessage(sessionId, content);
            setReadiness(r);
            await refreshMessages(sessionId);
          })
        }
      />
      <PreviewPanel
        readiness={readiness}
        handingOff={handingOff}
        onGenerate={() =>
          guarded(async () => {
            setHandingOff(true);
            try {
              await composeApi.handoff(sessionId);
              setError(null);
            } finally {
              setHandingOff(false);
            }
          })
        }
      />
    </section>
  );
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ComposeWorkspace.tsx dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx
git commit -m "feat(compose-ui): add ComposeWorkspace container wiring all panels"
```

---

## Task 9: Swap the mockup in SpecFactoryPage + styles

**Files:**
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.tsx`
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css`
- Test: `dashboard/src/spec-factory/SpecFactoryPage.test.tsx` (extend)

- [ ] **Step 1: Write the failing test (page renders the new modal on the compose tab)**

In `SpecFactoryPage.test.tsx`, add (the page defaults to the compose tab on load). First add a `/compose/sessions` branch to the existing `beforeEach` fetch mock so the new workspace's `listSessions()` resolves:

```ts
      if (url.endsWith("/compose/sessions")) {
        return Promise.resolve(response([]));
      }
```

(place it before the final fallback `return Promise.resolve(response(candidatePayload));`). Then add a test:

```ts
it("shows the Compose session modal on the compose tab", async () => {
  render(<SpecFactoryPage />);
  // compose is the default tab
  expect(
    await screen.findByRole("dialog", { name: /Compose session/i }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: /New Session/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Load Session/i })).toBeTruthy();
});
```

- [ ] **Step 2: Run; verify FAIL**

Run (from `dashboard/`): `npx vitest run src/spec-factory/SpecFactoryPage.test.tsx`
Expected: FAIL — the old mockup has no `dialog` named "Compose session".

- [ ] **Step 3: Swap the component**

In `dashboard/src/spec-factory/SpecFactoryPage.tsx`:
(a) Add the import at the top (with the other imports): `import { ComposeWorkspace } from "./compose/ComposeWorkspace.js";`
(b) DELETE the mockup `function ComposeWorkspace() { ... }` (~line 849) and the mockup `function AddSourcesPanel(...) { ... }` (~line 760) entirely. (They are only used by each other and the compose tab render.)
(c) Find where the page renders the compose tab — `{tab === "compose" ? (` (~line 1576) — and ensure its body is `<ComposeWorkspace />` (the imported one). Since the imported component has the same name, the JSX `<ComposeWorkspace />` now resolves to the import. Confirm no other references to the deleted `AddSourcesPanel` remain (grep).

- [ ] **Step 4: Append styles**

Append to `dashboard/src/spec-factory/SpecFactoryPage.css` (do not edit existing rules):

```css
/* ── Compose Phase 3b ───────────────────────────────────────── */
.sf-compose-session-modal {
  background: var(--sf-panel, #14141c);
  border-radius: 16px;
  padding: 28px;
  max-width: 460px;
  width: 92%;
  color: inherit;
}
.sf-compose-modal-actions { display: flex; gap: 12px; margin-top: 20px; }
.sf-compose-session-list { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 8px; }
.sf-compose-session-list button { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: 10px; }
.sf-compose-source-list { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 8px; }
.sf-compose-source { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.03); }
.sf-compose-source-name { font-weight: 600; flex: 1 1 auto; word-break: break-word; }
.sf-compose-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; }
.sf-compose-badge.is-converted { background: rgba(34,197,94,.18); color: #4ade80; }
.sf-compose-badge.is-converting, .sf-compose-badge.is-pending, .sf-compose-badge.is-awaiting_upload { background: rgba(245,158,11,.18); color: #fbbf24; }
.sf-compose-badge.is-failed, .sf-compose-badge.is-unsupported { background: rgba(239,68,68,.18); color: #f87171; }
.sf-compose-source-error { flex-basis: 100%; font-size: 12px; color: #f87171; }
.sf-compose-open-questions { margin: 8px 0; padding-left: 18px; display: grid; gap: 4px; }
.sf-compose-error { background: rgba(239,68,68,.15); color: #f87171; padding: 8px 12px; border-radius: 8px; margin-bottom: 8px; }
.sf-button-primary.is-ready { box-shadow: 0 0 0 2px rgba(124,92,255,.5); }
.sf-confetti { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.sf-confetti-piece { position: absolute; top: -10px; width: 8px; height: 14px; border-radius: 2px; animation: sf-confetti-fall 2s linear forwards; }
@keyframes sf-confetti-fall {
  0% { transform: translateY(-10px) rotate(0deg); opacity: 1; }
  100% { transform: translateY(420px) rotate(360deg); opacity: 0; }
}
.sf-preview-panel { position: relative; }
```

- [ ] **Step 5: Run; verify PASS + full page suite**

Run: `npx vitest run src/spec-factory/SpecFactoryPage.test.tsx` (the new test passes; the existing Spec Board / Archive / OneShot tests still pass — they click into other tabs and are unaffected by the compose swap).
Run: `npx tsc --noEmit` (clean). Confirm no dangling `AddSourcesPanel` reference: `grep -rn "AddSourcesPanel" src/` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/spec-factory/SpecFactoryPage.tsx dashboard/src/spec-factory/SpecFactoryPage.css dashboard/src/spec-factory/SpecFactoryPage.test.tsx
git commit -m "feat(compose-ui): replace Compose mockup with live ComposeWorkspace + styles"
```

---

## Task 10: Full suite + completion notes

**Files:**
- Create: `docs/superpowers/plans/2026-06-02-compose-sessions-phase-3b-COMPLETION.md`

- [ ] **Step 1: Full dashboard test run + typecheck**

Run (from `dashboard/`): `npm run test` (the whole dashboard suite — all compose + existing tests pass) and `npx tsc --noEmit` (clean). Record counts.

- [ ] **Step 2: Build the dashboard bundle**

Run (from `dashboard/`): `npm run build` (Vite build succeeds — catches any import/type error the unit tests miss).

- [ ] **Step 3: Write completion notes**

Create the completion doc covering: what shipped (modal, three panels, badges, SSE chat, Analyze, readiness-gated Generate Draft + confetti + Draft-anyway), test/build results, the manual verification path (below), the dependency on Phase 3a, and any deferred polish (e.g. drag-drop file upload, source preview, optimistic chat echo).

Manual verification (requires Phases 1/2/3a deployed + the dashboard running against them):

```
1. Open the dashboard → Compose tab → "New Session" → name it → Create.
2. Add a note ("Repo is billing-service. Add CSV export.") and/or upload a PDF → badge goes converting → converted.
3. Click "Analyze Sources" → an assistant message appears in chat with open questions; Preview shows the summary + questions.
4. Answer in chat ("Use billing-service, export invoices as CSV") → assistant replies via SSE; readiness updates.
5. When ready → confetti + "Generate Draft → Send to Spec Board"; click it → the COMPOSE-<id> card appears in Spec Board → Ready For Review.
6. (Override) at any point click "Draft anyway" to hand off with open questions remaining.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-02-compose-sessions-phase-3b-COMPLETION.md
git commit -m "docs(compose): Phase 3b completion notes"
```

---

## Self-Review

**1. Spec coverage (design "Product model" + "Triggers & controls" + "Clarification loop" — frontend portion):**
- New/Load Session modal → Task 4 (`SessionModal`) + Task 8 (wired). ✓
- Three-panel workspace (Sources/Chat/Preview) → Tasks 5/6/7 + Task 8 container. ✓
- Drop-in sources (files via presigned upload, notes, YouTube) → Tasks 2 (`uploadFile`/`addNote`/`addYoutube`) + 5 (UI). ✓
- Live per-source conversion badges + retry → Task 5 + Task 8 polling. ✓
- "Analyze Sources" trigger → Task 5 button + Task 8 `analyze`. ✓
- Clarification chat with open questions appearing as messages, SSE-driven → Tasks 3 (stream hook), 6 (ChatPanel), 8 (wiring). ✓
- Readiness-gated "Generate Draft → Send to Spec Board" + confetti + "Draft anyway" → Task 7 (PreviewPanel + Confetti) + Task 8 (handoff). ✓
- Replace the mockup; lands in the existing Spec Board draft_ready queue via the existing handoff → Task 9. ✓
- Deferred (acceptable polish, noted in completion): drag-and-drop file dropzone (uses a file picker button instead), in-chat token streaming (we refetch messages on each SSE `message` event rather than stream tokens — simpler and correct), source content preview. Audio is Phase 4.

**2. Placeholder scan:** No "TBD/TODO/handle errors appropriately". Every code/test step is complete. The Task 8 test note about a stateful sources mock is concrete guidance (flip a `let added` flag), not a placeholder.

**3. Type consistency:**
- `composeTypes.ts` (Task 1) types consumed by `composeApi` (Task 2), the hook (Task 3), and every panel (Tasks 4–8). Field names (`conversionStatus`, `originalFilename`, `readiness`, `openQuestions`, `sourceCount`) match the backend read-models verified in Phases 1–3a. ✓
- `composeApi` function names (`createSession`, `listSessions`, `getSession`, `listSources`, `listMessages`, `addNote`, `addYoutube`, `reconvert`, `analyze`, `postMessage`, `handoff`, `uploadFile`) defined in Task 2, consumed in Task 8 with matching signatures. ✓
- `useComposeStream(sessionId, onEvent)` (Task 3) consumed in Task 8. ✓
- Panel prop contracts: `SourcesPanel`/`ChatPanel`/`PreviewPanel` props defined in Tasks 5/6/7 match the props passed in Task 8. ✓
- `FormattedText` exported in Task 1, imported by `ChatPanel` (Task 6). ✓
- The `ComposeStreamEvent` union (Task 1) matches the SSE events the 3a backend emits (`status`/`message`/`readiness`). ✓

**Cross-phase dependency:** This plan REQUIRES Phase 3a merged (the `/analyze`, `/messages`, `/stream` endpoints). If executed before 3a deploys, the UI builds and unit-tests pass (all network is mocked), but the live happy-path (Task 10 manual steps 3–5) won't work until 3a is live. Note this in the completion doc.
