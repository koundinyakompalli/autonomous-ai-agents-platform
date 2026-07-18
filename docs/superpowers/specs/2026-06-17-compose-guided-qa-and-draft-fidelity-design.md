# Compose: Guided Q&A, Summary, Pop-out + Draft Fidelity — Design

**Date:** 2026-06-17
**Status:** Approved (design) — pending implementation plan
**Scope:** Spec Factory **Compose** clarification surface + the Compose→draft handoff. Seven items
from operator feedback, brainstormed together because they share one backbone (the readiness
schema). Two are confirmed bugs (ship first); five are UX/flow features.

## Items covered

| # | Item | Type |
|---|---|---|
| 1 | Draft Epic dropped 7 of 8 agreed stories | **Bug** |
| 4 | Password-protected session: added sources invisible (count shows 8, list empty) | **Bug** |
| 2 | Context summary expands into chat; want fixed/scrollable + short "ideating" + "problem" | UX |
| 3 | Pop-out full-screen chat (accessibility) | UX |
| 5 | Pending items as clickable tiles; "pick the question to answer first" | UX/flow |
| 6 | Questions phrased precisely / less wordy | Prompt |
| 7 | Each question offers up to 3 suggested answers (A/B/C) + custom | UX/flow |

## Confirmed root causes (verified in code)

- **#1:** `compose-service.handoff()` passes only `sourceSummary: session.name` into
  `requestDraftGeneration` — the clarification agent's multi-story plan (today only prose in
  `contextMarkdown`) never reaches the draft generator. Compounding it, `draft-generator.ts`
  buildPrompt instructs *"Return exactly one Epic and one child Story/Task per repository
  involved"* — so even with context it caps at one child per repo. The 8-story breakdown is
  lost at the handoff.
- **#4:** #317 added a server-side token gate (`authorizeProtectedRead`) on `GET /sources`,
  `/messages`, `/stream` for password-protected sessions. But `dashboard/.../composeApi.ts`
  has **no token plumbing** — `resumeSession` doesn't capture the minted token and
  `listSources` never sends it. So `getSession` (which returns `sourceCount`) shows 8, but the
  token-gated `listSources` read returns empty/401. A #317 regression: server enforcement
  without client plumbing.

## Locked decisions (from brainstorming)

- #1: agent emits a **structured story breakdown** every turn; the draft creates **exactly one
  child per agreed story** (not per repo). The latest persisted breakdown is the contract.
- #5/#6/#7: Analyze → short reply + **clickable question tiles** → "pick one to start" → agent
  presents the picked question with **A/B/C suggested answers + custom**; clicking A/B/C posts
  that option's text as the user turn; the tile marks answered. Questions are **precise/short**.
- #2: structured **`ideating`** (2-3 lines) + **`problem`** (1-2 lines), shown in a
  **fixed-height scrollable** box (never expands into chat).
- #3: full-screen **overlay** pop-out reusing the same chat component.
- Implementation sequencing: **bugs #1 + #4 first**, then the UX features.

## Architecture

### 1. Readiness schema (backbone) — `compose-types.ts` + `compose-chat-agent.ts`

All additions are optional/backward-compatible; everything persists inside the existing
`readiness_json JSON` column (**no migration**).

```ts
interface ComposeOpenQuestion {
  id: string;
  question: string;          // precise, <= ~15 words
  options?: string[];        // up to 3 concrete candidate answers (A/B/C)
  answered?: boolean;
  answer?: string;           // the chosen/typed answer once resolved
}

interface ComposeStory {
  id: string;
  title: string;
  summary: string;           // one line
  repos?: string[];
  sequence?: number;
}

interface ComposeReadiness {
  // existing (kept): ready, summary, details?, repoEvidence?, codeInvestigation?, openQuestions
  ideating?: string;         // #2 — 2-3 lines, what we're shaping
  problem?: string;          // #2 — 1-2 lines, what we're solving
  questions?: ComposeOpenQuestion[];   // #5/#6/#7 — structured supersedes openQuestions for render
  stories?: ComposeStory[];            // #1 — the draft contract
}
```

- `openQuestions: string[]` is **kept and still populated** (back-compat with preview/handoff
  logic and the SSE consumers). `questions[]` is the new render source when present.
