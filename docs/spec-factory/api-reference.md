# HTTP API reference

This document is the HTTP contract for Spec Factory's Compose and Louise
lanes. PR `#468` adds authoritative workflow projection and durable handoff/draft
behavior while preserving the existing route namespace. Route line numbers in
older passages are informational; endpoint names and request/response contracts
are authoritative.

## Contents

- [Base path, transport, and auth model](#base-path-transport-and-auth-model)
- [Actor identity](#actor-identity)
- [Stream tokens](#stream-tokens)
- [`Idempotency-Key` contract](#idempotency-key-contract)
- [SSE contract](#sse-contract)
- [Error envelope and status codes](#error-envelope-and-status-codes)
- [Compose routes](#compose-routes)
  - [`GET /repositories`](#get-repositories)
  - [`GET /sessions`](#get-sessions)
  - [`POST /sessions`](#post-sessions)
  - [`POST /sessions/import`](#post-sessionsimport)
  - [`GET /sessions/:sessionId`](#get-sessionssessionid)
  - [`GET /sessions/:sessionId/context`](#get-sessionssessionidcontext)
  - [`POST /sessions/:sessionId/resume`](#post-sessionssessionidresume)
  - [`POST /sessions/:sessionId/export`](#post-sessionssessionidexport)
  - [`DELETE /sessions/:sessionId`](#delete-sessionssessionid)
  - [`POST /sessions/:sessionId/turns/:turnJobId/cancel`](#post-sessionssessionidturnsturnjobidcancel)
  - [`POST /sessions/:sessionId/notes`](#post-sessionssessionidnotes)
  - [`POST /sessions/:sessionId/handoff`](#post-sessionssessionidhandoff)
  - [`GET /sessions/:sessionId/sources`](#get-sessionssessionidsources)
  - [`GET /sessions/:sessionId/sources/:sourceId/preview`](#get-sessionssessionidsourcessourceidpreview)
  - [`POST /sessions/:sessionId/uploads`](#post-sessionssessioniduploads)
  - [`POST /sessions/:sessionId/sources/:sourceId/uploaded`](#post-sessionssessionidsourcessourceiduploaded)
  - [`POST /sessions/:sessionId/youtube`](#post-sessionssessionidyoutube)
  - [`POST /sessions/:sessionId/jira`](#post-sessionssessionidjira)
  - [`POST /sessions/:sessionId/confluence`](#post-sessionssessionidconfluence)
  - [`POST /sessions/:sessionId/sources/reconvert-failed`](#post-sessionssessionidsourcesreconvert-failed)
  - [`DELETE /sessions/:sessionId/sources/:sourceId`](#delete-sessionssessionidsourcessourceid)
  - [`GET /sessions/:sessionId/source-deletions`](#get-sessionssessionidsource-deletions)
  - [`POST /sessions/:sessionId/sources/:sourceId/restore`](#post-sessionssessionidsourcessourceidrestore)
  - [`POST /sessions/:sessionId/sources/:sourceId/reconvert`](#post-sessionssessionidsourcessourceidreconvert)
  - [`POST /sessions/:sessionId/research/code`](#post-sessionssessionidresearchcode)
  - [`POST /sessions/:sessionId/analyze`](#post-sessionssessionidanalyze)
  - [`POST /sessions/:sessionId/messages`](#post-sessionssessionidmessages)
  - [`GET /sessions/:sessionId/messages`](#get-sessionssessionidmessages)
  - [`GET /sessions/:sessionId/workflow-state`](#get-sessionssessionidworkflow-state)
  - [`GET /sessions/:sessionId/stream`](#get-sessionssessionidstream)
- [Legacy draft-pipeline routes](#legacy-draft-pipeline-routes)
- [Rate limits, cost ceilings, and quotas](#rate-limits-cost-ceilings-and-quotas)

## Base path, transport, and auth model

- Base URL: `https://<dashboard-host>/api/spec-factory`. The dashboard ALB routes both `/api/spec-factory` and `/api/spec-factory/*` to the `SPEC-FACTORY` ECS service on port `3012` (`SPEC_FACTORY_PORT=3012`, container from `Dockerfile.spec-factory:33` running `node dist/spec-factory/main.js`).
- Router mounts (`src/spec-factory/server.ts:1104-1107`):
  - `/api/spec-factory/*` — legacy Louise/Jira draft routes.
  - `/api/spec-factory/compose/*` — Compose routes documented below.
- Transport: JSON over HTTP/1.1. `express.json({ limit: "2mb" })` request body cap (`src/spec-factory/server.ts:707`).
- Health: `GET /health` returns `{ "status": "ok" }` for ALB checks (`src/spec-factory/server.ts:1100`).

Auth model, in order of precedence:

1. **Ingress identity.** The ALB forwards the OIDC user via `x-amzn-oidc-identity` (or `x-forwarded-user` for local dev). `actorFromRequest` (`src/spec-factory/routes.ts:53-61`) extracts the trimmed header and returns `{ id, display }`. When both headers are missing the actor falls back to `spec-factory-operator`, which `session-guard.ts:11` treats as the `SYSTEM_ACTOR`.
2. **Actor context adapter.** Compose service methods internally lift `SpecFactoryActor` to an `ActorContext` (`src/spec-factory/session/session-guard.ts:18-34`) that carries `source: "oidc" | "system"` and admin roles derived from the comma-separated `SPEC_FACTORY_ADMIN_IDS` env var.
3. **Session-lifecycle gates.** Every write and every content read passes through one of `assertSessionReadable` / `assertSessionMutable` / `assertSessionStreamable` / `assertSessionHandoffAllowed` (`src/spec-factory/session/session-guard.ts:46-82`). Archived sessions and sessions owned by another non-admin actor both surface as `404 was not found`, matching the [operations doc](./operations.md#session-lifecycle). `SYSTEM_ACTOR` may read/write for background workers, admins come from `SPEC_FACTORY_ADMIN_IDS`, and legacy rows with `created_by IS NULL` remain accessible for compatibility.
4. **Password-protected sessions.** Sessions created with a non-empty `password` (`compose-service.ts:811`) require a caller-held stream token minted by `POST /sessions/:sessionId/resume`. The token is presented either as `x-compose-token: <token>` (for JSON reads and mutations) or `?token=<token>` (for SSE, which cannot set headers). See [Stream tokens](#stream-tokens).

Status — shipped: OIDC-derived owner and admin ACLs are enforced in the session-guard layer, with unowned legacy sessions preserved as readable/mutable. Plan §7.2.

## Actor identity

The `actor` field on every mutation body/log line is the OIDC identity. Do not send it in the request body; the API always reads it from headers via `actorFromRequest`.

| Ingress header         | Purpose                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `x-amzn-oidc-identity` | Primary OIDC sub id from the dashboard ALB.                            |
| `x-forwarded-user`     | Local dev proxies. Only used when `x-amzn-oidc-identity` is absent.    |
| `x-compose-token`      | Stream token for password-protected sessions (mutations + JSON reads). |
| `Idempotency-Key`      | Required turn dedup key. See below.                                    |
| `Last-Event-ID`        | Standard SSE resume cursor for `GET /stream`.                          |

## Stream tokens

Password-protected sessions mint short-lived tokens on `POST /resume` and revoke on archive.

- **Mint.** `POST /sessions/:sessionId/resume` with `{ "password": "<plain>" }` — service verifies against the argon2id-hashed password on the session, then mints a 32-byte hex token, hashes it (SHA-256), inserts into `compose_stream_tokens` with `expires_at = now + STREAM_TOKEN_TTL_MS` (30 min, `compose-service.ts:110`), and returns the plaintext token in the response. See `compose-service.ts:900-980`.
- **Verify.** `verifyStreamToken` hashes the incoming token and calls `verifyStreamTokenHash` (`compose-service.ts:940-956`). The route layer gates every protected read/mutation through `authorizeProtectedRead`/`authorizeProtectedMutation` (`compose-routes.ts:261-286`) which returns `401 A valid stream token is required` on mismatch or absent token.
- **Revoke.** `DELETE /sessions/:sessionId` archives the session AND calls `revokeSessionStreamTokens` before the archive transaction (`compose-service.ts:983-1012`). After archive, all further reads return `404`.
- **Unprotected sessions.** `isSessionPasswordProtected` (`compose-service.ts:959-970`) is `false` when no password hash exists. Route middleware short-circuits — no `x-compose-token` header is required, preserving the pre-token contract for legacy dashboard clients.

Status — shipped. The token store is durable in MySQL and works across replicas; Valkey is never consulted for stream-token correctness. SSE uses `compose_session_events` for replay, Valkey for low-latency cross-replica delivery, and cursor-batched durable polling for recovery.

Example — resume then subscribe.

```bash
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -H "x-amzn-oidc-identity: alice" \
  -d '{"password":"correct horse battery staple"}' \
  https://dash.example.com/api/spec-factory/compose/sessions/42/resume | jq -r .streamToken)

curl -N -H 'Accept: text/event-stream' \
  "https://dash.example.com/api/spec-factory/compose/sessions/42/stream?token=$TOKEN"
```

## `Idempotency-Key` contract

Status — Phase 2 has partially shipped (migration `054_compose_turn_jobs.sql` created the `compose_turn_jobs` table with a `(session_id, idempotency_key)` UNIQUE constraint on line 112, and the route layer reads the `Idempotency-Key` header via `idempotencyKeyFromRequest` at `compose-routes.ts:163-181`, then applies it in `/analyze` and `/messages`). HTTP `POST /messages` and `POST /analyze` reject missing headers with `400 idempotency_key_required`. At the service layer, `analyze` and `postMessage` dedupe against `compose_turn_jobs`; in `SPEC_FACTORY_DURABLE_TURNS=drain|on`, the API returns after creating the queued durable job and the `ComposeTurnWorker` owns execution. Remaining Phase 2 work is production rollout/observability, not HTTP idempotency enforcement.

Target contract, verbatim from plan §27.1 (2506-2516):

- **Applies to** every turn-producing mutation: `POST /messages`, `POST /analyze`, and any future POST that enqueues a turn.
- **Header.** `Idempotency-Key: <opaque ASCII 1..128 chars, [A-Za-z0-9._~+/-]+>`. Clients SHOULD use a UUIDv4 or ULID.
- **Requirement.** Header is REQUIRED. Requests without it return `400 idempotency_key_required`.
- **Uniqueness.** `(session_id, idempotency_key)` is `UNIQUE` on `compose_turn_jobs` (plan §8.3). Duplicate submits with the same body return the prior `{ messageId, turnJobId, status }` verbatim (`compose-database.ts:1997-2150`).
- **Conflict.** Same key + different body → `409 idempotency_key_reused`. The service compares `turnRequestHash(...)` against the stored request hash.
- **Retention.** Resolved keys survive at least 24h so retries observe the same outcome; after that the key MAY be reused only with an identical request.
- **Analyze bridge.** The system-driven analyze path derives a deterministic key `analyze:<sessionId>:<requestId>`.
- **Ordering guarantee.** Insert the user-message row, the `compose_turn_jobs` row, and the idempotency mapping in a single DB transaction BEFORE enqueueing the turn. Missing headers are rejected at the route layer before the service can append a user message.

Return codes with a valid dedup:

```text
HTTP/1.1 202 Accepted
{
  "accepted": true,
  "messageId": 917,
  "turnJobId": 5501,
  "status": "queued"
}
```

## SSE contract

All server-to-client streaming for a Compose session flows over a single `text/event-stream` connection at `GET /sessions/:sessionId/stream`. See [operations](./operations.md#sse-lifecycle) for connection lifetime and heartbeat details.

**Today's frame shape** (`src/spec-factory/compose-sse.ts:28-35`):

```text
id: <numeric durable event id when event store is wired; omitted otherwise>
event: <event.type from ComposeChatEvent>
data: <JSON of the ComposeChatEvent>

```

The current `ComposeChatEvent` union (`src/spec-factory/compose-types.ts`) is small — `status`, `message`, `readiness`, `session`, and compact `invalidate` projections — and the durable-event mapping in `durableEventType` already normalizes these to the canonical dot.snake names on write. An invalidation tells the dashboard to reload authoritative messages or readiness through the JSON API; it never replaces the database row that owns that state.

**Target event catalog** (plan §10.1 lines 1097-1136, canonical dot.snake, verbatim):

```text
session.created
session.updated
session.archived
source.added
source.uploaded
source.conversion.started
source.conversion.completed
source.conversion.failed
source.distillation.started
source.distillation.completed
context.patch.created
context.merge.started
context.updated
message.created
turn.queued
turn.started
turn.status
turn.completed
turn.duplicate_suppressed
turn.lease_fence_rejected
turn.cancelling
turn.cancelled
turn.awaiting_user_input
turn.clarification_answered
turn.clarification_expired
turn.discarded_due_to_archive
task.queued
task.started
task.status
task.completed
task.failed
task.lease_fence_rejected
task.cancelled
policy_denied
coordinator.decision.rejected
assistant.delta
assistant.final
assistant.discarded_due_to_archive
readiness.updated
handoff.started
handoff.completed
handoff.failed
error
```

Do not invent parallel CamelCase names (plan §10.1 line 1138). Every log message, DB row `event_type`, and SSE `event:` line uses these identifiers verbatim.

Status — Phase 1 session/source events shipped: `ComposeService` records best-effort durable `session.created` after workspace/S3 path persistence, `source.added` for note, upload placeholder, Jira, Confluence, and YouTube intake paths, plus `source.uploaded` when an upload placeholder moves to pending conversion. Generated research sources also record `source.added` from the research executor. Conversion lifecycle events are emitted by the conversion worker as `source.conversion.started`, `source.conversion.completed`, and `source.conversion.failed`; when conversion-source distillation is enabled, the same worker records `task.queued` for the created `source_distillation` task.

**Resume / replay contract.**

- Query cursor: `?after=<eventId>` OR standard `Last-Event-ID: <eventId>` header. `streamEventCursorFromRequest` (`compose-routes.ts:197-207`) prefers `Last-Event-ID` when both are present.
- A fresh connection with no cursor starts at `getLatestSessionEventId(sessionId)`. Initial messages, readiness, and workflow state come from their authoritative JSON endpoints, so opening a session does not replay historical status errors.
- **Replay → live bridge** (`compose-routes.ts`, `compose-sse.ts`): on a reconnect with an explicit cursor, the route (1) queries `listSessionEventsAfter(sessionId, cursor)` and writes each row with `id: <numericId>` framing, (2) subscribes to the live hub with `replay: false` and a paused `Number.MAX_SAFE_INTEGER` cursor, (3) requeries the store for the small window that may have committed before the live subscription, (4) lowers the live cursor to the last durable row written, and (5) performs one more durable catch-up read while skipping rows already delivered live. The MySQL event log is the ordered bridge source; the `ComposeSseHub` replay buffer remains a 20-event ring for the no-event-store dev path only.
- Readiness updates are compact `invalidate/readiness` payloads under the canonical `readiness.updated` event type. Oversized message payloads similarly become `invalidate/messages`; the dashboard reloads the full state from MySQL-backed APIs instead of treating payload size as a product failure.
- Heartbeats and the `: connected` comment do not include an `id:` line. A fresh connection receives one synthetic `event: cursor` frame at the captured durable high-water mark so the browser has a `Last-Event-ID` even if the stream is otherwise idle; the marker carries no product state.

Status — shipped (§10.3): `ComposeSseHub` emits frames without an `id:` line only when no event store is wired. Durable live events use the committed `compose_session_events.id`; Valkey publishes canonical events across replicas and cursor-batched MySQL reads recover any fanout gap. Valkey remains a latency optimization, not a stream-token or event-ordering authority.

## Error envelope and status codes

Every error response uses:

```json
{ "error": { "message": "<human-readable>" } }
```

Route-level classification (`compose-routes.ts:83-127`, `routes.ts:63-91`):

| Status | Condition                                                                                                                                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- |
| 400    | `positiveInt` rejects a non-integer path/body id; body validation errors matching the compose validator patterns (`is required`, `Jira key`, `Invalid Compose session bundle`, `not previewable`, `no uploaded object`).                                                         |
| 401    | Password-protected session accessed without / with an invalid stream token (`compose-routes.ts:261-286`). `POST /resume` failure surfaces here too when the password is wrong.                                                                                                   |
| 404    | Session or source missing OR archived (archived sessions surface as `was not found`, `session-guard.ts:36-54`).                                                                                                                                                                  |
| 409    | Legacy draft-pipeline conflicts: draft not latest, must be ready, unpublished child tickets, retry-attachments precondition, non-Louise source (`routes.ts:74-89`).                                                                                                              |
| 429    | `POST /messages` or `POST /analyze` when the per-session pending turn depth >= `MAX_QUEUED_TURNS_PER_SESSION` (default 3, `compose-service.ts:87-89`), or `POST /research/code` when the research budget gate rejects enqueue. Body: `{"accepted": false, "reason": "<queue_full | budget_exceeded | ...>"}`. |
| 500    | Any unclassified `Error`.                                                                                                                                                                                                                                                        |

## Compose routes

All routes below are mounted under `/api/spec-factory/compose`. Each entry lists the guard-call site from `compose-service.ts`.

### `GET /repositories`

Lists code repositories available for repo-grounding an analyze turn. Unauthenticated (no session context). Handler: `compose-routes.ts:296`.

Response: array of `ComposeRepositoryOption` (`compose-types.ts:135-140`).

```bash
curl https://dash.example.com/api/spec-factory/compose/repositories
```

```json
[
  {
    "id": 7,
    "repoName": "cp-autonomous-ai-agents-platform",
    "repoUrl": "https://github.com/…",
    "defaultBranch": "main",
    "description": ""
  }
]
```

### `GET /sessions`

Lists Compose sessions. Handler: `compose-routes.ts:305`. Response: array of `ComposeSessionSummary` (`compose-types.ts:252-296`) excluding archived rows.

```bash
curl https://dash.example.com/api/spec-factory/compose/sessions
```

### `POST /sessions`

Creates a new session. Handler: `compose-routes.ts:314`; service `createSession` (`compose-service.ts:811-879`).

Request body:

```json
{
  "name": "OneShot readiness spike",
  "userName": "alice",
  "password": "optional"
}
```

- `name` (required, non-empty). Empty → `400`.
- `userName` (optional). Stored as `createdBy`/`createdByDisplay`.
- `password` (optional). Non-null enables stream-token auth; hashed via argon2id before insert.

Response `201`: full `ComposeSessionSummary`.

### `POST /sessions/import`

Handler: `compose-routes.ts:330`. Accepts a bundle produced by `POST /export`. Body may be `{ "bundle": <ComposeSessionExportBundle> }` or the bundle at the top level. Validates against `ComposeSessionExportBundleSchema` (`compose-types.ts:383-392`). Errors starting `Invalid Compose session bundle` → `400`.

Response `201`: `ComposeSessionImportResult` (`compose-types.ts:399-402`).

### `GET /sessions/:sessionId`

Read a session summary. Handler: `compose-routes.ts:344`; service `getSession` (`compose-service.ts:881-898`).

- Guard: `requireReadableSession` (archived → `404`).
- **Password sessions:** `getSession` rejects unresumed reads with `401 Password is required` (`compose-service.ts:889-891`); dashboard callers must POST `/resume` first.
- Response `200`: `ComposeSessionSummary`.

```bash
curl -H "x-compose-token: $TOKEN" https://dash.example.com/api/spec-factory/compose/sessions/42
```

### `GET /sessions/:sessionId/context`

Read the latest committed Working Context projection for a session. Handler: `compose-routes.ts`; service `getContextProjection`; repository `getLatestContextProjection`.

- Guard: protected read + `requireReadableSession` (archived → `404`).
- **Password sessions:** callers must provide `x-compose-token: <token>`, same as `/messages` and `/sources`.
- Response `200`: `ComposeContextProjection | null`. `null` means the session has no committed `compose_context_versions` row yet.
- Dashboard usage: when legacy `compose_sessions.readiness` is absent, the Compose workspace fetches this endpoint and projects `summary.problemStatement`, `summary.recommendedNextActions`, `openQuestions`, and `conflicts` into the existing readiness UI.

```bash
curl -H "x-compose-token: $TOKEN" https://dash.example.com/api/spec-factory/compose/sessions/42/context
```

### `POST /sessions/:sessionId/resume`

Verifies the password and mints a stream token for protected sessions. Handler: `compose-routes.ts:373`; service `resumeSession` (`compose-service.ts:900-980`).

Request:

```json
{ "password": "correct horse battery staple" }
```

Response `200` (protected): `ComposeSessionSummary & { streamToken: "<hex64>" }`.
Response `200` (unprotected): plain `ComposeSessionSummary` — no `streamToken`, and none is required for subsequent calls.
Wrong password → `401 Compose session <id> password did not match`.

### `POST /sessions/:sessionId/export`

Handler: `compose-routes.ts:391`; service `exportSession` (`compose-service.ts:1128-1275`). Sends `Content-Disposition: attachment; filename="compose-session-<id>.json"`.

Request body (protected sessions only):

```json
{ "password": "correct horse battery staple" }
```

Response `200`: `ComposeSessionExportBundle` (`compose-types.ts:383-396`) — session name/created-by/readiness plus every source with `conversionStatus="converted"` and non-empty markdown.

### `DELETE /sessions/:sessionId`

Archive + revoke stream tokens. Handler: `compose-routes.ts:413`; service `deleteSession` (`compose-service.ts:983-1012`).

- Guard: `requireAuthorizedSession(..., "mutable")` — password required in body when protected.
- Effect: `revokeSessionStreamTokens` runs before the archive transaction. The archive transaction cancels non-terminal `compose_turn_jobs` and `compose_agent_tasks`, then sets `compose_sessions.archived_at`. Subsequent reads/mutations return `404`.
- Body: `{"password":"…"}` (protected sessions only).
- Response `202`: `{"deleted": true}`.

### `POST /sessions/:sessionId/turns/:turnJobId/cancel`

Cancel a queued/running durable turn without archiving the whole session.

- Guard: protected mutation (`x-compose-token` required when the session is password-protected) + `requireMutableSession`.
- Effect: cancels the `compose_turn_jobs` row when it is still non-terminal, cancels queued/running `compose_agent_tasks` linked to that turn, clears active worker leases, and records durable `turn.cancelling` / `turn.cancelled` / `task.cancelled` events with `reason="operator_cancelled"`.
- Response `202`: `{ "cancelled": true|false, "turnJobId": <id>, "cancelledAgentTaskIds": [...], "status": "cancelled"|"completed"|... }`.
- `cancelled=false` means the turn was already terminal. Unknown turn/session returns `404`.

### `POST /sessions/:sessionId/notes`

Append an operator note as an inline `note` source. Handler: `compose-routes.ts:448`; guard `authorizeProtectedMutation`; service `addNote` (`compose-service.ts:1277-1317`).

Request:

```json
{ "content": "Client wants dark mode toggle on the OneShot dashboard." }
```

- `content` required, non-empty after trim. Empty → `400 Compose note content is required`.
- Marks session context dirty; records `note_source_added` activity.
- Response `202`: `ComposeSessionSummary`.

### `POST /sessions/:sessionId/handoff`

Handler: `compose-routes.ts:469`; service `handoff` (`compose-service.ts:1319-1746`).

- Guard: `authorizeProtectedMutation` → `assertSessionHandoffAllowed`.
- Blocks when any source is in `HANDOFF_BLOCKING_STATUSES` (converting/failed uploads); returns `400 Cannot hand off Compose session <id> until blocked sources are resolved: <list>`.
- Creates or reuses the compatibility `COMPOSE-<sessionId>` source, then creates
  an idempotent `compose_handoffs` aggregate and queues `handoff_build`.
- The handoff freezes requested context, message high-watermark, source revision
  set, and repository manifest before asynchronous work starts.
- Response `202` in v4 mode:

```json
{
  "sourceId": 4711,
  "session": { "id": 42, "status": "active" },
  "handoffId": 81,
  "status": "snapshot_building",
  "contextVersion": 7,
  "messageHighWatermarkId": 1201
}
```

The context worker writes the content-addressed handoff Markdown/JSON artifacts,
verifies checksum/size, commits `compose_handoff_snapshots`, and queues a durable
draft workflow. `/workflow-state` and correlated events expose every handoff and
draft stage. In legacy-disabled operation the startup gate requires this path;
the synchronous source-only path remains rollback compatibility until Work
Order T is accepted and the rollback window is closed.

### `GET /sessions/:sessionId/sources`

Handler: `compose-routes.ts:487`; guard `authorizeProtectedRead`; service `listSources` (calls `composeRepository.listSessionSources`).

Response `200`: array of `ComposeSessionSourceSummary` (`compose-types.ts:298-338`) with conversion status, entities, usefulness, and — for `converted` rows — the full Markdown body.

```bash
curl -H "x-compose-token: $TOKEN" \
  https://dash.example.com/api/spec-factory/compose/sessions/42/sources
```

### `GET /sessions/:sessionId/sources/:sourceId/preview`

Signed image preview URL for converted image uploads. Handler: `compose-routes.ts:499`; guard `authorizeProtectedRead`. Returns `400 Source … is not previewable` for non-image sources and `400 … has no uploaded object` when the raw S3 key is empty.

### `POST /sessions/:sessionId/uploads`

Mint a presigned S3 PUT URL for a new upload source. Handler: `compose-routes.ts:520`; guard `authorizeProtectedMutation`; service `requestUpload` (`compose-service.ts:1748-1813`).

Request:

```json
{
  "filename": "call-recording.mp3",
  "mimeType": "audio/mpeg",
  "sizeBytes": 12345678
}
```

- `filename` required and trimmed.
- `sizeBytes` optional; when finite and > `MAX_UPLOAD_BYTES` (`524_288_000` = 500 MB, `compose-service.ts:93-94`) → `500 Upload exceeds the maximum size of 524288000 bytes`.
- Chooses converter: `voxtral` for audio/video mime/ext, else `markitdown`.
- Response `201`: `ComposeUploadTarget` (`compose-types.ts:353-358`) — `{ sourceId, uploadUrl, s3KeyRaw, expiresInSeconds }`.

Client must PUT to `uploadUrl` (S3), then confirm via `POST /sources/:sourceId/uploaded`.

### `POST /sessions/:sessionId/sources/:sourceId/uploaded`

Marks the source uploaded and kicks conversion drain. Handler: `compose-routes.ts:542`; guard `authorizeProtectedMutation`; service `confirmUpload` (`compose-service.ts:1815-1844`).

Response `202`: `{"accepted": true}`.

### `POST /sessions/:sessionId/youtube`

Adds a YouTube URL as a source. Handler: `compose-routes.ts:561`; service `addYoutube` (`compose-service.ts:1846-1878`). `normalizeYoutubeUrl` throws `400`-style errors on malformed URLs.

Request:

```json
{ "url": "https://www.youtube.com/watch?v=abc123" }
```

Response `202`: `{"accepted": true}`. Runs conversion drain in the background.

### `POST /sessions/:sessionId/jira`

Adds a Jira issue by key. Handler: `compose-routes.ts:578`; service `addJira` (`compose-service.ts:1914-1943`). Requires `JiraSourceFetcher` in service options. Errors matching `/Jira key/` → `400`.

Request:

```json
{ "jiraKey": "COMPOSE-123" }
```

Response `202`: `{"accepted": true}`.

### `POST /sessions/:sessionId/confluence`

Adds a Confluence page by URL. Handler: `compose-routes.ts:596`; service `addConfluence` (`compose-service.ts:1880-1912`).

Request:

```json
{ "url": "https://example.atlassian.net/wiki/spaces/ENG/pages/456/Page" }
```

Response `202`: `{"accepted": true}`.

### `POST /sessions/:sessionId/sources/reconvert-failed`

Requeues every `failed` source on the session for conversion retry. Handler: `compose-routes.ts:614`; guard `authorizeProtectedMutation`.

Response `202`: `{ requeued: <count> }`.

### `DELETE /sessions/:sessionId/sources/:sourceId`

Logically removes a session source and recursively invalidates generated
research whose `parent_source_ids_json` depends on it. The transaction creates
explicit `source_removal` context patches, cancels stale turn/task work,
supersedes in-progress context/handoff/draft state, and queues one context
merge. The original source is recoverable until `undoUntil`; generated
descendants are intentionally not restored.

Response `202`:

```json
{
  "id": 801,
  "sessionId": 7,
  "sourceId": 21,
  "sourceTitle": "requirements.md",
  "status": "undoable",
  "undoUntil": "2026-07-11T12:10:00.000Z",
  "invalidatedSourceIds": [21, 22],
  "invalidatedHandoffIds": [91],
  "dependentSourceCount": 1,
  "createdAt": "2026-07-11T12:00:00.000Z"
}
```

### `GET /sessions/:sessionId/source-deletions`

Returns unexpired, undoable source deletions for the session. Protected-read
authorization applies. Expired, restored, purging, and purged rows are not
returned.

Response `200`: an array of source-deletion summaries in newest-first order.

### `POST /sessions/:sessionId/sources/:sourceId/restore`

Restores the original source during its undo window, supersedes any pending
removal patch, and requeues conversion or source distillation as appropriate
against the latest committed context. Generated research descendants remain
deleted and must be regenerated from the restored evidence.

Response `202`: the deletion summary with `status: "restored"`.

Response `410`: the source was not deleted from this session, was already
restored, or its undo window expired.

### `POST /sessions/:sessionId/sources/:sourceId/reconvert`

Requeues a single source. Handler: `compose-routes.ts:650`.

Response `202`: `{"accepted": true}`.

### `POST /sessions/:sessionId/research/code`

Manually queues a `code_research` agent task. Handler: `compose-routes.ts:669`; service `requestCodeResearch` (`compose-service.ts:2211-2258`).

Flags: requires both `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk` and `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=true`; otherwise returns `503 code_research_enqueue_disabled`.

Request:

```json
{
  "question": "Where is retry logic implemented?",
  "parentSourceIds": [11, 12],
  "contextVersionUsed": 4
}
```

- `question` required and non-empty after trim.
- `parentSourceIds` optional, deduped positive integers.
- `contextVersionUsed` optional positive integer. Invalid/missing values are stored as `null`.
- On success, creates a `compose_agent_tasks` row with `capability="code_research"` and records durable `task.queued` with the task id, question, parent source ids, and context version.

Response `202`: `{ "accepted": true, "agentTaskId": 501, "capability": "code_research", "status": "queued" }`.

### `POST /sessions/:sessionId/analyze`

Queues an analyze turn — the "read all sources, produce a readiness JSON" flow. Handler: `compose-routes.ts:689`; guard `authorizeProtectedMutation`; service `analyze` (`compose-service.ts:3698-3806`).

Request:

```json
{ "repositoryIds": [7, 12], "reset": true }
```

- `repositoryIds` (optional): array of positive integers, deduped, capped at 25 (`compose-routes.ts:142-151`).
- `reset` (optional, default false): when `true`, calls `resetSessionProgress` before enqueue — deletes prior conversation turn rows/tasks, drops `claude_session_id`, clears readiness, deletes workspace manifests, and preserves user-authored sources.
- `Idempotency-Key` header — see [contract](#idempotency-key-contract). When present, `createAnalyzeTurn` dedupes on `(session_id, idempotency_key)` and returns the prior turn (`compose-service.ts:3717-3746`).
- Durable `turn.queued` records the normalized `repositoryIds` in `compose_session_events.payload_json` for operator audit.

Blocked-source guard: any source in `ANALYZE_BLOCKING_STATUSES` (converting) → `500 Cannot analyze Compose session <id> until sources finish processing`.

Responses:

- `202 { "accepted": true, "messageId": null, "turnJobId": 5501, "status": "queued" }` when durable turns are on.
- Missing `Idempotency-Key` never reaches the service; the route returns `400 idempotency_key_required`.
- `429 { "accepted": false, "reason": "queue_full" }` when pending depth ≥ `MAX_QUEUED_TURNS_PER_SESSION`.

### `POST /sessions/:sessionId/messages`

Post a user chat message and enqueue a chat turn. Handler: `compose-routes.ts:711`; guard `authorizeProtectedMutation`; service `postMessage` (`compose-service.ts:3808-3993`).

Request:

```json
{ "content": "Which repos already handle password hashing?" }
```

- `content` required, non-empty after trim. Empty → `400 Message content is required`.
- `Idempotency-Key` header — same contract as `/analyze`.
- Order-of-operations invariant (target §27.1 line 2513): with `Idempotency-Key`, the DB transaction inserts the user-message row, the `compose_turn_jobs` row, and the mapping row before enqueue. Without the header, the route returns `400 idempotency_key_required`.
- If the session has a durable turn parked in `awaiting_user_input`, the same endpoint records the message as that turn's clarification answer, emits `turn.clarification_answered`, and requeues the parked turn instead of creating a second turn. Each clarification round stores its `Idempotency-Key` on the answer message, so the same durable turn can ask multiple questions. A retry with the same key and content returns the original message/turn ids even after the turn has moved to a later question; the same key with different content returns `409 idempotency_key_reused`. If the parked turn expired first, the durable turn worker abandons it, emits `turn.clarification_expired`, and the next message follows the normal new-turn path.

Responses:

- `202 { "accepted": true, "messageId": 917, "turnJobId": 5501, "status": "queued" }` with durable turns and `Idempotency-Key`.
- `202 { "accepted": true }` legacy path.
- `429 { "accepted": false, "reason": "queue_full" }` before the message row is written (`compose-service.ts:3827-3832`).

Success also publishes an SSE `message.created` frame with `role: "user"` and the content (`compose-service.ts:3882-3896`).

### `GET /sessions/:sessionId/messages`

Full ordered conversation history. Handler: `compose-routes.ts:735`; guard `authorizeProtectedRead`; service `listMessages` (`compose-service.ts:3995-3997`).

Response: array of `ComposeSessionMessageSummary` (`compose-types.ts:340-348`) sorted by `createdAt`.

### `GET /sessions/:sessionId/workflow-state`

Returns the latest authoritative turn plus handoff/draft projection. This is the
dashboard's source for activity, queue position, retry/failure, stale-state,
approval, publish, and terminal rendering. It is owner/admin/password protected
like other session reads and returns `404` for archived or inaccessible
sessions.

```json
{
  "sessionId": 42,
  "generatedAt": "2026-07-10T12:00:00.000Z",
  "turn": {
    "id": 5501,
    "kind": "chat",
    "status": "running",
    "attemptCount": 1,
    "maxAttempts": 3,
    "queuePosition": null,
    "requestedContextVersion": 7,
    "contextVersionUsed": 7,
    "queuedAt": "2026-07-10T11:59:58.000Z",
    "startedAt": "2026-07-10T11:59:59.000Z",
    "completedAt": null,
    "clarificationExpiresAt": null,
    "errorCode": null,
    "errorMessage": null
  },
  "handoff": {
    "id": 81,
    "sourceId": 900,
    "status": "drafting",
    "contextVersionUsed": 7,
    "messageHighWatermarkId": 1201,
    "snapshotId": 82,
    "draftWorkflowId": 83,
    "workflowStatus": "running",
    "workflowStage": "synthesize",
    "draftId": null,
    "epicKey": null,
    "errorCode": null,
    "errorMessage": null,
    "updatedAt": "2026-07-10T12:00:00.000Z"
  }
}
```

`turn` and `handoff` are independently nullable. Clients must not infer success
from elapsed time or a linked source; terminal state comes from this projection
or a newer correlated SSE event.

### `GET /sessions/:sessionId/stream`

Server-Sent Events for the session. Handler: `compose-routes.ts:746-819`. Reads token from `?token=` (EventSource cannot set headers) or `x-compose-token`. Response headers set on connect: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.

Query / headers:

- `?token=<hex>` — required for password-protected sessions.
- `?after=<eventId>` OR `Last-Event-ID: <eventId>` — replay cursor (`streamEventCursorFromRequest` at `compose-routes.ts:197-207`).

If neither cursor is present, this is a fresh subscription. The server captures the session event high-water mark before opening the stream and sends only newer events; the dashboard reconciles the current state through the session, messages, context, and workflow-state endpoints.

Behavior on connect:

1. Verify session lifecycle (`assertSessionStreamable`, archived → `404`).
2. Verify stream token when protected.
3. Write `: connected`; on a fresh subscription, write a state-free `cursor` frame at the captured durable high-water mark. Heartbeats follow while the connection remains open.
4. When an event store is wired: resolve the explicit resume cursor or capture the current high-water mark for a fresh connection, replay only rows after that cursor, subscribe to the live hub with a paused cursor, re-query the store for the small gap window, lower the live cursor, then run one more durable catch-up read that skips rows already delivered live.
5. Live frames flow from `ComposeSseHub.publish`. Full state projections remain in MySQL; `invalidate/messages` and `invalidate/readiness` frames tell the dashboard which authoritative endpoint to reload.

Disconnect: `req.on("close")` unsubscribes from the hub (`compose-routes.ts:817-819`). The hub does NOT self-evict dead subscribers — the route contract owns unsubscribe.

```bash
curl -N -H 'Accept: text/event-stream' \
  -H 'Last-Event-ID: 8421' \
  "https://dash.example.com/api/spec-factory/compose/sessions/42/stream?token=$TOKEN"
```

Sample frames:

```text
id: 8422
event: turn.status
data: {"type":"status","status":"thinking","mode":"chat"}

id: 8423
event: assistant.final
data: {"type":"message","role":"assistant","content":"Yes — auth/password-hasher.ts covers it."}

id: 8424
event: readiness.updated
data: {"type":"invalidate","resource":"readiness"}
```

Alias — `POST /sessions/:sessionId/stream` is not exposed; the `/events` path in plan §27.2 is reserved for a future alias only. Do not use it today.

## Legacy draft-pipeline routes

Mounted at `/api/spec-factory`. The Compose service must not depend on these; they cover the Louise/Jira draft flow that Phase 10 will enrich.

| Method | Path                                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/status`                              | Board-wide status summary. `routes.ts:104`. Includes `composeControlPlane.turns.legacyInflight` and `legacyQueued` from the live API replica, durable DB queue gauges plus turn/task lease-expired, duplicate-suppressed, and lease-fence-rejected counters, `composeControlPlane.turns.outcomesByContextVersionToday` UTC-day terminal turn counters grouped by `contextVersionUsed`, `composeControlPlane.agentTasks.byCapability` per-capability queue/terminal counters, `composeControlPlane.coordinator.decisionsToday` UTC-day decision counters, `composeControlPlane.llm` UTC-day call/token/cost/failure totals plus `byPurposeToday` attribution from `spec_factory_llm_calls`, `composeControlPlane.workers` live/stale heartbeat totals by runtime mode, `composeControlPlane.retention` archived-workspace cleanup counters plus LLM audit artifact backlog from `compose_sessions` / `spec_factory_llm_calls`, `composeControlPlane.events` durable event throughput, `composeControlPlane.streams` active/connected/disconnected SSE counters for the current replica, `composeControlPlane.streamTokens` active/expired/minted/revoked DB token counters, `composeControlPlane.research` research-task runtime/terminal counters, durable failure counters, and `composeControlPlane.context` patch/version health from `compose_context_patches` and `compose_context_versions`. |
| GET    | `/sources`                             | List board sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| POST   | `/sources/refresh`                     | Kick a board refresh; `{ "force": true }` bypasses debounce.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/louise/candidates`                   | Alias of `/sources` used by the Louise UI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/louise/refresh`                      | Alias of `/sources/refresh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/sources/:sourceId/drafts`            | Queue a draft generation for a source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET    | `/sources/:sourceId/drafts/latest`     | Read latest draft; `404` when none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/sources/:sourceId/events`            | Source event log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/sources/:sourceId/attachments`       | Priority attachments and retry state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/sources/:sourceId/attachments/retry` | Retry failed attachments; `409 Retry priority attachments before generating a draft` when preconditions fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PUT    | `/drafts/:draftId`                     | Update a draft; `409 is not the latest draft` on stale write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/drafts/:draftId/approve`             | Approve draft; `409 must be ready` when readiness is incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/sources/:sourceId/oneshot`           | Trigger a OneShot end-to-end submission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/sources/:sourceId/discard`           | Archive a board source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/sources/:sourceId/restore`           | Restore an archived source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| GET    | `/oneshot/submissions`                 | List recent OneShot submissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/archive/sources`                     | List archived sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Actor is always `actorFromRequest(req).id`. Standard error envelope; conflict class `409` for the legacy-only preconditions listed above.

## Rate limits, cost ceilings, and quotas

- **No per-user rate limits today.** The only backpressure is `MAX_QUEUED_TURNS_PER_SESSION = 3` (`compose-service.ts:85-88`, override via `COMPOSE_MAX_QUEUED_TURNS`) — bursts beyond that get `429 queue_full`.
- **Upload cap:** `MAX_UPLOAD_BYTES = 524_288_000` (500 MB, override via `COMPOSE_MAX_UPLOAD_BYTES`, `compose-service.ts:91-93`). Mirrors the MarkItDown sidecar's own cap so oversized uploads fail at `/uploads` instead of after the presigned PUT.
- **Chat retry envelope:** `CHAT_RETRY_MAX_ATTEMPTS = 3` with base backoff `COMPOSE_RETRY_BASE_MS` (default 1s, `compose-service.ts:103-105`). Each retry emits an SSE `turn.status` frame with `status: "retrying"` and the `attempt`/`maxAttempts`/`nextRetryInSeconds` triple (`compose-types.ts:224-241`).
- **Research budgets — Phase 6/9 limited routing:**
  - `SPEC_FACTORY_RESEARCH_MAX_COST_USD=3.0` — per-task Claude SDK research budget cap used as the reservation amount for manual research and as the upper bound for coordinator-dispatched tasks.
  - `SPEC_FACTORY_RESEARCH_COST_CEILING_USD` — per-session rolling USD ceiling checked before manual `POST /research/code` and coordinator `dispatch_research` enqueue. Unset is fail-closed for both paths.
  - `SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION=3` — max queued/running manual/coordinator research tasks for the session.
  - `SPEC_FACTORY_RESEARCH_TASKS_PER_24H` — optional per-session rolling 24h cap on manual/coordinator research task launches.
  - `SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD`, `SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS`, and `SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H` — optional global caps checked by the same enqueue gate when set.
  - `SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN=3` — max research tasks the Chat Coordinator may dispatch per turn.
  - `SPEC_FACTORY_COORDINATOR_MAX_COST_USD` — optional per-call Chat Coordinator reservation; when unset and LLM Gateway cost ceilings are configured, the server supplies `0.25`.
- **LLM audit:** LLM Gateway calls land in `spec_factory_llm_calls`; research executor runs land in `compose_agent_runtime_runs`. The research budget check sums committed LLM spend, completed research runtime spend, and queued/running task reservations.

See [operations](./operations.md#budgets-and-quotas) for on-call runbooks on cost breach and quota exhaustion.

---

**Cross-references.**

- [Architecture](./architecture.md) — how routes map to services and workers.
- [Data model](./data-model.md) — table shapes for `compose_sessions`, `compose_turn_jobs`, `compose_session_events`, `compose_stream_tokens`.
- [Operations](./operations.md) — deploy, feature flags, SSE runbook.
- Canonical plan sections: [§10.1 event catalog](../superpowers/spec-factory/spec_factory_transformation_plan_v3.md), §27.1 idempotency, §27.2 SSE resume, §28 feature flags.
