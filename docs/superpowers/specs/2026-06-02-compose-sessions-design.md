# Compose Sessions Design

**Date:** 2026-06-02
**Status:** Approved for planning
**Author:** kompallik (with Claude Code)
**Related:** `docs/superpowers/specs/2026-05-27-spec-factory-design.md` (the Louise workflow this builds on)

## Goal

Build the **Compose** workflow inside Spec Factory: a human-in-the-loop, chat-driven
way to turn freeform raw material (documents, slides, spreadsheets, images, audio,
YouTube links, notes) into an OneShot-ready Jira Epic bundle — without an
originating Jira ticket.

Where the existing **Louise** workflow is *autonomous* (a `louise-estimated` ticket
is auto-qualified and auto-drafted with no human loop), **Compose** is *interactive*:
the operator assembles sources, an LLM reads them and asks clarifying questions, the
operator answers in chat, and once the LLM (or the operator) declares the intent
ready, the session is handed off into the **existing** draft-generation pipeline and
lands in the same `draft_ready` board queue.

## The Core Insight

Compose is a **new front-half** bolted onto the **existing back-half**.

The existing `SpecFactoryService.generateDraft({ sourceId })` already does:

```
markSourceDrafting
  → evidenceCollector.collect(sourceId)        ← the ONLY Jira-specific step
  → taskWorkspaceManager.prepare(...)
  → qualifier.qualify(...)
  → repoContextCollector.collect(...)          ← repo checkout + code grounding
  → taskWorkspaceManager.prepare(... with repo context)
  → generator.generate(...)                    ← LLM drafts the Epic bundle
  → createDraft(...)                            → source flips to draft_ready
```

Everything downstream of `collect` depends only on the produced **`EvidenceManifest`**
plus the `spec_factory_sources` row. Therefore Compose does **not** need its own
qualifier, repo-deep-dive, draft-generator, validator, renderer, publisher, or board.
It only needs to **produce an `EvidenceManifest` (and a populated workspace) from
converted session sources instead of from a Jira ticket**, then hand off into the
unchanged pipeline.

> A Compose-originated Epic is indistinguishable from a Louise Epic once it reaches
> `draft_ready`, except for an `origin` badge.

The chat experience is **"Claude running against a folder"** — a persistent Claude SDK
session whose working directory is the session's EFS workspace, reading the converted
`.md` sources plus an accumulating `chat.md`, conversing with the operator (it cannot
write code, only talk and read).

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Backend home | **Extend the Spec Factory service** (port 3012) | Reuses DB, draft pipeline, board, publisher, OneShot submitter with zero glue; one service to deploy. |
| Context strategy | **No RAG — agent reads workspace files** | Matches how `draft-generator` already works; no new infra. RAG deferred until measured necessary. |
| markitdown integration | **Python sidecar microservice** (same ECS task, `localhost:8080`) | Clean language boundary; the same markitdown engine the MCP uses; deterministic batch conversion; no extra networking/IAM. |
| v1 formats | **All listed formats** | markitdown handles everything non-audio (incl. YouTube transcripts, ZIP iteration, image EXIF+OCR, EPub); **audio → voxtral**. |
| Session → source mapping | **New `compose_sessions` table; mint a `spec_factory_sources` row at handoff** with synthetic key `COMPOSE-<id>` | Keeps the board logic and the Louise table untouched; one additive `origin` column only. |
| Readiness gate | **LLM decides, operator can override** ("Draft anyway") | Rigor without trapping the operator behind a stubborn LLM. |
| Upload path | **Presigned S3 PUT direct from browser** | Keeps large files (audio, ZIP, PPT) off the ECS request path / ALB timeouts; matches the existing S3 archive pattern. Requires bucket CORS. |
| Chat transport | **SSE streaming** | A live CLI-like typing experience. The one place we add streaming; the rest of the dashboard stays polling. |
| Draft integration | **Approach A — pluggable `EvidenceProvider`** | One pipeline, one set of tests; reuses repo-deep-dive + code grounding (explicitly wanted). The Compose path **skips the autonomous qualifier-reject** — the chat readiness verdict already qualified it. |

## Architecture

### The seam: `EvidenceProvider`

