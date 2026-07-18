# Compose UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seven presentational refinements to the Compose workspace UI — accordion context summary (Problem Statement / Solution), pop-out button inside the summary tile, answered questions hidden in Preview, repo-evidence removed, arrow-icon send button, messaging-style chat bubbles (speaker label above the bubble), and a progress bar in the Preview panel.

**Architecture:** Frontend-only. Two React components (`ChatPanel.tsx`, `PreviewPanel.tsx`) + their tests + `SpecFactoryPage.css`. No backend, data-model, or API change — every field used (`ideating`, `problem`, `ready`, `questions[].answered`) already exists on `ComposeReadiness`.

**Tech Stack:** React 18 + Vitest + Testing Library (jsdom), lucide-react icons (`Maximize2`, `X`, `ArrowUp`, `ChevronDown`, `ChevronUp` all confirmed available).

## Global Constraints

- **Frontend-only.** No DDL, no migration, no API/route/service change.
- **No data-model change.** Accordion is a pure relabel of existing fields: **Problem Statement = `problem`**, **Solution = `ideating`**.
- ESM `.js` import specifiers even for `.tsx`; `import type` for type-only imports (`verbatimModuleSyntax`).
- The `.sf-chat-context-summary` tile keeps `className="sf-chat-context-summary"` + `aria-label="Context summary"` (the flex-layout regression-guard test in ChatPanel.test depends on the class).
- The pop-out button keeps `aria-label="Pop out chat"` (collapsed) / `"Exit full screen"` (popped out) verbatim.
- The send button keeps an accessible name "Send" (`aria-label="Send"`) so existing `getByRole("button", { name: /Send/i })` tests pass unchanged.
- Chat bubble `<article>` elements keep their `aria-label` ("User reply" / "{agent} reply" / "{agent} question"); only the visible `.sf-chat-speaker` `<span>` moves out of the bubble.
- `repoEvidence`/`codeInvestigation` stay in the type and data — only the Preview rendering is removed.
- Frontend tests run from the dashboard dir: `cd dashboard && npx vitest run <path-relative-to-dashboard>`. RTL suites keep `afterEach(cleanup)`.

---

## File Structure

- `dashboard/src/spec-factory/compose/PreviewPanel.tsx` — filter answered questions (#3); remove repo-evidence block + `repoEvidenceLine` helper + `ComposeRepoEvidence` import (#4); add progress bar between Details and Open Questions (#7).
- `dashboard/src/spec-factory/compose/ChatPanel.tsx` — accordion summary (#1); pop-out icon inside the summary tile + floating fallback (#2); arrow-icon send button (#5); speaker label above the bubble (#6).
- `dashboard/src/spec-factory/SpecFactoryPage.css` — accordion, progress bar, messaging-bubble, and send-icon styles.
- Tests updated: `PreviewPanel.test.tsx`, `ChatPanel.test.tsx`.

---

## Phase 1 — PreviewPanel (independent)

### Task 1: Hide answered questions in the Preview tiles

**Files:**
- Modify: `dashboard/src/spec-factory/compose/PreviewPanel.tsx:118`
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`

**Interfaces:**
- Produces: PreviewPanel renders only unanswered questions as tiles (`readiness.questions` filtered by `!q.answered`).

- [ ] **Step 1: Update the existing test + add a focused one**

In `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`, the existing test `"renders question tiles and calls onSelectQuestion on click"` (~:303-333) currently asserts the answered `q-2` ("async") tile is shown. That contradicts the new behavior — update its tail (the "answered tile shows resolved state" block ~:329-332) to assert the answered question is NOT rendered:

```ts
    fireEvent.click(firstTile);
    expect(onSelectQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q-1" }),
    );
    // answered questions are filtered out of the side panel
    expect(within(tiles).queryByText(/Sync or async/i)).toBeNull();
    expect(within(tiles).queryByText(/async/i)).toBeNull();
  });
