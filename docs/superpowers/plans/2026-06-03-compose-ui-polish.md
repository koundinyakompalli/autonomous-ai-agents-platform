# Compose UI Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Restore the Compose dashboard UI to production-grade, matching the existing Spec Factory design system. The Phase 3b mockup→live swap kept components functional but lost styling: overlapping labels/inputs, unstyled buttons, a session modal that blocks the side-nav, and a lost "Add sources" modal.

**Architecture:** All work is in `dashboard/src/spec-factory/`. Reuse the EXISTING design tokens + rich panel/chat/modal CSS already in `SpecFactoryPage.css` (the mockup's styling is still there — lines ~769–1418). Do NOT invent a new aesthetic; match the established dark-glass + Vanta-wave language. The fix is: (a) scope the session modal to the workspace column so the nav stays clickable; (b) restore the "Add sources" → rich source modal flow; (c) style the form internals + chat dock + empty states that were left raw.

**Tech Stack:** React 18 + Vite + Vitest + @testing-library/react (jsdom). Gates: `npx vitest run src/spec-factory` (from `dashboard/`) + `npm run build`. NOT `tsc --noEmit` (main has ~53 pre-existing errors).

**Branch:** `fix/compose-ui-polish` (already created off main).

## Verified ground truth (read before implementing)

- Tokens live on `.sf-shell` (`--sf-text #f2f3f5`, `--sf-muted #a6abb5`, `--sf-surface-2 #262930`, `--sf-line`, `--sf-line-strong`, `--sf-blue #5aa7ff`, `--sf-green #7dcc72`, `--sf-glass-blur`).
- `.sf-shell` is `display:grid; grid-template-columns: 196px minmax(0,1fr)` — `SideNav` (col 1) and the tab content (col 2) are siblings. `ComposeWorkspace` renders in col 2.
- **Bug:** `SessionModal` renders `.sf-modal-backdrop { position: fixed; inset: 0; z-index: 40 }` (CSS ~line 1420) → it covers the WHOLE viewport including the nav, so Spec Board/OneShot/etc. can't be clicked while the Compose modal is up.
- Rich source-add modal CSS ALREADY EXISTS (mockup leftovers): `.sf-source-backdrop`, `.sf-source-modal`, `.sf-source-modal-header`, `.sf-source-big-drop`, `.sf-source-option-row`, `.sf-source-close` (CSS ~1253–1418). The mockup's `AddSourcesPanel` markup was deleted in Phase 3b but the CSS remains — reuse it.
- `.sf-sources-panel textarea` is styled (line 1016) but modal/source-row `<label>/<input>` are raw → overlapping text.
- `.sf-chat-dock input` is styled (line 1123) but `ChatPanel` now uses a `<textarea>` → dock lost styling.
- Missing CSS classes the live components emit: `sf-compose-empty`, `sf-compose-modal-choose`, `sf-compose-modal-new`, `sf-compose-modal-load`, `sf-source-add-note`, `sf-source-add-youtube`.
- Existing component props (DO NOT change signatures unless a task says so):
  - `SessionModal({ sessions, onCreate, onLoad })`
  - `SourcesPanel({ sources, onAddNote, onAddYoutube, onUploadFiles, onReconvert, onAnalyze, analyzing })`
  - `ChatPanel({ messages, onSend, thinking })`
  - `PreviewPanel({ readiness, handingOff, onGenerate })`
  - `ComposeWorkspace()` renders `<SessionModal/>` when `sessionId===null`, else the 3 panels.
- Icons come from `lucide-react`. Phase 3b removed `ChevronDown, Clipboard, FileUp, Globe2, Link2, Sparkles` from `SpecFactoryPage.tsx`; the compose components import their own icons. `FormattedText` is exported from `SpecFactoryPage.tsx` and imported by `ChatPanel`.

---

## Task 1: Fix the session modal blocking the side-nav + style the modal

**Files:**
- Modify: `dashboard/src/spec-factory/compose/SessionModal.tsx`
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx` (only if needed for the scoping wrapper)
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css`
- Test: `dashboard/src/spec-factory/compose/SessionModal.test.tsx` (extend)

**Problem:** `.sf-modal-backdrop` is `position: fixed; inset: 0` and covers the nav. The modal is rendered inside `ComposeWorkspace` (grid col 2). It must overlay ONLY the workspace area.

- [ ] **Step 1: Add a failing test** asserting the modal uses a workspace-scoped backdrop class (not the global fixed one). In `SessionModal.test.tsx`:

```tsx
it("uses a workspace-scoped backdrop that does not cover the side-nav", () => {
  const { container } = render(<SessionModal sessions={[]} onCreate={vi.fn()} onLoad={vi.fn()} />);
  // scoped backdrop is absolute within the workspace column, never the global fixed full-viewport one
  const scoped = container.querySelector(".sf-compose-modal-backdrop");
  expect(scoped).not.toBeNull();
  expect(container.querySelector(".sf-modal-backdrop")).toBeNull();
});
```

- [ ] **Step 2: Run; verify FAIL** — `cd dashboard && npx vitest run src/spec-factory/compose/SessionModal.test.tsx`.

- [ ] **Step 3: Implement** — In `SessionModal.tsx`, change the outer wrapper `className` from `sf-modal-backdrop` to `sf-compose-modal-backdrop`. Keep the inner `.sf-compose-session-modal` dialog and all the existing `role="dialog" aria-modal="true" aria-label="Compose session"`. (Everything else in the component stays.)

- [ ] **Step 4: Add CSS.** In `SpecFactoryPage.css`, REPLACE the Phase 3b block's `.sf-compose-session-modal` rule (the simple one appended at the end, ~line 1992) and ADD a scoped backdrop. Append/replace within the "Compose Phase 3b" section:

```css
/* Compose session modal — scoped to the workspace column so the side-nav stays interactive */
.sf-compose-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  padding: 32px;
  background: rgba(6, 7, 9, 0.55);
  backdrop-filter: blur(3px) saturate(115%);
}
.sf-compose-session-modal {
  position: relative;
  width: min(440px, 100%);
  border: 1px solid var(--sf-line-strong);
  border-radius: 12px;
  background:
    linear-gradient(160deg, rgba(67, 78, 122, 0.16), transparent 42%),
    linear-gradient(20deg, transparent 60%, rgba(67, 128, 88, 0.12)),
    #14161b;
  color: var(--sf-text);
  padding: 28px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 32px 72px rgba(0, 0, 0, 0.46);
  animation: sf-modal-in 0.18s ease-out both;
}
.sf-compose-session-modal h2 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 600;
}
.sf-compose-session-modal > div > p,
.sf-compose-modal-choose p {
  margin: 0 0 18px;
  color: var(--sf-muted);
  font-size: 14px;
  line-height: 1.5;
}
```

> NOTE: `.sf-compose` (the workspace section) must establish a containing block for the absolute backdrop. Verify `.sf-compose` (CSS line ~769) has `position: relative` — it does (`position: relative; isolation: isolate`). The backdrop's `inset:0` therefore covers exactly the workspace column, not the nav. If `ComposeWorkspace` renders the modal inside `<section className="sf-workspace sf-compose">`, confirm that section is the positioned ancestor; it is.

- [ ] **Step 5: Style the modal forms + buttons.** Append to the same CSS section:

```css
.sf-compose-modal-new,
.sf-compose-modal-choose,
.sf-compose-modal-load {
  display: grid;
  gap: 14px;
}
.sf-compose-modal-new label {
  display: grid;
  gap: 6px;
  color: var(--sf-muted);
  font-size: 13px;
  font-weight: 600;
}
.sf-compose-modal-new input {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--sf-line-strong);
  border-radius: 8px;
  background: rgba(8, 10, 14, 0.45);
  color: var(--sf-text);
  padding: 0 12px;
  font: inherit;
  font-size: 14px;
}
.sf-compose-modal-new input:focus-visible {
  outline: none;
  border-color: var(--sf-blue);
  box-shadow: 0 0 0 3px rgba(90, 167, 255, 0.22);
}
.sf-compose-modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.sf-compose-modal-actions button {
  min-height: 38px;
  border-radius: 8px;
  border: 1px solid var(--sf-line-strong);
  background: rgba(255, 255, 255, 0.04);
  color: var(--sf-text);
  padding: 0 16px;
  font: inherit;
  font-size: 14px;
  font-weight: 650;
  cursor: pointer;
  transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease;
}
.sf-compose-modal-actions button:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: var(--sf-line-strong);
  background: rgba(255, 255, 255, 0.07);
}
.sf-compose-modal-actions button[type="submit"],
.sf-compose-modal-choose .sf-compose-modal-actions button:first-child {
  border-color: transparent;
  background: linear-gradient(180deg, rgba(125, 204, 114, 0.92), rgba(96, 173, 90, 0.92));
  color: #0c1410;
}
.sf-compose-modal-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sf-compose-session-list {
  list-style: none;
  padding: 0;
  margin: 4px 0 0;
  display: grid;
  gap: 8px;
  max-height: 320px;
  overflow: auto;
}
.sf-compose-session-list button {
  width: 100%;
  text-align: left;
  display: grid;
  gap: 3px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--sf-line);
  background: rgba(255, 255, 255, 0.03);
  color: var(--sf-text);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}
.sf-compose-session-list button:hover {
  border-color: var(--sf-line-strong);
  background: rgba(255, 255, 255, 0.06);
}
.sf-compose-session-list strong { font-size: 14px; }
.sf-compose-session-list span { color: var(--sf-muted); font-size: 12px; }
```

- [ ] **Step 6: Run; verify PASS** — vitest for SessionModal (new + existing pass) + `npm run build`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/spec-factory/compose/SessionModal.tsx dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "fix(compose-ui): scope session modal to workspace + style modal forms"
```

---

## Task 2: Restore the "Add sources" modal in SourcesPanel

**Files:**
- Modify: `dashboard/src/spec-factory/compose/SourcesPanel.tsx`
- Create: `dashboard/src/spec-factory/compose/AddSourceModal.tsx`
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css` (reuse + extend existing `.sf-source-*` modal rules)
- Test: `dashboard/src/spec-factory/compose/SourcesPanel.test.tsx` (extend), `dashboard/src/spec-factory/compose/AddSourceModal.test.tsx` (create)

**Goal:** Replace the three raw inline add-fields (`Add files` / `Add a note` / `YouTube URL`) with a single polished **"Add sources"** button that opens a modal (reusing the existing `.sf-source-modal` CSS) offering: drop/upload files, paste a note, add a YouTube/web URL. Keep the converted-source list + badges + Retry + the Analyze button in the panel. The panel's existing props are unchanged — the modal calls the same `onUploadFiles`/`onAddNote`/`onAddYoutube` handlers.

- [ ] **Step 1: Write AddSourceModal test** — `dashboard/src/spec-factory/compose/AddSourceModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddSourceModal } from "./AddSourceModal.js";

describe("AddSourceModal", () => {
  it("renders a dialog with file, note, and url affordances and closes", () => {
    const onClose = vi.fn();
    render(
      <AddSourceModal onClose={onClose} onUploadFiles={vi.fn()} onAddNote={vi.fn()} onAddYoutube={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: /Add source material/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Close add sources/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("submits a note and closes", () => {
    const onAddNote = vi.fn();
    const onClose = vi.fn();
    render(
      <AddSourceModal onClose={onClose} onUploadFiles={vi.fn()} onAddNote={onAddNote} onAddYoutube={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText(/Paste a note/i), { target: { value: "Repo is billing-service" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add note$/i }));
    expect(onAddNote).toHaveBeenCalledWith("Repo is billing-service");
    expect(onClose).toHaveBeenCalled();
  });

  it("submits a youtube url", () => {
    const onAddYoutube = vi.fn();
    render(
      <AddSourceModal onClose={vi.fn()} onUploadFiles={vi.fn()} onAddNote={vi.fn()} onAddYoutube={onAddYoutube} />,
    );
    fireEvent.change(screen.getByLabelText(/YouTube or web URL/i), { target: { value: "https://youtu.be/x" } });
    fireEvent.click(screen.getByRole("button", { name: /Add URL/i }));
    expect(onAddYoutube).toHaveBeenCalledWith("https://youtu.be/x");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <AddSourceModal onClose={onClose} onUploadFiles={vi.fn()} onAddNote={vi.fn()} onAddYoutube={vi.fn()} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run; verify FAIL.**

- [ ] **Step 3: Implement `AddSourceModal.tsx`:**

```tsx
import { useEffect, useRef, useState } from "react";
import { FileUp, Link2, X } from "lucide-react";

export function AddSourceModal({
  onClose,
  onUploadFiles,
  onAddNote,
  onAddYoutube,
}: {
  onClose: () => void;
  onUploadFiles: (files: File[]) => void;
  onAddNote: (content: string) => void;
  onAddYoutube: (url: string) => void;
}) {
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sf-source-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="sf-source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sf-add-source-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="sf-source-close" type="button" aria-label="Close add sources" onClick={onClose}>
          <X size={28} aria-hidden="true" />
        </button>

        <header className="sf-source-modal-header">
          <h2 id="sf-add-source-title">
            Add source material for
            <span> your Epic</span>
          </h2>
        </header>

        <label
          className="sf-source-big-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length) {
              onUploadFiles(files);
              onClose();
            }
          }}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            aria-label="Upload files"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) {
                onUploadFiles(files);
                onClose();
              }
            }}
          />
          <FileUp size={34} aria-hidden="true" />
          <strong>Drop files or click to upload</strong>
          <span>PDF, slides, docs, spreadsheets, images, audio, and more</span>
        </label>

        <div className="sf-add-source-fields">
          <div className="sf-add-source-field">
            <label htmlFor="sf-add-source-note">Paste a note</label>
            <textarea
              id="sf-add-source-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Paste notes, ideas, or directions…"
            />
            <button
              type="button"
              className="sf-button sf-button-primary"
              disabled={note.trim().length === 0}
              onClick={() => {
                onAddNote(note.trim());
                onClose();
              }}
            >
              Add note
            </button>
          </div>

          <div className="sf-add-source-field">
            <label htmlFor="sf-add-source-url">YouTube or web URL</label>
            <div className="sf-add-source-url-row">
              <span aria-hidden="true"><Link2 size={18} /></span>
              <input
                id="sf-add-source-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://youtu.be/…"
              />
              <button
                type="button"
                className="sf-button sf-button-primary"
                disabled={url.trim().length === 0}
                onClick={() => {
                  onAddYoutube(url.trim());
                  onClose();
                }}
              >
                Add URL
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `SourcesPanel.tsx`** to use the button+modal and keep the source list. Replace the three inline add-blocks (`sf-source-add-row` button, `sf-source-add-note`, `sf-source-add-youtube`) with a single "Add sources" button that opens `AddSourceModal`; KEEP the `<ul className="sf-compose-source-list">` and the Analyze button in the header. The props stay identical. New version:

