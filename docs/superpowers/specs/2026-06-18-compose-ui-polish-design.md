# Compose UI Polish: Accordion Summary, Progress, Messaging Bubbles — Design

**Date:** 2026-06-18
**Status:** Approved (design) — pending implementation plan
**Scope:** Spec Factory **Compose** workspace UI only — `ChatPanel.tsx`, `PreviewPanel.tsx`,
and `SpecFactoryPage.css`. Seven presentational/interaction refinements. **No backend, no
data-model, no API change** — every field needed already exists on `ComposeReadiness`.

## Items covered

| # | Item | Type |
|---|---|---|
| 1 | Context summary → single-open accordion: "Problem Statement" + "Solution" | UX |
| 2 | Move the pop-out/maximize button **inside** the context-summary tile | UX |
| 3 | Answered open questions disappear from the Preview side panel | UX |
| 4 | Remove the Repo Evidence block from Preview | UX |
| 5 | Replace the "Send" text button with a sleek arrow icon button | UX |
| 6 | Chat bubbles: speaker label **outside/above** the bubble (messaging-style) | UX |
| 7 | Progress bar below the Preview Details card, above Open Questions | UX |

## Current behavior (verified on `origin/main` @ e85d5e2)

- **#1/#2:** `ChatPanel.tsx` renders `.sf-chat-context-summary` with a `<span>Context summary</span>`
  header and two static rows — `aria-label="Ideating"` (renders `ideatingText`) and
  `aria-label="Problem"` (renders `problemText`). The pop-out maximize button lives in a
  separate `.sf-chat-toolbar` row ABOVE the summary tile.
- **#3:** `PreviewPanel.tsx` renders `structuredQuestions = readiness.questions ?? []` as tiles
  with NO `answered` filter — answered questions stay visible.
- **#4:** `PreviewPanel.tsx` renders a `.sf-preview-repo-evidence` `<article>` ("Agent inspected
  N files…" + per-repo lines) from `readiness.repoEvidence`/`codeInvestigation`.
- **#5:** the chat dock's submit control is a `<button className="sf-chat-send">Send</button>`.
- **#6:** `.sf-chat-msg` bubbles render the `.sf-chat-speaker` label INSIDE the bubble, above
  the `FormattedText`.
- **#7:** no progress indicator exists.

Data available (no change needed): `ComposeReadiness.ideating`, `.problem`, `.ready`,
`.questions: ComposeOpenQuestion[]` where each question has `answered?: boolean`.

## Architecture

### 1. Context-summary accordion — `ChatPanel.tsx`

The `.sf-chat-context-summary` tile becomes a single-open accordion with two sections:

- **"Problem Statement"** renders the existing `problem` field (`problemText`).
- **"Solution"** renders the existing `ideating` field (`ideatingText`).

Local state `const [openSection, setOpenSection] = useState<"problem" | "solution">("problem")`.
Each section is a header `<button>` (`aria-expanded`, `aria-controls`) plus a body that renders
only when that section is open. Clicking a header sets `openSection` to it; only one body shows
at a time; **Problem Statement is open by default**. The body uses the existing summary text.

Edge cases:
- Only `problem` present → render the Problem Statement section (expandable), no Solution.
- Only `ideating` present → render the Solution section; since it's the only one, default
  `openSection` should resolve to the present section (if `problem` is absent, Solution is the
  initially-open one). Compute the effective open section: prefer `problem` when present, else
  `solution`.
- Neither present → the whole `.sf-chat-context-summary` tile does not render (today's
  `hasContextSummary` gate, unchanged).

The accordion replaces the two static `.sf-chat-summary-row` divs. The tile keeps
`className="sf-chat-context-summary"` + `aria-label="Context summary"` (the flex-layout
regression-guard test depends on the class).

### 2. Pop-out button inside the summary tile — `ChatPanel.tsx`

