# Spec Factory Engineering Hardening Checklist

**Date:** 2026-06-17
**Status:** Proposed (complements the in-flight product checklist)
**Method:** 8-dimension multi-agent code audit of `src/spec-factory/**`, `dashboard/src/spec-factory/**`, `sidecar/markitdown/**`, and `terraform/spec-factory-ecs.tf` — 76 findings, 21 adversarially verified/confirmed, 1 refuted. Payload-size and config-drift claims were recomputed independently from the source constants.

## How this relates to the existing checklist

`2026-06-17-spec-factory-enhancement-checklist.md` (which codex is implementing) is a **product / UX / conversational-experience** roadmap — conversation flow, agent identity, readiness preview, source intelligence, repo grounding, evidence traceability, template modes. It is good and largely orthogonal to this document.

This checklist is the **reliability / correctness / security / observability** counterpart. It captures the confirmed *bugs and root causes* — including the two operator-reported symptoms (slow chat, failing video) — that the product checklist does **not** cover. Where the two overlap, it is called out as **[BLOCKS …]** or **[PAIRS WITH …]**.

> ⚠️ **Dependency the product checklist must know about:** its P0 item *"return immediately, then stream the assistant response through SSE"* is **structurally unsafe today** until P0-A.3 (SSE delivery decoupled from process memory) and P1-A.2 (SSE reconnect/replay) below are done. Fire-and-forget + in-process SSE means a streamed reply is silently lost on any replica scale-out or dropped connection. Sequence these first.

---

## Verified root causes of the two reported symptoms

| Symptom | Confirmed root cause | Where | Quick fix |
|---|---|---|---|
| **Video fails** | One 300s timeout wraps S3 fetch + ffmpeg + *all sequential* per-segment Bedrock calls; sidecar is provisioned for 1800s/3600s, so advertised capacity can never be transcribed | `compose-conversion.ts:22,151-155,219-262`; `server.ts:71-76` | Per-stage + per-segment timeouts, env-wired (P0-B.1) |
| **Video fails** | 600s segment → ~25.6 MB base64 **and** ~26.4k audio tokens + 8.2k reserved output > Voxtral ~32k context window → `ValidationException` → `markSourceFailed`. Videos almost always exceed one short segment, so short clips work and the bug looks "intermittent" | `sidecar/markitdown/app.py:32,257-259`; `compose-voxtral.ts:48-72`; `terraform/variables.tf` | Lower `COMPOSE_AUDIO_SEGMENT_SECONDS` 600→300 (P0-B.2) |
| **Chat slow** | `runTurn` calls `workspaceManager.prepare()` **twice**; the 2nd `rm -rf`s + rewrites every source to EFS (and races the conversion worker) on a stale snapshot; messages+sources re-read from DB twice | `compose-service.ts:764-789,822-839` | Drop `sources` from 2nd prepare (P0-A.1) |
| **Chat slow** | Source ops (`confirmUpload`/`addYoutube`/`addConfluence`/`reconvert`) end with inline `await drain()`, which converts the **entire** pending queue before the HTTP request returns — one session waits on others' backlog | `compose-service.ts:652,662,675,707,722` | `void drain().catch(...)` (P0-A.2) |
| **Chat *feels* slow** (perception) | No token streaming or progress; `status:thinking` fires once, then a static "Working on it" spinner for the whole turn — a normal turn is indistinguishable from a hang | `compose-service.ts:768-771,845-854`; `ChatPanel.tsx:233-246` | Coarse `onProgress` breadcrumbs + elapsed counter (P1-A.1) |
| **Chat slow** (scaling) | Chat runs Opus 4.8 (300s ceiling) sharing `SPEC_FACTORY_MODEL_ID` with the heavy draft/qualify pipeline; can't downgrade independently; re-reads every source each turn with no prompt caching | `compose-chat-agent.ts:122-152`; `compose-database.ts:398-422` | `COMPOSE_CHAT_MODEL_ID` + prompt caching (P0-A.4 / P1-A.3) |

> The video symptom is **over-determined** — timeout collapse (P0-B.1), segment size (P0-B.2), sidecar OOM (P1-B.1), and no-segment-retry (P1-B.2) all plausibly co-occur. **Ship observability (P0-C.1) first** and re-triage from real `error_message` distributions before assuming which dominates.

---