```tsx
import { useState } from "react";
import { FilePlus2 } from "lucide-react";
import type {
  ComposeConversionStatus,
  ComposeSourceSummary,
} from "./composeTypes.js";
import { AddSourceModal } from "./AddSourceModal.js";

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
  const [addOpen, setAddOpen] = useState(false);

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
        <button
          className="sf-source-add-button"
          type="button"
          onClick={() => setAddOpen(true)}
        >
          <FilePlus2 size={18} aria-hidden="true" />
          Add sources
        </button>
      </div>

      {sources.length === 0 ? (
        <div className="sf-source-saved-area">
          <strong>Saved sources will appear here</strong>
          <span>Drop files, paste notes, or add a YouTube/web URL from “Add sources”.</span>
        </div>
      ) : (
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
      )}

      {addOpen ? (
        <AddSourceModal
          onClose={() => setAddOpen(false)}
          onUploadFiles={onUploadFiles}
          onAddNote={onAddNote}
          onAddYoutube={onAddYoutube}
        />
      ) : null}
    </section>
  );
}
```

- [ ] **Step 5: Update `SourcesPanel.test.tsx`** for the new flow. The existing tests reference the inline `Add a note`/`Upload files`/`Add note` fields directly in the panel — those now live behind the "Add sources" button. Update them: assert the "Add sources" button opens the modal, then the note/url/upload affordances are reachable inside it. Keep the badge/Retry/Analyze tests (those are still in the panel). Concretely:
  - Replace any test that does `getByLabelText(/Add a note/i)` directly with: click `getByRole("button",{name:/Add sources/i})` first, then query within the dialog.
  - Keep: Analyze disabled when `analyzing||sources.length===0`; badge labels; Retry on failed/unsupported; the converted list rendering.
  - Add: clicking "Add sources" shows `getByRole("dialog",{name:/Add source material/i})`.

  (Write concrete assertions mirroring AddSourceModal.test.tsx for the in-modal actions; ensure `onUploadFiles`/`onAddNote`/`onAddYoutube` still fire with the same args.)

