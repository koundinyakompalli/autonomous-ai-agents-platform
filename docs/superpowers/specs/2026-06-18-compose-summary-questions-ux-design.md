# Compose UX Fixes: Summary-in-Chat, Open Questions, Re-analyze Reset — Design

**Date:** 2026-06-18
**Status:** Approved (design) — pending implementation plan
**Scope:** Spec Factory **Compose** workspace UI (chat + preview panels) plus a small
backend addition for the re-analyze reset. Five operator-feedback items, all in the
Compose surface. No data-model migration — the only persisted change reuses existing
columns.

## Items covered

| # | Item | Type |
|---|---|---|
| 1 | Ideating + Problem belong in the chat's **Context Summary**, not Preview; drop the prose summary | UX |
| 2 | Rename Preview's **"Pending items"** → **"Open Questions"** | Copy |
| 3 | Clicking an Open Question injects it into the chat as an **agent turn** and shows **A/B/C chips above the input** (custom typing still allowed) | UX/flow |
| 4 | Re-analyzing an in-progress session shows a **confirm dialog** and performs a **full reset** (clear chat, readiness, Claude session; keep sources) | UX + backend |
| 5 | Replace the pop-out **text** button with a **maximize icon**; "Exit full screen" with a **close icon** | Copy/UX |

## Current behavior (verified in code, `origin/main` @ 3613e61)

- **#1:** `PreviewPanel.tsx:130-152` renders `Ideating`/`Problem` blocks in a
  `.sf-preview-summary` container. `ChatPanel.tsx:225-233` renders the *prose*
  `readiness.summary` as the "Context summary" block (fed by
  `ComposeWorkspace.tsx:486` `contextSummary={readiness?.summary ?? null}`).
- **#2:** `PreviewPanel.tsx:193` and `:220` label the section `"Pending items"`.
- **#3:** `onSelectQuestion` (`ComposeWorkspace.tsx:655`) only calls
  `setActiveQuestion(question)`. The A/B/C chips already render inside the chat dock
  above the textarea (`ChatPanel.tsx:296-318`), but the selected question is **not**
  added to the chat thread, so the interaction reads as "options floating in the chat
  area" rather than a Q&A turn.
- **#4:** `analyze()` (`compose-service.ts:1269`) does **not** reset; `runTurn`
  resumes the existing `claudeSessionId` (`:985`) and keeps prior messages/readiness.
  A `markSessionContextDirty(sessionId)` repo method (`compose-database.ts:686-695`)
  already nulls `readiness_json` + `claude_session_id` + demotes status — but does
  **not** delete chat messages.
- **#5:** `ChatPanel.tsx:213-224` renders a text button ("Pop out" / "Exit full
  screen"). `lucide-react` is already used in `ComposeWorkspace.tsx:2`.

## Architecture

### 1. Summary moves into the chat — `ChatPanel.tsx`, `PreviewPanel.tsx`, `ComposeWorkspace.tsx`

- **ChatPanel** gains two optional props `ideating?: string` and `problem?: string`
  and **drops** its dependence on the prose `contextSummary` for the summary block.
  The "Context Summary" `<article aria-label="Context summary">` now renders up to two
  labeled rows — **Ideating** and **Problem** — when present. `hasContextSummary`
  becomes `Boolean(ideating?.trim() || problem?.trim())` so the `.has-context-summary`
  layout class and the existing initial-analyze-reply suppression keep working.
- **`contextSummary` prop is removed** from ChatPanel (no consumer needs the prose
  summary anymore). Any logic that used `hasContextSummary` (e.g. suppressing the
  initial analyze reply) now keys off ideating/problem presence.
- **PreviewPanel** removes the `.sf-preview-summary` block (`:130-152`) and its
  `ideating`/`problem`/`hasStructuredSummary`/`fallbackSummary` locals. Preview keeps
  Details, Repo evidence, and Open Questions only.
- **ComposeWorkspace** passes `ideating={readiness?.ideating ?? null}` and
  `problem={readiness?.problem ?? null}` to ChatPanel; removes the `contextSummary`
  prop.

### 2. Rename to "Open Questions" — `PreviewPanel.tsx`

- Both section labels ("Pending items" at `:193` and `:220`) become **"Open
  Questions"**. The `<ul aria-label="Pending items">` (`:221`) becomes
  `aria-label="Open Questions"` for consistency. The `aria-label="Pending questions"`
  on the tile `role="group"` (`:197`) becomes `aria-label="Open Questions"`.

### 3. Question click → agent turn + chips above input — `ComposeWorkspace.tsx`, `ChatPanel.tsx`

- **ComposeWorkspace** `onSelectQuestion(question)` now:
  1. injects the question text as a **local assistant message** into `messages`
     (via the existing `createLocalMessage(sessionId, "assistant", question.question)`),
     deduped so re-clicking the same question doesn't double-add it, then
  2. `setActiveQuestion(question)` so the chips render.
  This makes the picked question read as "the agent asked this", matching the chat flow.
- **ChatPanel**: the A/B/C chips already live in the dock above the textarea
  (`:296-318`); confirm they render there (not inside the scroll window) and adjust CSS
  if the visual reads as "inside the chat". Clicking a chip sends the option text via
  the existing `onSend` (posts a user turn through the normal path). Custom typing in
  the textarea remains available. Chips are disabled while `thinking` (already the case).

### 4. Re-analyze full reset — confirm dialog + backend reset