## P0 — Stop-the-bleeding (do first)

### P0-A. Chat latency (active at the current single replica)
- [x] **A.1** Drop the `sources` argument from the **post-agent** `workspaceManager.prepare()` call (`compose-service.ts:830-839`) — write only `chat.md`/`context.md`. Removes a full per-turn EFS `rm -rf`+rewrite **and** the race that orphans concurrent conversion-worker source writes. *(quick win, effort S)*
- [x] **A.2** Detach the on-demand conversion kick: `await this.conversionWorker.drain()` → `void this.conversionWorker.drain().catch(log)` in `confirmUpload`/`addYoutube`/`addConfluence`/`reconvert`/`reconvertFailedSources` (`compose-service.ts:652,662,675,707,722`). Routes return 202 promptly; the DB conditional claim already prevents double-processing. *(quick win, effort S)*
- [ ] **A.3** Pass the already-validated session from `postMessage`/`analyze` into `runTurn` and append the assistant message in memory — eliminates the 2nd `getSession` + 2nd `listMessages` round-trips per turn (`compose-service.ts:764-789,896-911`). *(effort S)* **Partial:** assistant message is now appended in memory for the post-agent workspace rewrite, eliminating the 2nd `listMessages` round-trip.
- [x] **A.4** Add `COMPOSE_CHAT_MODEL_ID` (fallback `SPEC_FACTORY_MODEL_ID` → `ANTHROPIC_MODEL` → default), mirroring the existing `qualifier.ts:225-229` override; default chat to a **Sonnet** tier. Additive/backward-compatible; lets operators run fast chat without downgrading draft generation. *(quick win, effort S)* **[PAIRS WITH product checklist P2 "smaller fast-path prompt"]**

### P0-B. Video / media failure
- [ ] **B.1** Replace the single `DEFAULT_CONVERT_TIMEOUT_MS` wrapper with **per-stage** timeouts: a longer `extractAudio` timeout aligned to the sidecar ffmpeg ceiling, and a **per-segment** timeout around each `voxtral.transcribe`. Introduce env-configurable `COMPOSE_TRANSCRIBE_TIMEOUT_MS` (distinct from the markitdown `/convert` timeout), wire it through `server.ts:71-76`, and keep it **strictly below** `conversionLeaseMs` (raise the lease in lockstep) so a reclaim can't double-process mid-flight. Pass an `AbortController`/request timeout to the Bedrock + sidecar fetches so a hung segment is actually cancelled. *(effort M)*
- [ ] **B.2** Lower `COMPOSE_AUDIO_SEGMENT_SECONDS` **600 → 300** in the sidecar (`app.py:32`), the Node default, **and** `terraform/variables.tf` (keep all three aligned). 300s → ~12.8 MB base64, ~21.4k tokens < 32k window. Add a guard in `compose-voxtral.transcribe` that rejects on estimated **duration/token count** (not just bytes) and lower `max_tokens` from 8192 (transcripts rarely need it). Do **not** switch to MP3 to extend segment *length* — token cost tracks duration (~44 tok/s), so a longer MP3 segment still overruns the window. *(quick win, effort S)*

### P0-C. Observability (unblocks correct triage of everything above)
- [ ] **C.1** Add `createLogger('compose-conversion')` and `createLogger('compose-turn')` (the rest of the platform uses pino `createLogger` ~119×; compose has **zero**). Log per `convertOne`: source id/kind/byte size/segment count/per-stage durations + structured failure cause; per `runTurn`: per-stage timing (workspace prep, model call, parse, persist, SSE). Emit `conversion_failed`/`turn_duration` counters/timers. **Without this, the video root cause cannot be confirmed from prod.** *(effort M)* **[PAIRS WITH product checklist P2 "Track agent latency by phase" and P3 "debug drawer"]**
- [ ] **C.2** Add a structured `.catch` (log `sessionId`+`mode`) to the fire-and-forget `analyze`/`postMessage` routes (`compose-routes.ts:348,363`) so failed turns stop vanishing with zero trace. *(quick win, effort S)*

---

## P1 — High-value correctness, resilience & security