- [ ] **Step 6: Add CSS** for the modal's note/url field layout (reuses existing `.sf-source-backdrop/.sf-source-modal/.sf-source-big-drop/.sf-source-modal-header`). Append to the Compose section:

```css
.sf-add-source-fields {
  display: grid;
  gap: 20px;
}
.sf-add-source-field {
  display: grid;
  gap: 8px;
}
.sf-add-source-field > label {
  color: rgba(242, 243, 245, 0.78);
  font-size: 15px;
  font-weight: 600;
}
.sf-add-source-field textarea {
  min-height: 96px;
  resize: vertical;
  border: 1px solid var(--sf-line-strong);
  border-radius: 8px;
  background: rgba(8, 10, 14, 0.4);
  color: var(--sf-text);
  padding: 12px;
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
}
.sf-add-source-field .sf-button {
  justify-self: start;
}
.sf-add-source-url-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--sf-line-strong);
  border-radius: 8px;
  background: rgba(8, 10, 14, 0.4);
  padding: 6px 6px 6px 14px;
}
.sf-add-source-url-row > span { color: var(--sf-muted); display: grid; place-items: center; }
.sf-add-source-url-row input {
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--sf-text);
  font: inherit;
  font-size: 14px;
  padding: 8px 0;
}
```

- [ ] **Step 7: Run; verify PASS** (AddSourceModal + SourcesPanel suites) + `npm run build`.

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/spec-factory/compose/AddSourceModal.tsx dashboard/src/spec-factory/compose/AddSourceModal.test.tsx dashboard/src/spec-factory/compose/SourcesPanel.tsx dashboard/src/spec-factory/compose/SourcesPanel.test.tsx dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "feat(compose-ui): restore Add sources modal (drop/note/url) + source list"
```

---

## Task 3: Polish ChatPanel dock + PreviewPanel empty state

**Files:**
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css`
- Test: existing ChatPanel/PreviewPanel suites still pass (no component API change)