- **Backend `ComposeRepository.resetSessionProgress(sessionId)`** (new): in one method,
  `DELETE FROM compose_session_messages WHERE session_id = ?`, then reuse the existing
  null-out (set `readiness_json = NULL`, `claude_session_id = NULL`, demote `ready` →
  `draft`). Sources are untouched.
- **Backend `ComposeService.analyze({ sessionId, repositoryIds, reset? })`**: when
  `reset === true`, call `resetSessionProgress(sessionId)` **before** enqueuing the
  analyze turn (so `runTurn` reads zero prior messages and a null `claudeSessionId`,
  starting a brand-new Claude session from sources). `reset` absent/false → today's
  behavior, byte-for-byte (the core Louise/non-reset path is unchanged).
- **Route `POST /sessions/:sessionId/analyze`**: read an optional `reset: boolean`
  from the body and pass it through.
- **`composeApi.analyze(sessionId, repositoryIds, reset?)`**: send
  `{ repositoryIds, reset }`. Default `reset = false`.
- **ComposeWorkspace** `onAnalyze`:
  - Compute `hasProgress = messages.length > 0 || readiness != null`.
  - If `hasProgress` → open a new `ReanalyzeConfirmModal`. On confirm: clear local
    `messages`/`readiness`/`activeQuestion`, then call `analyze(sessionId, repoIds, true)`.
  - Else → call `analyze(sessionId, repoIds, false)` directly (no dialog), as today.
- **`ReanalyzeConfirmModal`** (new, sibling to the existing `DraftAnywayConfirmModal`
  in `ComposeWorkspace.tsx`): warns "Re-analyzing resets this session. All chat
  progress, open questions, and the current preview will be cleared and analysis
  restarts from your sources. Sources are kept." Cancel / "Reset & analyze" actions.

### 5. Pop-out icon buttons — `ChatPanel.tsx`

- Replace the text in the pop-out button with a lucide icon: `Maximize2` when
  collapsed, `X` when popped out. Keep `type="button"`, keep the existing
  `aria-label` values verbatim ("Pop out chat" / "Exit full screen") so accessibility
  and the existing pop-out test still pass. Icon gets `aria-hidden="true"`; the button
  carries the accessible name via `aria-label`.

## Data flow (a guided turn, after these changes)

```
Analyze (fresh) → readiness { ideating, problem, questions[A/B/C] }
  → ChatPanel shows Ideating + Problem in Context Summary
  → Preview shows Open Questions tiles
  → click a tile → question injected as agent turn in chat + A/B/C chips above input
  → click "B" (or type) → postMessage → agent answers, refreshes readiness
Re-analyze (in-progress) → confirm dialog → reset (clear chat/readiness/claude session)
  → analyze restarts from sources only
```

## Error handling / back-compat

- `ideating`/`problem` optional; absent → Context Summary block hidden (no prose
  fallback — the prose `summary` is intentionally dropped from the UI; it remains in
  the data model untouched for the export bundle / back-compat).
- `analyze` `reset` defaults false; the existing analyze and the Louise pipeline are
  unaffected.
- `resetSessionProgress` only touches the one session's messages + the columns
  `markSessionContextDirty` already touches; sources and the row itself persist.
- Injecting the question as a local assistant message is **frontend-only** (a negative
  local id, like other optimistic messages); it is not persisted, and the real
  agent turn on answer supersedes it on the next `refreshMessages`.

## Testing (TDD)

- **PreviewPanel:** no `.sf-preview-summary` / Ideating / Problem block renders; the
  section label reads "Open Questions" in both the tiles branch and the legacy
  checklist branch; tile click still calls `onSelectQuestion`.
- **ChatPanel:** Ideating + Problem render in the Context Summary block from the new
  props; prose `contextSummary` prop is gone; A/B/C chips render in the dock above the
  textarea; the pop-out button renders an icon and keeps `aria-label="Pop out chat"` /
  `"Exit full screen"`.
- **ComposeWorkspace:** clicking an Open Question injects an assistant message with the
  question text AND sets the active question (chips appear); a fresh session's Analyze
  calls `analyze(..., false)` with no dialog; an in-progress session's Analyze opens the
  confirm dialog, and confirming clears local state + calls `analyze(..., true)`.
- **composeApi:** `analyze` sends `reset` in the body (true when passed, false/omitted
  by default).
- **Backend:** `resetSessionProgress` deletes the session's messages and nulls
  readiness/claude session; `analyze({ reset: true })` invokes it before enqueuing;
  `analyze({})` / `analyze({ reset: false })` does NOT (unchanged path).
- RTL suites keep `afterEach(cleanup)`.

## Implementation sequencing

1. Backend reset (`resetSessionProgress` + `analyze` reset flag + route) — independent,
   no UI dependency.
2. `composeApi.analyze` reset flag — consumes the route.
3. ChatPanel summary-from-ideating/problem + icon button (#1 ChatPanel half, #5).
4. PreviewPanel drop summary + rename (#1 Preview half, #2).
5. ComposeWorkspace wiring: pass ideating/problem, question→agent-turn injection,
   re-analyze confirm + reset call, icon (#1 wiring, #3, #4 frontend).

Each phase is independently shippable; the new field/flag is optional/back-compatible.

## Out of scope / deferred

- The token-consumption tracking + usage screen (separate, larger feature — paused).
- Persisting the injected question as a real assistant message server-side (kept
  frontend-only; the agent's answer turn is the source of truth).
- Any change to the prose `summary` in the data model or export bundle.

## No migration

`resetSessionProgress` is DML on existing tables/columns. No DDL, no migration file.