`generateDraft` currently hardcodes `this.evidenceCollector.collect(sourceId)`. We
invert that single dependency into a strategy interface:

```ts
interface EvidenceProvider {
  collect(sourceId: number): Promise<EvidenceManifest>;
}
```

- `JiraEvidenceProvider` — today's `SpecFactoryEvidenceCollector`, **behavior unchanged**
  (Louise path). Fetches the ticket, archives attachments to S3, builds the manifest.
- `ComposeEvidenceProvider` — builds an `EvidenceManifest` from the session's converted
  `.md` sources, `context.md`, `sources-index.md`, and `chat.md`. No Jira fetch.

`generateDraft` selects the provider by the source's **`origin`** field
(`'louise' | 'compose'`). For `origin='compose'` it also **skips the autonomous
reject**: qualification still runs (its `repoHints` feed the repo-deep-dive and the
event is still recorded), but a *soft* "not qualified" verdict does **not** route the
source to `not_qualified` — the operator already approved it in chat. Genuine errors
(SDK timeout, draft validation failure) still fail the job exactly as today.

**Behavior-preservation requirement:** before refactoring `generateDraft`, write a
characterization test pinning the current Louise behavior, so the refactor is provably
behavior-preserving for the existing path.

### Components (new)

| Module (in `src/spec-factory/`) | Responsibility |
|---|---|
| `compose-routes.ts` | HTTP + SSE endpoints under `/api/spec-factory/compose/*`. |
| `compose-service.ts` | Session lifecycle, message turns, handoff orchestration. |
| `compose-database.ts` | CRUD for `compose_sessions`, `compose_session_sources`, `compose_session_messages`. |
| `compose-uploads.ts` | Presigned-PUT issuance; upload reconciliation. |
| `compose-conversion.ts` | Conversion worker job handler: route to markitdown sidecar / voxtral; write workspace `.md`; maintain `sources-index.md`. |
| `compose-markitdown-client.ts` | Thin HTTP client for the sidecar. |
| `compose-voxtral.ts` | Audio → transcript via Bedrock `mistral.voxtral-small-24b-2507`. |
| `compose-agent.ts` | The persistent, resumable Claude chat session over the workspace; emits context + readiness verdict; streams turns. |
| `compose-evidence-provider.ts` | `ComposeEvidenceProvider` — builds `EvidenceManifest` from session sources. |

The **session worker** reuses the existing `spec_factory_processing_jobs` queue and
its claim / stale-recovery machinery, adding the job type `compose_conversion` (the
handoff enqueues the existing `draft_generation` job type). The `job_type` column is
`VARCHAR(50)`, not an ENUM, so the new job type needs **no migration** — just a new
constant alongside `DRAFT_GENERATION_JOB`.

The **markitdown sidecar** is a new minimal container (`Dockerfile.compose-markitdown`):
`python:3.12-slim` + `markitdown[all]` + FastAPI, exposing `POST /convert` (multipart
file **or** `{ url }` for YouTube) and `/health`. It runs as a **second container in
the same ECS task definition** as the Spec Factory service, reachable on
`http://localhost:8080` — no extra service, networking, or IAM. Stateless; scales with
the service.

## Data Model

Two new tables; the existing 8 Spec Factory tables are untouched except **one additive
column**.

### `spec_factory_sources` — additive change

Add:

- `origin ENUM('louise','compose') NOT NULL DEFAULT 'louise'`

Existing rows default to `louise`. Compose sources use `source_jira_key = 'COMPOSE-<sessionId>'`
which satisfies the existing `^[A-Z][A-Z0-9]+-\d+$` validation regex. No other column on
this table changes.

### `compose_sessions` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | PK BIGINT AUTO_INCREMENT | |
| `name` | VARCHAR(200) NOT NULL | from the New Session form |
| `created_by` | VARCHAR(120) NULL | optional user-name |
| `created_by_display` | VARCHAR(200) NULL | |
| `status` | ENUM(`draft`,`ready`,`handed_off`,`archived`) NOT NULL DEFAULT `draft` | `ingesting` is *derived* from open conversion jobs, not stored |
| `claude_session_id` | VARCHAR(120) NULL | the resumable SDK session id (warm thread) |
| `source_id` | BIGINT NULL FK → `spec_factory_sources.id` + unique key | set at handoff (idempotency key) |
| `readiness_json` | JSON NULL | latest `{ ready, openQuestions[], summary }` verdict |
| `s3_prefix` | VARCHAR(300) NOT NULL | `compose/<id>/` package root |
| `workspace_path` | VARCHAR(400) NOT NULL | EFS session dir |
| `created_at` / `updated_at` | TIMESTAMP | |