```

Then add a dedicated test:

```ts
  it("hides answered questions from the Open Questions tiles", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [
            { id: "q-1", question: "Which repo?", answered: false },
            { id: "q-2", question: "Sync or async?", answered: true, answer: "async" },
            { id: "q-3", question: "Webhook or polling?" },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const tiles = screen.getByRole("group", { name: /Open Questions/i });
    expect(within(tiles).getByText("Which repo?")).toBeTruthy();
    expect(within(tiles).getByText("Webhook or polling?")).toBeTruthy();
    expect(within(tiles).queryByText("Sync or async?")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx -t "hides answered questions"`
Expected: FAIL — the answered "Sync or async?" tile still renders.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/PreviewPanel.tsx`, change line 118 from:

```tsx
  const structuredQuestions = readiness.questions ?? [];
```

to:

```tsx
  const structuredQuestions = (readiness.questions ?? []).filter(
    (question) => !question.answered,
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/PreviewPanel.tsx dashboard/src/spec-factory/compose/PreviewPanel.test.tsx
git commit -m "feat(compose): hide answered questions from the Preview Open Questions tiles"
```

---

### Task 2: Remove the Repo Evidence block from Preview

**Files:**
- Modify: `dashboard/src/spec-factory/compose/PreviewPanel.tsx` (remove lines ~138-161 block, the `repoEvidenceLine` helper ~8-20, the `ComposeRepoEvidence` import)
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`

**Interfaces:**
- Produces: PreviewPanel never renders a `.sf-preview-repo-evidence` block; `repoEvidence`/`codeInvestigation` are ignored by the UI.

- [ ] **Step 1: Update the tests**

In `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`:
- The existing test `"renders a Repo evidence block from readiness.repoEvidence"` (~:236-269) must be DELETED (the block no longer exists).
- The existing test `"renders no Repo evidence block when repoEvidence is absent"` (~:271-281) — KEEP it but make its readiness include `repoEvidence` to prove it's never rendered now. Replace its body with:

```ts
  it("never renders a Repo evidence block, even when repoEvidence is present", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["Which repo?"],
          summary: "s",
          repoEvidence: [
            {
              repoName: "core-app",
              headSha: "abc1234",
              techStack: "Java",
              inspectedPaths: ["App.java"],
              keyMatches: [],
              warnings: [],
            },
          ],
          codeInvestigation: { filesRead: 3, toolCalls: 9 },
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("article", { name: /Repo evidence/i }),
    ).toBeNull();
    expect(screen.queryByText(/Agent inspected/i)).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx -t "never renders a Repo evidence"`
Expected: FAIL — the Repo evidence article + "Agent inspected" text still render.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/PreviewPanel.tsx`:
1. Delete the entire repo-evidence `<article>` block (lines ~138-161, the `{readiness.repoEvidence && readiness.repoEvidence.length > 0 ? (...) : null}` expression).
2. Delete the `repoEvidenceLine` helper (lines ~8-20).
3. Remove `ComposeRepoEvidence` from the import (line ~5); keep `ComposeOpenQuestion` and `ComposeReadiness`. New import block:

```tsx
import { Confetti } from "./Confetti.js";
import type {
  ComposeOpenQuestion,
  ComposeReadiness,
} from "./composeTypes.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/PreviewPanel.tsx dashboard/src/spec-factory/compose/PreviewPanel.test.tsx
git commit -m "feat(compose): remove Repo evidence block from the Preview panel"
```

---

### Task 3: Progress bar between Details and Open Questions

**Files:**
- Modify: `dashboard/src/spec-factory/compose/PreviewPanel.tsx` (add a helper + a block inside `.sf-preview-body`)
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css` (append progress styles)
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`

**Interfaces:**
- Produces: a `.sf-preview-progress` block with `role="progressbar"`, `aria-valuenow/min/max`, a visible label, and a filled bar. Rendered between the Details `<article>` and the Open Questions `<article>`, only when `readiness.questions.length > 0` OR `readiness.ready`.

- [ ] **Step 1: Write the failing tests**

Add to `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`:

```ts
  it("shows a progress bar reflecting answered/total questions", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [
            { id: "q-1", question: "A?", answered: true, answer: "x" },
            { id: "q-2", question: "B?", answered: false },
            { id: "q-3", question: "C?", answered: false },
            { id: "q-4", question: "D?", answered: false },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText(/Making progress/i)).toBeTruthy();
  });

  it("shows 'Just getting started' at zero answered", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [{ id: "q-1", question: "A?" }, { id: "q-2", question: "B?" }],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText(/Just getting started/i)).toBeTruthy();
  });

  it("shows 'Ready to draft' at 100% when ready", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: true,
          openQuestions: [],
          summary: "s",
          questions: [{ id: "q-1", question: "A?", answered: true, answer: "x" }],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText(/Ready to draft/i)).toBeTruthy();
  });

  it("hides the progress bar before any questions exist and not ready", () => {
    render(
      <PreviewPanel
        readiness={{ ready: false, openQuestions: [], summary: "s" }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx -t "progress bar"`
Expected: FAIL — no `progressbar` role exists.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/PreviewPanel.tsx`, add a helper near the other helpers (after `previewDetails`, before the component):

```tsx
function previewProgress(readiness: ComposeReadiness): {
  pct: number;
  label: string;
} | null {
  const all = readiness.questions ?? [];
  const total = all.length;
  if (total === 0 && !readiness.ready) return null;
  const answered = all.filter((question) => question.answered).length;
  const pct = readiness.ready ? 1 : total > 0 ? answered / total : 0;
  let label: string;
  if (readiness.ready) label = "Ready to draft 🎉";
  else if (pct === 0) label = "Just getting started";
  else if (pct < 0.5) label = "Making progress…";
  else label = "Almost there…";
  return { pct, label };
}
```

In the component, after `const structuredQuestions = ...` compute:

```tsx
  const progress = previewProgress(readiness);
```

Insert the progress block inside `.sf-preview-body`, BETWEEN the Details `<article>` (closes ~:136) and the Open Questions block (opens ~:163):

```tsx
        {progress ? (
          <div className="sf-preview-progress" aria-label="Session progress">
            <div className="sf-preview-progress-head">
              <span className="sf-section-label">Progress</span>
              <span className="sf-preview-progress-status">{progress.label}</span>
            </div>
            <div
              className="sf-preview-progress-track"
              role="progressbar"
              aria-label="Session progress"
              aria-valuenow={Math.round(progress.pct * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="sf-preview-progress-fill"
                style={{ width: `${Math.round(progress.pct * 100)}%` }}
              />
            </div>
          </div>
        ) : null}
```

In `dashboard/src/spec-factory/SpecFactoryPage.css`, append:

```css
.sf-preview-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sf-preview-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.sf-preview-progress-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--sf-accent, #6251ac);
}
.sf-preview-progress-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(98, 81, 172, 0.14);
  overflow: hidden;
}
.sf-preview-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6251ac, #44c8bd);
  transition: width 0.3s ease;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/PreviewPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/PreviewPanel.tsx dashboard/src/spec-factory/compose/PreviewPanel.test.tsx dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "feat(compose): add session progress bar to the Preview panel"
```

---

## Phase 2 — ChatPanel context summary (accordion + pop-out)

### Task 4: Context summary accordion (Problem Statement / Solution)

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx` (the summary block ~:235-254, add `useState` for the open section)
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css` (accordion styles)
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: existing `ideating`/`problem` props + `ideatingText`/`problemText` locals.
- Produces: the `.sf-chat-context-summary` tile renders an accordion with a "Problem Statement" section (= `problemText`) and a "Solution" section (= `ideatingText`); single-open; Problem Statement open by default (or the only present section). Section headers are buttons with `aria-expanded`.

- [ ] **Step 1: Rewrite the summary test + add accordion tests**

In `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`, replace the test `"shows Ideating and Problem in the context summary when available"` (~:72-91) with:

```ts
  it("renders the context summary as a Problem Statement / Solution accordion", () => {
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
    // both section headers present
    const problemHeader = within(summary).getByRole("button", {
      name: /Problem Statement/i,
    });
    const solutionHeader = within(summary).getByRole("button", {
      name: /Solution/i,
    });
    // Problem Statement open by default; Solution collapsed
    expect(problemHeader.getAttribute("aria-expanded")).toBe("true");
    expect(solutionHeader.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(summary).getByText("Operators cannot export billing data."),
    ).toBeTruthy();
    expect(
      within(summary).queryByText("Shaping a CSV export epic."),
    ).toBeNull();
    // clicking Solution opens it and collapses Problem Statement
    fireEvent.click(solutionHeader);
    expect(solutionHeader.getAttribute("aria-expanded")).toBe("true");
    expect(problemHeader.getAttribute("aria-expanded")).toBe("false");
    expect(within(summary).getByText("Shaping a CSV export epic.")).toBeTruthy();
    expect(
      within(summary).queryByText("Operators cannot export billing data."),
    ).toBeNull();
    expect(
      container.querySelector(".sf-chat-panel.has-context-summary"),
    ).toBeTruthy();
  });

  it("opens the Solution section when only ideating is present", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        ideating="Only the approach is known."
      />,
    );
    const summary = screen.getByRole("article", { name: /Context summary/i });
    expect(
      within(summary).queryByRole("button", { name: /Problem Statement/i }),
    ).toBeNull();
    const solutionHeader = within(summary).getByRole("button", {
      name: /Solution/i,
    });
    expect(solutionHeader.getAttribute("aria-expanded")).toBe("true");
    expect(within(summary).getByText("Only the approach is known.")).toBeTruthy();
  });
```

NOTE: the suite has a module-level `messages` fixture and imports `fireEvent`/`within`/`screen` from `@testing-library/react` (confirm). Other tests at ~:145 query `getByRole("article", { name: /Context summary/i })` and assert open-questions text is NOT inside it — those still pass because the accordion is still that article and the question text isn't in it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "accordion"`
Expected: FAIL — there are no "Problem Statement"/"Solution" section buttons.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`:

Add an open-section state after the existing `const [input, setInput] = useState("")` (~:124):

```tsx
  const [openSection, setOpenSection] = useState<"problem" | "solution">(
    "problem",
  );
```

After `const problemText = ...` / `const ideatingText = ...` (~:134-135), compute the effective open section (so it never points at an absent section):

```tsx
  const effectiveOpenSection =
    openSection === "problem" && !problemText && ideatingText
      ? "solution"
      : openSection === "solution" && !ideatingText && problemText
        ? "problem"
        : openSection;
```

Replace the summary block (`{hasContextSummary ? (<article ...>...two rows...</article>) : null}`, ~:235-254) with the accordion. The `<span>Context summary</span>` header stays; the two `.sf-chat-summary-row` divs become accordion sections:

```tsx
      {hasContextSummary ? (
        <article
          className="sf-chat-context-summary"
          aria-label="Context summary"
        >
          <span className="sf-chat-summary-title">Context summary</span>
          {problemText ? (
            <div className="sf-chat-summary-section" aria-label="Problem Statement">
              <button
                type="button"
                className="sf-chat-summary-header"
                aria-expanded={effectiveOpenSection === "problem"}
                onClick={() => setOpenSection("problem")}
              >
                <span>Problem Statement</span>
                {effectiveOpenSection === "problem" ? (
                  <ChevronUp size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
              </button>
              {effectiveOpenSection === "problem" ? (
                <p className="sf-chat-summary-body">{problemText}</p>
              ) : null}
            </div>
          ) : null}
          {ideatingText ? (
            <div className="sf-chat-summary-section" aria-label="Solution">
              <button
                type="button"
                className="sf-chat-summary-header"
                aria-expanded={effectiveOpenSection === "solution"}
                onClick={() => setOpenSection("solution")}
              >
                <span>Solution</span>
                {effectiveOpenSection === "solution" ? (
                  <ChevronUp size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
              </button>
              {effectiveOpenSection === "solution" ? (
                <p className="sf-chat-summary-body">{ideatingText}</p>
              ) : null}
            </div>
          ) : null}
        </article>
      ) : null}
```

Add `ChevronDown, ChevronUp` to the lucide import (line 2):

```tsx
import { ChevronDown, ChevronUp, Maximize2, X } from "lucide-react";
```

In `dashboard/src/spec-factory/SpecFactoryPage.css`, append:

```css
.sf-chat-summary-title {
  display: block;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.7;
  margin-bottom: 4px;
}
.sf-chat-summary-section + .sf-chat-summary-section {
  border-top: 1px solid rgba(98, 81, 172, 0.16);
}
.sf-chat-summary-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  background: none;
  border: 0;
  cursor: pointer;
  font: 600 13px/1.3 inherit;
  color: inherit;
  text-align: left;
}
.sf-chat-summary-body {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.45;
  opacity: 0.85;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS (the accordion tests + all existing tests; the flex-layout regression-guard tests are unaffected — the class/`has-context-summary` stay).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "feat(compose): context summary becomes a Problem Statement / Solution accordion"
```

---

### Task 5: Move the pop-out button inside the summary tile

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx` (remove `.sf-chat-toolbar`; render the button inside the tile + a floating fallback)
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css` (positioning)
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `onPopOut`/`isPoppedOut` props; the accordion summary tile (Task 4).
- Produces: when `onPopOut` is set AND a summary exists, the pop-out icon button renders INSIDE `.sf-chat-context-summary` (top-right). When `onPopOut` is set AND no summary exists, a `.sf-chat-popout-floating` button renders. No `.sf-chat-toolbar` element exists. `aria-label` unchanged.

- [ ] **Step 1: Update the pop-out tests**

In `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`, the existing tests query the pop-out button by `name: /Pop out chat/i` (~:439, ~:467) — those still resolve. ADD a placement test + a no-toolbar test:

```ts
  it("renders the pop-out button inside the context summary tile", () => {
    render(
      <ChatPanel
        messages={messages}
        onSend={vi.fn()}
        thinking={false}
        problem="A problem."
        onPopOut={vi.fn()}
      />,
    );
    const popBtn = screen.getByRole("button", { name: /Pop out chat/i });
    expect(popBtn.closest(".sf-chat-context-summary")).toBeTruthy();
    expect(document.querySelector(".sf-chat-toolbar")).toBeNull();
  });

  it("renders a floating pop-out button when there is no summary yet", () => {
    render(
      <ChatPanel messages={messages} onSend={vi.fn()} thinking={false} onPopOut={vi.fn()} />,
    );
    const popBtn = screen.getByRole("button", { name: /Pop out chat/i });
    expect(popBtn.closest(".sf-chat-context-summary")).toBeNull();
    expect(popBtn.classList.contains("sf-chat-popout-floating")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "pop-out button inside"`
Expected: FAIL — the button is in `.sf-chat-toolbar`, not inside the summary tile.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`:

1. Delete the `.sf-chat-toolbar` block (~:218-234).

2. Define a reusable pop-out button element before the `return` (after `function send()`):

```tsx
  const popOutButton = onPopOut ? (
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
  ) : null;
```

3. Inside the `.sf-chat-context-summary` article (from Task 4), render the button as the first child (top-right via CSS), right after the opening `<article ...>`:

```tsx
        <article
          className="sf-chat-context-summary"
          aria-label="Context summary"
        >
          {popOutButton}
          <span className="sf-chat-summary-title">Context summary</span>
          ...accordion sections...
        </article>
```

4. After the summary block (when there is NO summary), render the floating fallback. Add right after the `{hasContextSummary ? (...) : null}` expression:

```tsx
      {onPopOut && !hasContextSummary ? (
        <div className="sf-chat-popout-floating-wrap">{
          /* reuse the same button, but tagged floating */
        }
          <button
            type="button"
            className="sf-chat-popout sf-chat-popout-floating"
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

(The in-tile `popOutButton` and the floating button are mutually exclusive: in-tile renders only when `hasContextSummary`; floating renders only when `!hasContextSummary`. So exactly one pop-out button exists at a time — `getByRole` stays unambiguous.)

In `dashboard/src/spec-factory/SpecFactoryPage.css`, append:

```css
.sf-chat-context-summary {
  position: relative;
}
.sf-chat-context-summary .sf-chat-popout {
  position: absolute;
  top: 10px;
  right: 10px;
}
.sf-chat-popout-floating-wrap {
  display: flex;
  justify-content: flex-end;
}
.sf-chat-popout-floating {
  align-self: flex-end;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "feat(compose): move pop-out button inside the summary tile (floating fallback before analyze)"
```

---

## Phase 3 — ChatPanel bubbles + send

### Task 6: Arrow-icon send button

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx` (the send button ~:356-363, import)
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Produces: the dock submit control is an icon button (lucide `ArrowUp`) with `aria-label="Send"`, `type="button"`, `disabled` when input empty, `onClick={send}`. Accessible name stays "Send".

- [ ] **Step 1: Add a test**

In `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`, add:

```ts
  it("renders the send control as an icon button keyed by aria-label", () => {
    render(<ChatPanel messages={messages} onSend={vi.fn()} thinking={false} />);
    const send = screen.getByRole("button", { name: /Send/i });
    expect(send.querySelector("svg")).toBeTruthy();
    expect(send.textContent?.trim()).toBe("");
  });
```

The existing send tests (`"sends a message and clears the input"`, `"does not send a blank message"`) query `getByRole("button", { name: /Send/i })` — they keep passing because `aria-label="Send"` preserves the accessible name.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "send control as an icon"`
Expected: FAIL — the button renders the text "Send", not an `<svg>`.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`, add `ArrowUp` to the lucide import:

```tsx
import { ArrowUp, ChevronDown, ChevronUp, Maximize2, X } from "lucide-react";
```

Replace the send button (~:356-363):

```tsx
        <button
          type="button"
          className="sf-chat-send"
          onClick={send}
          disabled={input.trim().length === 0}
          aria-label="Send"
          title="Send"
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx
git commit -m "feat(compose): replace Send text button with an arrow icon button"
```

---

### Task 7: Messaging-style bubbles — speaker label above the bubble

**Files:**
- Modify: `dashboard/src/spec-factory/compose/ChatPanel.tsx` (the displayTurns map ~:265-284, the first-open-question article ~:256-264, and the thinking/retry indicators ~:285-315)
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css` (turn wrapper + bubble alignment)
- Test: `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `displayTurns`, `agentName`, `shouldPromptFirstQuestion`, `firstOpenQuestion`, `thinking`, `retryStatus`.
- Produces: each turn is a `.sf-chat-turn.is-{role}` wrapper containing a `.sf-chat-speaker` `<span>` (sibling, above) + a `.sf-chat-msg` `<article>` (keeps its `aria-label`). The visible speaker label is outside the bubble.

- [ ] **Step 1: Update tests for the new structure**

In `dashboard/src/spec-factory/compose/ChatPanel.test.tsx`:
- The tests asserting `within(article).getByText("You")` / `within(question).getByText("Mendel")` (~:149, ~:197-198, ~:201, ~:205) assume the speaker is INSIDE the bubble article. Update them to assert the speaker is on the turn wrapper instead. Concretely, for the test `"splits question-prefixed user messages…"` (~:194-205), change the speaker assertions:

```ts
    // the agent question bubble keeps its aria-label; the speaker sits on the wrapper
    const question = screen.getByRole("article", { name: /Mendel question/i });
    expect(question.closest(".sf-chat-turn")).toBeTruthy();
    expect(within(question.closest(".sf-chat-turn") as HTMLElement).getByText("Mendel")).toBeTruthy();

    const answer = screen.getByRole("article", { name: /User reply/i });
    const answerTurn = answer.closest(".sf-chat-turn") as HTMLElement;
    expect(within(answerTurn).getByText("You")).toBeTruthy();
    expect(within(answerTurn).getByText("billing-service")).toBeTruthy();
    expect(answer.textContent).not.toContain("Which repo?");
```

- **Audit every `within(<bubble>).getByText(<speaker>)` assertion** — after the restructure the speaker label ("Mendel"/"You") is NO LONGER inside the bubble article, so any `within(question).getByText("Mendel")` or `within(answer).getByText("You")` breaks. Grep the test file for `within(` and fix each speaker-inside-bubble assertion to query the `.sf-chat-turn` wrapper instead. Known sites (line numbers approximate): the `"keeps open questions out of the context summary and starts the agent chat"` test (~:153, `within(question).getByText("Mendel")`) and the `"does not duplicate…"` test (~:201). For each, change the speaker assertion to:
  ```ts
    const turn = question.closest(".sf-chat-turn") as HTMLElement;
    expect(within(turn).getByText("Mendel")).toBeTruthy();
    // the question CONTENT stays in the bubble:
    expect(within(question).getByText("Which repo?")).toBeTruthy();
  ```
  Assertions that check message CONTENT inside the bubble (`within(reply).getByText("design decisions")` STRONG/CODE/listitem at ~:258-303) are UNCHANGED — content stays in the bubble. The thinking test `getAllByText("Mendel").length > 1` (~:319) still works (the speaker label still renders, now on the wrapper). `getByRole("article", { name: /…reply|…question/i })` queries keep passing (aria-label preserved on the article).
- Add one focused structural test:

```ts
  it("renders the speaker label outside the message bubble", () => {
    render(
      <ChatPanel
        messages={[
          { id: 30, sessionId: 7, role: "user", content: "hello there", createdAt: "t" },
        ]}
        onSend={vi.fn()}
        thinking={false}
      />,
    );
    const bubble = screen.getByRole("article", { name: /User reply/i });
    // speaker label is NOT inside the bubble
    expect(within(bubble).queryByText("You")).toBeNull();
    // it lives on the shared turn wrapper, above the bubble
    const turn = bubble.closest(".sf-chat-turn") as HTMLElement;
    expect(turn).toBeTruthy();
    expect(within(turn).getByText("You")).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx -t "speaker label outside"`
Expected: FAIL — the speaker `<span>` is inside the bubble; `within(bubble).queryByText("You")` is non-null and `.sf-chat-turn` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

In `dashboard/src/spec-factory/compose/ChatPanel.tsx`, wrap each turn so the speaker is a sibling above the bubble.

Replace the first-open-question article (~:256-264):

```tsx
        {shouldPromptFirstQuestion ? (
          <div className="sf-chat-turn is-assistant">
            <span className="sf-chat-speaker">{agentName}</span>
            <article
              className="sf-chat-msg is-assistant is-open-question"
              aria-label={`${agentName} question`}
            >
              <FormattedText text={firstOpenQuestion ?? ""} />
            </article>
          </div>
        ) : null}
```

Replace the displayTurns map (~:265-284):

```tsx
        {displayTurns.map((turn) => (
          <div
            key={turn.key}
            className={`sf-chat-turn is-${turn.role}${
              turn.openQuestion ? " is-open-question" : ""
            }`}
          >
            <span className="sf-chat-speaker">
              {turn.role === "user" ? "You" : agentName}
            </span>
            <article
              className={`sf-chat-msg is-${turn.role}${
                turn.openQuestion ? " is-open-question" : ""
              }`}
              aria-label={
                turn.role === "user"
                  ? "User reply"
                  : turn.openQuestion
                    ? `${agentName} question`
                    : `${agentName} reply`
              }
            >
              <FormattedText text={turn.content} />
            </article>
          </div>
        ))}
```

Wrap the retry indicator (~:285-301) so its speaker is above the bubble:

```tsx
        {thinking && retryStatus ? (
          <div className="sf-chat-turn is-assistant">
            <span className="sf-chat-speaker">{agentName}</span>
            <div
              role="status"
              aria-label="Retrying"
              aria-live="polite"
              className="sf-chat-msg is-assistant sf-chat-thinking is-retrying"
            >
              <em>
                {`Retrying… (attempt ${retryStatus.attempt} of ${retryStatus.maxAttempts}, next try in ${retryStatus.nextRetryInSeconds}s)`}
              </em>
              {retryStatus.message?.trim() ? (
                <span className="sf-chat-retry-detail">
                  {retryStatus.message}
                </span>
              ) : null}
            </div>
          </div>
        ) : thinking ? (
          <div className="sf-chat-turn is-assistant">
            <span className="sf-chat-speaker">{agentName}</span>
            <div
              className="sf-chat-msg is-assistant sf-chat-thinking"
              aria-live="polite"
            >
              <em>{thinkingLabel}</em>
              <span className="sf-chat-typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        ) : null}
```

In `dashboard/src/spec-factory/SpecFactoryPage.css`, append:

```css
.sf-chat-turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sf-chat-turn.is-user {
  align-items: flex-end;
}
.sf-chat-turn.is-assistant {
  align-items: flex-start;
}
.sf-chat-turn .sf-chat-speaker {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  opacity: 0.6;
  padding: 0 6px;
}
```

(The existing `.sf-chat-msg .sf-chat-speaker` styling that assumed the label was a child can stay — it no longer matches since the span is now a sibling — but if it sets display/spacing that conflicts, leave the bubble rules; the new `.sf-chat-turn .sf-chat-speaker` governs the relocated label.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dashboard && npx vitest run src/spec-factory/compose/ChatPanel.test.tsx`
Expected: PASS (the new structural test + all existing tests; article aria-labels preserved).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/spec-factory/compose/ChatPanel.tsx dashboard/src/spec-factory/compose/ChatPanel.test.tsx dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "feat(compose): messaging-style chat bubbles with speaker label above the bubble"
```

---

## Final verification

### Task 8: Full suite + typecheck + browser check + PR

- [ ] **Step 1: Frontend tests**

Run: `cd dashboard && npx vitest run src/spec-factory/compose`
Expected: PASS (ChatPanel + PreviewPanel + the rest of the compose suite).

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c "spec-factory/compose"` — Expected: `0`.
Run: `cd dashboard && npx tsc -p tsconfig.server.json --noEmit` — Expected: clean.
(Backend is untouched, but run `npx tsc --noEmit` from the worktree root too — Expected: clean.)

- [ ] **Step 3: Browser visual check**

Build a static harness pointing at the real CSS and render ChatPanel (accordion summary with pop-out icon in the tile; arrow send button; messaging bubbles) and PreviewPanel (progress bar between Details and Open Questions; no repo-evidence; answered questions hidden). Confirm via Chrome DevTools MCP: accordion toggles single-open; pop-out sits inside the summary tile; bubbles show the speaker label above; progress bar renders with the right fill + label. Screenshot to confirm.

- [ ] **Step 4: Commit any CSS adjustment, then open the PR**

```bash
git add -A && git commit -m "style(compose): polish accordion/progress/bubble visuals" || true
git push -u origin fix/compose-ui-polish
```

Open the PR against `main`; title: "Compose UI polish: accordion summary, progress bar, messaging bubbles, icon send".

---

## Self-Review

**Spec coverage:**
- #1 accordion (Problem Statement=`problem` default-open / Solution=`ideating`): Task 4. ✓
- #2 pop-out inside the summary tile (+ floating fallback): Task 5. ✓
- #3 answered questions hidden: Task 1. ✓
- #4 remove repo-evidence: Task 2. ✓
- #5 arrow-icon send: Task 6. ✓
- #6 messaging bubbles (speaker outside bubble, aria-label preserved): Task 7. ✓
- #7 progress bar between Details and Open Questions (answered/total, ready→100%, hidden pre-questions): Task 3. ✓
- No backend/data change; presentational only. ✓

**Placeholder scan:** No TBD/TODO; every code step has real code. The browser check (Task 8 Step 3) is verification, not a placeholder. The one comment-only JSX fragment in Task 5 Step 3 is illustrative inside a complete block — the actual button code follows it in full.

**Type consistency:** `previewProgress(readiness): { pct, label } | null` used once (Task 3). `openSection: "problem" | "solution"` + `effectiveOpenSection` consistent (Task 4). `popOutButton` element + `.sf-chat-popout-floating` class consistent (Task 5). `.sf-chat-turn.is-{role}` wrapper + `.sf-chat-speaker` sibling consistent (Task 7). All preserved `aria-label`s ("Context summary", "Pop out chat"/"Exit full screen", "Send", "User reply"/"{agent} reply"/"{agent} question") match the spec's Global Constraints. Lucide imports (`ArrowUp, ChevronDown, ChevronUp, Maximize2, X`) accumulate consistently across Tasks 4/5/6.