- Remove the standalone `.sf-chat-toolbar` row.
- Render the maximize/close icon button (existing `Maximize2`/`X`, same `onPopOut`/`isPoppedOut`
  props, same `aria-label` "Pop out chat"/"Exit full screen") in the top-right of the
  `.sf-chat-context-summary` tile header — absolutely positioned within the tile so it doesn't
  consume a row.
- **Fallback when no summary exists yet:** because the button used to render unconditionally
  (toolbar) but the summary tile is conditional, render a minimal floating pop-out button in the
  panel (top-right, `position: absolute`) when `onPopOut` is set AND there is no summary, so
  pop-out stays reachable before the first analyze. (Keeps the control always available.)

### 3. Answered questions hidden in Preview — `PreviewPanel.tsx`

- Change `structuredQuestions = readiness.questions ?? []` to filter out answered:
  `(readiness.questions ?? []).filter((q) => !q.answered)`. The rest of the tiles branch is
  unchanged. When the filtered list is empty, the existing fallback paths (legacy checklist /
  "ready to draft") apply as today.

### 4. Remove Repo Evidence — `PreviewPanel.tsx`

- Delete the entire `.sf-preview-repo-evidence` `<article>` block and its
  `repoEvidenceLine` helper if it becomes unused. `readiness.repoEvidence`/`codeInvestigation`
  remain in the type and data (untouched) — just not rendered. Remove the now-unused
  `ComposeRepoEvidence` import if nothing else references it.

### 5. Arrow icon send button — `ChatPanel.tsx`

- Replace the `Send` text button with an icon button: lucide `ArrowUp` (sleek, "submit"
  affordance). Keep `type="button"`, the `onClick={send}`, `disabled={input.trim().length === 0}`,
  and add `aria-label="Send"` + `title="Send"`. Icon gets `aria-hidden="true"`. Keep the
  `sf-chat-send` class (CSS already styles it as a round button); the icon replaces the text.

### 6. Messaging-style bubbles — `ChatPanel.tsx` + CSS

- Restructure each chat turn so the visible `.sf-chat-speaker` label is a sibling ABOVE the
  bubble, not inside it. New structure per turn:
  ```
  <div class="sf-chat-turn is-{role}{ is-open-question}">
    <span class="sf-chat-speaker">You | {agentName}</span>
    <article class="sf-chat-msg ..." aria-label="User reply | {agent} reply | {agent} question">
      <FormattedText/>
    </article>
  </div>
  ```
  The bubble (`.sf-chat-msg`) holds only the message text. The wrapper `.sf-chat-turn` controls
  alignment (user → right, agent → left) via CSS. The same applies to the synthetic
  first-open-question article and the thinking/retry indicators (their speaker label moves above
  their bubble too, for visual consistency).
- **Preserve the test contract:** the `aria-label` STAYS on the `.sf-chat-msg` `<article>`
  (NOT moved to the wrapper), so the ~16 existing assertions of the form
  `getByRole("article", { name: /…reply|…question/i })` keep resolving unchanged. Only the
  visible `.sf-chat-speaker` `<span>` relocates from inside the article to the wrapper above it.
  The speaker text ("You" / agent name) is removed from inside the bubble. Existing tests that do
  `within(article).getByText("You"|agentName)` (the speaker-inside-bubble assertions) must be
  updated to query the speaker on the `.sf-chat-turn` wrapper instead — these are the only
  bubble tests that change.
- CSS: `.sf-chat-turn { display:flex; flex-direction:column; gap:4px; }`,
  `.sf-chat-turn.is-user { align-items:flex-end; }`,
  `.sf-chat-turn.is-assistant { align-items:flex-start; }`. The `.sf-chat-speaker` becomes a small
  label above the bubble. Existing `.sf-chat-msg` bubble styling (background, radius, max-width)
  stays; remove the in-bubble speaker styling that assumed the label was a child.

### 7. Progress bar — `PreviewPanel.tsx` + CSS

- A new `.sf-preview-progress` block rendered **between the Details `<article>` and the Open
  Questions `<article>`**, inside `.sf-preview-body`.
