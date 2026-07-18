# Compose UX Fixes: Summary-in-Chat, Open Questions, Re-analyze Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five Compose UX fixes — move Ideating/Problem into the chat's Context Summary (drop the prose summary), rename "Pending items" → "Open Questions", make an Open-Question click inject the question as an agent chat turn + show A/B/C chips above the input, add a confirm-dialog + full backend reset when re-analyzing an in-progress session, and replace the pop-out text button with icons.

**Architecture:** Mostly dashboard React changes in three Compose components (`ChatPanel.tsx`, `PreviewPanel.tsx`, `ComposeWorkspace.tsx`) plus their CSS. One small backend addition: a `ComposeRepository.resetSessionProgress` method and an optional `reset` flag threaded through `ComposeService.analyze` → the analyze route → `composeApi.analyze`. No schema migration — the reset is DML on existing tables/columns.

**Tech Stack:** TypeScript (Node ESM, `.js` import specifiers), Express, MySQL2, React 18 + Vitest + Testing Library (jsdom), lucide-react icons.

## Global Constraints

- **No migration.** `resetSessionProgress` is DML on existing tables/columns.
- **`analyze` `reset` defaults to false / absent → today's behavior byte-for-byte.** The Louise/non-reset path must be unaffected.
- **ESM import specifiers** end in `.js` even for `.ts`/`.tsx` files (e.g. `./composeTypes.js`). Use `import type` for type-only imports (`verbatimModuleSyntax`).
- **Pop-out button accessible names stay verbatim:** `aria-label="Pop out chat"` (collapsed) and `aria-label="Exit full screen"` (popped out) — existing tests + accessibility depend on them.
- **Prose `readiness.summary` is dropped from the UI only** — it stays in the data model and export bundle untouched.
- **The injected Open-Question chat turn is frontend-only** (a negative local message id), never persisted.
- **Frontend RTL suites** call `afterEach(cleanup)`.
- **Run tests from the correct dir.** Backend: from worktree root `/tmp/cp-compose-ui`, `npx vitest run <path>`. Frontend: `cd dashboard && npx vitest run <path-relative-to-dashboard>` (jsdom env is declared per-file via `// @vitest-environment jsdom`).

---

## File Structure

**Backend (`src/spec-factory/`)**
- `compose-database.ts` — add `resetSessionProgress(sessionId)` (delete messages + null readiness/claude session/demote status).
- `compose-service.ts` — `analyze({ sessionId, repositoryIds, reset? })`: when `reset`, call `resetSessionProgress` before enqueuing. Add `"resetSessionProgress"` to the repo type the service consumes.
- `compose-routes.ts` — `POST /analyze` reads optional `reset` from the body.

**Frontend (`dashboard/src/spec-factory/compose/`)**
- `composeApi.ts` — `analyze(sessionId, repositoryIds, reset?)` sends `reset` in the body.
- `ChatPanel.tsx` — Context Summary renders Ideating/Problem from new props (drop `contextSummary`); pop-out icon button.
- `PreviewPanel.tsx` — remove the summary block; rename labels to "Open Questions".
- `ComposeWorkspace.tsx` — pass ideating/problem to ChatPanel; question-click injects an assistant turn; re-analyze confirm modal + reset call; icon import.
- `dashboard/src/spec-factory/SpecFactoryPage.css` — any CSS tweaks for the icon button / chip placement.

**Tests updated (behavior changed):** `ChatPanel.test.tsx`, `PreviewPanel.test.tsx`, `compose-service.test.ts`, `compose-database.test.ts`, `composeApi.test.ts`, `ComposeWorkspace.test.tsx`.

---

## Phase 1 — Backend reset

### Task 1: `ComposeRepository.resetSessionProgress`

**Files:**
- Modify: `src/spec-factory/compose-database.ts` (add method near `markSessionContextDirty` at ~:686)
- Test: `src/spec-factory/compose-database.test.ts`

**Interfaces:**
- Produces: `async resetSessionProgress(sessionId: number): Promise<void>` — runs `DELETE FROM compose_session_messages WHERE session_id = ?` then `UPDATE compose_sessions SET readiness_json = NULL, claude_session_id = NULL, status = CASE WHEN status = 'ready' THEN 'draft' ELSE status END WHERE id = ?`.

- [ ] **Step 1: Write the failing test**

Add to `src/spec-factory/compose-database.test.ts` inside `describe("ComposeRepository", ...)`:

```ts
  it("resetSessionProgress deletes messages and nulls readiness + claude session", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 3 }, []]) // DELETE messages
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]); // UPDATE session
    const repo = new ComposeRepository({
      query,
      getConnection: vi.fn(),
    } as never);

    await repo.resetSessionProgress(7);

    const deleteSql = String(query.mock.calls[0][0]);
    expect(deleteSql).toContain("DELETE FROM compose_session_messages");
    expect(query.mock.calls[0][1]).toEqual([7]);
    const updateSql = String(query.mock.calls[1][0]);
    expect(updateSql).toContain("readiness_json = NULL");
    expect(updateSql).toContain("claude_session_id = NULL");
    expect(query.mock.calls[1][1]).toEqual([7]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-database.test.ts -t "resetSessionProgress"`
Expected: FAIL — `repo.resetSessionProgress is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-database.ts`, add immediately after the `markSessionContextDirty` method (after its closing `}` at ~:695):

```ts
  // Full reset for re-analyze: drop the conversation and the derived state so a
  // fresh analyze starts a brand-new Claude session from the sources only.
  // Sources are intentionally untouched.
  async resetSessionProgress(sessionId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM compose_session_messages WHERE session_id = ?`,
      [sessionId],
    );
    await this.pool.query(
      `UPDATE compose_sessions
       SET readiness_json = NULL,
           claude_session_id = NULL,
           status = CASE WHEN status = 'ready' THEN 'draft' ELSE status END
       WHERE id = ?`,
      [sessionId],
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-database.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-database.ts src/spec-factory/compose-database.test.ts
git commit -m "feat(compose): add resetSessionProgress to clear chat + readiness + claude session"
```

---

### Task 2: `ComposeService.analyze` reset flag

**Files:**
- Modify: `src/spec-factory/compose-service.ts` (the consumed-repo type union ~:90-100, and `analyze` at ~:1269)
- Test: `src/spec-factory/compose-service.test.ts`

**Interfaces:**
- Consumes: `ComposeRepository.resetSessionProgress` (Task 1).
- Produces: `analyze(input: { sessionId: number; repositoryIds?: number[]; reset?: boolean }): Promise<ComposeTurnAccepted>` — when `input.reset === true`, calls `this.composeRepository.resetSessionProgress(input.sessionId)` before enqueuing the analyze turn.

- [ ] **Step 1: Write the failing test**

In `src/spec-factory/compose-service.test.ts`, first add `resetSessionProgress: vi.fn().mockResolvedValue(undefined),` to the `composeRepository` mock object in `buildService()` (insert after the `setReadiness:` line ~:56).

Then add a test inside `describe("ComposeService", ...)`:

```ts
  it("analyze with reset clears progress before enqueuing; without reset it does not", async () => {
    const { service, composeRepository, chatAgent } = buildService();
    chatAgent.run.mockResolvedValue({
      envelope: {
        reply: "ok",
        readiness: { ready: false, openQuestions: [], summary: "" },
      },
      sessionId: "claude-1",
      metrics: { durationMs: 1, toolCalls: 0 },
    });

    await service.analyze({ sessionId: 7, reset: true });
    await flushAsyncTurns();
    expect(composeRepository.resetSessionProgress).toHaveBeenCalledWith(7);

    composeRepository.resetSessionProgress.mockClear();
    await service.analyze({ sessionId: 7 });
    await flushAsyncTurns();
    expect(composeRepository.resetSessionProgress).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-service.test.ts -t "analyze with reset"`
Expected: FAIL — `resetSessionProgress` not called (the flag is ignored).

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-service.ts`, add `"resetSessionProgress"` to the `Pick<ComposeRepository, ...>` union the service consumes (the list that already contains `"setClaudeSessionId"`, `"setReadiness"`, `"markSessionContextDirty"` around :90-100). Add the line:

```ts
  | "resetSessionProgress"
```

Then change `analyze` (at ~:1269) to accept and honor `reset`:

```ts
  async analyze(input: {
    sessionId: number;
    repositoryIds?: number[];
    reset?: boolean;
  }): Promise<ComposeTurnAccepted> {
    await this.assertNoBlockedSources({
      sessionId: input.sessionId,
      blockedStatuses: ANALYZE_BLOCKING_STATUSES,
      message: (blocked) =>
        `Cannot analyze Compose session ${input.sessionId} until sources finish processing: ${formatBlockedSources(blocked)}`,
    });
    requireSession(
      await this.composeRepository.getSession(input.sessionId),
      input.sessionId,
    );
    if (input.reset) {
      await this.composeRepository.resetSessionProgress(input.sessionId);
    }
    const accepted = this.enqueueTurn({
      sessionId: input.sessionId,
      mode: "analyze",
      latestUserMessage: null,
      repositoryIds: input.repositoryIds,
    });
    return accepted ? { accepted: true } : { accepted: false, reason: "queue_full" };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-service.test.ts`
Expected: PASS (the new test + all existing analyze tests, which call `analyze({ sessionId: 7 })` without `reset` and must still not call `resetSessionProgress`).

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-service.ts src/spec-factory/compose-service.test.ts
git commit -m "feat(compose): analyze accepts optional reset flag to clear session first"
```

---

### Task 3: analyze route reads `reset` from the body

**Files:**
- Modify: `src/spec-factory/compose-routes.ts` (the `POST /sessions/:sessionId/analyze` handler at ~:395)
- Test: `src/spec-factory/compose-routes.test.ts` (already exists — has a real `http` server harness via `makeService()`/`start()`/`ctx.request()`; NO supertest in this repo)

**Interfaces:**
- Consumes: `ComposeService.analyze` reset flag (Task 2).
- Produces: the route passes `reset: req.body?.reset === true` into `service.analyze`.

- [ ] **Step 1: Update the existing test + add a reset case**

`src/spec-factory/compose-routes.test.ts` already exists and uses this pattern: a `makeService()` mock, an `async start(service)` that boots a real `http` server and returns `ctx.request(path, init)` → `{ status, body }`. **Do NOT add supertest** (it is not a dependency).

First, the existing test `"POST /sessions/:id/analyze accepts the turn ..."` (~:491-510) asserts `service.analyze` was called with `{ sessionId: 7, repositoryIds: [3, 5] }`. Adding `reset` to the route call will change that — update its assertion to include `reset: false`:

```ts
    expect(service.analyze).toHaveBeenCalledWith({
      sessionId: 7,
      repositoryIds: [3, 5],
      reset: false,
    });
```

Then add a new test (mirroring the existing one's harness) right after it:

```ts
  it("POST /sessions/:id/analyze forwards reset=true from the body", async () => {
    const service = makeService();
    service.analyze.mockResolvedValue({ accepted: true });
    const ctx = await start(service);
    server = ctx.server;
    const res = await ctx.request(
      "/api/spec-factory/compose/sessions/7/analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryIds: [3], reset: true }),
      },
    );
    expect(res.status).toBe(202);
    expect(service.analyze).toHaveBeenCalledWith({
      sessionId: 7,
      repositoryIds: [3],
      reset: true,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/spec-factory/compose-routes.test.ts -t "analyze"`
Expected: FAIL — the route calls `service.analyze({ sessionId, repositoryIds })` with no `reset` (the updated existing assertion expecting `reset: false` and the new `reset: true` test both fail).

- [ ] **Step 3: Write minimal implementation**

In `src/spec-factory/compose-routes.ts`, update the analyze handler (~:395-404):

```ts
  router.post("/sessions/:sessionId/analyze", async (req, res) => {
    try {
      const sessionId = positiveInt(req.params.sessionId, "sessionId");
      const repositoryIds = repositoryIdsFromBody(req.body?.repositoryIds);
      const reset = req.body?.reset === true;
      const result = await service.analyze({ sessionId, repositoryIds, reset });
      res.status(turnAcceptStatus(result)).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/spec-factory/compose-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-routes.ts src/spec-factory/compose-routes.test.ts
git commit -m "feat(compose): analyze route forwards reset flag from request body"
```

---

## Phase 2 — composeApi reset flag

### Task 4: `composeApi.analyze` sends `reset`

**Files:**
- Modify: `dashboard/src/spec-factory/compose/composeApi.ts` (`analyze` at ~:189)
- Test: `dashboard/src/spec-factory/compose/composeApi.test.ts`

**Interfaces:**
- Produces: `analyze(sessionId: number, repositoryIds?: number[], reset?: boolean): Promise<ComposeTurnAccepted>` — body is `{ repositoryIds, reset }`, `reset` defaulting to `false`.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/composeApi.test.ts` inside `describe("composeApi", ...)`:

```ts
  it("analyze sends reset flag in the body (default false)", async () => {
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true }));
    await api.analyze(7, [3], true);
    let [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ repositoryIds: [3], reset: true });

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue(ok({ accepted: true }));
    await api.analyze(7, [3]);
    [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ repositoryIds: [3], reset: false });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/composeApi.test.ts -t "reset flag"`
Expected: FAIL — body has no `reset` field.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/composeApi.ts`, replace `analyze` (~:189):

```ts
export function analyze(
  sessionId: number,
  repositoryIds: number[] = [],
  reset = false,
): Promise<ComposeTurnAccepted> {
  return requestJson<ComposeTurnAccepted>(
    `${BASE}/sessions/${sessionId}/analyze`,
    { method: "POST", body: JSON.stringify({ repositoryIds, reset }) },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/composeApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/composeApi.ts dashboard/src/spec-factory/compose/composeApi.test.ts
git commit -m "feat(compose): composeApi.analyze sends reset flag"
```

---

## Phase 3 — ChatPanel: summary from ideating/problem + icon button

### Task 5: ChatPanel Context Summary renders Ideating/Problem; drop `contextSummary`

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Produces: ChatPanel props gain `ideating?: string | null` and `problem?: string | null`; the `contextSummary` prop is **removed**. The `.sf-chat-context-summary` block renders an "Ideating" row and/or a "Problem" row when present; `hasContextSummary = Boolean(ideating?.trim() || problem?.trim())`.

- [ ] **Step 1: Write the failing test**

In `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`:

Replace the test `"shows a context summary above the conversation when available"` (lines ~72-88) with:

```ts
  it("shows Ideating and Problem in the context summary when available", () => {
    const { container } = render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        ideating="Shaping a CSV export epic."
        problem="Operators cannot export billing data."
      />,
    );
    const summary = screen.getByRole("article", { name: /Context summary/i });
    expect(within(summary).getByText(/Ideating/i)).toBeTruthy();
    expect(within(summary).getByText("Shaping a CSV export epic.")).toBeTruthy();
    expect(within(summary).getByText(/Problem/i)).toBeTruthy();
    expect(
      within(summary).getByText("Operators cannot export billing data."),
    ).toBeTruthy();
    expect(
      container.querySelector(".sf-chat-panel.has-context-summary"),
    ).toBeTruthy();
  });
```

Then update the other tests that pass `contextSummary=` to pass `ideating=` instead (they only need the summary to exist so `.has-context-summary` is set):
- `"keeps open questions out of the context summary and starts the agent chat"` (~:129): change `contextSummary="Need repository and scope."` → `ideating="Need repository and scope."`.
- `"does not duplicate the first open question when it is already in chat"` (~:153): change `contextSummary="Need repository."` → `ideating="Need repository."`.
- `"splits question-prefixed user messages into an agent prompt and user answer"` (~:175): change `contextSummary="Need repository."` → `ideating="Need repository."`.

Ensure `within` is imported from `@testing-library/react` in this file (it is used elsewhere in the suite already).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "Ideating and Problem"`
Expected: FAIL — ChatPanel has no `ideating`/`problem` props; the summary block still keys off `contextSummary`.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`:

Change the prop destructure + type (remove `contextSummary`, add `ideating`/`problem`) at ~:96-120:

```tsx
export function ChatPanel({
  messages,
  onSend,
  thinking,
  progressMessage,
  ideating = null,
  problem = null,
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
  ideating?: string | null;
  problem?: string | null;
  openQuestions?: string[];
  sessionId?: number | null;
  retryStatus?: ComposeRetryStatus | null;
  activeQuestion?: ComposeOpenQuestion | null;
  onPopOut?: () => void;
  isPoppedOut?: boolean;
}) {
```

Change the `hasContextSummary` computation (~:131):

```tsx
  const ideatingText = ideating?.trim() ?? "";
  const problemText = problem?.trim() ?? "";
  const hasContextSummary = Boolean(ideatingText || problemText);
```

Replace the context-summary `<article>` block (~:225-233) with:

```tsx
      {hasContextSummary ? (
        <article
          className="sf-chat-context-summary"
          aria-label="Context summary"
        >
          <span>Context summary</span>
          {ideatingText ? (
            <div className="sf-chat-summary-row" aria-label="Ideating">
              <strong>Ideating</strong>
              <p>{ideatingText}</p>
            </div>
          ) : null}
          {problemText ? (
            <div className="sf-chat-summary-row" aria-label="Problem">
              <strong>Problem</strong>
              <p>{problemText}</p>
            </div>
          ) : null}
        </article>
      ) : null}
```

(The `isInitialAnalyzeReply` suppression in `visibleMessages` already references `hasContextSummary` — leave it; it now keys off ideating/problem, which is correct.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS (the rewritten + updated tests; the CSS flex-layout tests at ~:90-127 are unaffected).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx
git commit -m "feat(compose): chat context summary shows Ideating/Problem instead of prose summary"
```

---

### Task 6: Pop-out icon button

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx` (the pop-out button ~:213-224, and imports)
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: existing `onPopOut`/`isPoppedOut` props.
- Produces: the pop-out button renders a lucide `Maximize2` icon when collapsed and `X` when popped out; `aria-label` stays `"Pop out chat"` / `"Exit full screen"`.

- [ ] **Step 1: Write the failing test**

Add to `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`:

```ts
  it("renders the pop-out control as an icon button with stable aria-labels", () => {
    const onPopOut = vi.fn();
    const { rerender } = render(
      <ChatPanel messages={[]} onSend={vi.fn()} thinking={false} onPopOut={onPopOut} />,
    );
    const popBtn = screen.getByRole("button", { name: /Pop out chat/i });
    // Icon-only: the visible text is not the words "Pop out"
    expect(popBtn.textContent?.trim()).toBe("");
    expect(popBtn.querySelector("svg")).toBeTruthy();
    fireEvent.click(popBtn);
    expect(onPopOut).toHaveBeenCalled();

    rerender(
      <ChatPanel messages={[]} onSend={vi.fn()} thinking={false} onPopOut={onPopOut} isPoppedOut />,
    );
    const exitBtn = screen.getByRole("button", { name: /Exit full screen/i });
    expect(exitBtn.querySelector("svg")).toBeTruthy();
    expect(exitBtn.textContent?.trim()).toBe("");
  });
```

Ensure `fireEvent` is imported from `@testing-library/react` in this file (it is used elsewhere already).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "icon button with stable aria-labels"`
Expected: FAIL — the button renders the text "Pop out" / "Exit full screen", not an `<svg>`.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`, add the icon import at the top (after the React import):

```tsx
import { Maximize2, X } from "lucide-react";
```

Replace the pop-out button block (~:213-224) with:

```tsx
      {onPopOut ? (
        <div className="sf-chat-toolbar">
          <button
            type="button"
            className="sf-chat-popout"
            onClick={onPopOut}
            aria-label={isPoppedOut ? "Exit full screen" : "Pop out chat"}
            title={isPoppedOut ? "Exit full screen" : "Pop out chat"}
          >
            {isPoppedOut ? (
              <X size={16} aria-hidden="true" />
            ) : (
              <Maximize2 size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : null}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx
git commit -m "feat(compose): pop-out control uses maximize/close icons"
```

---

## Phase 4 — PreviewPanel: drop summary + rename to Open Questions

### Task 7: Remove the Preview summary block; rename "Pending items" → "Open Questions"

**Files:**
- Modify: `dashboard/src/spec-factory/compose/PreviewPanel.tsx`
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`

**Interfaces:**
- Produces: PreviewPanel no longer renders the `.sf-preview-summary` / Ideating / Problem block; the Open-Questions section label reads "Open Questions" in both the tiles branch and the legacy checklist branch; the legacy `<ul>` and the tile group use `aria-label="Open Questions"`.

- [ ] **Step 1: Write the failing test**

In `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`:

1. Delete the test `"renders Ideating and Problem blocks when present"` (lines ~284-305) — the block no longer exists in Preview.

2. Add a guard test:

```ts
  it("does not render an Ideating/Problem/Summary block in the preview", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["Which repo?"],
          summary: "prose summary",
          ideating: "shaping",
          problem: "the problem",
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("article", { name: /Ideating/i })).toBeNull();
    expect(screen.queryByRole("article", { name: /Problem/i })).toBeNull();
    expect(screen.queryByLabelText(/Session summary/i)).toBeNull();
  });
```

3. Update the three `name: /Pending items/i` queries (lines ~54, ~113, ~198) to `name: /Open Questions/i`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx -t "does not render an Ideating"`
Expected: FAIL — the Ideating article still renders.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/PreviewPanel.tsx`:

1. Remove the summary locals (lines ~118-121): delete `const ideating = ...`, `const problem = ...`, `const hasStructuredSummary = ...`, `const fallbackSummary = ...`. Keep `const structuredQuestions = readiness.questions ?? [];`.

2. Remove the entire summary JSX block (lines ~130-152, the `{hasStructuredSummary ? (...) : fallbackSummary ? (...) : null}` expression) so `.sf-preview-body` starts with the Details `<article>`.

3. Rename the labels:
   - Tiles branch (~:193): `<span className="sf-section-label">Pending items</span>` → `Open Questions`.
   - Tiles `role="group"` (~:197): `aria-label="Pending questions"` → `aria-label="Open Questions"`.
   - Legacy checklist branch (~:220): `<span className="sf-section-label">Pending items</span>` → `Open Questions`.
   - Legacy `<ul>` (~:221): `aria-label="Pending items"` → `aria-label="Open Questions"`.

4. If `normalizedText` becomes unused after removing the summary locals, leave it — it's still used by `inferModule`/`previewDetails`. (Verify no unused-var lint error; `normalizedText` is used in `previewDetails`/`inferModule`, so it stays.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/PreviewPanel.tsx dashboard/src/spec-factory/compose/PreviewPanel.test.tsx
git commit -m "feat(compose): drop preview summary block; rename Pending items to Open Questions"
```

---

## Phase 5 — ComposeWorkspace wiring

### Task 8: Pass ideating/problem to ChatPanel; inject question as agent turn on select

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx` (the `chatPanelEl` props ~:486, the `onSelectQuestion` ~:655)
- Test: `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`

**Interfaces:**
- Consumes: ChatPanel `ideating`/`problem` props (Task 5); `PreviewPanel.onSelectQuestion` (existing).
- Produces: ChatPanel receives `ideating={readiness?.ideating ?? null}` + `problem={readiness?.problem ?? null}` (no `contextSummary`); clicking an Open Question injects an assistant local message with the question text (deduped) AND sets `activeQuestion`.

- [ ] **Step 1: Update the existing analyze test, then write the failing test**

This suite drives the REAL component through a global `fetch` stub (no `composeApi` module mock). Key harness facts (read the file to confirm): `lastAnalyzeBody` captures the parsed analyze request body; `FakeEventSource.instances[0].listeners.readiness({ data: JSON.stringify({ type: "readiness", readiness: {...} }) })` injects a readiness SSE event; a session is opened via the "New Session" → "Create session" flow; the chat window is `.sf-chat-window` (`aria-label="Compose conversation"`).

First, the existing test `"runs Analyze and surfaces readiness open questions"` (~:423-477) will break from this phase's changes — update it:
- Line ~452: `expect(lastAnalyzeBody).toEqual({ repositoryIds: [3] });` → `expect(lastAnalyzeBody).toEqual({ repositoryIds: [3], reset: false });` (Task 4 added `reset`). NOTE: this assumes the session is fresh (no readiness yet) so no confirm dialog — which is the case at that point in the test.
- Lines ~473-476: the assertion querying the `"Context summary"` article for `"Which repo?"` — the readiness it injects has only `summary: "Need repo."` (no ideating/problem), so after Task 8 the Context Summary block won't render at all. Change these lines to assert the question shows as an agent turn instead (it already asserts the `Mendel question` article at ~:468-472), and drop the now-invalid Context-summary query, OR inject `ideating: "Need repo."` in the readiness payload and keep a Context-summary assertion. Pick injecting `ideating`: in the readiness payload (~:460-464) add `ideating: "Need repo.",` and change the ~:473-476 block to assert the Context Summary contains "Need repo." and not "Which repo?":

```ts
    expect(
      within(screen.getByRole("article", { name: /Context summary/i }))
        .queryByText("Which repo?"),
    ).toBeNull();
    expect(
      within(screen.getByRole("article", { name: /Context summary/i }))
        .getByText("Need repo."),
    ).toBeTruthy();
```

Then add the new test (mirror the open-session + readiness-injection flow; inject readiness with a structured `questions` array, then click the Open-Questions tile in the Preview):

```ts
  it("injects the picked open question into the chat as an agent turn", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: false,
            openQuestions: ["Which repo owns the change?"],
            summary: "",
            ideating: "Shaping it.",
            questions: [
              { id: "q-1", question: "Which repo owns the change?", options: ["a", "b"] },
            ],
          },
        }),
      });
    });
    // click the Open Questions tile in the Preview
    const tile = await screen.findByRole("button", {
      name: /Which repo owns the change/i,
    });
    fireEvent.click(tile);
    // the question now appears as an agent turn in the chat window
    const convo = document.querySelector(".sf-chat-window") as HTMLElement;
    await waitFor(() =>
      expect(within(convo).getByText(/Which repo owns the change/i)).toBeTruthy(),
    );
  });
```

NOTE: confirm `act`, `waitFor`, `within` are imported (they are, per the suite header). Keep `afterEach(cleanup)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx -t "injects the picked open question"`
Expected: FAIL — clicking the tile sets the active question but does not add a chat message.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`:

1. In `chatPanelEl` (~:479-514), replace `contextSummary={readiness?.summary ?? null}` with:

```tsx
      ideating={readiness?.ideating ?? null}
      problem={readiness?.problem ?? null}
```

2. Replace the PreviewPanel `onSelectQuestion` (~:655) with a handler that injects the question as an assistant turn (deduped) and sets the active question:

```tsx
        onSelectQuestion={(question) => {
          if (sessionId !== null) {
            const text = question.question.trim();
            setMessages((prev) => {
              const alreadyShown = prev.some(
                (m) => m.role === "assistant" && m.content.trim() === text,
              );
              if (alreadyShown) return prev;
              return [...prev, createLocalMessage(sessionId, "assistant", text)];
            });
          }
          setActiveQuestion(question);
        }}
```

(`createLocalMessage(id, role, content)` exists at ~:166 and accepts `"assistant"`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ComposeWorkspace.tsx dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx
git commit -m "feat(compose): chat shows Ideating/Problem; picking a question adds it as an agent turn"
```

---

### Task 9: Re-analyze confirm modal + full reset

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx` (state, the SourcesPanel `onAnalyze` ~:583, a new `ReanalyzeConfirmModal` near `DraftAnywayConfirmModal` ~:714)
- Test: `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`

**Interfaces:**
- Consumes: `composeApi.analyze(sessionId, repositoryIds, reset)` (Task 4).
- Produces: a fresh session's Analyze calls `analyze(..., false)` with no dialog; an in-progress session's Analyze (`messages.length > 0 || readiness != null`) opens `ReanalyzeConfirmModal`; confirming clears local `messages`/`readiness`/`activeQuestion` then calls `analyze(..., true)`.

- [ ] **Step 1: Write the failing test**

Use the suite's real harness (`lastAnalyzeBody` for the analyze body; `FakeEventSource...readiness(...)` to put the session "in progress"; the New Session → Create flow to open a session). There is NO `composeApi` mock in this suite. Add:

```ts
  it("re-analyzing an in-progress session asks for confirmation then resets", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });
    // make the session "in progress" by injecting readiness
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: { ready: false, openQuestions: [], summary: "", ideating: "x" },
        }),
      });
    });
    // add a note so Analyze is enabled
    fireEvent.click(screen.getByRole("button", { name: /Add sources/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sketch Pad/i }));
    fireEvent.change(screen.getByLabelText("Sketch pad / manual notes"), {
      target: { value: "Repo is billing-service" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add note$/i }));

    lastAnalyzeBody = null;
    fireEvent.click(
      await screen.findByRole("button", { name: /Analyze Sources/i }),
    );
    // confirm dialog appears; analyze NOT yet sent
    const confirm = await screen.findByRole("button", { name: /Reset & analyze/i });
    expect(lastAnalyzeBody).toBeNull();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(lastAnalyzeBody).toEqual({ repositoryIds: [], reset: true }),
    );
  });

  it("analyzing a fresh session does not prompt and sends reset=false", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: /New Session/i }));
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });
    // fresh session: no readiness injected, add a note to enable Analyze
    fireEvent.click(screen.getByRole("button", { name: /Add sources/i }));
    fireEvent.click(screen.getByRole("button", { name: /Sketch Pad/i }));
    fireEvent.change(screen.getByLabelText("Sketch pad / manual notes"), {
      target: { value: "Repo is billing-service" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add note$/i }));

    lastAnalyzeBody = null;
    fireEvent.click(
      await screen.findByRole("button", { name: /Analyze Sources/i }),
    );
    await waitFor(() =>
      expect(lastAnalyzeBody).toEqual({ repositoryIds: [], reset: false }),
    );
    expect(screen.queryByRole("button", { name: /Reset & analyze/i })).toBeNull();
  });
