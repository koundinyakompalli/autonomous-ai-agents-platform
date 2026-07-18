# Compose Sessions — Phase 3a Completion Notes

**Branch:** `feat/compose-sessions-phase-3a` (off latest `main` incl. merged Phases 1+2)
**Status:** Implementation complete; backend tests green; build clean.

## What shipped (clarification backend)

Phase 3a adds the "Claude-against-a-folder" clarification loop on the backend: an **Analyze Sources** context pass, a **resumable chat agent**, a **readiness verdict** that gates handoff, and an **SSE** channel streaming assistant turns.

| Task | What |
|------|------|
| 1 | `compose-types.ts`: `ComposeReadinessSchema`, `ComposeChatEnvelopeSchema` + `ComposeChatEnvelope`, `ComposeChatEvent` SSE union. |
| 2 | `ComposeRepository`: `listMessages`, `setClaudeSessionId`, `setReadiness` (promotion-only — documented). |
| 3 | `ComposeWorkspaceManager`: writes `chat.md`/`context.md` into the session workspace + registers it as an SDK repo. |
| 4 | `ComposeChatAgent`: resumable `runAgent` wrapper (analyze + chat modes) returning the structured `{reply, readiness, contextMarkdown?}` envelope. |
| 5 | `ComposeSseHub`: per-session SSE fan-out + 20s heartbeat (+ documented unsubscribe contract). |
| 6 | `ComposeService`: `runTurn` (one-active-turn lock + prepare + agent + persist + SSE publish), `analyze`, `postMessage`, `listMessages`; constructor grows to 9 args. |
| 7 | Routes: `POST /analyze`, `POST /messages`, `GET /messages`, `GET /stream` (SSE); router takes the hub. |
| 8 | Server wiring: `ComposeChatAgent`/`ComposeWorkspaceManager`/`ComposeSseHub` constructed, `startHeartbeat()`, 9-arg `ComposeService`, hub passed to the router. (Folded into Tasks 6+7 commits to keep the build green.) |

## Verification (as of completion)

- `npm run build` (tsc): **clean**.
- `npx vitest run src/spec-factory`: **196 tests pass across 26 files.**
- New module test counts: compose-types (+chat), compose-database (listMessages/set*), compose-workspace (2), compose-chat-agent (3), compose-sse (4), compose-service (analyze/postMessage/listMessages), compose-routes (analyze/messages/stream incl. SSE subscribe+unsubscribe).

### Known environmental note (pre-existing, unrelated)

The full `src/spec-factory` run reports **1 error: `Cannot find package 'jsdom'`** — from dashboard frontend `.tsx` tests collected by the glob (jsdom is a `dashboard/package.json` devDependency, not installed at the repo root). No Phase-3a backend file uses jsdom; all 196 backend tests pass. Same pre-existing noise seen in Phases 1+2.

## Endpoints added (`/api/spec-factory/compose`)

| Method & path | Result | Notes |
|---|---|---|
| `POST /sessions/:id/analyze` | 200 → readiness | the "Analyze Sources" trigger; runs the context pass, persists context.md + an assistant turn, opens the chat. |
| `POST /sessions/:id/messages` | 200 → readiness | a chat turn; persists user+assistant turns, resumes the warm Claude thread. |
| `GET  /sessions/:id/messages` | 200 → messages | durable transcript. |
| `GET  /sessions/:id/stream` | SSE | `status` / `message` / `readiness` events; 20s heartbeat. |

(Readiness is also persisted on the session via `readiness_json`; the existing `POST /handoff` is unchanged and can be called any time — the "Draft anyway" override is a UI concern in Phase 3b.)

## Load-bearing constraints / env vars

- **SSE through the ALB:** the spec-factory ALB target group sets **no `idle_timeout`** → defaults to **60s**. The SSE stream sends `: ping` every **20s** (`COMPOSE_SSE_HEARTBEAT_MS`, default 20000) so a long agent turn (minutes) isn't reaped. Verify on deploy that the ALB doesn't buffer SSE (the route also sets `X-Accel-Buffering: no`, `Cache-Control: no-transform`).
- **`COMPOSE_CHAT_TIMEOUT_MS`** (default 300000 = 5 min) bounds each agent turn.
- One active turn per session (in-memory `activeTurns` lock); a concurrent message is rejected with "a clarification turn is already in progress".
- The chat agent is `read_only` and resumes via `claude_session_id` (`forkSessionOnResume: false`).

## Deployment

No new infra and no migration. The chat agent reuses the existing Bedrock/`runAgent` path and the EFS session workspace (already mounted). Ships via the normal CI image build + ECS redeploy on merge to `main`. (`COMPOSE_SSE_HEARTBEAT_MS`/`COMPOSE_CHAT_TIMEOUT_MS` have safe code defaults; set them in terraform only if you want to override.)

## Manual happy-path (requires deploy + a converted session from Phase 2)

```
1. (Phase 2) create session + add a note/file → it converts to a source.
2. POST /compose/sessions/<id>/analyze
   -> 200 { ready:false, openQuestions:[...], summary } ; an assistant message is persisted.
3. GET  /compose/sessions/<id>/stream (EventSource) -> receives status/message/readiness events.
4. POST /compose/sessions/<id>/messages { "content":"It's the billing-service repo" }
   -> 200 { ready:true|false, ... } ; user+assistant turns persisted; SSE carries them.
5. GET  /compose/sessions/<id>/messages -> the full transcript.
6. When ready:true, POST /compose/sessions/<id>/handoff (existing) -> draft_ready card with the gathered context as evidence.
```

## Phase-3a → Phase-3b handoff

The backend now exposes `/analyze`, `/messages` (POST+GET), `/stream` (SSE), and readiness on the session. **Phase 3b** (the dashboard React UI — plan already written: `2026-06-02-compose-sessions-phase-3b-frontend.md`) builds the modal, three-panel workspace, live source badges, the chat box wired to `/messages` + `/stream`, the **Analyze Sources** button → `/analyze`, the readiness-gated **Generate Draft** button + confetti → existing `/handoff`, and "Draft anyway". **3b's live happy-path requires 3a deployed.**

## Backlog (carried from reviews; intentionally deferred)

- Dual-schema (hand-written JSON schema + Zod) drift risk in `ComposeChatAgent` — matches the existing `qualifier.ts` pattern; no sync test (accepted codebase convention).
- The double `workspaceManager.prepare` per turn when `contextMarkdown` changes (writes chat.md twice) — infrequent, tiny files; acceptable.
- `setReadiness` is promotion-only (never demotes row status; live readiness from `readiness_json`) — deliberate to avoid board flip-flopping.