### `compose_session_sources` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `session_id` | FK → `compose_sessions.id` | |
| `kind` | ENUM(`file`,`youtube`,`chat`,`note`) NOT NULL | |
| `original_filename` | VARCHAR(400) NULL | |
| `mime_type` | VARCHAR(160) NULL | |
| `size_bytes` | BIGINT NULL | |
| `source_url` | VARCHAR(2000) NULL | for `youtube` |
| `s3_key_raw` | VARCHAR(500) NULL | presigned-PUT target for original bytes |
| `converter` | ENUM(`markitdown`,`voxtral`,`none`) NOT NULL | `none` for already-markdown notes |
| `markdown_path` | VARCHAR(500) NULL | converted `.md` in the workspace |
| `markdown_content` | MEDIUMTEXT NULL | converted body retained in DB for evidence packaging |
| `conversion_status` | ENUM(`awaiting_upload`,`pending`,`converting`,`converted`,`unsupported`,`failed`) NOT NULL DEFAULT `pending` | files start `awaiting_upload` until browser PUT confirmation |
| `conversion_started_at` | TIMESTAMP(3) NULL | active lease start |
| `conversion_attempts` | INT NOT NULL DEFAULT 0 | incremented on claim |
| `conversion_lease_expires_at` | TIMESTAMP(3) NULL | stale `converting` rows become claimable after this |
| `error_message` | TEXT NULL | |
| `created_at` / `updated_at` | TIMESTAMP | |

### `compose_session_messages` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `session_id` | FK → `compose_sessions.id` | |
| `role` | ENUM(`user`,`assistant`,`system`) NOT NULL | |
| `content` | MEDIUMTEXT NOT NULL | |
| `created_at` | TIMESTAMP | |

Every turn is **both** persisted here (for render/rehydrate/reconnect) **and** flattened
into `chat.md` in the workspace so the agent reads the conversation as a durable source.

Audit trail reuses the existing `spec_factory_events` table with new `event_type`
values: `compose_session_created`, `compose_source_uploaded`, `compose_source_converted`,
`compose_readiness_evaluated`, `compose_handed_off`.

## Workflows

### Session lifecycle & modal

- The Compose tab opens with a **modal overlay**: **New Session** / **Load Session**.
- **New Session** → form (`name` required, `user-name` optional) →
  `POST /compose/sessions` → creates the row (`status=draft`), mints `s3_prefix` and
  `workspace_path` → reveals the three-panel workspace (Sources / Chat / Preview).
- **Load Session** → `GET /compose/sessions` lists sessions (name, status, updated,
  source count) → selecting rehydrates the panels and **resumes** the warm Claude
  thread via `claude_session_id`.

### Ingestion

**Upload (presigned S3 PUT):**

1. Browser → `POST /compose/sessions/:id/uploads` with `{ filename, mimeType, sizeBytes }`
   → inserts a `compose_session_sources` row (`awaiting_upload`), returns a **presigned PUT URL**
   to `s3_key_raw = compose/<id>/raw/<sourceId>-<safeName>`.
2. Browser PUTs bytes directly to S3 (**bucket CORS** for the dashboard origin — added in
   terraform).
3. Browser → `POST /compose/sessions/:id/sources/:sourceId/uploaded` → flips the row to
   `pending` and kicks the conversion drain. The update is scoped by `{ sessionId, sourceId }`.
4. **YouTube / notes** skip the presign: `POST /compose/sessions/:id/sources` with
   `{ kind:'youtube', url }` or `{ kind:'note', text }` enqueues conversion directly
   (notes → `converter='none'`, written straight to the workspace).

**Conversion (session worker claims `compose_conversion` jobs):**