```

NOTE: this assumes the `fetch` stub's `/analyze` handler keeps recording `lastAnalyzeBody = JSON.parse(init.body)` (it does, ~:247-248). The fresh-session case must NOT have injected readiness and must have an empty `messages` list (the suite's `/messages` fetch returns `[]`). If the suite's note-add flow happens to inject a readiness or message that trips `hasProgress`, open a brand-new session id with no readiness for the fresh case.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx -t "re-analyzing an in-progress"`
Expected: FAIL — there is no confirm dialog; analyze is called immediately without a `reset` arg.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`:

1. Add state near the other `useState` declarations (e.g. after `draftAnywayConfirmOpen`):

```tsx
  const [reanalyzeConfirmOpen, setReanalyzeConfirmOpen] = useState(false);
```

2. Add a helper (above the `return`) that runs the analyze call:

```tsx
  const runAnalyze = useCallback(
    (reset: boolean) =>
      guarded(async () => {
        if (sessionId === null) return;
        if (reset) {
          setMessages([]);
          setReadiness(null);
          setActiveQuestion(null);
        }
        setAnalyzing(true);
        setProgressMessage("Starting analysis");
        try {
          await composeApi.analyze(sessionId, selectedRepositoryIds, reset);
          setThinking(true);
        } catch (error) {
          setAnalyzing(false);
          setThinking(false);
          setProgressMessage(null);
          throw error;
        }
      }),
    [guarded, sessionId, selectedRepositoryIds],
  );
