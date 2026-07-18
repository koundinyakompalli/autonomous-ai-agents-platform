# Compose UI Polish — Completion Notes

**Branch:** `fix/compose-ui-polish` (off `main`, which has merged Phases 1/2/3a/3b + the Phase 4 plan).
**Status:** Complete; full dashboard suite green; build clean.

## Why

Phase 3b swapped the static Compose mockup for live functional components, but the new
components emitted class names that were never styled and used raw HTML form fields — so the
rich styling that still lives in `SpecFactoryPage.css` no longer applied. Result (from the
reported screenshots): overlapping labels/inputs, unstyled gray buttons, a lost "Add sources"
modal, a chat dock floating at the top of an empty panel, and a session modal whose backdrop
covered the entire viewport — including the side-nav — blocking navigation.

## What shipped

| Task | What | Commits |
|------|------|---------|
| 1 | **Session modal no longer blocks the side-nav.** Swapped the global `.sf-modal-backdrop` (`position: fixed; inset: 0`, covered the whole viewport) for a workspace-scoped `.sf-compose-modal-backdrop` (`position: absolute; inset: 0` inside the positioned `.sf-compose` column). The side-nav (Spec Board / OneShot / etc.) stays clickable while the Compose modal is up. Also styled the New/Load/choose forms, inputs, and buttons to the design system. | `bfe3791`, `c57380f`, `e1c1d12` |
| 2 | **Restored the "Add sources" modal.** A single polished "Add sources" button opens `AddSourceModal` (drag-drop/click-to-upload files, paste a note, add a YouTube/web URL), reusing the existing `.sf-source-*` modal CSS, wired to the real `onUploadFiles`/`onAddNote`/`onAddYoutube` handlers. The Sources panel keeps the converted-source list, live conversion badges, Retry, the empty "saved sources" state, and the Analyze button. Removed the raw inline add-fields. | `73f303d`, `f521dd9` |
| 3 | **Chat dock + layout + empty states.** Styled the chat dock's `<textarea>` (the panel now uses a textarea, which had no matching CSS); laid out `.sf-chat-panel` as a column so the conversation grows/scrolls and the dock pins to the bottom; styled the disabled send button, the "thinking" bubble, the preview empty state, and the open-questions list; made the Generate/Draft button full-width. | `52871a2` |
| 4 | Full-suite verification + these notes. | (this doc) |

All styling reuses the **existing** Spec Factory design tokens (`--sf-text`, `--sf-muted`,
`--sf-surface-2`, `--sf-line`, `--sf-line-strong`, `--sf-blue`, `--sf-green`, `--sf-glass-blur`)
and existing classes — no new aesthetic was introduced.

## Verification

- `npm run test` (full dashboard): **474 passed | 4 skipped, 0 failures** (baseline was 467; +AddSourceModal, +SessionModal scope test, SourcesPanel tests reworked for the modal flow).
- `npm run build` (vite): **✓ built**, clean.
- Guards:
  - Every class emitted by the compose components now has a matching CSS rule (the original "unstyled orphan" bug is gone).
  - No compose component uses the global `.sf-modal-backdrop` (the `SessionModal.test.tsx` reference is the negative assertion proving it).
  - No orphaned inline `sf-source-add-note` / `sf-source-add-youtube` emitters or dead CSS.
- `tsc --noEmit` is NOT the gate for this dashboard (main carries ~53 pre-existing tsc errors); the gates are vite build + vitest.

## Manual visual checklist (after deploy / `npm run dev`)

```
1. Compose tab → the session modal is centered over the workspace ONLY; the side-nav
   (Spec Board, OneShot, Watchdog…) is still clickable.
2. New Session / Load Session forms: labels above inputs (no overlap), styled inputs +
   buttons; Create disabled until a name is typed; Load lists sessions as cards.
3. Enter a session → three glass panels (Sources / Chat / Preview).
4. Sources: "Add sources" opens a polished modal — drop/upload files, paste a note,
   add a YouTube/web URL; added sources appear as a list with conversion badges + Retry.
5. Chat: conversation fills the panel and scrolls; the rounded input dock pins to the
   bottom; Send disabled while empty/thinking.
6. Preview: empty state reads "Add sources, then click Analyze Sources to start."; after
   Analyze, shows the summary + open questions + a full-width Generate Draft / Draft anyway
   button (confetti when ready).
```

## Deployment

Frontend-only; ships via the normal dashboard image build + ECS redeploy on merge. No
migration, no terraform, no backend change.
