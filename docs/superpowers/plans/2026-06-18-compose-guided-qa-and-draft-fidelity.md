# Compose: Guided Q&A, Summary, Pop-out + Draft Fidelity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two trust-breaking Compose bugs (draft drops agreed stories; protected-session sources invisible) and add guided Q&A (precise questions + A/B/C suggested answers + clickable tiles), a fixed/scrollable Ideating/Problem summary, and a full-screen pop-out chat.

**Architecture:** All new state lives inside the existing `readiness_json JSON` column as optional, backward-compatible fields on `ComposeReadiness` (`ideating`, `problem`, `questions[]`, `stories[]`) — **no migration**. The clarification agent emits the new fields through its structured-output schema; the Zod `ComposeReadinessSchema` must allow them or they are stripped before persistence. The draft generator reads the persisted `stories[]` (carried on the compose `EvidenceManifest`) and emits one child ticket per story, falling back to today's per-repo behavior when absent. The frontend captures the `resumeSession` stream token for protected sessions and plumbs it through the token-gated reads, renders structured summary + question tiles, and toggles a full-screen overlay.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), Zod, Express, MySQL2, Claude Agent SDK; React 18 + Vitest + Testing Library (jsdom) on the dashboard.

## Global Constraints

- **No migration.** Every new field lives inside the existing `readiness_json JSON` column. No DDL, no migration file.
- **Every new field is optional / backward-compatible.** Absent → today's behavior (prose `summary`, flat `openQuestions` checklist, per-repo draft).
- **Zod gates persistence.** The clarification agent's output is parsed by `ComposeChatEnvelopeSchema` → `ComposeReadinessSchema` before it is stringified into `readiness_json`. Any field not declared on `ComposeReadinessSchema` is silently dropped. New persisted fields MUST be added to both the TS interface AND the Zod schema.
- **`openQuestions: string[]` stays populated** for back-compat (SSE consumers, preview/handoff prose, existing ChatPanel splitting). `questions[]` is the new render source when present.
- **ESM import specifiers** end in `.js` even for `.ts` files (e.g. `./compose-types.js`).
- **Frontend RTL suites** call `afterEach(cleanup)`.
- **Run tests from the worktree root** `/tmp/cp-guided-qa`. Backend: `npx vitest run <path>`. Frontend: `cd dashboard && npx vitest run <path>` (jsdom env declared per-file via `// @vitest-environment jsdom`).
- **TypeScript `verbatimModuleSyntax`**: import types with `import type`.

---

## File Structure

**Backend (`src/spec-factory/`)**
- `compose-types.ts` — add `ComposeOpenQuestion`, `ComposeStory` interfaces; extend `ComposeReadiness` + `ComposeReadinessSchema` with `ideating`, `problem`, `questions`, `stories`.
- `compose-chat-agent.ts` — extend `COMPOSE_CHAT_JSON_SCHEMA` with the four new fields; extend `ANALYZE_INSTRUCTIONS` + `CHAT_INSTRUCTIONS` with precise/options/pick-first/stories/summary guidance.
- `compose-database.ts` — `parseReadiness` gains `parseQuestions` / `parseStories` and preserves `ideating` / `problem`.
- `evidence.ts` — `EvidenceManifest` + `buildComposeEvidenceManifest` carry optional `composeStories?: ComposeStory[]`.
- `compose-evidence-provider.ts` — pass the linked session's `readiness.stories` into `buildComposeEvidenceManifest`.
- `draft-generator.ts` — `buildPrompt` swaps the per-repo line for story-driven wording and injects the authoritative story list when `evidenceManifest.composeStories` is present.

**Frontend (`dashboard/src/spec-factory/compose/`)**
- `composeTypes.ts` — mirror `ComposeOpenQuestion`, `ComposeStory`, the new `ComposeReadiness` fields, and `streamToken` on `ComposeSessionSummary`.
- `composeApi.ts` — `resumeSession` returns `streamToken`; `listSources` / `listMessages` / `getSession` accept an optional token sent as `x-compose-token`.
- `useComposeStream.ts` — accept an optional token, append `?token=` to the EventSource URL.
- `ComposeWorkspace.tsx` — store the per-session token, pass it to the token-gated reads + stream, wire question-tile clicks to `postMessage`, own the pop-out toggle.
- `PreviewPanel.tsx` — render Ideating/Problem blocks in a fixed-height scrollable container; render `questions[]` as clickable tiles (fallback to `openQuestions` checklist).
- `ChatPanel.tsx` — render the active question's A/B/C option buttons; accept a pop-out toggle control.

---

## Phase 1 — Bug #4 (token plumbing) + the `stories[]` schema backbone

### Task 1: `ComposeStory` type + `readiness.stories[]` (backend type & Zod)

**Files:**
- Modify: `src/spec-factory/compose-types.ts:39-57` (interface) and `:103-108` (Zod schema)
- Test: `src/spec-factory/compose-types.test.ts`

**Interfaces:**
- Produces: `interface ComposeStory { id: string; title: string; summary: string; repos?: string[]; sequence?: number }`; `ComposeReadiness.stories?: ComposeStory[]`; `ComposeReadinessSchema` accepts an optional `stories` array. (Phase 2 + parseReadiness + the frontend consume these.)

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-types.test.ts` inside `describe("compose-types", ...)`:

```ts
  it("ComposeReadinessSchema accepts and preserves a stories breakdown", () => {
    const parsed = ComposeChatEnvelopeSchema.parse({
      reply: "Here is the plan.",
      readiness: {
        ready: false,
        openQuestions: ["q1"],
        summary: "s",
        stories: [
          {
            id: "story-1",
            title: "Add token plumbing",
            summary: "Send x-compose-token on protected reads",
            repos: ["dashboard"],
            sequence: 1,
          },
        ],
      },
    });
    expect(parsed.readiness.stories).toHaveLength(1);
    expect(parsed.readiness.stories?.[0]).toMatchObject({
      id: "story-1",
      title: "Add token plumbing",
      sequence: 1,
    });
  });
```

Add `ComposeChatEnvelopeSchema` to the existing import block if not already imported (it is, per current file).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-types.test.ts -t "stories breakdown"`
Expected: FAIL — `parsed.readiness.stories` is `undefined` (Zod strips the unknown key).

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-types.ts`, add the interface after `ComposeReadinessDetails` (after line 85):

```ts
export interface ComposeOpenQuestion {
  id: string;
  /** Precise, <= ~15 words, one concrete decision. */
  question: string;
  /** Up to 3 concrete candidate answers (A/B/C). */
  options?: string[];
  answered?: boolean;
  /** The chosen or typed answer once resolved. */
  answer?: string;
}

export interface ComposeStory {
  id: string;
  title: string;
  /** One line. */
  summary: string;
  repos?: string[];
  sequence?: number;
}
```

Extend the `ComposeReadiness` interface (after `codeInvestigation?` at line 56):

```ts
  /** #2 — 2-3 lines describing what we're shaping. */
  ideating?: string;
  /** #2 — 1-2 lines describing the problem we're solving. */
  problem?: string;
  /** #5/#6/#7 — structured questions; supersedes openQuestions for render when present. */
  questions?: ComposeOpenQuestion[];
  /** #1 — the draft contract: one child ticket per story. */
  stories?: ComposeStory[];
```

Add the Zod sub-schemas immediately before `ComposeReadinessSchema` (before line 103):

```ts
const ComposeOpenQuestionSchema = z.object({
  id: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).max(3).optional(),
  answered: z.boolean().optional(),
  answer: z.string().trim().min(1).optional(),
});

const ComposeStorySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().trim().default(""),
  repos: z.array(z.string().trim().min(1)).optional(),
  sequence: z.number().int().nonnegative().optional(),
});
```

Extend `ComposeReadinessSchema` (currently lines 103-108) to:

```ts
export const ComposeReadinessSchema = z.object({
  ready: z.boolean(),
  openQuestions: z.array(z.string().trim().min(1)).default([]),
  summary: z.string().trim().default(""),
  details: ComposeReadinessDetailsSchema.nullable().optional(),
  ideating: z.string().trim().min(1).optional(),
  problem: z.string().trim().min(1).optional(),
  questions: z.array(ComposeOpenQuestionSchema).optional(),
  stories: z.array(ComposeStorySchema).optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-types.test.ts`
Expected: PASS (all compose-types tests).

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-types.ts src/spec-factory/compose-types.test.ts
git commit -m "feat(compose): add ComposeStory/ComposeOpenQuestion + readiness schema fields"
```

---

### Task 2: `parseReadiness` preserves the new fields on DB read

**Files:**
- Modify: `src/spec-factory/compose-database.ts:179-199` (and add helpers near `parseCodeInvestigation` at :168-177)
- Test: `src/spec-factory/compose-database.test.ts`

**Interfaces:**
- Consumes: `ComposeStory`, `ComposeOpenQuestion`, `ComposeReadiness` from Task 1.
- Produces: `getSession()` / `findSessionBySourceId()` return `readiness` with `stories`, `questions`, `ideating`, `problem` populated when present in `readiness_json`.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-database.test.ts` after the `getSession preserves repoEvidence` test (after line 168):

```ts
  it("getSession preserves stories, questions, ideating, and problem from readiness_json", async () => {
    const query = vi.fn().mockResolvedValueOnce([
      [
        {
          id: 25,
          name: "Guided QA",
          created_by: null,
          created_by_display: null,
          status: "draft",
          claude_session_id: null,
          source_id: null,
          readiness_json: JSON.stringify({
            ready: false,
            openQuestions: ["q1"],
            summary: "s",
            ideating: "Shaping the guided Q&A flow.",
            problem: "Operators lose agreed stories at handoff.",
            questions: [
              {
                id: "q-1",
                question: "Which repo owns the token?",
                options: ["dashboard", "core-app", "interop"],
                answered: false,
              },
            ],
            stories: [
              {
                id: "story-1",
                title: "Token plumbing",
                summary: "Send token on protected reads",
                repos: ["dashboard"],
                sequence: 1,
              },
            ],
          }),
          s3_prefix: "compose/25/",
          workspace_path: "/mnt/efs/spec-factory/compose/25",
          password_hash: null,
          source_count: 1,
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
        },
      ],
      [],
    ]);
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    const session = await repo.getSession(25);

    expect(session?.readiness?.ideating).toBe("Shaping the guided Q&A flow.");
    expect(session?.readiness?.problem).toBe(
      "Operators lose agreed stories at handoff.",
    );
    expect(session?.readiness?.questions).toHaveLength(1);
    expect(session?.readiness?.questions?.[0]).toMatchObject({
      id: "q-1",
      question: "Which repo owns the token?",
      options: ["dashboard", "core-app", "interop"],
    });
    expect(session?.readiness?.stories).toHaveLength(1);
    expect(session?.readiness?.stories?.[0]).toMatchObject({
      id: "story-1",
      title: "Token plumbing",
      sequence: 1,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-database.test.ts -t "stories, questions, ideating"`
Expected: FAIL — `session.readiness.ideating` is `undefined` (parseReadiness rebuilds the object and drops unknown keys).

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-database.ts`, add the import for the new types. The file currently imports `ComposeReadinessDetails`, `ComposeRepoEvidence`, `ComposeCodeInvestigation` from `./compose-types.js` — add `ComposeOpenQuestion` and `ComposeStory` to that import.

Add two helpers after `parseCodeInvestigation` (after line 177):

```ts
function parseQuestions(value: unknown): ComposeOpenQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item) => {
      const id = textOrNull(item.id);
      const question = textOrNull(item.question);
      if (!id || !question) return null;
      const options = Array.isArray(item.options)
        ? item.options
            .map((opt) => textOrNull(opt))
            .filter((opt): opt is string => Boolean(opt))
            .slice(0, 3)
        : undefined;
      const answer = textOrNull(item.answer);
      return {
        id,
        question,
        ...(options && options.length > 0 ? { options } : {}),
        ...(typeof item.answered === "boolean"
          ? { answered: item.answered }
          : {}),
        ...(answer ? { answer } : {}),
      } satisfies ComposeOpenQuestion;
    })
    .filter((q): q is ComposeOpenQuestion => q !== null);
  return questions.length > 0 ? questions : null;
}

function parseStories(value: unknown): ComposeStory[] | null {
  if (!Array.isArray(value)) return null;
  const stories = value
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item) => {
      const id = textOrNull(item.id);
      const title = textOrNull(item.title);
      if (!id || !title) return null;
      const repos = Array.isArray(item.repos)
        ? item.repos
            .map((repo) => textOrNull(repo))
            .filter((repo): repo is string => Boolean(repo))
        : undefined;
      const sequence = numberOrNull(item.sequence);
      return {
        id,
        title,
        summary: typeof item.summary === "string" ? item.summary : "",
        ...(repos && repos.length > 0 ? { repos } : {}),
        ...(sequence !== null ? { sequence } : {}),
      } satisfies ComposeStory;
    })
    .filter((s): s is ComposeStory => s !== null);
  return stories.length > 0 ? stories : null;
}
```

Extend `parseReadiness` (lines 179-199). After the `codeInvestigation` line add the four parses and spread them into the return:

```ts
function parseReadiness(
  value: string | unknown | null,
): ComposeSessionSummary["readiness"] {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const details = parseReadinessDetails(obj.details);
  const repoEvidence = parseRepoEvidence(obj.repoEvidence);
  const codeInvestigation = parseCodeInvestigation(obj.codeInvestigation);
  const questions = parseQuestions(obj.questions);
  const stories = parseStories(obj.stories);
  const ideating = textOrNull(obj.ideating);
  const problem = textOrNull(obj.problem);
  return {
    ready: Boolean(obj.ready),
    openQuestions: Array.isArray(obj.openQuestions)
      ? obj.openQuestions.filter((q): q is string => typeof q === "string")
      : [],
    summary: typeof obj.summary === "string" ? obj.summary : "",
    ...(details ? { details } : {}),
    ...(repoEvidence ? { repoEvidence } : {}),
    ...(codeInvestigation ? { codeInvestigation } : {}),
    ...(questions ? { questions } : {}),
    ...(stories ? { stories } : {}),
    ...(ideating ? { ideating } : {}),
    ...(problem ? { problem } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-database.ts src/spec-factory/compose-database.test.ts
git commit -m "feat(compose): preserve stories/questions/ideating/problem on readiness read"
```

---

### Task 3: Agent JSON schema accepts the new fields

**Files:**
- Modify: `src/spec-factory/compose-chat-agent.ts:64-116` (`COMPOSE_CHAT_JSON_SCHEMA`)
- Test: `src/spec-factory/compose-chat-agent.test.ts`

**Interfaces:**
- Produces: the agent's structured-output schema declares `ideating`, `problem`, `questions`, `stories` under `readiness.properties` (additive — not added to `required`, so older turns stay valid).

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-chat-agent.test.ts` (create the file if it does not exist; if creating, use the header below). First confirm whether the file exists:

Run: `ls src/spec-factory/compose-chat-agent.test.ts`

If it exists, add this test to its main `describe`. If it does not exist, create it with:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeChatAgent } from "./compose-chat-agent.js";

function runAgentReturning(structuredOutput: unknown) {
  return vi.fn().mockResolvedValue({
    success: true,
    output: "",
    structuredOutput,
    sessionId: "sess-1",
    metrics: {
      durationMs: 10,
      toolCalls: 0,
      tokensUsed: { input: 10, output: 10 },
      modelUsed: "test-model",
    },
  });
}

describe("ComposeChatAgent schema + prompt", () => {
  it("exposes ideating/problem/questions/stories on the readiness output schema", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });
    const schema = runAgent.mock.calls[0][0].outputSchema;
    const readinessProps = schema.properties.readiness.properties;
    expect(readinessProps.ideating).toMatchObject({ type: "string" });
    expect(readinessProps.problem).toMatchObject({ type: "string" });
    expect(readinessProps.questions.type).toBe("array");
    expect(readinessProps.questions.items.properties.options.maxItems).toBe(3);
    expect(readinessProps.stories.type).toBe("array");
    expect(readinessProps.stories.items.required).toEqual(
      expect.arrayContaining(["id", "title", "summary"]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts -t "ideating/problem/questions/stories"`
Expected: FAIL — `readinessProps.ideating` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-chat-agent.ts`, extend the `readiness.properties` object inside `COMPOSE_CHAT_JSON_SCHEMA` (after the `details` property block closes at line 109, before `required` at line 111):

```ts
        ideating: {
          type: "string",
          description:
            "2-3 lines describing what we are shaping this session (operator-facing).",
        },
        problem: {
          type: "string",
          description: "1-2 lines describing the problem we are solving.",
        },
        questions: {
          type: "array",
          description:
            "Precise open questions (<= ~15 words each). Supersedes openQuestions for rendering.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              options: {
                type: "array",
                maxItems: 3,
                items: { type: "string" },
                description:
                  "Up to 3 concrete candidate answers (A/B/C), grounded in sources/code.",
              },
              answered: { type: "boolean" },
              answer: { type: "string" },
            },
            required: ["id", "question"],
          },
        },
        stories: {
          type: "array",
          description:
            "Implementation breakdown: one entry per shippable story. This list is the contract the draft builds from.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
              repos: { type: "array", items: { type: "string" } },
              sequence: { type: "integer" },
            },
            required: ["id", "title", "summary"],
          },
        },
```

Leave the `required: ["ready", "openQuestions", "summary", "details"]` array unchanged (new fields are optional).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-chat-agent.ts src/spec-factory/compose-chat-agent.test.ts
git commit -m "feat(compose): expose ideating/problem/questions/stories on agent output schema"
```

---

### Task 4: Bug #4 — token plumbing through composeApi

**Files:**
- Modify: `dashboard/src/spec-factory/compose/composeApi.ts:55-67` (`resumeSession`), `:98-110` (`listSources`/`listMessages`), `:55-57` (`getSession`)
- Modify: `dashboard/src/spec-factory/compose/composeTypes.ts:68-80` (`ComposeSessionSummary`)
- Test: `dashboard/src/spec-factory/compose/composeApi.test.ts`

**Interfaces:**
- Produces: `resumeSession(...)` returns `ComposeSessionSummary & { streamToken?: string }`; `listSources(sessionId, token?)`, `listMessages(sessionId, token?)`, `getSession(sessionId, token?)` send `x-compose-token: <token>` when a token is supplied.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/composeApi.test.ts` inside `describe("composeApi", ...)`:

```ts
  it("listSources sends x-compose-token when a token is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(ok([]));
    await api.listSources(7, "tok-123");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/spec-factory/compose/sessions/7/sources");
    expect(
      (init?.headers as Record<string, string>)["x-compose-token"],
    ).toBe("tok-123");
  });

  it("listSources omits the token header when none is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(ok([]));
    await api.listSources(7);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(
      (init?.headers as Record<string, string>)["x-compose-token"],
    ).toBeUndefined();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/composeApi.test.ts -t "x-compose-token"`
Expected: FAIL — `listSources` does not accept a token arg, so the header is absent.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/composeTypes.ts`, add `streamToken` to `ComposeSessionSummary` (after `updatedAt: string;` at line 79):

```ts
  /** Short-lived stream token minted by resume for password-protected sessions. */
  streamToken?: string;
```

In `dashboard/src/spec-factory/compose/composeApi.ts`, add a header helper after `requestJson` (after line 34):

```ts
function tokenHeaders(token?: string | null): Record<string, string> {
  return token ? { "x-compose-token": token } : {};
}
```

Update `getSession` (lines 55-57):

```ts
export function getSession(
  sessionId: number,
  token?: string,
): Promise<ComposeSessionSummary> {
  return requestJson<ComposeSessionSummary>(`${BASE}/sessions/${sessionId}`, {
    headers: tokenHeaders(token),
  });
}
```

Update `resumeSession` return type (lines 59-67):

```ts
export function resumeSession(
  sessionId: number,
  password?: string,
): Promise<ComposeSessionSummary & { streamToken?: string }> {
  return requestJson<ComposeSessionSummary & { streamToken?: string }>(
    `${BASE}/sessions/${sessionId}/resume`,
    { method: "POST", body: JSON.stringify({ password }) },
  );
}
```

Update `listSources` and `listMessages` (lines 98-110):

```ts
export function listSources(
  sessionId: number,
  token?: string,
): Promise<ComposeSourceSummary[]> {
  return requestJson<ComposeSourceSummary[]>(
    `${BASE}/sessions/${sessionId}/sources`,
    { headers: tokenHeaders(token) },
  );
}

export function listMessages(
  sessionId: number,
  token?: string,
): Promise<ComposeChatMessage[]> {
  return requestJson<ComposeChatMessage[]>(
    `${BASE}/sessions/${sessionId}/messages`,
    { headers: tokenHeaders(token) },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/composeApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/composeApi.ts dashboard/src/spec-factory/compose/composeTypes.ts dashboard/src/spec-factory/compose/composeApi.test.ts
git commit -m "fix(compose): plumb resume stream token through token-gated reads (#4)"
```

---

### Task 5: Bug #4 — EventSource sends the token; ComposeWorkspace stores & passes it

**Files:**
- Modify: `dashboard/src/spec-factory/compose/useComposeStream.ts:33-49`
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx` (state + the read call-sites)
- Test: `dashboard/src/spec-factory/compose/useComposeStream.test.ts`

**Interfaces:**
- Consumes: `resumeSession` returning `streamToken` (Task 4); `listSources`/`listMessages`/`getSession` token args (Task 4).
- Produces: `useComposeStream(sessionId, onEvent, options, token?)` appends `?token=<token>` to the stream URL; `ComposeWorkspace` holds `streamToken` state per active session and threads it into every protected read + the stream.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/useComposeStream.test.ts` (mirror its existing EventSource-stub pattern). First read the file's existing stub setup; then add:

```ts
  it("appends the token query param to the stream URL when provided", () => {
    const created: string[] = [];
    class StubEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        created.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", StubEventSource as never);
    renderHook(() =>
      useComposeStream(7, () => {}, {}, "tok-xyz"),
    );
    expect(created[0]).toBe(
      "/api/spec-factory/compose/sessions/7/stream?token=tok-xyz",
    );
  });
```

Ensure `renderHook` is imported from `@testing-library/react` and `useComposeStream` from `./useComposeStream.js` (match the file's existing imports; add only if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/useComposeStream.test.ts -t "token query param"`
Expected: FAIL — URL has no `?token=` (the hook ignores the 4th arg).

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/useComposeStream.ts`, add a `token` parameter and use it in the URL + effect deps:

```ts
export function useComposeStream(
  sessionId: number | null,
  onEvent: (event: ComposeStreamEvent) => void,
  options: UseComposeStreamOptions = {},
  token?: string | null,
): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (sessionId === null) return;
    if (typeof EventSource === "undefined") return;

    const url = token
      ? `/api/spec-factory/compose/sessions/${sessionId}/stream?token=${encodeURIComponent(token)}`
      : `/api/spec-factory/compose/sessions/${sessionId}/stream`;
    const source = new EventSource(url);
```

Change the effect dependency array from `[sessionId]` to `[sessionId, token]` (final line of the effect).

In `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`:

Add state after `const [readiness, ...]` (after line 123):

```ts
  const [streamToken, setStreamToken] = useState<string | null>(null);
```

In `openSession` (line 293) capture the token:

```ts
        const session = await composeApi.resumeSession(id, password);
        setStreamToken(session.streamToken ?? null);
        setSessions((prev) => upsertSessionSummary(prev, session));
        setSessionId(id);
        setReadiness(session.readiness ?? null);
        await Promise.all([
          refreshSources(id, session.streamToken ?? null),
          refreshMessages(id, session.streamToken ?? null),
        ]);
```

Update `refreshSources` (lines 147-153) and `refreshMessages` (lines 170-187) to accept an optional token, defaulting to the stored `streamToken`. Because these are `useCallback`s defined before `streamToken` state, read the token from a ref to avoid a stale closure. Add a ref alongside the state:

```ts
  const streamTokenRef = useRef<string | null>(null);
```

Keep it in sync — add an effect after the state declarations:

```ts
  useEffect(() => {
    streamTokenRef.current = streamToken;
  }, [streamToken]);
```

Then:

```ts
  const refreshSources = useCallback(async (id: number, token?: string | null) => {
    try {
      setSources(await composeApi.listSources(id, token ?? streamTokenRef.current));
    } catch {
      /* keep last */
    }
  }, []);
```

```ts
  const refreshMessages = useCallback(async (id: number, token?: string | null) => {
    try {
      const persisted = await composeApi.listMessages(
        id,
        token ?? streamTokenRef.current,
      );
      setMessages((prev) => {
        // ...unchanged body...
```

In `onStreamReconnect` (line 267) update the captured token after resume:

```ts
    void composeApi
      .resumeSession(sessionId)
      .then((session) => {
        setStreamToken(session.streamToken ?? null);
        setSessions((prev) => upsertSessionSummary(prev, session));
        setReadiness((prev) => session.readiness ?? prev);
      })
```

Pass the token to the stream hook (line 284):

```ts
  useComposeStream(sessionId, onStreamEvent, {
    onOpen: onStreamReconnect,
    onStuck: onStreamStuck,
  }, streamToken);
```

Clear the token in `returnToSessionPicker` (line 387) and `handleDeleteSession` cleanup (after `setReadiness(null)` at line 328):

```ts
    setStreamToken(null);
```

(Add the `setStreamToken(null)` line in both `returnToSessionPicker` and the `if (sessionId === id)` block of `handleDeleteSession`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/useComposeStream.test.ts src/spec-factory/compose/ComposeWorkspace.test.tsx`
Expected: PASS (existing ComposeWorkspace tests still green; protected reads now carry the token).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/useComposeStream.ts dashboard/src/spec-factory/compose/useComposeStream.test.ts dashboard/src/spec-factory/compose/ComposeWorkspace.tsx
git commit -m "fix(compose): store + plumb stream token to protected reads and SSE (#4)"
```

---

## Phase 2 — Bug #1 completion (handoff carries stories → one child per story)

### Task 6: `EvidenceManifest` carries `composeStories`; provider supplies them

**Files:**
- Modify: `src/spec-factory/evidence.ts:26-42` (`EvidenceManifest`), `:299-333` (`buildComposeEvidenceManifest`)
- Modify: `src/spec-factory/compose-evidence-provider.ts:42-65`
- Test: `src/spec-factory/compose-evidence-provider.test.ts` (and `evidence.test.ts` if present)

**Interfaces:**
- Consumes: `ComposeStory` (Task 1); `ComposeRepository.findSessionBySourceId` returning `readiness.stories` (Task 2).
- Produces: `EvidenceManifest.composeStories?: ComposeStory[]`; `buildComposeEvidenceManifest({..., composeStories?})` sets it; `ComposeEvidenceProvider.collect()` passes `session.readiness?.stories`.

- [ ] **Step 1: Write the failing test**

First check the provider test file exists:

Run: `ls src/spec-factory/compose-evidence-provider.test.ts`

Add this test to it (matching its existing mock-repo pattern). If the file does not exist, create it:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeEvidenceProvider } from "./compose-evidence-provider.js";

describe("ComposeEvidenceProvider", () => {
  it("carries the session's readiness.stories onto the evidence manifest", async () => {
    const composeRepo = {
      findSessionBySourceId: vi.fn().mockResolvedValue({
        id: 5,
        workspacePath: null,
        readiness: {
          ready: false,
          openQuestions: [],
          summary: "s",
          stories: [
            { id: "story-1", title: "A", summary: "a", sequence: 1 },
            { id: "story-2", title: "B", summary: "b", sequence: 2 },
          ],
        },
      }),
      listSessionSourceContents: vi
        .fn()
        .mockResolvedValue([
          { sourceId: 1, filename: "note.md", content: "hello" },
        ]),
    };
    const specRepo = {
      getSourceById: vi.fn().mockResolvedValue({
        sourceJiraKey: "COMPOSE-5",
        sourceSummary: "Guided QA",
      }),
    };
    const provider = new ComposeEvidenceProvider(
      composeRepo as never,
      specRepo as never,
    );

    const manifest = await provider.collect(42);

    expect(manifest.composeStories).toHaveLength(2);
    expect(manifest.composeStories?.[0]).toMatchObject({
      id: "story-1",
      title: "A",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-evidence-provider.test.ts -t "readiness.stories"`
Expected: FAIL — `manifest.composeStories` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/evidence.ts`, import `ComposeStory` from `./compose-types.js` at the top (add to an existing import from that module, or add a new `import type { ComposeStory } from "./compose-types.js";`).

Add to `EvidenceManifest` (after `repoClassifierContext?` block, before `warnings: string[];` at line 41):

```ts
  /** Compose-only: the agreed story breakdown that the draft must honor (one child per story). */
  composeStories?: ComposeStory[];
```

Extend `buildComposeEvidenceManifest`'s input type (line 299) and return. Add `composeStories?: ComposeStory[];` to the input object type and set it on the returned manifest:

```ts
export function buildComposeEvidenceManifest(input: {
  sourceJiraKey: string;
  sourceSummary: string;
  sources: ComposeEvidenceSourceInput[];
  repoReferences?: SpecFactoryRepoReferenceManifest;
  repoClassifierContext?: EvidenceManifest["repoClassifierContext"];
  composeStories?: ComposeStory[];
}): EvidenceManifest {
```

In the returned object (after `repoClassifierContext: input.repoClassifierContext,` at line 331), add:

```ts
    ...(input.composeStories && input.composeStories.length > 0
      ? { composeStories: input.composeStories }
      : {}),
```

In `src/spec-factory/compose-evidence-provider.ts`, the `collect()` method already loads `session` via `findSessionBySourceId`. Add the stories to the manifest call (lines 60-64):

```ts
    return buildComposeEvidenceManifest({
      sourceJiraKey: source.sourceJiraKey,
      sourceSummary: source.sourceSummary,
      sources,
      composeStories: session.readiness?.stories,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-evidence-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/evidence.ts src/spec-factory/compose-evidence-provider.ts src/spec-factory/compose-evidence-provider.test.ts
git commit -m "feat(compose): carry agreed stories onto the compose evidence manifest (#1)"
```

---

### Task 7: Draft generator — one child per story + per-repo fallback

**Files:**
- Modify: `src/spec-factory/draft-generator.ts:142-204` (`buildPrompt`)
- Test: `src/spec-factory/draft-generator.test.ts`

**Interfaces:**
- Consumes: `EvidenceManifest.composeStories` (Task 6).
- Produces: when `input.evidenceManifest.composeStories` is non-empty, `buildPrompt` emits the story-driven instruction + an authoritative story list and omits the per-repo line; otherwise it keeps the existing per-repo line verbatim.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/draft-generator.test.ts` (uses the existing `evidenceManifest()` + `validBundle()` helpers):

```ts
  it("uses story-driven wording and lists stories when composeStories is present", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 1,
        toolCalls: 0,
        tokensUsed: { input: 1, output: 1 },
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");
    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "COMPOSE-5",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: {
        ...evidenceManifest(),
        composeStories: [
          { id: "story-1", title: "Token plumbing", summary: "Send token", sequence: 1 },
          { id: "story-2", title: "Draft fidelity", summary: "One child per story", sequence: 2 },
        ],
      },
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("exactly one child ticket per story");
    expect(prompt).not.toContain(
      "Return exactly one Epic and one child Story/Task per repository involved.",
    );
    expect(prompt).toContain("Token plumbing");
    expect(prompt).toContain("Draft fidelity");
  });

  it("keeps the per-repo wording when no composeStories are provided", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "",
      structuredOutput: validBundle(),
      metrics: {
        durationMs: 1,
        toolCalls: 0,
        tokensUsed: { input: 1, output: 1 },
        modelUsed: "test-model",
      },
    });
    const generator = new DraftGenerator(runAgent, "test-model");
    await generator.generate({
      sourceId: 12,
      sourceJiraKey: "CPDEV-22410",
      repoIds: ["spec-factory-source-12-core-app"],
      evidenceManifest: evidenceManifest(),
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain(
      "Return exactly one Epic and one child Story/Task per repository involved.",
    );
    expect(prompt).not.toContain("exactly one child ticket per story");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/draft-generator.test.ts -t "story-driven wording"`
Expected: FAIL — prompt always contains the per-repo line and never the story-driven line.

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/draft-generator.ts`, `buildPrompt` (line 142). Compute the story list once at the top of the function and branch the requirements line. Replace the single line 153 (`"- Return exactly one Epic and one child Story/Task per repository involved.",`) with a conditional, and append an authoritative story section.

At the top of `buildPrompt`, before `return [`:

```ts
function buildPrompt(input: GenerateDraftInput): string {
  const stories = input.evidenceManifest.composeStories ?? [];
  const hasStories = stories.length > 0;
  const storyDirective = hasStories
    ? "- Return one Epic. A story breakdown is provided below: create exactly one child ticket per story, preserving each story's title and sequence; a story may span repositories — set technicalDetails.repo to its primary repo; do not collapse or merge stories."
    : "- Return exactly one Epic and one child Story/Task per repository involved.";
  const storySection = hasStories
    ? [
        "",
        "Authoritative story breakdown (one child ticket per story, in sequence):",
        ...[...stories]
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
          .map((story, index) => {
            const repos = story.repos?.length
              ? ` [repos: ${story.repos.join(", ")}]`
              : "";
            return `${index + 1}. ${story.title} — ${story.summary}${repos}`;
          }),
      ]
    : [];
  return [
```

Change line 153 to use `storyDirective`:

```ts
    "Requirements:",
    storyDirective,
    "- Child tickets must be self-contained for OneShot QUALIFIER intake.",
```

Append `storySection` to the array just before the closing `].join("\n");`. The current tail is:

```ts
    "",
    renderCompactEvidenceSummary(input.evidenceManifest),
    "",
    renderCompactRepoContextSummary(input.repoContextManifest),
  ].join("\n");
```

Change it to:

```ts
    "",
    renderCompactEvidenceSummary(input.evidenceManifest),
    "",
    renderCompactRepoContextSummary(input.repoContextManifest),
    ...storySection,
  ].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/draft-generator.test.ts`
Expected: PASS (including the pre-existing per-repo assertion at line 132-133 which still holds in the fallback path).

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/draft-generator.ts src/spec-factory/draft-generator.test.ts
git commit -m "feat(compose): draft one child per agreed story; per-repo fallback (#1)"
```

---

### Task 8: Agent prompt — maintain `stories[]` every turn (closes #1 end-to-end)

**Files:**
- Modify: `src/spec-factory/compose-chat-agent.ts:118-148` (`ANALYZE_INSTRUCTIONS` + `CHAT_INSTRUCTIONS`)
- Test: `src/spec-factory/compose-chat-agent.test.ts`

**Interfaces:**
- Consumes: the `stories` schema field (Task 3).
- Produces: both prompt blocks instruct the agent to maintain `readiness.stories[]` as the complete, current implementation breakdown each turn.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-chat-agent.test.ts`:

```ts
  it("instructs the agent to maintain the stories breakdown every turn", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "chat",
      resumeSessionId: null,
      latestUserMessage: "go",
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("readiness.stories");
    expect(prompt).toContain("contract the draft builds from");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts -t "maintain the stories breakdown"`
Expected: FAIL — neither prompt mentions `readiness.stories`.

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-chat-agent.ts`, append a stories line to `ANALYZE_INSTRUCTIONS` (after item 4, before the closing `].join("\n")` at line 134):

```ts
  "5. Maintain `readiness.stories`: the implementation breakdown as one entry per shippable story (id, title, one-line summary, repos, sequence). This list is the contract the draft builds from — keep it complete and current.",
```

Append the same intent to `CHAT_INSTRUCTIONS` (before its closing `].join("\n")` at line 148):

```ts
  "Maintain `readiness.stories` every turn as the complete implementation breakdown (one entry per shippable story: id, title, one-line summary, repos, sequence). This list is the contract the draft builds from — keep it complete and current as scope evolves.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-chat-agent.ts src/spec-factory/compose-chat-agent.test.ts
git commit -m "feat(compose): agent maintains the stories breakdown each turn (#1)"
```

---

## Phase 3 — Q&A + summary agent guidance (#5 pick-first, #6 precise, #7 options, #2 fields)

### Task 9: Agent prompt — precise questions, A/B/C options, pick-first, ideating/problem

**Files:**
- Modify: `src/spec-factory/compose-chat-agent.ts:118-148` (`ANALYZE_INSTRUCTIONS` + `CHAT_INSTRUCTIONS`)
- Test: `src/spec-factory/compose-chat-agent.test.ts`

**Interfaces:**
- Consumes: `questions`, `ideating`, `problem` schema fields (Task 3).
- Produces: both prompts instruct: questions are precise (≤ ~15 words) with up to 3 grounded `options`; ANALYZE reply is short and asks the operator to pick a question first; on an answered turn mark it `answered` + record `answer`; populate `ideating` (2-3 lines) and `problem` (1-2 lines) every turn while keeping `summary`.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-chat-agent.test.ts`:

```ts
  it("ANALYZE prompt is pick-first and asks for precise A/B/C options + ideating/problem", () => {
    // buildPrompt is exercised via run(); capture both modes.
    const analyzeAgent = new ComposeChatAgent(
      runAgentReturning({
        reply: "ok",
        readiness: { ready: false, openQuestions: [], summary: "" },
      }) as never,
      "test-model",
      1000,
    );
    return analyzeAgent
      .run({
        sessionId: 1,
        workspaceRepoId: "compose-1",
        mode: "analyze",
        resumeSessionId: null,
        latestUserMessage: null,
      })
      .then(() => {
        // re-run to read the prompt off the mock is brittle; instead assert on
        // the static instruction text via a fresh spy:
      });
  });
```

The above is awkward because `buildPrompt` is private. Instead assert on the prompt captured from `runAgent`. Replace the test body with the simpler captured-prompt form:

```ts
  it("ANALYZE prompt is pick-first with precise A/B/C options + ideating/problem", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("Pick the one you want to clarify first");
    expect(prompt).toContain("up to 3 concrete");
    expect(prompt).toContain("15 words");
    expect(prompt).toContain("`ideating`");
    expect(prompt).toContain("`problem`");
  });

  it("CHAT prompt marks answered questions and refreshes ideating/problem", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "chat",
      resumeSessionId: null,
      latestUserMessage: "A",
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("mark it answered");
    expect(prompt).toContain("`ideating`");
    expect(prompt).toContain("`problem`");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts -t "pick-first"`
Expected: FAIL — prompts don't contain the pick-first / options / ideating text.

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-chat-agent.ts`, add lines to `ANALYZE_INSTRUCTIONS` (before its closing `].join("\n")`, after the stories item added in Task 8):

```ts
  "6. Populate `readiness.questions`: precise open questions (each <= ~15 words, one concrete decision, no preamble). For each, propose up to 3 concrete, distinct candidate answers in `options` (A/B/C), grounded in the sources or attached code — real choices, not yes/no/maybe. Keep `openQuestions` populated in parallel for back-compat.",
  "7. Keep the `reply` short: state how many open questions you found and ask the operator to pick the one they want to clarify first — e.g. 'I found N open questions. Pick the one you want to clarify first.' Do not dump all questions into prose.",
  "8. Populate `readiness.ideating` (2-3 lines: what we're shaping) and `readiness.problem` (1-2 lines: the problem we're solving) every turn. Keep `readiness.summary` populated for back-compat.",
```

Add to `CHAT_INSTRUCTIONS` (before its closing `].join("\n")`, after the stories line added in Task 8):

```ts
  "Maintain `readiness.questions` with precise items (<= ~15 words) and up to 3 grounded `options` (A/B/C) each; keep `openQuestions` populated in parallel. When the operator's message answers a surfaced question, mark it answered (set `answered: true` and record the chosen/typed `answer`), then surface the next most valuable open question.",
  "Refresh `readiness.ideating` (2-3 lines) and `readiness.problem` (1-2 lines) every turn; keep `readiness.summary` populated for back-compat.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-chat-agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-chat-agent.ts src/spec-factory/compose-chat-agent.test.ts
git commit -m "feat(compose): guided Q&A prompt — precise questions, A/B/C, pick-first, summary (#2/#5/#6/#7)"
```

---

## Phase 4 — Frontend (summary blocks, question tiles + A/B/C, pop-out)

### Task 10: Frontend types mirror the new readiness fields

**Files:**
- Modify: `dashboard/src/spec-factory/compose/composeTypes.ts:36-49` (`ComposeReadiness`)
- Test: `dashboard/src/spec-factory/compose/composeTypes.test.ts`

**Interfaces:**
- Produces: TS `ComposeOpenQuestion`, `ComposeStory`, and `ComposeReadiness.{ideating?, problem?, questions?, stories?}` on the dashboard (consumed by PreviewPanel/ChatPanel/ComposeWorkspace).

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/composeTypes.test.ts` (it is a type-shape test file). First read it to match its style; then add a compile-shape test:

```ts
  it("ComposeReadiness carries ideating/problem/questions/stories", () => {
    const readiness: ComposeReadiness = {
      ready: false,
      openQuestions: ["q"],
      summary: "s",
      ideating: "shaping",
      problem: "solving",
      questions: [
        { id: "q-1", question: "Which repo?", options: ["a", "b"], answered: false },
      ],
      stories: [{ id: "s-1", title: "T", summary: "one line", sequence: 1 }],
    };
    expect(readiness.questions?.[0].options).toEqual(["a", "b"]);
    expect(readiness.stories?.[0].title).toBe("T");
  });
```

Ensure `ComposeReadiness` is imported via `import type { ComposeReadiness } from "./composeTypes.js";` (add if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/composeTypes.test.ts -t "ideating/problem/questions/stories"`
Expected: FAIL — TS compile error: object literal may only specify known properties (`ideating` not on `ComposeReadiness`).

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/composeTypes.ts`, add the two interfaces before `ComposeReadiness` (before line 36):

```ts
export interface ComposeOpenQuestion {
  id: string;
  question: string;
  options?: string[];
  answered?: boolean;
  answer?: string;
}

export interface ComposeStory {
  id: string;
  title: string;
  summary: string;
  repos?: string[];
  sequence?: number;
}
```

Extend `ComposeReadiness` (after `codeInvestigation?` at line 48):

```ts
  ideating?: string;
  problem?: string;
  questions?: ComposeOpenQuestion[];
  stories?: ComposeStory[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/composeTypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/composeTypes.ts dashboard/src/spec-factory/compose/composeTypes.test.ts
git commit -m "feat(compose): mirror ideating/problem/questions/stories in dashboard types"
```

---

### Task 11: PreviewPanel — Ideating/Problem blocks (fixed-height scrollable) + question tiles

**Files:**
- Modify: `dashboard/src/spec-factory/compose/PreviewPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`

**Interfaces:**
- Consumes: `ComposeReadiness.{ideating, problem, questions}` (Task 10).
- Produces: PreviewPanel accepts an optional `onSelectQuestion?: (question: ComposeOpenQuestion) => void` prop; renders an `aria-label="Ideating"` block + `aria-label="Problem"` block inside a `sf-preview-summary` container (CSS `max-height` + `overflow:auto`); renders `questions[]` as buttons with `aria-label="Pending questions"` when present, else the existing `openQuestions` checklist.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`:

```ts
  it("renders Ideating and Problem blocks when present", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "fallback summary",
          ideating: "We are shaping the guided Q&A flow.",
          problem: "Operators lose agreed stories at handoff.",
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByRole("article", { name: /Ideating/i })).toBeTruthy();
    expect(
      within(screen.getByRole("article", { name: /Ideating/i })).getByText(
        /shaping the guided Q&A flow/i,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("article", { name: /Problem/i })).toBeTruthy();
  });

  it("renders question tiles and calls onSelectQuestion on click", () => {
    const onSelectQuestion = vi.fn();
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["legacy"],
          summary: "s",
          questions: [
            { id: "q-1", question: "Which repo owns the token?", options: ["dashboard", "core-app"] },
            { id: "q-2", question: "Sync or async?", answered: true, answer: "async" },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
        onSelectQuestion={onSelectQuestion}
      />,
    );
    const tiles = screen.getByRole("group", { name: /Pending questions/i });
    const firstTile = within(tiles).getByRole("button", {
      name: /Which repo owns the token/i,
    });
    fireEvent.click(firstTile);
    expect(onSelectQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q-1" }),
    );
    // answered tile shows resolved state
    expect(within(tiles).getByText(/async/i)).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx -t "Ideating"`
Expected: FAIL — no Ideating article rendered.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/PreviewPanel.tsx`:

Update the import to include the question type:

```ts
import type {
  ComposeOpenQuestion,
  ComposeReadiness,
  ComposeRepoEvidence,
} from "./composeTypes.js";
```

Add `onSelectQuestion` to the props (after `onViewEpic?` in the destructure + the type at lines 86-94):

```ts
  onSelectQuestion,
}: {
  readiness: ComposeReadiness | null;
  handingOff: boolean;
  handoffBlockedReason?: string | null;
  generatedSourceId?: number | null;
  onGenerate: () => void;
  onViewEpic?: () => void;
  onSelectQuestion?: (question: ComposeOpenQuestion) => void;
}) {
```

Inside the rendered body, add a summary block at the top of `<div className="sf-preview-body">` (before the Details article at line 119). Compute the values first (after `const details = previewDetails(readiness);` at line 109):

```ts
  const ideating = normalizedText(readiness.ideating);
  const problem = normalizedText(readiness.problem);
  const hasStructuredSummary = Boolean(ideating || problem);
  const fallbackSummary = normalizedText(readiness.summary);
  const structuredQuestions = readiness.questions ?? [];
```

Then render the summary container as the first child of `sf-preview-body`:

```tsx
        {hasStructuredSummary ? (
          <div className="sf-preview-summary" aria-label="Session summary">
            {ideating ? (
              <article className="sf-preview-summary-block" aria-label="Ideating">
                <span className="sf-section-label">Ideating</span>
                <p>{ideating}</p>
              </article>
            ) : null}
            {problem ? (
              <article className="sf-preview-summary-block" aria-label="Problem">
                <span className="sf-section-label">Problem</span>
                <p>{problem}</p>
              </article>
            ) : null}
          </div>
        ) : fallbackSummary ? (
          <div className="sf-preview-summary" aria-label="Session summary">
            <article className="sf-preview-summary-block" aria-label="Summary">
              <span className="sf-section-label">Summary</span>
              <p>{fallbackSummary}</p>
            </article>
          </div>
        ) : null}
```

Replace the pending-items checklist block (lines 156-173) to prefer question tiles when present:

```tsx
        {structuredQuestions.length > 0 ? (
          <article className="sf-preview-checklist">
            <span className="sf-section-label">Pending items</span>
            <div
              className="sf-question-tiles"
              role="group"
              aria-label="Pending questions"
            >
              {structuredQuestions.map((question) => (
                <button
                  key={question.id}
                  type="button"
                  className={`sf-question-tile${question.answered ? " is-answered" : ""}`}
                  onClick={() => onSelectQuestion?.(question)}
                  aria-pressed={Boolean(question.answered)}
                >
                  <span className="sf-question-tile-text">{question.question}</span>
                  {question.answered && question.answer ? (
                    <span className="sf-question-tile-answer">{question.answer}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </article>
        ) : checklist.length > 0 ? (
          <article className="sf-preview-checklist">
            <span className="sf-section-label">Pending items</span>
            <ul aria-label="Pending items">
              {checklist.map((item, index) => (
                <li key={`${item}-${index}`}>
                  <span aria-hidden="true" />
                  <p>{item}</p>
                </li>
              ))}
            </ul>
          </article>
        ) : (
          <article className="sf-preview-checklist is-complete">
            <span className="sf-section-label">Next step</span>
            <p>Generate the draft and send it to Spec Board.</p>
          </article>
        )}
```

Add the CSS to the Compose stylesheet `dashboard/src/spec-factory/SpecFactoryPage.css` (confirm with `grep -rln "sf-preview-checklist" dashboard/src` — it resolves to that file). Append:

```css
.sf-preview-summary {
  max-height: 8.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.sf-question-tiles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.sf-question-tile {
  text-align: left;
  cursor: pointer;
  border: 1px solid var(--sf-border, #d0d5dd);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--sf-surface, #fff);
}
.sf-question-tile.is-answered {
  opacity: 0.65;
}
.sf-question-tile-answer {
  display: block;
  font-size: 0.8em;
  opacity: 0.8;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`
Expected: PASS (existing PreviewPanel tests still green — the prose-summary path is preserved as fallback).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/PreviewPanel.tsx dashboard/src/spec-factory/compose/PreviewPanel.test.tsx dashboard/src
git commit -m "feat(compose): Ideating/Problem summary + clickable question tiles (#2/#5)"
```

---

### Task 12: ChatPanel — active question A/B/C option buttons + pop-out control

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `ComposeOpenQuestion` (Task 10); `onSend` (existing).
- Produces: ChatPanel accepts optional `activeQuestion?: ComposeOpenQuestion | null`, `onPopOut?: () => void`, `isPoppedOut?: boolean`. When `activeQuestion` has `options`, render A/B/C buttons that call `onSend(option)`; render a pop-out toggle button (`aria-label="Pop out chat"` / "Exit full screen") when `onPopOut` is provided.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`:

```ts
  it("renders A/B/C option buttons for the active question and sends the option text", () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={false}
        onSend={onSend}
        activeQuestion={{
          id: "q-1",
          question: "Which repo owns the token?",
          options: ["dashboard", "core-app", "interop"],
        }}
      />,
    );
    const options = screen.getByRole("group", { name: /Suggested answers/i });
    fireEvent.click(within(options).getByRole("button", { name: /core-app/i }));
    expect(onSend).toHaveBeenCalledWith("core-app");
  });

  it("renders a pop-out control when onPopOut is provided", () => {
    const onPopOut = vi.fn();
    render(
      <ChatPanel
        sessionId={1}
        messages={[]}
        thinking={false}
        onSend={vi.fn()}
        onPopOut={onPopOut}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Pop out chat/i }));
    expect(onPopOut).toHaveBeenCalled();
  });
```

Confirm `within` and `fireEvent` are imported in this test file; add to the `@testing-library/react` import if missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "option buttons"`
Expected: FAIL — no Suggested answers group exists.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`:

Extend the imports:

```ts
import type {
  ComposeChatMessage,
  ComposeMessageRole,
  ComposeOpenQuestion,
} from "./composeTypes.js";
```

Add the new props to the destructure + type (the function signature at lines 95-113):

```ts
export function ChatPanel({
  messages,
  onSend,
  thinking,
  progressMessage,
  contextSummary,
  openQuestions = [],
  sessionId,
  retryStatus = null,
  activeQuestion = null,
  onPopOut,
  isPoppedOut = false,
}: {
  messages: ComposeChatMessage[];
  onSend: (content: string) => void;
  thinking: boolean;
  progressMessage?: string | null;
  contextSummary?: string | null;
  openQuestions?: string[];
  sessionId?: number | null;
  retryStatus?: ComposeRetryStatus | null;
  activeQuestion?: ComposeOpenQuestion | null;
  onPopOut?: () => void;
  isPoppedOut?: boolean;
}) {
```

Add a pop-out button in the panel header region. The `<section>` opens at line 199 and the chat window at line 215. Insert a toolbar right after the opening `<section ...>` tag and before the context-summary article:

```tsx
      {onPopOut ? (
        <div className="sf-chat-toolbar">
          <button
            type="button"
            className="sf-chat-popout"
            onClick={onPopOut}
            aria-label={isPoppedOut ? "Exit full screen" : "Pop out chat"}
          >
            {isPoppedOut ? "Exit full screen" : "Pop out"}
          </button>
        </div>
      ) : null}
```

Add the option buttons inside the dock, just above the `<textarea>` (before line 278). Render when the active question has options:

```tsx
      {activeQuestion?.options && activeQuestion.options.length > 0 ? (
        <div
          className="sf-chat-options"
          role="group"
          aria-label="Suggested answers"
        >
          {activeQuestion.options.map((option, index) => (
            <button
              key={`${activeQuestion.id}-${index}`}
              type="button"
              className="sf-chat-option"
              onClick={() => onSend(option)}
            >
              <span className="sf-chat-option-key">
                {String.fromCharCode(65 + index)}
              </span>
              <span>{option}</span>
            </button>
          ))}
        </div>
      ) : null}
```

Add CSS to `dashboard/src/spec-factory/SpecFactoryPage.css` (same stylesheet as Task 11):

```css
.sf-chat-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 0.25rem 0.5rem;
}
.sf-chat-options {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding: 0 0.5rem 0.5rem;
}
.sf-chat-option {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  border: 1px solid var(--sf-border, #d0d5dd);
  border-radius: 999px;
  padding: 0.35rem 0.75rem;
  background: var(--sf-surface, #fff);
}
.sf-chat-option-key {
  font-weight: 600;
  opacity: 0.7;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS (existing ChatPanel tests still green — new props are optional).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx dashboard/src
git commit -m "feat(compose): A/B/C answer buttons + pop-out control on ChatPanel (#3/#7)"
```

---

### Task 13: ComposeWorkspace — wire active question, tile selection, and full-screen overlay

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`
- Test: `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`

**Interfaces:**
- Consumes: `ChatPanel` (`activeQuestion`/`onPopOut`/`isPoppedOut`, Task 12); `PreviewPanel` (`onSelectQuestion`, Task 11); `readiness.questions` (Task 10).
- Produces: clicking a PreviewPanel question tile sets `activeQuestion`; ChatPanel shows it with A/B/C; clicking an option posts via the existing `onSend` → `postMessage`; a pop-out toggle renders a full-screen overlay (`role="dialog"`, `aria-label="Compose chat full screen"`) wrapping the same ChatPanel; Esc/close exits.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx` (match its existing render + fetch-mock setup). Add:

```ts
  it("opens a full-screen overlay when the chat pop-out is toggled", async () => {
    // Render an active session (reuse the suite's helper that resumes a session
    // and returns sources/messages). After the session is open:
    const popOut = await screen.findByRole("button", { name: /Pop out/i });
    fireEvent.click(popOut);
    expect(
      screen.getByRole("dialog", { name: /Compose chat full screen/i }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Compose chat full screen/i }),
      ).toBeNull(),
    );
  });
```

NOTE: ComposeWorkspace tests require an active session. Read `ComposeWorkspace.test.tsx` and reuse its existing pattern for opening a session (it mocks `composeApi` and clicks the load button). Wrap the assertions above in that flow. If the suite uses a `vi.mock("./composeApi.js")` module mock, ensure `resumeSession` resolves a session and `listSources`/`listMessages` resolve arrays so the workspace renders ChatPanel.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx -t "full-screen overlay"`
Expected: FAIL — no pop-out button / dialog.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`:

Import `ComposeOpenQuestion`:

```ts
import type {
  ComposeChatMessage,
  ComposeConversionStatus,
  ComposeHandoffResult,
  ComposeOpenQuestion,
  ComposeReadiness,
  ComposeRepositoryOption,
  ComposeSessionExportBundle,
  ComposeSessionSummary,
  ComposeSourceSummary,
  ComposeStreamEvent,
} from "./composeTypes.js";
```

Add state (after `const [streamToken, ...]` from Task 5):

```ts
  const [activeQuestion, setActiveQuestion] = useState<ComposeOpenQuestion | null>(
    null,
  );
  const [chatPoppedOut, setChatPoppedOut] = useState(false);
```

Add an Esc handler effect (after the existing effects, near line 198):

```ts
  useEffect(() => {
    if (!chatPoppedOut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setChatPoppedOut(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [chatPoppedOut]);
```

When a new readiness arrives, reconcile the active question (so an answered question's resolved state shows and a removed question clears). In `onStreamEvent`'s readiness branch (line 246-247):

```ts
      } else if (event.type === "readiness") {
        setReadiness(event.readiness);
        setActiveQuestion((prev) =>
          prev
            ? (event.readiness.questions?.find((q) => q.id === prev.id) ?? null)
            : prev,
        );
      }
```

Extract the ChatPanel into a reusable element so the overlay reuses it. Replace the inline `<ChatPanel .../>` (lines 523-553) by first building the shared props. Define a `renderChatPanel` helper inside the component, before the `return`:

```tsx
  const chatPanelEl = (
    <ChatPanel
      sessionId={sessionId}
      messages={messages}
      thinking={thinking}
      progressMessage={progressMessage}
      retryStatus={retryStatus}
      contextSummary={readiness?.summary ?? null}
      openQuestions={readiness?.openQuestions ?? []}
      activeQuestion={activeQuestion}
      onPopOut={() => setChatPoppedOut((v) => !v)}
      isPoppedOut={chatPoppedOut}
      onSend={(content) =>
        guarded(async () => {
          const localMessage = createLocalMessage(sessionId, "user", content);
          setMessages((prev) => [...prev, localMessage]);
          setThinking(true);
          setProgressMessage("Sending message");
          try {
            await composeApi.postMessage(sessionId, content);
          } catch (error) {
            setMessages((prev) =>
              prev.filter((message) => message.id !== localMessage.id),
            );
            setThinking(false);
            setProgressMessage(null);
            throw error;
          }
        })
      }
    />
  );
```

Replace the inline ChatPanel usage in the layout with `{chatPanelEl}`.

Pass `onSelectQuestion` to PreviewPanel (the `<PreviewPanel ...>` at line 604):

```tsx
      <PreviewPanel
        readiness={readiness}
        handingOff={handingOff}
        handoffBlockedReason={handoffBlockedReason(sources)}
        generatedSourceId={activeSourceId}
        onSelectQuestion={(question) => setActiveQuestion(question)}
        onGenerate={() => {
```

Add the overlay near the end of the returned JSX, before the closing `</section>` (after the `draftAnywayConfirmOpen` block at line 636):

```tsx
      {chatPoppedOut ? (
        <div
          className="sf-chat-fullscreen-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Compose chat full screen"
        >
          <div className="sf-chat-fullscreen">{chatPanelEl}</div>
        </div>
      ) : null}
```

NOTE: rendering `chatPanelEl` in two places at once would duplicate React keys/DOM. Guard the inline instance so only one renders at a time — replace `{chatPanelEl}` in the normal layout with:

```tsx
      {chatPoppedOut ? <div className="sf-chat-placeholder" aria-hidden="true" /> : chatPanelEl}
```

Clear pop-out + active question in `returnToSessionPicker` (line 387) and `handleDeleteSession` cleanup:

```ts
    setActiveQuestion(null);
    setChatPoppedOut(false);
```

Add CSS to `dashboard/src/spec-factory/SpecFactoryPage.css` (same stylesheet as Tasks 11-12):

```css
.sf-chat-fullscreen-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.75);
  display: flex;
  padding: 2.5vh 2.5vw;
}
.sf-chat-fullscreen {
  margin: auto;
  width: min(1100px, 95vw);
  height: 95vh;
  display: flex;
  flex-direction: column;
  background: var(--sf-surface, #fff);
  border-radius: 0.75rem;
  font-size: 1.05rem;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx`
Expected: PASS (existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ComposeWorkspace.tsx dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx dashboard/src
git commit -m "feat(compose): wire question tiles, A/B/C answers, and full-screen chat overlay (#3/#5/#7)"
```

---

## Final verification

### Task 14: Full suite + typecheck

- [ ] **Step 1: Backend tests**

Run: `npx vitest run src/spec-factory`
Expected: PASS (all spec-factory suites).

- [ ] **Step 2: Frontend tests**

Run: `cd dashboard && npx vitest run src/spec-factory/compose`
Expected: PASS.

- [ ] **Step 3: Typecheck both projects**

Run: `npx tsc --noEmit` (root) and `cd dashboard && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit any fixes, then open the PR**

```bash
git add -A && git commit -m "test(compose): guided Q&A + draft fidelity final verification" || true
```

Open the PR against `main`; title: "Compose: guided Q&A, summary, pop-out + draft fidelity (#1/#2/#3/#4/#5/#6/#7)".

---

## Self-Review

**Spec coverage:**
- #1 (draft drops stories): Tasks 1 (schema), 2 (persist), 3 (agent schema), 6 (manifest carries stories), 7 (draft one-per-story + fallback), 8 (agent maintains stories). ✓
- #4 (protected sources invisible): Tasks 4 (api token), 5 (stream token + workspace plumbing). ✓
- #2 (fixed/scrollable summary + ideating/problem): Tasks 1/2/3/9 (fields + agent), 10 (FE type), 11 (FE render in scrollable container). ✓
- #3 (pop-out full-screen): Tasks 12 (control), 13 (overlay). ✓
- #5 (clickable tiles, pick-first): Tasks 9 (pick-first prompt), 11 (tiles), 13 (selection → active question). ✓
- #6 (precise questions): Task 9. ✓
- #7 (A/B/C options): Tasks 3/9 (options field + prompt), 11 (tile shows), 12 (A/B/C buttons → postMessage), 13 (wiring). ✓
- No migration: all fields in `readiness_json`; Global Constraints + every task honor it. ✓
- Back-compat: `openQuestions` kept; PreviewPanel checklist + prose summary fallbacks (Task 11); per-repo draft fallback (Task 7). ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. The two FE test tasks that depend on the existing suite's session-open helper (Task 13) and possible test-file existence (Tasks 3, 6, 9) include explicit `ls`/`grep` discovery steps and a concrete fallback (full file header) rather than a placeholder.

**Type consistency:** `ComposeStory`/`ComposeOpenQuestion` field names (`id`, `title`, `summary`, `repos`, `sequence`; `id`, `question`, `options`, `answered`, `answer`) are identical across backend `compose-types.ts` (Task 1), DB parse (Task 2), agent schema (Task 3), manifest (Task 6), and frontend `composeTypes.ts` (Task 10). `streamToken` consistent across Tasks 4/5. `onSelectQuestion`, `activeQuestion`, `onPopOut`, `isPoppedOut` prop names consistent across Tasks 11/12/13. Draft directive strings asserted in Task 7 match exactly what Task 7 writes.
