# Compose Sessions — Phase 3b Completion Notes

**Branch:** `feat/compose-sessions-phase-3b` (off latest `main` incl. merged Phases 1+2+3a)
**Status:** Implementation complete; frontend tests green; build clean.

## What shipped (the Compose dashboard UI)

Phase 3b adds the complete React dashboard UI for Compose: a tabbed **Compose** view in the Spec Factory page, a session modal (New/Load), a three-panel workspace (Sources + Chat + Preview), live source conversion badges with retry, the **Analyze Sources** button, SSE-driven chat with thinking indicator, readiness gating + confetti, and **Generate Draft → Send to Spec Board** handoff with an override.

| Task | What |
|------|------|
| 1 | `composeTypes.ts`: UI types (`ComposeSession`, `ComposeSource`, `ComposeMessage`, `ComposeReadiness`) + exported `FormattedText` component from `SpecFactoryPage.tsx`. |
| 2 | `composeApi.ts`: full fetch client for sessions/sources/messages/notes/youtube/reconvert/analyze/postMessage/handoff + 3-step presigned `uploadFile` (get presigned URL, PUT to S3, confirm). |
| 3 | `useComposeStream.ts`: SSE hook subscribing to `/sessions/:id/stream`; exposes `status`/`message`/`readiness` events via handler-ref; re-subscribes on session change. |
| 4 | `SessionModal.tsx`: New/Load modal, role=dialog "Compose session"; New creates a session, Load lists existing sessions to resume. |
| 5 | `SourcesPanel.tsx`: add files/note/youtube UI; live conversion badges over 6 statuses (`pending`/`converting`/`converted`/`failed`/`unsupported`/`analyzing`); Retry button on failed/unsupported; Analyze Sources button gated on `analyzing || sources.length===0`. |
| 6 | `ChatPanel.tsx`: message list rendered via `FormattedText`; Enter-to-send input (Shift+Enter = newline); thinking indicator during assistant turns. |
| 7 | `PreviewPanel.tsx` + `Confetti.tsx`: readiness summary + open questions; readiness-gated "Generate Draft → Send to Spec Board" / "Draft anyway" override; dependency-free confetti when ready. |
| 8 | `ComposeWorkspace.tsx`: container orchestrating session state, source polling while in-flight, SSE→state wiring, all panels + analyze + handoff flows. |
| 9 | Swapped the static mockup in `SpecFactoryPage.tsx` for live `<ComposeWorkspace/>`, removed 2 obsolete mockup page tests + 6 orphaned icon imports, appended Compose CSS. |
| 10 | Full-suite verification + these notes. |

## Verification (as of completion)

- `npm run test` (vitest from `dashboard/`): **64 test files passed | 1 skipped (65); 467 tests passed | 4 skipped (471).**
- `npm run build` (vite build + tsc server config): **clean** (vite ✓ built in 966ms; tsc server config clean).

### Note: `tsc --noEmit` is NOT the gate for this dashboard

Main carries ~53 pre-existing tsc errors (inherited tech debt). The enforced gates are `npm run test` (vitest) and `npm run build` (vite + tsc server config), both of which are green.

## Endpoints consumed (all under `/api/spec-factory/compose`)

Phase 3b consumes the backend built in Phases 1/2/3a:

| Method & path | Used for |
|---|---|
| `POST /sessions` | Create new compose session. |
| `GET  /sessions` | List sessions for Load modal. |
| `GET  /sessions/:id` | Fetch session metadata. |
| `GET  /sessions/:id/sources` | Poll source list for live badges. |
| `POST /sessions/:id/notes` | Add note source. |
| `POST /sessions/:id/youtube` | Add YouTube source. |
| `POST /sessions/:id/uploads` + S3 PUT + `POST /sessions/:id/sources/:sid/uploaded` | 3-step presigned file upload. |
| `POST /sessions/:id/sources/:sid/reconvert` | Retry failed/unsupported source. |
| `POST /sessions/:id/analyze` | Analyze Sources trigger (context pass). |
| `POST /sessions/:id/messages` | Send chat message (user turn). |
| `GET  /sessions/:id/messages` | Fetch full transcript. |
| `GET  /sessions/:id/stream` | SSE channel (status/message/readiness events). |
| `POST /sessions/:id/handoff` | Generate Draft → Send to Spec Board. |

## Cross-phase dependency

The UI builds and unit-tests fully against mocked network (MSW), but the **live happy-path requires Phases 1/2/3a DEPLOYED** (the backend endpoints).

## Manual verification path (requires deploy + dashboard running against it)

```
1. Open the dashboard → Compose tab → "New Session" → name it → Create.
2. Add a note ("Repo is billing-service. Add CSV export.") and/or upload a PDF → badge goes converting → converted.
3. Click "Analyze Sources" → an assistant message appears in chat with open questions; Preview shows the summary + questions.
4. Answer in chat ("Use billing-service, export invoices as CSV") → assistant replies via SSE; readiness updates.
5. When ready → confetti + "Generate Draft → Send to Spec Board"; click it → the COMPOSE-<id> card appears in Spec Board → Ready For Review.
6. (Override) at any point click "Draft anyway" to hand off with open questions remaining.
```

## Deferred polish (acceptable, noted)

- **Drag-and-drop dropzone**: we use a file-picker button (simpler, works fine).
- **In-chat token streaming**: we refetch the full transcript on each SSE `message` event rather than streaming deltas — simpler and correct; the backend already persists the complete turn.
- **Source content preview**: no inline preview of converted source content in the UI (the backend has it in the workspace markdown; not exposed via API yet).
- **Audio transcription**: Phase 4 (voxtral integration).

## Deployment

No new infra or migration. Phase 3b ships via the normal dashboard CI build + static asset deploy on merge to `main`. The live endpoints are already deployed from Phase 3a.

## Phase-3b → next

The Compose frontend is complete. The next phase (Phase 4) adds **audio transcription** (voxtral) as a new source type, reusing the same conversion pipeline and workspace flow.

## Backlog (carried from implementation; intentionally accepted)

- **Source polling**: `ComposeWorkspace` polls `/sessions/:id/sources` every 2s while any source is `pending` or `converting`. Acceptable for the small source counts (≤10) and short conversion times (seconds). Could be upgraded to SSE source events if conversion latency grows.
- **SSE reconnect**: `useComposeStream` reconnects on disconnect but does not replay missed events — the UI refetches messages on reconnect to stay in sync. Acceptable given the durable transcript; chat turns are never lost.
- **"Thinking..." indicator**: shown during assistant turns but does not convey token-level progress. Acceptable given the typical turn duration (seconds).
