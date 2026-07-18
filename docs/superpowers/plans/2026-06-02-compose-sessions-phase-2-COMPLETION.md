# Compose Sessions — Phase 2 Completion Notes

**Branch:** `feat/compose-sessions-phase-2` (off latest `main` incl. merged Phase 1)
**Status:** Implementation complete; backend tests green; build clean; `terraform validate` passes; sidecar image builds + pytest passes in-container.

## What shipped (ingestion)

Phase 2 lets an operator add real source material to a Compose session — files (presigned S3 upload), YouTube URLs, and notes — and have each converted to Markdown in the session workspace, with live per-source status, feeding the existing `ComposeEvidenceProvider` at handoff.

| Task | What |
|------|------|
| 1 | Migration 038: `markdown_content MEDIUMTEXT` on `compose_session_sources` + `idx_compose_sources_status_id (conversion_status, id)`. |
| 2 | Types: `markdownContent` on `ComposeSessionSourceSummary`; `ComposeUploadTarget`. |
| 3 | `ComposeRepository`: replaced the Phase-1 note-as-tagged-message hack with the `markdown_content` column; added `SourceRow`/`mapSource` + `createUploadSource`/`createYoutubeSource`/`updateSourceS3Key`/`getSessionSource`/`listSessionSources`/`claimNextPendingSource` (optimistic claim)/`markSourceConverted`/`markSourceFailed`/`markSourceUnsupported`/`reconvertSource`/`markSourceUploaded`. |
| 4 | markitdown FastAPI sidecar (`sidecar/markitdown/`) + `Dockerfile.compose-markitdown` (non-root, ffmpeg, `markitdown[all]==0.1.6`). |
| 5 | `MarkitdownClient` (Node HTTP client). |
| 6 | `ComposeUploads` (presigned PUT issuance + `fetchRawObject`). |
| 7 | `ComposeConversionWorker` (claim → convert → persist) with a per-conversion timeout (default 5 min). |
| 8 | Service + routes + server wiring; **`awaiting_upload` state (migration 039)** gates file uploads so the periodic drain can't claim a not-yet-uploaded file. |
| 9 | Infra: sidecar as a 2nd (non-essential) container in the Spec Factory ECS task + its ECR repo & lifecycle policy; S3 CORS; `COMPOSE_*` env; CI build/push both images. |

## Verification (as of completion)

- `npm run build` (tsc): **clean**.
- Backend compose + touched suite (11 files): **112 tests pass.**
- `terraform -chdir=terraform validate`: **Success! The configuration is valid.** `terraform fmt -check`: clean.
- Sidecar: `docker build -f Dockerfile.compose-markitdown` succeeds; `pytest` runs **3/3 inside the container** (as the non-root `appuser`).

### Known environmental note (pre-existing, unrelated)

Running the whole `src/spec-factory` glob surfaces a `Cannot find package 'jsdom'` startup error from **dashboard frontend `.tsx` tests** (jsdom is a `dashboard/package.json` devDependency, not installed at the repo root). No Phase-2 backend file requests jsdom; all backend tests pass. Pre-existing, unrelated to this work.

## State machine (after Phase 2)