```

3. Replace the SourcesPanel `onAnalyze` (~:583-597) with:

```tsx
        onAnalyze={() => {
          const hasProgress = messages.length > 0 || readiness !== null;
          if (hasProgress) {
            setReanalyzeConfirmOpen(true);
            return;
          }
          void runAnalyze(false);
        }}
```

4. Add the modal render near the `draftAnywayConfirmOpen` block (~:674-683):

```tsx
      {reanalyzeConfirmOpen ? (
        <ReanalyzeConfirmModal
          onCancel={() => setReanalyzeConfirmOpen(false)}
          onConfirm={() => {
            setReanalyzeConfirmOpen(false);
            void runAnalyze(true);
          }}
        />
      ) : null}
```

5. Clear the flag in `returnToSessionPicker` and the `handleDeleteSession` cleanup (add `setReanalyzeConfirmOpen(false);` alongside the other resets there).

6. Add the modal component near `DraftAnywayConfirmModal` (~:714):

```tsx
function ReanalyzeConfirmModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="sf-source-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="sf-source-modal sf-draft-anyway-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-reanalyze-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sf-source-modal-header">
          <h2 id="sf-reanalyze-title">Re-analyze and reset this session?</h2>
          <p>
            Re-analyzing clears all chat progress, open questions, and the
            current preview, then restarts analysis from your sources. Your
            sources are kept.
          </p>
        </header>
        <div className="sf-compose-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="is-danger" onClick={onConfirm}>
            Reset &amp; analyze
          </button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ComposeWorkspace.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ComposeWorkspace.tsx dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx
git commit -m "feat(compose): confirm + full reset when re-analyzing an in-progress session"
```

---

## Final verification

### Task 10: Full suites + typecheck + browser check + PR

- [ ] **Step 1: Backend tests**

Run (from `/tmp/cp-compose-ui`): `npx vitest run --root . src/spec-factory --exclude '**/dashboard/**'`
Expected: PASS.

- [ ] **Step 2: Frontend tests**

Run: `cd dashboard && npx vitest run src/spec-factory/compose`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit` (root) — Expected: clean.
Run: `cd dashboard && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "spec-factory/compose"` — Expected: `0` (pre-existing investigation/oneshot/server errors are unrelated; only compose count must be 0).
Run: `cd dashboard && npx tsc -p tsconfig.server.json --noEmit` — Expected: clean.

- [ ] **Step 4: Browser visual check (CSS / layout)**

Build a static harness pointing at the real CSS and render the ChatPanel (Context Summary with Ideating+Problem rows, A/B/C chips above the dock input) and confirm the chips sit in the dock above the textarea (not inside the scroll window) and the icon button shows. If the chips read as "inside the chat", add minimal CSS in `dashboard/src/spec-factory/SpecFactoryPage.css` to anchor `.sf-chat-options` within `.sf-chat-dock` above the textarea, and add a test asserting that CSS string. (Use Chrome DevTools MCP as in the prior layout fix.)