**Problem:** `ChatPanel` uses a `<textarea aria-label="Message">` in `.sf-chat-dock`, but the dock CSS only styled `.sf-chat-dock input`. And `.sf-compose-empty` / preview empty state are unstyled.

- [ ] **Step 1: Add CSS.** Append to the Compose section:

```css
/* ChatPanel dock now uses a textarea (multi-line) */
.sf-chat-dock textarea {
  min-width: 0;
  border: 0;
  outline: 0;
  resize: none;
  max-height: 120px;
  background: transparent;
  color: #f7f8ff;
  font: 500 15px/1.4 inherit;
  padding: 8px 0;
}
.sf-chat-dock textarea::placeholder { color: rgba(247, 248, 255, 0.68); }
.sf-chat-send:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
.sf-chat-thinking { opacity: 0.75; font-style: italic; }

/* Preview / compose empty states */
.sf-compose-empty {
  color: var(--sf-muted);
  font-size: 13px;
  line-height: 1.6;
}
.sf-preview-panel .sf-compose-open-questions li {
  color: var(--sf-text);
  font-size: 13px;
  line-height: 1.5;
}
.sf-preview-panel .sf-button-primary {
  width: 100%;
  justify-content: center;
}
```

> The `.sf-chat-dock` grid is `minmax(0,1fr) 44px` — a textarea fits the first column. If the dock's vertical centering looks off with a textarea, set `.sf-chat-dock { align-items: center; }` (only if needed — verify visually via the build; do not over-edit).