```
file upload:   awaiting_upload --confirmUpload--> pending --claim--> converting --> converted | failed | unsupported
youtube:       pending --claim--> converting --> converted | failed
note:          converted (direct; no conversion needed)
reconvert:     failed|unsupported --> pending
```
- `awaiting_upload` is **not claimable** (`claimNextPendingSource` selects only `pending`) — this closes the upload race (a file can't be converted before its bytes land in S3).
- Audio (`audio/*` mime or known ext) → `unsupported` in Phase 2; **voxtral is Phase 4** (verified available in `us-east-2`).

## Endpoints added (`/api/spec-factory/compose`)

| Method & path | Result | Notes |
|---|---|---|
| `POST /sessions/:id/uploads` | 201 | body `{filename, mimeType?, sizeBytes?}` → presigned PUT target; mints an `awaiting_upload` source. |
| `POST /sessions/:id/sources/:sid/uploaded` | 202 | browser signals upload done → `markSourceUploaded` → drain. |
| `POST /sessions/:id/youtube` | 202 | body `{url}` → pending youtube source → drain. |
| `GET  /sessions/:id/sources` | 200 | live per-source status list. |
| `POST /sessions/:id/sources/:sid/reconvert` | 202 | failed/unsupported → pending → drain. |

## Deploy steps (in order)

1. **Apply migrations 038 and 039** to the DB (out-of-band; CI does not run migrations). 039 adds `awaiting_upload` to the `conversion_status` enum — safe/fast on the empty table.
2. `terraform apply` (with `enable_spec_factory`): creates the `specter/compose-markitdown` ECR repo + lifecycle policy, adds the sidecar container to the task def, the `COMPOSE_*` env, and S3 CORS. **Tighten `compose_upload_allowed_origins`** from the `["*"]` default to the dashboard origin(s) in `shared.auto.tfvars`.
3. CI (`spec-factory-build-push.yml`) on push to `main` builds + pushes BOTH images (spec-factory + compose-markitdown) and force-new-deploys the ECS service.

## Manual happy-path (requires migrations 038+039, both images deployed, service :3012, sidecar :8080)

```
1. POST /compose/sessions { "name":"Audit upload" }                      -> 201 { id }
2. POST /compose/sessions/<id>/uploads { "filename":"spec.pdf", "mimeType":"application/pdf", "sizeBytes":12345 }
                                                                          -> 201 { sourceId, uploadUrl, s3KeyRaw }  (source = awaiting_upload)
3. PUT  <uploadUrl> with the file bytes (browser/curl direct to S3)       -> 200
   IMPORTANT: the presigned PUT signs ContentType, so the request MUST send a
   `Content-Type` header matching the `mimeType` passed in step 2, or S3 returns 403.
   (curl: `-H "Content-Type: application/pdf" --upload-file spec.pdf "<uploadUrl>"`.)
   The Phase-3 frontend must set this header on the upload fetch.
4. POST /compose/sessions/<id>/sources/<sourceId>/uploaded                -> 202  (-> pending -> drain)
5. GET  /compose/sessions/<id>/sources                                    -> source transitions converting -> converted; markdownContent populated
6. POST /compose/sessions/<id>/youtube { "url":"https://youtu.be/..." }   -> 202 ; converts to a transcript source
7. POST /compose/sessions/<id>/handoff                                    -> 202 ; the COMPOSE-<id> draft now includes the converted material as evidence
```

## Phase-3 / hardening backlog (surfaced by review, intentionally deferred)

- **Orphan `awaiting_upload` reaper:** if a browser requests an upload URL but never calls `/uploaded`, the source sits in `awaiting_upload` forever. (Cleaner than the prior fail-orphan behavior, but unbounded.) Add a TTL sweep (e.g. >24h → `failed` "upload abandoned"), ideally reusing the stale-job reaper pattern.
- **`confirmUpload` session validation:** it takes `sessionId` but only uses `sourceId`; consider validating the source belongs to the session (or dropping the param).
- **Task CPU/memory sizing:** the sidecar shares the task's 512/1024; markitdown can be memory-heavy on large files. Monitor post-deploy; bump task size or add per-container reservations if needed.
- **CORS tightening:** `compose_upload_allowed_origins` defaults to `["*"]` (presigned URLs are self-authenticating); set the dashboard origin(s) at deploy.
- **Enum-ordering:** `awaiting_upload` was added as the FIRST enum value (free on the empty table); future enum additions should append at the end to stay INPLACE on populated tables.
- **Conversion AbortSignal:** the per-conversion timeout stops *waiting* but doesn't abort the underlying sidecar fetch; pass an `AbortController` through `MarkitdownClient` if sidecar resource pressure shows up.
- **Image attachments / non-text edge formats** beyond markitdown's defaults, and **audio (voxtral)** — Phase 4.

## Phase-2 → Phase-3 handoff

Converted sources now carry real `markdownContent`, read by the unchanged `listSessionSourceContents` → `ComposeEvidenceProvider`. Phase 3 adds the **"Analyze Sources"** button (context pass) + the **SSE clarification chat** + the readiness gate / **"Generate Draft"** button (see the design doc's "Triggers & controls" section), plus the dashboard React UI. The conversion worker drains on each add and on a 5s interval; Phase 3 builds the chat agent loop on top of the converted corpus.