### P1-A. Streaming & SSE delivery (the real "feels slow / feels broken" fixes)
- [ ] **A.1** Cheap interim streaming: thread `runAgent`'s `onProgress` callback through `ChatAgentLike.run` → `runTurn` and publish coarse tool-activity breadcrumbs ("Reading sources…", "Updating brief…") + an elapsed-seconds counter to replace the static spinner. Works with the existing SDK. *(effort M)* **[IS the product checklist P0 "stream richer progress states" — implement here]** **Partial:** static spinner is replaced with backend-published phase breadcrumbs; `runAgent.onProgress` and elapsed counter remain.
- [ ] **A.2** SSE reconnect + replay: add `source.onopen` (refetch messages+readiness from DB and explicitly clear `thinking`/`analyzing` flags — an `onopen` refetch alone won't clear the React flag) and `source.onerror` to `useComposeStream.ts:19-46`; have `/stream` send a backlog/last-event on (re)connect. Today a dropped EventSource connection strands the UI in "thinking" forever. *(effort M)*
- [ ] **A.3** (Larger) Decouple turn-completion delivery from process-local memory: back `ComposeSseHub` with shared pub/sub (Redis/SNS fanout or a DB-polled per-session event log), **or** persist a turn-status/last-event row and poll. **This is the prerequisite for any multi-replica scale-out and for the product checklist's "run the agent turn in the background and stream through SSE."** *(effort L)* **[BLOCKS product checklist P0 background-turn streaming]**

### P1-B. Conversion robustness
- [ ] **B.1** Sidecar memory: the `compose-markitdown` container sets no `memory`/`memoryReservation` and shares a 0.5 vCPU / 1 GB task with the Node app, while holding the full upload (up to `MEDIA_MAX_BYTES`=500 MB) + base64 in memory. Highest-leverage fix: **stream segments to S3 and return segment URLs** instead of base64-in-JSON (removes the ~1.5× inflation held on *both* containers). Also set sidecar `memory`/`memoryReservation` and bump/split task sizing. *(effort M)*
- [ ] **B.2** Per-segment transient retry: `transcribeMedia` currently throws on the **first** segment rejection, discarding all prior segments (`compose-conversion.ts:249-260`). Accumulate successful segments; add a **Bedrock-specific** transient classifier (do *not* reuse `oneshot/retry-classifier.ts` verbatim — its patterns don't match Voxtral error strings) with bounded backoff that fits inside the per-segment timeout. *(effort M)* **[OneShot port — see P2-D]**
- [ ] **B.3** Auto-retry transient conversion failures: `convertOne`'s catch unconditionally `markSourceFailed` for *any* error (S3 hiccup, sidecar 503, EFS contention). `conversion_attempts` is incremented (`compose-database.ts:655`) but never read. Classify deterministic (415/validation) → fail; transient → reset to a **delayed-pending** (not-before timestamp) up to MAX attempts. *(effort M)*

### P1-C. Lifecycle & resource leaks
- [ ] **C.1** Schedule `ComposeRetentionCleaner`: it is fully implemented but **only** a `package.json` script (`spec-factory:compose-cleanup`) — no EventBridge/scheduled ECS task wires it, so archived sessions + EFS workspaces + DB rows grow unbounded. Add an EventBridge-scheduled `run-task` (daily, `COMPOSE_CLEANUP_DRY_RUN=true` first) and define `COMPOSE_WORKSPACE_RETENTION_DAYS`. **Also: it has no S3 deletion path at all** — raw uploads are never purged; add S3 prefix cleanup. *(effort M)* **[PAIRS WITH product checklist P3 "retention visibility"]**
- [ ] **C.2** Spec Factory core processing-job recovery: `expireStaleProcessingJobs` only touches `'running'` jobs based on `started_at` with no heartbeat, and a legit qualify+deep-dive+draft run (≤20 min) can exceed the 30-min stale window and race a live worker. Add `AND status='running'` to `completeProcessingJob`/`failProcessingJob` and assert `affectedRows===1` (`database.ts:1154-1163`) so an expired job can't be silently resurrected; derive the stale threshold from `SPEC_FACTORY_DRAFT_TIMEOUT_MS` + slack; add a `'queued'`-job age-out / startup sweep. *(quick win for the guard, effort S; full sweep M)*

### P1-D. Security / authorization
- [ ] **D.1** `/stream` SSE (and `messages` GET/POST, `sources` GET, `notes`, `analyze`, `uploads`) perform **no session authorization** — `/stream` only validates `positiveInt` then subscribes, while `runTurn` publishes the full assistant reply over it. Password protection is decorative for live traffic and any guessed integer id leaks another session's conversation. Route all content paths through `requireAuthorizedSession`; for EventSource (no body) issue a short-lived per-session token from `resumeSession`. *(effort M)*
- [ ] **D.2** Add `requireSession`(+not-archived) guards to `addYoutube`/`addConfluence` (they skip the session existence check `requestUpload`/`addJira` perform); validate `requestUpload` `sizeBytes` against a configured max aligned with sidecar limits (+ a client check in `AddSourceModal`). *(effort S)*

### P1-E. Handoff correctness **[PAIRS WITH product checklist P2 handoff loop]**
- [ ] **E.1** `handoff()` creates + links the spec source **before** `requestDraftGeneration`, which is **not** wrapped in try/catch (`compose-service.ts:550-605`). If it throws, the session links to a source stuck in `drafting` and the early-return on re-handoff makes "Draft anyway" silently no-op. Wrap in try/catch, record `handoff_draft_request_failed`, and make re-handoff re-queue a draft when the linked source has no active job. *(effort M)*

---

## P2 — OneShot optimizations to port (shared resilience layer)

> The two recent OneShot retry commits (`02df09d` "Improve Retry Mechanism", `4aa7dcd` "Fix transient retry ETA handling") and `#301` evidence synthesis are the relevant sources.

- [ ] **D.1 (shared module)** Extract OneShot's transient-retry backoff (`consumer-visibility.ts:34-93`) + deterministic classifier (`retry-classifier.ts`) into provider-agnostic `src/utils/transient-retry.ts` + `src/utils/retry-classifier.ts`, consumed by both `src/oneshot` and the new Compose retry paths — prevents re-copying the schedule and re-creating the `02df09d→4aa7dcd` drift. *(effort M)*
- [ ] **D.2** Port retry **ETA surfacing** (`4aa7dcd` `retryPendingNextRetryAt/DelaySeconds/Attempt/MaxAttempts`, `TransientRetryMetadata`) to Compose: add a `'retrying'` variant to `ComposeChatEvent` status (`compose-types.ts:84-87`) and classify+retry `chatAgent.run` in `runTurn` (`compose-service.ts:799-813`), publishing "retrying, ETA…" instead of a dead-end bare error. *(effort M)* **[directly improves "feels unreliable"]**
- [ ] **D.3** Port `checkOneShotTokenBudget` concept (`token-budget.ts:88-174`) to the Compose chat agent (`compose-chat-agent.ts:132` + source assembly `compose-service.ts:776-789`) — cap/warn before a long session re-feeds an ever-larger source corpus into the model each turn (port the budget concept, not the run-row plumbing). *(effort M)*
- [ ] **D.4** Port `#301` evidence-synthesis prompt patterns (build an evidence map before planning, document-type-aware depth, per-paragraph citations) into `ANALYZE_INSTRUCTIONS` (`compose-chat-agent.ts:64-75`) and `draft-generator.ts` `buildPrompt`. Prompt-only, zero code risk; `buildComposeEvidenceManifest` already supplies a `## filename` citation key. Prevents briefs/drafts from silently omitting long transcripts. *(quick win, effort S)* **[PAIRS WITH product checklist P2 "Evidence Traceability"]**

---

## P3 — Lower-severity correctness, tests & polish

- [ ] **C.1** Config drift: surface env vars read by code but absent from terraform/.env.example so prod stops silently running hardcoded defaults — `COMPOSE_CONVERSION_POLL_MS`, `COMPOSE_CHAT_TIMEOUT_MS`, `MARKITDOWN_MAX_BYTES` (50 MB), `COMPOSE_AUDIO_MAX_BYTES` (500 MB), `COMPOSE_TRANSCRIBE_TIMEOUT_MS` (new), `COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES`. **Also fix `app.py:289` `allowed_suffixes=[]` → `None`** so the Confluence allowlist is actually enforced. *(quick win, effort S)*
- [ ] **C.2** Candidate ingestor pagination: `candidate-ingestor.ts:41` hardcodes `maxResults=50` and computes `truncated` (`:89`) but never paginates — overflow Louise candidates are silently dropped. Paginate (or loop while `truncated`); at minimum alarm when `truncated`. *(effort S)*
- [ ] **C.3** Spec Factory core edge cases: (a) `'queued'` jobs whose worker died never expire (add startup sweep / max-attempts / dead-letter); (b) OneShot submit applies PFOS before creating the run request — create-request-first (dedupe via `findExistingRunRequestId`); (c) non-transactional Epic publish can orphan/duplicate child issues. *(effort M)*
- [ ] **V.1** Video test coverage: every sidecar audio test monkeypatches `extract_audio_segments` (real ffmpeg/decode = **zero** coverage); `compose-voxtral.test.ts` only ever passes a 4-char base64, never near the size/token boundary. Add: a `transcribe()` test asserting rejection/chunking above the duration/token guard; a `compose-conversion` test driving N stub segments verifying per-segment timeout + all-segments-sent; a sidecar integration test running real ffmpeg on a tiny fixture. **The two top video bugs shipped untested.** *(effort M)*
- [ ] **F.1** Frontend re-render debt: source-poll (`ComposeWorkspace.tsx:183-191`) and board-poll (`SpecFactoryPage.tsx:1822-1985`) intervals are torn down + recreated on every state change (effect depends on the full `sources` array). Drive both off a stable `anyInFlight` boolean/ref so the timer is created once. *(effort M, low severity)*
- [ ] **F.2** Frontend chat/source UX polish: (a) `analyzing` is set from `status:thinking` which fires for *both* analyze and ordinary chat, so a normal message flips Sources to "Analyzing…" and disables Analyze — derive `analyzing` from the explicit handler/turn-kind; (b) key optimistic user echoes to a server id/turn token to avoid the dup window; (c) add a dismiss control for the stale global error toast; (d) confirm dialog for "Draft anyway". *(effort S, low severity)* **[PAIRS WITH product checklist P0 chat UI]** **Partial:** status events now carry analyze/chat mode, and chat-mode progress no longer toggles the Sources analyze button.
- [ ] **M.1** Multi-replica latent guard (only when scaling past 1 replica): back the `activeTurns` Set with a DB lease/`GET_LOCK` keyed on `session_id`; re-tune `conversionLeaseMs` to ~1.5× the per-attempt timeout once P0-B.1 lands; add the missing lease index. **For now: pin `desired_count=1`, document the single-replica constraint, and add a CloudWatch alarm if running-task-count > 1.** *(quick win for the guardrail, effort S)*

---

## Confirmed NON-issues (do not spend effort)
- **`webm` in both `AUDIO_EXTS` and `VIDEO_EXTS`** — `mediaMimeOrExt` is a single boolean `.some()`; both funnel to the identical `transcribeMedia` path (ffmpeg `-vn` drops video). No mis-routing. *(Optionally merge into one `MEDIA_EXTS` constant with a comment.)*
- **Voxtral `format:"wav"` enum** — correct; segments are genuinely pcm_s16le WAV.
- **Voxtral `us-east-2` region / AccessDenied theory** — **refuted** (live-probe project memory + consistent IAM/region). Not a cause.

---

## Residual uncertainty (from the audit's completeness critic)
1. The video failure is **over-determined** (P0-B.1, P0-B.2, P1-B.1, P1-B.2 likely co-occur). Ship **P0-C.1 observability first**, then re-triage from real `markSourceFailed` `error_message` values (`/timed out/` vs `ValidationException` vs OOM SIGKILL).
2. Failing-minute thresholds (10 / 30–60 min) are **unbenchmarked** — only the structural timeout/lease/sidecar mismatch is proven. Load-test with 30/45/60-min fixtures to set `COMPOSE_TRANSCRIBE_TIMEOUT_MS` empirically.
3. Per-segment Bedrock latency (~60 s) is an estimate — tune P0-B.1 timeout sizing against real traces.
4. Slow-chat contributor weighting (P0-A.1/A.3/A.4, P1-A.3) is structurally sound but unprofiled — P0-C.1 per-stage timing will quantify which dominates.
5. Frontend findings were reasoned from code, not a running dashboard; the SSE-stuck-thinking behavior (P1-A.2) is high-confidence from the event flow but unverified against a live reconnect.

**Suggested execution order:** P0-C.1 (see) → P0-B.2 + P0-A.1/A.2 (one-line/localized wins) → P0-B.1 (real video fix) → re-triage video from logs → P1-A.1/A.2 (streaming perception + reconnect) → P1-D.1 (auth) → the rest by rank.