- `COMPOSE_CHAT_JSON_SCHEMA` (the agent's structured-output schema) gains `ideating`,
  `problem`, `questions`, `stories`. The frontend `composeTypes.ts` mirrors the type.
- The DB read-path `parseReadiness` (`compose-database.ts`, extended in #322) gains
  `parseQuestions` / `parseStories` and preserves `ideating`/`problem`, so reload doesn't drop
  them (same class of bug as repoEvidence — handled once here).

### 2. Clarification agent prompt — `compose-chat-agent.ts`

- **#6 precise:** each question ≤ ~15 words, one concrete decision, no preamble.
- **#7 options:** for each open question propose up to 3 concrete, distinct candidate answers
  in `options`, grounded in sources/code (real choices, not yes/no/maybe); operator may pick or
  type their own.
- **#5 pick-first:** ANALYZE reply is short — "I found N open questions. Pick the one you want
  to clarify first." Do not dump all questions into prose. On a turn where the user answered a
  question, mark it `answered` with the `answer`, then surface the next.
- **#1 stories:** maintain `stories[]` as the implementation breakdown (one entry per shippable
  story: title, one-line summary, repos, sequence). "This list is the contract the draft builds
  from; keep it complete and current every turn."
- **#2 summary:** populate `ideating` (2-3 lines) and `problem` (1-2 lines) every turn; keep
  `summary` populated for back-compat.

### 3. Draft generator — `draft-generator.ts` + the handoff (`compose-service.ts`)

- `handoff()` passes the session's persisted `readiness.stories[]` (+ `ideating`/`problem`)
  into `requestDraftGeneration` → through `GenerateDraftInput` to the draft generator.
- **Replace** the buildPrompt line *"Return exactly one Epic and one child Story/Task per
  repository involved"* with: *"Return one Epic. When a story breakdown is provided, create
  exactly one child ticket per story, preserving each story's title and sequence; a story may
  span repositories — set technicalDetails.repo to its primary repo; do not collapse or merge
  stories."* Inject the story list as an explicit authoritative section of the prompt.
- `childTickets` schema stays `minItems: 1`, no max (already correct).
- **Fallback:** when no `stories[]` is supplied (older Compose sessions, or non-Compose Louise
  sources), keep today's evidence-derived per-repo behavior. The wording change applies only to
  the story-driven path, so the core Louise pipeline is unaffected.

### 4. Frontend

- **Bug #4 — token plumbing (`composeApi.ts` + `ComposeWorkspace.tsx`):** capture the token
  returned by `resumeSession`; store it per session in `ComposeWorkspace` state; pass it to
  `listSources`/`listMessages`/`getSession` as the `x-compose-token` header (and EventSource
  `?token=`). After adding a source to a protected session, the refresh re-fetches with the
  token → sources render. Unprotected sessions unchanged.
- **#2 — summary (`PreviewPanel.tsx`):** render labeled **Ideating** + **Problem** blocks from
  `readiness.ideating`/`problem` inside a fixed `max-height` + `overflow:auto` container; fall
  back to today's `summary` when absent.
- **#5/#7 — tiles (`PreviewPanel.tsx` + `ChatPanel.tsx`):** Pending items become a tile grid
  from `readiness.questions[]`. Click a tile → that question is "active": ChatPanel shows the
  question + **A/B/C buttons** + the normal input. Clicking an option calls
  `composeApi.postMessage(option.text)` (reuses the existing send path). Answered tiles show a
  resolved state (`question.answered` / `answer`). Back-compat: render `openQuestions[]`
  checklist when `questions[]` is absent.
- **#3 — pop-out (`ChatPanel.tsx` / `ComposeWorkspace.tsx`):** a "pop out" control toggles a
  full-screen overlay rendering the **same ChatPanel** in a larger container (bigger
  fonts/width); Esc/close returns. Presentational wrapper only — no chat-logic duplication.

## Data flow (a guided turn)

```
Analyze → agent returns { ideating, problem, questions[A/B/C], stories[] }
  → persisted in readiness_json; SSE "readiness" event
  → Preview shows Ideating/Problem (scrollable) + question tiles
  → user clicks a tile → ChatPanel shows that question + A/B/C
  → user clicks "B" → postMessage(optionB.text) → agent marks it answered, refreshes questions/stories
  → repeat until ready
Handoff → readiness.stories[] passed to draft generator → one child per story
```

## Error handling / back-compat

- Every new field optional; absent → today's behavior (prose summary, flat checklist,
  per-repo draft). No migration.
- `parseReadiness` preserves the new fields on reload (avoids the repoEvidence-style drop).
- Draft fallback to per-repo when `stories[]` empty keeps the Louise (non-Compose) pipeline
  intact.
- `ComposeReadinessSchema` (Zod) used for the LLM envelope + export bundle: extend it to allow
  the new fields on the envelope (the agent now emits them); export bundle may omit them
  (transient).

## Testing (TDD)

- **Backend:** `parseReadiness` round-trips `questions`/`stories`/`ideating`/`problem`; draft
  generator creates N children from N stories and falls back to per-repo when absent; handoff
  passes stories through; agent JSON schema accepts the new fields; chat prompt contains the
  precise/options/pick-first/stories instructions.
- **Frontend:** token attached to protected `listSources` (and added-source refresh shows
  sources); PreviewPanel renders Ideating/Problem + scroll, and question tiles incl. A/B/C;
  tile-option click posts option text; pop-out toggles the overlay; back-compat renders for
  absent `questions[]`. `afterEach(cleanup)` on touched RTL suites.

## Implementation sequencing

#1 (draft fidelity) has two halves with different dependencies, so the phasing reflects that
honestly rather than forcing all of #1 into phase 1:

1. **Phase 1 — bug #4 + the schema backbone for stories.** Ship #4 (protected-source token
   plumbing) — fully independent, lands immediately. In the same phase, add `ComposeStory` +
   `readiness.stories[]` to the schema + agent prompt + `parseReadiness`, because #1 cannot
   honor a breakdown that isn't being produced/persisted yet. (The `stories[]` field is the
   minimal slice of the phase-2 schema work that #1 needs.)
2. **Phase 2 — bug #1 completion.** Handoff carries `readiness.stories[]` into
   `requestDraftGeneration`; draft-generator prompt change (one child per story, per-repo
   fallback). Now end-to-end: agreed stories → matching child tickets.
3. **Phase 3 — remaining schema + agent for Q&A/summary:** `questions[]` (A/B/C), `ideating`,
   `problem` in the schema + agent prompt (#5 pick-first, #6 precise, #7 options, #2 fields) +
   `parseReadiness` preservation for those fields.
4. **Phase 4 — frontend:** summary blocks (#2), question tiles + A/B/C (#5/#7), pop-out (#3).

Net effect: the two trust-breaking bugs (#1, #4) are resolved by end of phase 2; the UX
features layer on after. Every phase is independently shippable behind the optional-field
back-compat.

## Out of scope / deferred

- The deferred draft-path `repo-context.ts` scan enhancement (separate prior fast-follow).
- Multi-answer batch selection (#7 variant) — single active question at a time for v1.
- A dedicated full-screen chat route (#3 is an overlay, not a route).

## No migration

All new fields live inside the existing `readiness_json JSON` column. No DDL, no migration file.