- [ ] **Step 2: Run** the full compose suite + `npm run build`; confirm ChatPanel/PreviewPanel tests still pass (no markup change).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/spec-factory/SpecFactoryPage.css
git commit -m "fix(compose-ui): style chat textarea dock + preview empty/question states"
```

---

## Task 4: Full suite + visual self-check + completion

**Files:**
- Create: `docs/superpowers/plans/2026-06-03-compose-ui-polish-COMPLETION.md`

- [ ] **Step 1: Full gates** — from `dashboard/`: `npm run test` (zero failures) and `npm run build` (✓). Record counts. Baseline before this work: 467 passed | 4 skipped. New AddSourceModal tests add ~4; SessionModal +1; SourcesPanel tests change but net count stays positive. Expect ZERO failures.

- [ ] **Step 2: Grep guard** — confirm no component still emits an unstyled-orphan class and the global backdrop is gone from the session modal:
```bash
cd dashboard
grep -rn "sf-modal-backdrop" src/spec-factory/compose/   # expect: no output (session modal now uses sf-compose-modal-backdrop)
grep -rn "sf-source-add-note\|sf-source-add-youtube" src/spec-factory/compose/  # expect: no output (replaced by the modal)
```

- [ ] **Step 3: Write completion notes** covering: the nav-blocking fix (scoped backdrop), the restored Add sources modal, the form/dock/empty-state styling, test/build results, and a manual visual checklist (modal doesn't cover nav; Add sources opens a polished modal; fields are aligned; chat dock styled; converted sources list shows badges).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-03-compose-ui-polish-COMPLETION.md
git commit -m "docs(compose): UI polish completion notes"
```