- Pull `s3_key_raw` to a temp path, route by type:
  - **Audio** (`audio/*`, `.mp3/.wav/.m4a/...`) → **voxtral** (`mistral.voxtral-small-24b-2507`,
    Bedrock) → transcript `.md`.
  - **Everything else** (PDF/Word/PPT/Excel/HTML/CSV/JSON/XML/text/images/EPub/ZIP/YouTube)
    → **markitdown sidecar** `POST /convert`. ZIPs expand recursively; images get
    EXIF + OCR; YouTube returns the transcript.
- Write markdown to `workspace_path/sources/<sourceId>-<name>.md`; set `markdown_path` +
  `conversion_status` (`converted` / `unsupported` / `failed` + `error_message`); record
  `compose_source_converted`.
- **Large-output discipline** (reusing the lesson from Spec Factory PR #230): each source
  also gets a one-line entry in a generated `sources-index.md`; full bodies live in
  per-source files the agent reads on demand — never one giant blob.
- The Sources panel polls `GET /compose/sessions/:id/sources` for live per-source badges
  (`awaiting_upload` / pending → converting → converted/failed) until conversions settle.

### Triggers & controls (when each stage kicks off)

Three distinct kick-off moments; only two are operator buttons:

| Stage | Trigger | Button? |
|---|---|---|
| **Source conversion** | Fires automatically the instant a source is added (file/note/URL). The Sources panel shows per-source badges (`converting → converted/failed`). The operator keeps adding freely — nothing locks, including mid-conversation. | No |
| **Context generation** | The explicit **"Analyze Sources"** button — the operator's "I'm done with my initial dump, analyze now" signal. Runs the context pass and opens the clarification chat. Re-runnable; sources added later fold into the next chat turn. | **Yes** |
| **Draft generation** | The **"Generate Draft → Send to Spec Board"** button. Enables/highlights (confetti) when the readiness verdict says requirements are met; the operator may also **"Draft anyway"** at any time. Runs the handoff. | **Yes** |

Because the chat agent re-reads whatever sources are present on each turn, there is **no
hard "done adding sources" freeze** — "Analyze Sources" is a *soft* "analyze what I have
now" signal, not a batch lock. New sources/directions added afterward join the next turn.

### Clarification loop ("Claude against a folder")

A **persistent Claude SDK agent** (`runAgent` with `resumeSessionId` /
`forkSessionOnResume`, partial streaming, idle watchdog — all already present in
`src/claude-sdk/index.ts`) whose cwd is the session workspace. Read-only over the
sources; it converses, it does not write code.

1. **Context pass** (triggered by the **"Analyze Sources"** button): the agent reads all
   converted sources and produces `context.md` (the rich session context) plus an initial
   **readiness verdict** with **open questions / clarifications** (e.g. "Which repository
   is this for?"). Persisted to `readiness_json`. The summary **and any open questions are
   posted as the first assistant turn(s) in the chat** so the operator can answer inline.
2. **Clarification turns:** while requirements are incomplete, the agent's missing-info
   **questions surface as assistant messages in the chat**. The operator replies → the turn
   is appended to `chat.md` and persisted to `compose_session_messages` → the warm thread is
   resumed with the new message → the agent answers and re-emits a readiness verdict. Pasting
   **new directions** follows the same path (becomes part of `chat.md`). Files added
   mid-session re-trigger conversion and are visible to the next turn.
3. **Readiness gate:** the verdict is `{ ready, openQuestions[], summary }`. While `ready`
   is false, the outstanding `openQuestions` are what appear in the chat for the operator to
   answer. When `ready` becomes true → the **"Generate Draft" button highlights + confetti**
   ("Ready for preview"). The operator may also press **"Draft anyway"** to force handoff
   with open questions remaining, but handoff is blocked while sources are still uploading,
   converting, failed, or unsupported.

**Transport:** `GET /compose/sessions/:id/stream` (SSE / EventSource) streams
`{ type: token | message | readiness | status }` events from the live turn. Posting a
message is `POST /compose/sessions/:id/messages`; its response streams over the SSE
channel. **Concurrency:** one active agent turn per session (per-session in-memory lock +
the warm `claude_session_id`); a second message waits or is rejected with "still
thinking." Sessions are mutually independent.

### Handoff to the draft pipeline

When ready (LLM verdict or operator override):

1. `POST /compose/sessions/:id/handoff` → mint a `spec_factory_sources` row:
   `source_jira_key='COMPOSE-<id>'`, `origin='compose'`, `state='drafting'`, summary from
   `context.md`. Link `compose_sessions.source_id`; set session `status='handed_off'`.
   **Idempotent:** if `source_id` is already set, return the existing source.
2. **Build the package:** ensure all converted `.md`, `context.md`, and `chat.md` are in
   the workspace and mirrored under `s3_prefix` (durable package).
3. Enqueue a `draft_generation` job (the **existing** job type) + `kickProcessing()`.
4. The worker runs the **existing `generateDraft`**, which now uses
   `ComposeEvidenceProvider` (origin-based): builds the manifest from `context.md` +
   `sources-index.md` + chat, **skips autonomous reject**, runs **repo-deep-dive
   (checkout + code grounding)**, drafts, validates, `createDraft` → source flips to
   **`draft_ready`**.
5. The card appears in **Spec Board → Ready For Review** (which already renders any
   `draft_ready` source) with a `compose` origin badge. From there: Approve → OneShot,
   unchanged.

## Error Handling

**Upload / conversion**

- A failed conversion sets `conversion_status='failed'` + `error_message` on that **one**
  source row — never blocks the session or sibling sources. The Sources panel shows a
  red badge with **Retry** (`POST /compose/sessions/:id/sources/:sourceId/reconvert`,
  idempotent re-enqueue).
- `unsupported` is surfaced explicitly, not silently dropped (fixes the gap the Louise
  attachment path has).
- Presigned-PUT orphans (uploaded but `/uploaded` never called): the session worker
  reconciles rows stuck `pending` past a TTL via S3 HEAD.
- Conversion jobs reuse the existing **stale-job reaper** (`expireStaleProcessingJobs`):
  a wedged job is failed after the stale timeout.

**Chat / agent loop**

- SDK timeout/idle → the turn fails with a chat-visible "I got stuck, try again"
  assistant message; the warm `claude_session_id` is preserved so the next message
  resumes rather than restarts. Reuses `isSdkTimeoutMessage` classification.
- SSE disconnect → the client reconnects to `/stream`; turns are durably persisted in
  `compose_session_messages`, so a dropped connection loses no conversation (client
  refetches the message list on reconnect).
- One-active-turn lock prevents concurrent agent runs corrupting the resumed session.

**Handoff**

- Idempotent (above): re-calling returns the existing source, never a duplicate.
- Concurrent calls recover from the synthetic `COMPOSE-<id>` duplicate-key race and link the
  session once; draft generation is requested only by the request that wins the link.
- Handoff rejects while any source is `awaiting_upload`, `pending`, `converting`, `failed`,
  or `unsupported`, with a source/status list for the operator.
- A genuine `generateDraft` error (not a soft reject) routes the minted source to
  `needs_attention` (recoverable) exactly like Louise; the operator retries from the
  board; the session stays `handed_off` with the error visible.
- Because the Compose path **skips the autonomous reject**, a session the operator
  approved cannot be bounced to `not_qualified`. If the repo-deep-dive finds **no
  registered repo**, the Compose path still drafts (the missing repo becomes an open
  question / warning in the Epic) rather than hard-failing — so a brainstormed spec
  without a clear repo still produces a previewable draft. (This differs from the Louise
  path, which hard-fails on zero repos.)

## Testing Strategy

**Unit**

- `ComposeEvidenceProvider` builds a correct `EvidenceManifest` from converted sources +
  `chat.md` (table-driven — the critical seam).
- Conversion routing: type → converter selection (audio→voxtral, rest→markitdown,
  note→none); `sources-index.md` generation; large-output truncation discipline.
- Readiness verdict parsing (ready / open-questions); handoff idempotency (second call
  returns same source).
- `origin` branch in `generateDraft`: compose source skips reject; **louise source
  unchanged** (characterization test written **first**).
- Synthetic key `COMPOSE-<id>` passes the `source_jira_key` regex.

**Service**

- Full session → handoff → `draft_ready` with mocked markitdown sidecar (HTTP stub),
  mocked Bedrock (agent + voxtral), mocked S3 presign. Asserts a board card lands
  identical in shape to a Louise draft.
- Conversion failure isolates to one source; retry path; stale-job recovery.

**markitdown sidecar**

- Its own pytest (one fixture per format family) + a Node-side contract test against the
  stubbed HTTP shape.

**Dashboard**

- Modal: New Session form validation; Load Session rehydrates panels.
- Sources panel live conversion badges; failed source shows Retry.
- Chat streams assistant turns over SSE (mocked EventSource); readiness → confetti;
  "Draft anyway" override.
- Handoff: the new card appears in Spec Board with a `compose` badge.

## Phasing

One spec, phased implementation so the risky ingestion work doesn't block the skeleton.

1. **Phase 1 — Session skeleton + seam.** Migrations (`origin` column, `compose_sessions`,
   `compose_session_sources`, `compose_session_messages`); modal (New/Load); the
   `EvidenceProvider` refactor + `ComposeEvidenceProvider`; handoff minting a `COMPOSE-<id>`
   source through the unchanged pipeline. **Deliverable:** a session whose only source is a
   typed-in note can hand off and produce a `draft_ready` card. Proves the seam end-to-end
   before any conversion infra.
2. **Phase 2 — Ingestion.** Presigned uploads + bucket CORS; markitdown sidecar container;
   conversion worker for all non-audio formats; Sources panel live states + retry.
3. **Phase 3 — Clarification loop.** SSE streaming; persistent resumable agent;
   `context.md` + `chat.md`; readiness gate + confetti + "Draft anyway."
4. **Phase 4 — Audio + edge formats.** voxtral (pending region verification), then format
   hardening (large ZIPs, EPub edge cases).

Each phase is independently demoable and testable.

## Risks

- **voxtral availability:** ~~confirm during planning~~ **VERIFIED 2026-06-02** against
  account `323960442001` in `us-east-2`: `mistral.voxtral-small-24b-2507` is `ACTIVE`,
  `ON_DEMAND`, `SPEECH→TEXT`, streaming-supported, and invoke access is granted (an
  `InvokeModel` probe returned `ValidationException`, not `AccessDenied`). Audio stays in
  scope. Two implementation notes:
  - The model ID is invoked **directly** (no `us.` inference-profile prefix, unlike the
    Claude models). Expose as `COMPOSE_VOXTRAL_MODEL_ID`; ensure the task IAM role allows
    `bedrock:InvokeModel` on this model.
  - voxtral uses a **Mistral/OpenAI-style `messages` request body**, so it does **not** go
    through the Claude SDK `runAgent` path. `compose-voxtral.ts` is a thin direct
    `bedrock-runtime` `InvokeModel` client. During planning, confirm how audio bytes are
    supplied (inline base64 message part vs. reference) — this bounds max audio file size.
- **SSE through the ALB:** confirm the ALB / target group passes long-lived SSE responses
  without buffering for `/api/spec-factory/compose/*`. The target group already proxies
  arbitrary `/api/spec-factory/*`; verify idle-timeout settings.
- **`generateDraft` refactor on a hot path:** the Louise flow depends on this function;
  the characterization test gate (above) is mandatory before refactoring.
- **EFS growth:** session workspaces add to the unbounded-EFS-growth concern already noted
  for Spec Factory task workspaces. Policy: archive should not delete files synchronously;
  archived sessions are marked eligible for a periodic cleanup job after a retention window.
  Raw uploads remain in S3 and converted source bodies remain in DB evidence rows; EFS is a
  working cache. A separate cleanup plan tracks implementation details.
- **URL ingestion hardening:** YouTube/web URL ingestion must enforce allowed schemes,
  private-network protection, redirect limits, response timeout, and size limits before it is
  treated as a general URL fetcher.

## Out of Scope (YAGNI)

- **RAG / vector DB** — deferred; revisit only if measured corpus size forces it.
- Multi-user real-time collaboration on a single session.
- The mockup's web search / "Fast Research" buttons (left as disabled UI).
- Multi-session bundling into one Epic.
