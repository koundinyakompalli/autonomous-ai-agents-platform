# Compose Sessions — Phase 1 Completion Notes

**Branch:** `feat/compose-sessions-phase-1`
**Status:** Implementation complete; all backend tests green; build clean.

## What shipped

Phase 1 proves the Compose→draft integration end-to-end: a Compose session whose only
source is a typed-in note can be handed off and produce a `draft_ready` card on the
existing Spec Board, flowing through the **unchanged** `generateDraft` pipeline via a
pluggable `EvidenceProvider` selected by a new `origin` column.

Delivered (14 commits, `439e18f` → `3bb8227`):

| Task | What |
|------|------|
| 1 | Migration 037: `origin` column on `spec_factory_sources` + `compose_sessions`, `compose_session_sources`, `compose_session_messages` tables; mirrored into `db/schema.sql`. |
| 2 | `compose-types.ts` — Zod enums, interfaces, `composeSourceJiraKey`. |
| 3 | `origin` surfaced through `SpecFactorySourceSummary` / `SourceRow` / `mapSource` / all source SELECTs. |
| 4 | `createComposeSource` + `getSourceOrigin` on `SpecFactoryRepository`. |
| 5 | `buildComposeEvidenceManifest` (non-Jira manifest builder). |
| 6 | `ComposeRepository` (sessions/sources/messages CRUD). |
| 7 | `ComposeEvidenceProvider` (the compose half of the seam). |
| 8 | `generateDraft` selects the evidence provider by `origin`; compose skips the autonomous reject and the zero-repo hard-fail; fails fast if a compose source has no provider. **Louise path provably unchanged (characterization test).** |
| 9 | `ComposeService` (create/list/get/addNote/handoff, idempotent handoff). |
| 10 | `compose-routes.ts` + server wiring; mounted at `/api/spec-factory/compose`. |

## Verification (as of completion)

- `npm run build` (tsc): **clean**.
- `npx vitest run src/spec-factory`: **138 tests pass across 20 files.**
- Backend compose + touched files in isolation (`compose-*.test.ts`, `service.test.ts`,
  `database.test.ts`, `evidence.test.ts`): **78/78 pass.**

### Known environmental note (not a Phase-1 regression)

Running `npx vitest run src/spec-factory` surfaces one startup error:
`Cannot find package 'jsdom'`. This originates from **dashboard frontend `.tsx` tests**
(which declare `vitest-environment jsdom`); `jsdom` is a `dashboard/package.json`
devDependency that is not installed at the repo root. None of the Phase-1 backend
files request jsdom, and all 138 backend tests pass. Pre-existing, unrelated to this
work. (To silence locally: install dashboard deps or scope vitest to `src/`.)

### Lineage note

The branch also contains `96bd60e Fix Spec Factory draft timeout recovery` (pre-existing,
inherited from `fix/spec-factory-timeout-recovery`). The `draft-generator.*` changes in
`git diff main...HEAD` belong to that commit, **not** to Compose Phase 1.

## Manual happy-path (requires migration 037 applied to a dev DB + service on :3012)

```
1. POST /api/spec-factory/compose/sessions { "name": "Billing export" }
   -> 201, { id }
2. POST /api/spec-factory/compose/sessions/<id>/notes
   { "content": "We need CSV export for the billing-service repo. AC: invoices export as CSV; existing PDF export unchanged." }
   -> 202
3. POST /api/spec-factory/compose/sessions/<id>/handoff
   -> 202, { sourceId }
4. GET  /api/spec-factory/louise/candidates
   -> the COMPOSE-<id> source appears; within one processing cycle its state
      becomes draft_ready (origin: "compose").
5. GET  /api/spec-factory/sources/<sourceId>/drafts/latest
   -> 200 with a rendered Epic bundle.
```

## Endpoints added (`/api/spec-factory/compose`)

| Method & path | Result | Notes |
|---|---|---|
| `POST /sessions` | 201 | body `{ name, userName? }`; blank name → 400. |
| `GET /sessions` | 200 | list (LIMIT 200). |
| `GET /sessions/:sessionId` | 200 / 404 | not-found → 404. |
| `POST /sessions/:sessionId/notes` | 202 | body `{ content }`; blank → 400. |
| `POST /sessions/:sessionId/handoff` | 202 | mints `COMPOSE-<id>` source, idempotent. |

## Deferred to later phases (intentional)

- **Phase 2:** presigned S3 uploads + bucket CORS; markitdown sidecar; conversion worker
  (replaces the note-as-`system`-message Phase-1 shortcut with workspace-file reads via
  `markdown_path`); Sources panel live states + retry.
- **Phase 3:** SSE streaming; persistent resumable Claude chat agent; `context.md` + `chat.md`;
  readiness gate + confetti + "Draft anyway."
- **Phase 4:** voxtral audio (verified available in `us-east-2`); edge formats.

## Phase-2 hardening backlog (surfaced by review, acceptable for Phase 1)

- DB-level uniqueness on `compose_sessions.source_id` (or `linkSource` idempotency) for
  concurrent handoff safety.
- `createSession` insert-then-update path has a failure window (row with empty paths if
  `updateSessionPaths` fails).
- Note filename `note-<sourceCount+1>.md` can collide if notes are deleted or added
  concurrently.
- `listSessionSourceContents` LIKE pattern assumes server-generated filenames (no SQL
  wildcards / `]]`) — documented in code.
- Optional: extract shared `errorPayload`/`optionalString` route helpers; map a third
  `origin` via a registry rather than an `isCompose` boolean if more origins are added.
- Micro-opt (cold path): `generateDraft` calls both `getSourceById` (which now selects
  `origin`) and a separate `getSourceOrigin`. Could read `source.origin` off the already-
  fetched source to drop one round-trip. Deferred — negligible vs. the LLM draft step, and
  would require updating the compose tests' `getSourceById` mocks to carry `origin`.