- **Metric:** based on ALL questions (answered + open), `total = readiness.questions.length`,
  `answered = questions.filter(q => q.answered).length`. `pct = total ? answered/total : 0`.
  When `readiness.ready` is true, `pct = 1`.
- **Label by state:**
  - `ready` → "Ready to draft 🎉"
  - `pct === 0` → "Just getting started"
  - `pct < 0.5` → "Making progress…"
  - `pct < 1` → "Almost there…"
  - `pct === 1` (all answered, not yet ready) → "Almost there…"
- **Visibility:** render only when `total > 0` OR `readiness.ready` (nothing to track before the
  first analyze produces questions). A labeled bar: `role="progressbar"` with
  `aria-valuenow={Math.round(pct*100)}`, `aria-valuemin={0}`, `aria-valuemax={100}`, and a visible
  text label + a filled `<div>` whose width is `${pct*100}%`.

## Data flow

```
readiness (SSE/reload) →
  ChatPanel: Context Summary accordion (Problem Statement=problem default-open / Solution=ideating)
             pop-out icon inside the tile
             bubbles: speaker label above bubble; arrow send button
  PreviewPanel: progress bar (answered/total, ready→100%) between Details and Open Questions
                Open Questions tiles filter out answered
                no repo-evidence block
```

## Error handling / back-compat

- All changes are presentational; no field added or removed from the data model.
- `repoEvidence`/`codeInvestigation` stay in the type/data; only the Preview rendering is removed.
- The accordion's default-open logic must not crash when only one of problem/solution is present.
- The progress bar is hidden when there are no questions and the session isn't ready.

## Testing (TDD, all RTL with `afterEach(cleanup)`)

- **ChatPanel:**
  - Context summary renders "Problem Statement" + "Solution" headers; Problem Statement body
    visible by default, Solution body hidden; clicking "Solution" shows its body and hides
    Problem Statement; clicking back toggles.
  - Only `problem` present → only Problem Statement section; only `ideating` present → Solution
    section is the open one.
  - Pop-out icon button renders inside the `.sf-chat-context-summary` tile (its `closest(".sf-chat-context-summary")` is truthy) with `aria-label="Pop out chat"`; clicking calls `onPopOut`.
  - No `.sf-chat-toolbar` element renders.
  - Send control is an icon button (`aria-label="Send"`, contains an `<svg>`, no "Send" text),
    disabled when input empty, calls `onSend` when clicked with text.
  - A user turn renders the speaker label ("You") OUTSIDE the `.sf-chat-msg` bubble (the label's
    `closest(".sf-chat-msg")` is null; the label and bubble share a `.sf-chat-turn` wrapper). The
    bubble article keeps its `aria-label` so `getByRole("article", { name: /User reply/i })` still
    resolves.
- **PreviewPanel:**
  - Answered questions are not rendered as tiles; only unanswered show.
  - No `.sf-preview-repo-evidence` / "Agent inspected" text renders even when `repoEvidence` is
    present.
  - Progress bar: hidden when no questions and not ready; with 0/total answered → "Just getting
    started" + valuenow 0; partial (<50%) → "Making progress…"; (50–99%) → "Almost there…"; all
    answered or `ready` → "Ready to draft 🎉"/100. The bar sits between Details and Open Questions
    in the DOM order.

## Implementation sequencing

1. **PreviewPanel** (independent): filter answered (#3), remove repo-evidence (#4), add progress
   bar (#7).
2. **ChatPanel** structure: accordion summary (#1) + pop-out inside tile (#2).
3. **ChatPanel** bubbles + send (#6, #5) + CSS.

Each phase is independently shippable and test-covered.

## Out of scope / deferred

- Token-consumption tracking + usage screen (separate, paused feature).
- Any agent-prompt / readiness data change (the accordion is a pure relabel of existing fields:
  Problem Statement=`problem`, Solution=`ideating`).
- Persisting accordion open-state across reloads (local UI state only).

## No backend change

Frontend + CSS only. No DDL, no migration, no API/route/service change.