---

## Self-Review

**Spec coverage:** nav-blocking modal → Task 1 (scoped backdrop). Lost "Add sources" modal → Task 2. Overlapping labels/inputs → Tasks 1+2 (form CSS). Unstyled buttons → Tasks 1+2. Chat dock textarea → Task 3. Empty states → Task 3. All use existing tokens; no new aesthetic. ✓

**Placeholder scan:** all CSS + component code is concrete. Task 2 Step 5 (SourcesPanel test update) describes exact assertions to mirror — implementer writes them against the new markup. ✓

**Type consistency:** `AddSourceModal` props (`onClose, onUploadFiles, onAddNote, onAddYoutube`) ← passed by `SourcesPanel` from its own identical-named props. `SourcesPanel`/`ChatPanel`/`PreviewPanel`/`SessionModal` public prop signatures UNCHANGED → `ComposeWorkspace` needs no edits (except Task 1 confirms the modal scoping works within `.sf-compose`). ✓

**Risk:** the scoped backdrop relies on `.sf-compose { position: relative }` (verified present). If `ComposeWorkspace` renders `<SessionModal/>` inside `<section className="sf-workspace sf-compose">`, the absolute backdrop covers the workspace column only. Confirm during Task 1 that the modal is a child of that section (it is — `ComposeWorkspace` returns the SessionModal inside the `.sf-workspace.sf-compose` section when `sessionId===null`).