- [ ] **Step 5: Commit any CSS fix, then open the PR**

```bash
git add -A && git commit -m "style(compose): anchor A/B/C chips above the chat input" || true
git push -u origin fix/compose-summary-questions-ux
```

Open the PR against `main`; title: "Compose UX: summary-in-chat, Open Questions, re-analyze reset, icon pop-out".

---

## Self-Review

**Spec coverage:**
- #1 (summary into chat, drop prose): Task 5 (ChatPanel renders Ideating/Problem, drops `contextSummary`), Task 7 (Preview drops summary block), Task 8 (workspace passes ideating/problem). ✓
- #2 (rename to Open Questions): Task 7 (both labels + aria-labels). ✓
- #3 (question → agent turn + A/B/C above input): Task 8 (inject assistant turn + setActiveQuestion); A/B/C chips already render in the dock above the textarea (ChatPanel `:296-318`), verified in Task 10 Step 4. ✓
- #4 (re-analyze confirm + full reset): Task 1 (resetSessionProgress), Task 2 (analyze reset flag), Task 3 (route), Task 4 (composeApi), Task 9 (confirm modal + reset wiring). ✓
- #5 (icon pop-out): Task 6. ✓
- No migration: only DML in Task 1. ✓
- Back-compat: `reset` default false (Tasks 2/3/4); prose summary kept in data model (only removed from UI). ✓

**Placeholder scan:** No TBD/TODO. The two tasks that depend on the existing suite's session-open helper (Tasks 8, 9) and the routes-test dependency (Task 3) carry explicit discovery steps + a concrete fallback rather than a vague placeholder. Task 10 Step 4's CSS adjustment is conditional-on-observation (verification), not a placeholder.

**Type consistency:** `resetSessionProgress(sessionId: number): Promise<void>` identical in Task 1 (impl), Task 2 (service call + mock), Task 9 (via analyze). `analyze` signature `{ sessionId, repositoryIds?, reset? }` consistent across Tasks 2/3; `composeApi.analyze(sessionId, repositoryIds?, reset?)` consistent across Tasks 4/9. ChatPanel props `ideating?`/`problem?` (drop `contextSummary`) consistent across Tasks 5/8. `createLocalMessage(id, role, content)` matches the existing signature used in Task 8.
