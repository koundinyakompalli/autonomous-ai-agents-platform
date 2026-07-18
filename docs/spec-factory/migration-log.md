# Migration log (phases 0-11)

This log preserves the v3 phase history and records the v4 implementation
tranche. “Code ready” is not “shipped”: migrations, Terraform, flags, repair,
certification, and legacy removal each require separate environment evidence.

Grep hint: `grep -A 5 "Status: SHIPPED" migration-log.md` returns every phase that actually runs in production today. Everything else is aspirational and must not be cited as current behavior.

## Contents

- [How to update this log](#how-to-update-this-log)
- [V4 Work Orders C-U delivery](#v4-work-orders-c-u-delivery)
- [Phase 0 — Baseline, Lifecycle, and Safety](#phase-0--baseline-lifecycle-and-safety)
- [Phase 1 — Replayable Session Events and Shared Stream Tokens](#phase-1--replayable-session-events-and-shared-stream-tokens)
- [Phase 2 — Durable Compose Turn Jobs](#phase-2--durable-compose-turn-jobs)
- [Phase 3 — Runtime Split and Worker Modes](#phase-3--runtime-split-and-worker-modes)
- [Phase 4 — Workspace Manager](#phase-4--workspace-manager)
- [Phase 5 — Agent Task Queue and Capability Registry](#phase-5--agent-task-queue-and-capability-registry)
- [Phase 6 — Generated Research Sources](#phase-6--generated-research-sources)
- [Phase 7 — Source Distillation, Context Patches, Context Versions](#phase-7--source-distillation-context-patches-context-versions)
- [Phase 8 — LLM Gateway](#phase-8--llm-gateway)
- [Phase 9 — Stateless Chat Coordinator](#phase-9--stateless-chat-coordinator)
- [Phase 10 — Handoff Bundle and Draft Pipeline Enrichment](#phase-10--handoff-bundle-and-draft-pipeline-enrichment)
- [Phase 11 — Optional Specialists and Critic](#phase-11--optional-specialists-and-critic)
- [Cross-cutting workstreams](#cross-cutting-workstreams)
- [Resolved decisions and remaining open item](#resolved-decisions-and-remaining-open-item)

## V4 Work Orders C-U delivery

- Plan: `spec_factory_scale_and_reliability_plan_v4.md`.
- Delivery: PR `#468`.
- Repository status: CODE READY; review/merge pending at time of authoring.
- Environment status: NOT MIGRATED, NOT TERRAFORM-APPLIED, NOT CERTIFIED.

| Work orders | Implemented result                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-D         | Purpose-scoped direct Bedrock plus coordinator bundle hydration and backend-frozen requested/used context provenance.                                                       |
| E-F         | Bounded cumulative context-v4 reducer; source revisions/chunks; message-derived patches; explicit removal/conflict provenance.                                              |
| G-H         | Transactional outbox; leased relay; SQS queues/DLQs/quarantine; versioned envelopes; receipt/visibility fencing and redispatch repair.                                      |
| I-K         | API/worker separation, per-session concurrent turn workers, capability-specific runtimes, role images, IAM/secrets/network restrictions, exact heartbeats.                  |
| L           | Content-addressed S3 artifacts/manifests, task-local hydration, checksum/size verification, DSR exact deletion, reachability GC.                                            |
| M-N         | Frozen handoff aggregate/snapshot and durable resumable draft stages through approval, Jira publish, and OneShot submit.                                                    |
| O-P         | Correlated canonical event envelope, Valkey live fanout with MySQL replay, authoritative workflow-state UI, cancel/retry/stale/error states.                                |
| Q           | Split ECS services, per-role autoscaling, queues/alarms, Valkey, optional Aurora/RDS Proxy, digest-pinned role images, task-local scratch.                                  |
| R-S         | Retention and control-plane repair, bounded research/costs, immutable artifact GC, DSR coverage, context-v4 backfill/reconcile/report acceptance.                           |
| T           | Versioned certification manifest/evaluator, canonical-manifest integrity checks, hashed evidence recorder, CI artifact, functional/security commands, k6 load harness, chaos/DR evidence contract. Environment execution remains required. |
| U           | Application and Terraform fail-closed legacy-removal gates. Physical legacy code/path deletion remains intentionally blocked until accepted T evidence closes rollback.     |

Migrations added:

1. `069_spec_factory_context_v4.sql`
2. `070_spec_factory_outbox.sql`
3. `071_spec_factory_handoffs.sql`
4. `072_spec_factory_draft_workflows.sql`
5. `073_spec_factory_repair_and_bounds.sql`
6. `074_spec_factory_source_distillation_prompt_v2.sql` registers the strict
   canonical-text contract discovered during the Gate 3a context-worker canary.
7. `075_spec_factory_source_deletion_lifecycle.sql` adds recoverable source
   deletion batches, source deletion/purge markers, and bounded purge indexes.

Gate 3a also found that Bedrock rejects coordinator transport schemas containing
`oneOf`. The direct coordinator schema is now flat and Bedrock-compatible;
`CoordinatorDecisionSchema` remains the authoritative action-specific validator.

Verification required by the PR workflow: root build, schema/migration checker,
all Spec Factory tests, dashboard typecheck/tests/build, Terraform format/
validate, certification-manifest generation, and all role-specific Docker
builds. Production application of this tranche follows `operations.md`; no
migration or Terraform apply belongs to CI image publication.

## How to update this log

- One phase moves from `PLANNED` to `IN PROGRESS` only when a work-order branch is opened.
- One phase moves to `SHIPPED` only after every bullet under "Ship criteria" is verifiable in `main` (Definition of Done, plan `§36`).
- Update `Files added / changed`, `Migrations added`, and `Feature flags introduced` in the same PR that ships the phase. Do not batch across phases.
- Add follow-up items to the target follow-up phase, not to a shared TODO list.
- Cross-cutting workstreams (retention, artifact GC, alerts) are tracked in their own section and referenced from the phases that gate them.

---

## Phase 0 — Baseline, Lifecycle, and Safety

- Plan section: `§6 Phase 0`; guard invariants in `§9`.
- Work Order: `A — Baseline and Guards` (plan `§34`).
- Status: SHIPPED.

Summary. Phase 0 centralizes archived-session gating behind a single `ActorContext` + guard module and threads those guards through every mutating Compose route and stream endpoint. Stream tokens are now revoked before archive commit, and the DB predicate for activity updates already rejects archived rows, so post-archive writes cannot leak by racing the SSE hub.

Ship criteria (Definition of Done, plan `§36 Initial Durable Foundation Done`, guard scope only):

- Centralized guards exist for readable / mutable / streamable / handoff-allowed. Met at `src/spec-factory/session/session-guard.ts:38-82`.
- Every mutating Compose route calls `requireMutableSession` or `assertSessionHandoffAllowed`. Met by the `ComposeService` guard wrappers at `src/spec-factory/compose-service.ts:4000-4039`.
- Archived sessions reject reads/mutations/streams. Met at `session-guard.ts:46-82` (throws `not found` on `status === 'archived'`) and enforced by DB predicate `AND status <> 'archived'` in `recordSessionActivity` (`compose-database.ts:1794-1815`).
- Stream tokens are revoked on archive/delete. Met via `compose-service.ts:989` (revocation call inside `deleteSession` at `compose-service.ts:983`) and DB update on `compose_stream_tokens.revoked_at` (`compose-database.ts:1929-1943`).
- Idempotency fields exist on turn-job tables to unblock Phase 2. Met at `compose-database.ts:1997-2150` and `compose-database.ts:5894-5908` — `idempotency_key_reused` guard rejects duplicate inserts.
- Guard tests exist. Met at `src/spec-factory/session/session-guard.test.ts`.

Prerequisites: none. Phase 0 is the migration baseline.

Files added / changed:

- `src/spec-factory/session/session-guard.ts` (new in Phase 0; now enforces archive plus owner/admin access, with system-worker and legacy-unowned compatibility).
- `src/spec-factory/session/session-guard.test.ts` (new).
- `src/spec-factory/compose-service.ts` — private `requireMutableSession`, `requireReadableSession`, `requireStreamableSession`, `requireHandoffAllowedSession` (`compose-service.ts:4000-4039`) and call-site rewrites through every mutation.
- `src/spec-factory/compose-database.ts` — `recordSessionActivity` filters archived rows (`compose-database.ts:1794-1815`), plus `compose_stream_tokens` CRUD (`compose-database.ts:1903-1943`) and idempotency guard for turn-job inserts (`compose-database.ts:1997-2150`).
- `src/spec-factory/compose-routes.ts` — guard-aware route wiring for read / mutate / stream classes.

Migrations added:

- `db/migrations/053_compose_session_events_and_stream_tokens.sql` — `compose_session_events` + `compose_stream_tokens` tables (also used by Phase 1 replay; the schema is shared).

Feature flags introduced (all Phase 0-safe defaults; plan `§28`):

- `SPEC_FACTORY_DURABLE_EVENTS=false`.
- `SPEC_FACTORY_DURABLE_TURNS=off`.
- `SPEC_FACTORY_MODE=all-local`.
- `SPEC_FACTORY_AGENT_TASKS=false`, `SPEC_FACTORY_WORKSPACE_MANAGER=false`, `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false`, `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=false`, `SPEC_FACTORY_ENABLE_CONTEXT_MERGE=false`, `SPEC_FACTORY_LLM_GATEWAY=false`, `SPEC_FACTORY_CHAT_COORDINATOR=false`.
- `SPEC_FACTORY_RESEARCH_EXECUTOR=none`.
- `SPEC_FACTORY_ADMIN_IDS=""` (comma-separated OIDC subs; consumed by `actorContextFromSpecFactoryActor`, `session-guard.ts:18-34`).
- `Idempotency-Key` is required for HTTP turn-producing mutations.
- Stream tokens are DB-backed by `compose_stream_tokens`; there is no Redis token cutover flag.

Metrics added: none in Phase 0 beyond existing Compose counters. Phase 1 introduces the durable-event metrics; Phase 2 introduces the durable-turn metrics.

Follow-up items deferred to later phases:

- Tenant/org-scoped RBAC can replace the current owner/admin guard when an authoritative tenant model exists; `ActorContext.roles` is already wired to `SPEC_FACTORY_ADMIN_IDS`.
- Admin-only archive read route is not part of the shipped normal user surface; DSR deletion uses the explicit hard-delete service.
- Redis can be added later as a live fanout/cache assist, but `compose_session_events` and `compose_stream_tokens` are the durable sources of truth.

---

## Phase 1 — Replayable Session Events and Shared Stream Tokens

- Plan section: `§6 Phase 1`; event schema `§10`; token store `§10.4`.
- Work Order: `B — Durable Events and Shared Tokens` (plan `§34`).
- Status: PARTIALLY SHIPPED. App-code runtime selection is wired in `server.ts`, split-mode processes record `spec_factory_worker_heartbeats`, and Terraform defines disabled-by-default split worker services. Desired counts remain `0` until rollout gates enable them.

Summary. Phase 1 removes the stream-token and replay assumptions inside the API tier. Stream tokens are persisted in `compose_stream_tokens`, and SSE frames are persisted to `compose_session_events`; `/stream` emits SSE `id:` from the durable event id, honors `Last-Event-ID`, bridges the replay/live race through ordered durable-store catch-up rather than the bounded in-process replay ring, and polls the durable log for active subscriber cursors so another API replica's writes are delivered. Operator source intake records best-effort `source.added` / `source.uploaded` durable events, and the conversion worker emits best-effort `source.conversion.started`, `source.conversion.completed`, and `source.conversion.failed` durable events around source-row state changes. Redis Pub/Sub (or Streams) remains an optional low-latency fanout substrate after the MySQL-backed path is stable; it is not required for correctness.

Ship criteria (plan `§36 Initial Durable Foundation Done`, event slice):

- `compose_session_events` is authoritative; replay from `Last-Event-ID` yields byte-identical events to live fanout for the same session.
- Cross-replica delivery works through durable-log polling; Redis Pub/Sub (or Streams), if adopted later, is only a latency optimization.
- Stream tokens are shared across replicas and revocable in one place.
- `compose.events.replayed` and `compose.events.published` metrics report non-zero traffic.
- Zero lost durable events in the replay audit (§30.4 gate).

Prerequisites: Phase 0 (guards, revocation-on-archive, idempotency fields).

Files added / changed:

- `src/spec-factory/compose-sse.ts` — durable publisher/subscriber, replay buffer, paused replay bridge, and active-subscriber durable-log polling.
- `src/spec-factory/compose-routes.ts` — `GET /sessions/:sessionId/stream` uses durable ids, paused replay-to-live bridging, durable-store catch-up, and monotonic cursor advancement.
- `src/spec-factory/compose-database.ts` — `compose_session_events` append/replay and `compose_stream_tokens` token persistence/revocation/purge helpers.
- `src/spec-factory/compose-conversion.ts` — best-effort source conversion lifecycle event publisher.

Migrations added: `compose_session_events` and `compose_stream_tokens` already ship in migration `053_compose_session_events_and_stream_tokens.sql`.

Feature flags introduced (plan `§28`):

- `SPEC_FACTORY_DURABLE_EVENTS=true` (phase-1 required-mode switch; false keeps the shipped best-effort durable-store path).

Metrics added (plan `§30.2`):

- `compose.events.published`, surfaced through `/status` as `composeControlPlane.events.durablePublishedToday` plus `.latestPublishedAt`.
- `compose.events.replayed`, surfaced as the per-replica `composeControlPlane.events.replayedByThisReplica`; live SSE deliveries are paired as `.liveDeliveredByThisReplica`.
- `compose.events.persist_failed` and `compose.events.payload_too_large`, surfaced through `/status` as `composeControlPlane.events.durablePersistFailuresToday` and `.payloadTooLargeToday`.
- `compose.streams.connected` / `compose.streams.disconnected`, surfaced as per-replica `composeControlPlane.streams.connectedByThisReplica` / `.disconnectedByThisReplica` with active subscriber/session gauges.
- `compose.stream_tokens.created` / `compose.stream_tokens.revoked`, surfaced through `/status` as `composeControlPlane.streamTokens.createdToday` / `.revokedToday` with active and expired-unrevoked token gauges.

Follow-up items deferred to later phases:

- Session-local `sequence` remains nullable and reserved; the shipped replay cursor is the global `compose_session_events.id`.
- Vector retrieval integration for future search over events — no phase assigned; open decision 12.

---

## Phase 2 — Durable Compose Turn Jobs

- Plan section: `§6 Phase 2`; job schema `§11`; cutover `§28`.
- Work Order: `C — Durable Turns With Legacy Executor` (plan `§34`).
- Status: PARTIALLY SHIPPED.

Summary. Schema landed in migration `054_compose_turn_jobs.sql` (`compose_turn_jobs` with `turn_kind` / `lease_generation` / `idempotency_key`, `compose_turn_outputs`, `compose_session_messages.turn_job_id` / `context_version_used`). HTTP turn routes require `Idempotency-Key`, create/dedupe `compose_turn_jobs`, record best-effort `turn.queued`, and in `SPEC_FACTORY_DURABLE_TURNS=drain|on` leave execution to `ComposeTurnWorker` instead of the in-memory queue. `off|shadow` still routes through the legacy queue for rollout safety. Analyze turns are first-class jobs with `user_message_id = NULL`. Durable execution records `turn.started` after lease acquisition and `turn.completed` after the fenced final assistant write. Archive now atomically cancels non-terminal turn jobs and agent tasks before setting `archived_at`, `POST /sessions/:sessionId/turns/:turnJobId/cancel` cancels a single durable turn without archiving the session, and durable final writes fence against stale leases, archived sessions, and cancelled statuses. The remaining cutover work is production rollout validation and eventual removal of the legacy queue path after `legacy_inflight == 0`.

Ship criteria (plan `§36 Initial Durable Foundation Done`, turn slice):

- `compose_turn_jobs` and `compose_turn_outputs` (or equivalent) exist with `turn_kind`, nullable `user_message_id`, required `idempotency_key`, `lease_generation`, `attempt_count`, and terminal-state fields.
- Session-level turn locking guarantees only one running turn per session; queued backpressure matches or improves on today's `MAX_QUEUED_TURNS_PER_SESSION = 3` (`compose-service.ts:87`).
- Stale-job recovery reclaims turns whose lease expired without a heartbeat.
- One-final-assistant-response is enforced against `compose_turn_outputs`; duplicates are rejected before message insert (idempotency guard already scaffolded at `compose-database.ts:1997-2150`).
- Analyze turns run without a user-message row.
- `shadow -> drain -> on` cutover has been observed at least once with `legacy_inflight == 0` gating the flip.

Prerequisites: Phase 1 (durable events for turn lifecycle broadcasting) and Phase 0 (idempotency fields).

Files added / changed (target):

- `src/spec-factory/jobs/turn-job-store.ts` (new).
- `src/spec-factory/jobs/turn-job-processor.ts` (new).
- `src/spec-factory/agents/legacy-compose-chat-executor.ts` — turn-executor adapter wrapping `ComposeChatAgent.run` (`compose-chat-agent.ts:327-389`); live routing still goes through `ComposeService` until final legacy-chat cutover.
- `src/spec-factory/compose-service.ts` — durable `drain|on` delegation through `ComposeTurnWorker` is shipped; remove the in-memory legacy path after production drain reaches zero.
- `src/spec-factory/compose-routes.ts` — `POST /sessions/:sessionId/messages` and `POST /sessions/:sessionId/analyze` return 202 with a `turn_job_id`.

Migrations added: `db/migrations/054_compose_turn_jobs.sql` — `compose_turn_jobs`, `compose_turn_outputs`, plus `compose_session_messages.turn_job_id` / `context_version_used` columns (shipped).

Feature flags introduced:

- `SPEC_FACTORY_DURABLE_TURNS=off|shadow|drain|on` (plan `§28`).
- `Idempotency-Key` remains required for HTTP turn-producing mutations in `on`.

Metrics added (plan `§30.2`):

- `compose.turns.queued`, `compose.turns.running`, `compose.turns.completed`, `compose.turns.failed`.
- `compose.turns.duplicate_suppressed`, recorded as
  `turn.duplicate_suppressed` events and surfaced through `/status` as
  `composeControlPlane.turns.duplicateSuppressedToday`.
- `compose.turns.legacy_inflight` / `compose.turns.legacy_queued` (per-replica drain-gate signals surfaced through `/status`).
- `compose.turns.durable_queued`, `compose.turns.durable_running`, `compose.turns.durable_abandoned`.
- `compose.turns.lease_expired`, `compose.turns.lease_fence_rejected` (the latter is recorded as durable `turn.lease_fence_rejected` events and surfaced via `/status` as `turns.leaseFenceRejected`).

Follow-up items deferred to later phases:

- Redis-assisted turn-job wakeup remains optional; Phase 2 canonical state is DB polling plus lease fencing.
- Parked-turn expiry UX is shipped in the dashboard.
- Direct coordinator research/clarification dispatch through durable turn jobs is shipped behind Phase 9 flags.

---

## Phase 3 — Runtime Split and Worker Modes

- Plan section: `§6 Phase 3`; runtime enum `§12.1`.
- Work Order: `D — Runtime Modes` (plan `§34`).
- Status: PARTIALLY SHIPPED. App-code runtime selection and worker heartbeat inventory are wired in `server.ts`; Terraform now scaffolds disabled-by-default worker, research-worker, and conversion-worker ECS services.

Summary. Phase 3 splits the Spec Factory binary into runtime modes (`api`, `worker`, `research-worker`, optionally `conversion-worker`) sharing a single image and entrypoint (`src/spec-factory/main.ts:1`, `Dockerfile.spec-factory:33`). `all-local` remains for dev and for prod-until-cutover. `resolveSpecFactoryRuntime()` now selects which in-process loops start for each mode; production non-`all-local` modes stay gated on `SPEC_FACTORY_WORKSPACE_MANAGER=true` (or the temporary `SPEC_FACTORY_ALLOW_SPLIT_RUNTIME=true` compatibility override) until the ECS split lands.

Ship criteria:

- `SPEC_FACTORY_MODE` selects the process role; each mode boots only the processors it owns.
- Worker heartbeat + worker identity are visible in `spec_factory_worker_heartbeats` so stale-job runbooks can distinguish crashed workers from slow ones.
- Terraform `aws_ecs_service.spec_factory` remains the primary all-local/API service by default; optional split worker services are present with desired counts defaulting to `0`.

Prerequisites: Phase 2 (durable turn jobs) and Phase 1 (shared events + tokens). Do not enable production non-`all-local` modes until Phase 4.

Files added / changed (target):

- `src/spec-factory/main.ts` — mode dispatch.
- `src/spec-factory/bootstrap/api.ts`, `bootstrap/worker.ts`, `bootstrap/research-worker.ts`, optionally `bootstrap/conversion-worker.ts` (new).
- `terraform/spec-factory-ecs.tf` — optional `worker`, `research-worker`, and `conversion-worker` ECS service definitions gated by desired-count variables.

Migrations added: `063_spec_factory_worker_heartbeats.sql`.

Feature flags introduced:

- `SPEC_FACTORY_MODE=all-local|api|worker|research-worker|conversion-worker` (runtime selector, plan `§28` note).
- `SPEC_FACTORY_WORKSPACE_MANAGER=true` is the canonical split-mode gate; `SPEC_FACTORY_ALLOW_SPLIT_RUNTIME=true` remains a temporary compatibility override.

Metrics added:

- `/status` `composeControlPlane.workers` live/stale heartbeat totals plus `byMode` buckets for `all-local`, `api`, `worker`, `research-worker`, and `conversion-worker`.

Follow-up items deferred:

- Queue-depth autoscaling policy per role — deferred until observed queue growth justifies it. Terraform now provisions `spec_factory_worker_running_tasks_low` health alarms for enabled split worker services; the primary `spec_factory_running_tasks_high` alarm remains scoped to the primary all-local/API service until that service cuts over to `SPEC_FACTORY_MODE=api`.
- Local scratch attach in workers — Phase 4.

---

## Phase 4 — Workspace Manager

- Plan section: `§6 Phase 4`; contract `§13`.
- Work Order: `E — Workspace Manager` (plan `§34`).
- Status: SHIPPED. `ComposeWorkspaceManager.prepare`, session manifest writing, durable `compose_workspace_manifests` upsert, verified artifact writes, `attach`, `detach`, local scratch cleanup, and research-executor scratch attach/detach exist.

Summary. Phase 4 introduces a `WorkspaceManager` abstraction that owns attach / detach / hydrate / sync-back semantics before research workers exist. The shipped `ComposeWorkspaceManager` preserves the existing EFS-backed materialized workspace path, writes `session-manifest.json`, persists the latest derived manifest row in `compose_workspace_manifests`, can attach a durable workspace into local scratch, detach it, clean local scratch, and write verified artifacts through a temp-file protocol. The research executor now runs the Claude Agent SDK against an attached scratch copy and writes generated artifacts back to the durable workspace.

Ship criteria:

- `WorkspaceManager` interface owns attach / detach / hydrate / sync-back with a durable manifest per session/workspace.
- Existing `ComposeChatAgent` continues to run on the current materialized workspace path unchanged.
- Local-scratch hydration copies only required files; broad workspace copies remain opt-in per executor.
- Cleanup and retention hooks fire on session archive.

Prerequisites: Phase 3 (worker modes must be able to opt into local scratch).

Files added / changed (target):

- `src/spec-factory/workspace/workspace-manager.ts` (optional future split if `compose-workspace.ts` grows too large).
- `src/spec-factory/workspace/workspace-sync.ts` (future S3/object-store sync, if needed).
- `src/spec-factory/compose-artifact-gc.ts` (shipped; ties to cross-cutting artifact GC below).
- `src/spec-factory/compose-workspace.ts` — derives the workspace manifest file and optional durable sink payload.
- `src/spec-factory/compose-database.ts` — `upsertWorkspaceManifest` persists the latest manifest for active sessions.

Migrations added: `067_compose_workspace_manifests.sql`.

Feature flags introduced:

- `SPEC_FACTORY_WORKSPACE_MANAGER=true` when the abstraction goes hot; off in `all-local` for parity.

Metrics added:

- Workspace hydrate / sync latency, workspace bytes moved, workspace attach failures.

Follow-up items deferred: workspace snapshot / restore for turn replay — not scheduled.

---

## Phase 5 — Agent Task Queue and Capability Registry

- Plan section: `§6 Phase 5`; registry design `§14`.
- Work Order: `F — Agent Tasks and Capabilities` (plan `§34`).
- Status: PARTIALLY SHIPPED. `compose_agent_tasks`, lease recovery, `ComposeAgentTaskWorker`, worker heartbeat inventory, per-executor runtime-run ledger, executor registries for context tasks / research / critic / handoff, and the `legacy_compose_chat` turn adapter exist. Legacy chat fallback now runs through the named turn executor seam; remaining Phase 5 work is rollout/expansion of future specialist capabilities, not the legacy-chat boundary.

Summary. Phase 5 lands the generic durable specialist queue (`compose_agent_tasks`), capability registry, executor registry, and `compose_agent_runtime_runs` attempt ledger. The shipped queue has claim/lease/recovery semantics and capability-specific executors; the `legacy_compose_chat` adapter gives the live fallback turn path a named executor boundary while `ComposeService` still owns orchestration, workspace preparation, final-message fencing, and rollout-safe legacy queueing. Capabilities are named, executors are registered by `executor_type`, every task has its own lease and lifecycle events, and each worker attempt records a runtime run with terminal status plus optional provider/model/artifact/token/cost metadata.

Ship criteria:

- `compose_agent_tasks` exists with `capability`, `executor_type`, lease fields, and typed output JSON + artifact refs.
- Capability registry rejects unknown capabilities at enqueue time.
- Executor registry rejects unknown executor types at claim time.
- Status events (`task.*`) publish through the Phase 1 event pipeline.
- `compose_agent_runtime_runs` records every executor attempt and links it back to the owning `compose_agent_tasks` row.

Prerequisites: Phase 2 (job store patterns) and Phase 4 (workspace attach for research-executing capabilities).

Files added / changed (target):

- `src/spec-factory/agents/capability-registry.ts` (new).
- `src/spec-factory/agents/executor-registry.ts` (new).
- `src/spec-factory/agents/executors/agent-executor.ts` (new; base contract).
- `src/spec-factory/jobs/agent-task-store.ts` (new).
- `src/spec-factory/jobs/agent-task-processor.ts` (new).

Migrations added: `055_compose_agent_tasks.sql`, `064_compose_agent_runtime_runs.sql`.

Feature flags introduced:

- `SPEC_FACTORY_AGENT_TASKS=true` when the queue goes hot.

Metrics added (plan `§30.2`):

- `compose.agent_tasks.queued`, `compose.agent_tasks.completed`.
- Lease-lost / abandoned counters mirroring turn-job metrics, including durable `task.lease_fence_rejected` events surfaced via `/status` as `agentTasks.leaseFenceRejected`.

Follow-up items deferred:

- Additional specialist capabilities beyond code research and critic — Phase 11+.

---

## Phase 6 — Generated Research Sources

- Plan section: `§6 Phase 6`; contract `§18`; research worker `§23`.
- Work Order: `G — Generated Research` (plan `§34`).
- Status: PARTIALLY SHIPPED. Generated research source columns, Claude Agent SDK research executor, local-scratch workspace attach/detach, ingress split, value-driven redaction, tool allowlist validation, generated-source idempotency, and distillation enqueue hooks exist behind flags.

Summary. Phase 6 makes agent-generated research a first-class source. It extends `compose_session_sources` with a `generated_research` kind + `source_origin`, adds an artifact writer that captures the research report + evidence + tool trace (redacted), and ships a Claude Agent SDK research executor behind a feature flag. The executor hydrates a task-scoped local scratch workspace before the SDK run and detaches it afterward, while generated research artifacts are written to the durable session workspace.

Ship criteria (plan `§36 Agentic Research Foundation Done`):

- `compose_session_sources` accepts `kind = 'generated_research'` with `source_origin` populated.
- Research artifact writer stores structured artifact URIs; nothing is stored inside a DB transaction (plan `§35`).
- Tool allowlist is enforced before shell / tool execution.
- SDK traces are redacted at write time via `src/spec-factory/security/redaction.ts` (new).
- Research tasks are durable through Phase 5 agent-task queue and can run on a dedicated `research-worker` mode from Phase 3.

Prerequisites: Phase 5 (agent task queue), Phase 4 (workspace attach for repo access), Phase 3 (research-worker mode) — all required in production.

Files added / changed:

- `src/spec-factory/agents/research-executors.ts`.
- `src/spec-factory/security/redaction.ts`.
- `src/spec-factory/compose-database.ts` — new source-kind branches.
- Research artifact writer through `ComposeWorkspaceManager.writeArtifact`.

Migrations added: `056_compose_generated_sources.sql` for `compose_session_sources.source_origin`, generated-research metadata, context version, artifact checksum, and source provenance columns.

Feature flags introduced:

- `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk`.
- `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=true`.
- `SPEC_FACTORY_RESEARCH_MAX_COST_USD` (per-task research runner cap; default 3.0).
- `SPEC_FACTORY_RESEARCH_COST_CEILING_USD` (per-session numeric cap).
- `SPEC_FACTORY_RESEARCH_TASKS_PER_24H` (per-session rolling cap).
- `SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION` (per-session queued/running cap).
- `SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD`, `SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS`, `SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H` (optional global rolling caps).
- `SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED=true` to enqueue source-distillation tasks for generated research outputs.

Metrics added:

- `compose.research.runtime_seconds`, surfaced through `/status` as
  `composeControlPlane.research.avgRuntimeSecondsToday` and
  `.maxRuntimeSecondsToday` with running/completed/failed task counters.
- Tool-allowlist rejection counter (via redaction/security module).

Follow-up items deferred:

- Distillation of converted operator-added sources into context patches — Phase 7 (feature flag `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION`); generated research uses `SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED`. Both enqueue hooks exist, with task execution handled by the shared agent-task worker.
- Coordinator-driven research dispatch — Phase 9 (shipped behind durable-turn, research-executor, and budget gates).
- Further Bash allowlist expansion is operator-controlled; the shipped default remains read-only `Read` / `Grep` / `Glob` plus safe `rg` alias.

---

## Phase 7 — Source Distillation, Context Patches, Context Versions

- Plan section: `§6 Phase 7`; storage `§8` / `§19`; two-phase protocol `§20`.
- Work Order: `H — Context Versions` (plan `§34`).
- Status: PARTIALLY SHIPPED. Context patch/version tables, source distillation executor, context merge executor, checksummed artifact writes, latest-context pointer updates, the latest-context projection endpoint, and dashboard context version/status projection exist behind flags or API data. Source distillation uses the deterministic extractor by default and can opt into LLM Gateway-backed structured extraction with `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=true` plus `SPEC_FACTORY_LLM_GATEWAY=true`. Context merge is deterministic by default and can opt into LLM Gateway-backed semantic synthesis with `SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=true`; backend code still owns version, source, and patch identity fields. `ComposeService` now projects a conservative readiness view from the latest committed context for session reads when legacy readiness is absent; removing the legacy JSON column remains pending.

Summary. Phase 7 introduces canonical, versioned Working Context. A distillation agent turns each committed source (operator upload or generated research) into a context patch and records best-effort `source.distillation.started`, `context.patch.created`, and `source.distillation.completed` durable events. The context merger records `context.merge.started`, then commits a new `compose_context_versions` row via a two-phase artifact protocol (artifact written to durable store first, checksum + byte count verified, then DB pointer updated) and records `context.updated`; patch-level conflicts are preserved in the committed Markdown and structured context sidecar instead of being silently dropped. Patch creation and version commit both lock an active `compose_sessions` row before mutating their durable tables, so archive races cannot create authoritative context artifacts for archived sessions. Source creation/deletion, conversion claiming, source-status mutations, context-dirty/reset updates, and handoff linking require an active parent session before creating sources, executing work, mutating lifecycle state, or handing off the session. `compose_sessions.latest_context_version` becomes the read pointer for every chat turn.

Bounded-context hardening compacts oversized multi-chunk distillation patches
before v4 schema validation, compacts aggregate section overflow across source
provenance while protecting user/message-backed claims, and marks a reserved
context version `failed` when executor work aborts. This prevents deterministic
retry spend and orphaned `building` versions without weakening the strict
reducer used by non-runtime callers.

Ship criteria (plan `§36 Context Foundation Done`):

- Sources produce context patches through the distillation agent.
- Context merge commits a versioned row per successful merge.
- Latest context pointer updates only after the artifact exists in durable storage.
- Context artifacts carry verified checksum and byte count.
- Readiness (`compose_sessions.readiness`) becomes a projection of the latest committed context, not a mutable free-form field.

Prerequisites: Phase 6 (generated sources) and Phase 5 (task queue for distillation tasks) and Phase 4 (workspace / durable artifact store).

Files added / changed:

- `src/spec-factory/agents/context-executors.ts`.
- `src/spec-factory/compose-agent-task-worker.ts`.
- `src/spec-factory/compose-database.ts` — new stores for `compose_context_patches`, `compose_context_versions`, the `latest_context_version` pointer, and `getLatestContextProjection`; committed projections include patch-level conflicts.
- `src/spec-factory/compose-routes.ts` — `GET /sessions/:sessionId/context` returns the latest committed `ComposeContextProjection | null`.
- `src/spec-factory/compose-service.ts` — `listSessions`, `getSession`, and `resumeSession` preserve stored readiness when present and otherwise synthesize readiness from `compose_context_versions.summary_json` / `open_questions_json`.
- `dashboard/src/spec-factory/compose/*` — session summaries project `latestContextVersion` and `contextStatus` in the session picker and active-session toolbar; the workspace still has the explicit committed-context endpoint as a fallback.

Migrations added: `057_compose_context_versions.sql`, `065_compose_context_version_conflicts.sql`.

Feature flags introduced:

- `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=true`.
- `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=true` (requires `SPEC_FACTORY_LLM_GATEWAY=true`; optional `SPEC_FACTORY_CONTEXT_DISTILLATION_MAX_COST_USD` and `SPEC_FACTORY_CONTEXT_DISTILLATION_TIMEOUT_MS` bound the gateway call).
- `SPEC_FACTORY_ENABLE_CONTEXT_MERGE=true`.
- `SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=true` (requires `SPEC_FACTORY_LLM_GATEWAY=true`; optional `SPEC_FACTORY_CONTEXT_MERGE_MAX_COST_USD` and `SPEC_FACTORY_CONTEXT_MERGE_TIMEOUT_MS` bound the gateway call).

Metrics added:

- `compose.context_versions.committed`.
- `compose.context_versions.failed`.
- `/status` `composeControlPlane.context` patch backlog and UTC-day version
  counters.

Follow-up items deferred:

- Complete deletion of `compose_sessions.readiness_json` and the legacy writer contract — later cutover. Service-level projection, session-level context version/status, and the dashboard fallback projection are shipped.
- Retention policy for old context versions — Cross-cutting workstreams.

---

## Phase 8 — LLM Gateway

- Plan section: `§6 Phase 8`; interface `§15`.
- Work Order: `I — LLM Gateway` (plan `§34`).
- Status: PARTIALLY SHIPPED. `llm-gateway.ts`, `llm-audit.ts`, redacted audit artifacts, purpose-scoped direct Bedrock Converse routing, native JSON-schema output, the Claude Agent SDK rollback transport, normalized `streamText` fallback events, bounded transient retries, static + DB-backed `prompt-registry.ts`, durable `spec_factory_prompt_versions`, and Terraform-wired optional gateway/research budget ceilings exist. Product call paths are still limited, and tenant-specific default decisions remain pending.

Summary. Phase 8 centralizes every direct LLM call behind an `LlmGateway` interface with a Bedrock-only adapter, a purpose/capability model router, structured-output support, streaming normalization, retries, budgets, rate handling, and a `spec_factory_llm_calls` audit table. Current `streamText` normalizes the existing audited text-generation path into `{type:'text'}` then `{type:'done'}` async-iterable events; provider-native token streaming can replace the fallback later without changing callers. Current shipped callers validate supplied prompt versions through `prompt-registry.ts` before provider execution; unknown or purpose-mismatched `purpose@vN` values fail before a paid call or audit row. `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=db` switches validation/default resolution to `spec_factory_prompt_versions`.

Ship criteria:

- `LlmGateway` fronts every non-SDK direct model call in Spec Factory.
- Bedrock provider adapter is the only provider (plan `§35`: no OpenAI/Anthropic adapters until Bedrock-only surface is stable and a real requirement exists).
- Model router selects models by purpose/capability, not by hardcoded literals in business logic.
- Structured output is supported end to end and validated before caller sees a response.
- Retries and rate handling are enforced inside the gateway; optional session/global daily budget ceilings deny before provider execution when configured, and budget denials are logged (plan `§30.4`).
- Prompt registry resolves `purpose@vN` before dispatch and stores source + active version + changelog + schema expectations. The in-code registry remains the default; `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=db` enables durable storage.

Prerequisites: Phase 7 (context versions) and Phase 2 (durable turn jobs). Phase 9 depends on this.

Files added / changed:

- `src/spec-factory/llm/llm-gateway.ts`.
- `src/spec-factory/llm/bedrock-converse-provider.ts`.
- `src/spec-factory/llm/llm-audit.ts`.
- `src/spec-factory/llm/prompt-registry.ts`.
- `src/spec-factory/security/redaction.ts` — extended by gateway audit path.

Migrations added: `058_spec_factory_llm_calls.sql`; `061_spec_factory_llm_calls_budget_index.sql`; `062_spec_factory_prompt_versions.sql`.

Feature flags introduced:

- `SPEC_FACTORY_LLM_GATEWAY=true`.
- `SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES=<csv>` routes selected tool-free purposes through direct Bedrock Converse. The initial production canary is `chat_coordinator_fast`; removing it returns that purpose to the SDK transport.
- `SPEC_FACTORY_LLM_PROMPT_LOGGING=none|redacted|full` (default `redacted`; `full` requires `SPEC_FACTORY_LLM_SECURE_DEBUG=true` and is rejected when `NODE_ENV=production`, plan `§30.5`).
- `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE` (optional filesystem root for redacted/full prompt-response audit artifacts; unset leaves audit artifact URIs null while preserving usage rows).
- `SPEC_FACTORY_LLM_SECURE_DEBUG=true` (non-production only; explicit gate for unredacted prompt/response audit artifacts).
- `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=static|db` (default `static`; `db` uses `spec_factory_prompt_versions`).
- `SPEC_FACTORY_LLM_MAX_ATTEMPTS` (default `3`; transient throttling/429/5xx/timeout retries).
- `SPEC_FACTORY_LLM_RETRY_BASE_MS` (default `25`; linear retry backoff base).
- `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS` and optional purpose-specific `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_<PURPOSE>` overrides; caller requests above the effective cap fail before provider execution.
- `SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD` (optional).
- `SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD` (optional).

Metrics added (plan `§30.2`):

- `compose.llm.tokens.input` / `compose.llm.tokens.output`.
- `compose.llm.cost_usd` (session/day cap alarm gate, `§30.4`; sourced from `spec_factory_llm_calls.estimated_cost_usd`).
- `/status` `composeControlPlane.llm` UTC-day audit summary for calls, failures, tokens, cost, and latest call time.

Follow-up items deferred:

- Session/day/global budget ceilings are env-configurable through Terraform and fail closed when manual or coordinator research enqueue needs a per-session ceiling; tenant-specific defaults wait for a real tenant identifier.
- Additional providers (OpenAI/Anthropic direct) — explicitly deferred until Bedrock-only is stable (plan `§35`).

---

## Phase 9 — Stateless Chat Coordinator

- Plan section: `§6 Phase 9`; coordinator `§21`; legacy compatibility `§22`.
- Work Order: `J — Chat Coordinator` (plan `§34`).
- Status: PARTIALLY SHIPPED; answer routing plus `code_research` / `config_research` / `devops_research` dispatch and durable park/wake fan-in behind flags.

Summary. Phase 9 replaces the legacy `ComposeChatAgent` primary path with a stateless Chat Coordinator that reads a context bundle (Working Context version + selected source summaries + open questions), decides between answer / clarify / dispatch, and delegates code-current-implementation questions to Phase 6 research tasks. Legacy `ComposeChatAgent` remains as a fallback executor. `claude_session_id` is no longer product memory.

Current slice. `src/spec-factory/agents/chat-coordinator.ts` contains the typed `CoordinatorDecision` schema, backend-owned context bundle builder, prompt contract, and LLM Gateway-backed `ChatCoordinator.decide()` runner; `src/spec-factory/agents/chat-coordination-executor.ts` exposes it through the named `chat_coordination` turn-executor seam. `createSpecFactoryChatCoordinator()` is dormant unless both `SPEC_FACTORY_LLM_GATEWAY=true` and `SPEC_FACTORY_CHAT_COORDINATOR=true`. When injected, `ComposeService` can persist coordinator `answer` decisions through the same final-message fencing used by legacy turns, using the backend-frozen context bundle version as durable provenance. `escalate` decisions are now terminal policy-denied assistant finals, fenced through the same write path and accompanied by a durable `policy_denied` event, so they no longer fall through to `ComposeChatAgent`. `dispatch_research` is durable-only: it requires `SPEC_FACTORY_DURABLE_TURNS=drain|on`, `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk`, an active turn lease, and passing session budget/quota gates before `code_research`, `config_research`, or `devops_research` tasks are inserted. Durable dispatch is fenced by the active turn lease, parks the turn in `waiting_on_research`, and requeues it only while `attempt_count < max_attempts` when linked research tasks complete, fail terminally, or are abandoned by lease recovery. If durable-worker prerequisites or budget gates are unavailable, the turn falls back to `ComposeChatAgent` instead of creating orphaned `turn_job_id=NULL` tasks. On wake, `executeClaimedTurn` re-enters the coordinator path with the original user message, and the context bundle carries bounded `generated_research` Markdown plus linked task status/error history for synthesis. Durable `ask_clarification` writes a question and parks the same turn in `awaiting_user_input`. Migration `076_compose_clarification_answer_history.sql` stores each answer round's idempotency key on its transcript row, so multiple questions can reuse the same durable turn while delayed retries remain bound to the original answer. The durable turn worker expires stale parked turns, abandons them, and publishes `turn.clarification_expired`. Unsupported non-research capabilities and coordinator errors still fall back to `ComposeChatAgent`.

Organization-aware conversation context. The versioned
`mhk-organizational-context.md` resource is bundled into the production image.
`chat_coordinator@v2` always injects its operating/evidence baseline and
deterministically retrieves bounded relevant sections. The legacy SDK path uses
the same bounded prompt context and receives the complete document as a
runtime-materialized workspace reference. The shared application asset is
intentionally excluded from session-owned immutable manifests and DSR scope.
Migration
`077_spec_factory_chat_coordinator_org_context_v2.sql` registers the v2 prompt
before DB-backed prompt-registry deployments begin emitting it.

Ship criteria (plan `§36 Coordinator Done`):

- Coordinator answers from the context bundle for direct-context turns.
- Coordinator can dispatch research tasks and synthesize their results.
- Coordinator can park a turn for clarification without stale requeue.
- Legacy agent is a fallback executor, not the primary path.
- `claude_session_id` is not required for product continuity anywhere in the codebase.

Prerequisites: Phase 8 (LLM Gateway), Phase 7 (context versions), Phase 6 (research), Phase 5 (task queue), Phase 2 (durable turns).

Files added / changed (target):

- `src/spec-factory/agents/chat-coordinator.ts` (new).
- `src/spec-factory/session/context-builder.ts` (new).
- Coordinator decision schema (typed).
- `src/spec-factory/compose-service.ts` — migration router with legacy fallback before coordinator invocation.
- Cleanup of `claude_session_id` reads across the codebase.

Migrations added: `060_compose_clarification_answers.sql` introduced the parked-turn answer fields; `076_compose_clarification_answer_history.sql` adds per-answer idempotency history for multi-round clarification. Coordinator decisions are audited through durable `compose_session_events` (`turn.completed`, `task.queued`, `turn.awaiting_user_input`, and `coordinator.decision.rejected`) and surfaced through `/status`.

Feature flags introduced:

- `SPEC_FACTORY_CHAT_COORDINATOR=true`.
- `SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN=3` (default; per plan `§28`).
- `SPEC_FACTORY_COORDINATOR_MAX_COST_USD` (optional; defaults to `0.25` when LLM Gateway cost ceilings are enabled).

Metrics added:

- Coordinator decision-type distribution counters surfaced via `/status` as `composeControlPlane.coordinator.decisionsToday.answer`, `.dispatchResearch`, `.askClarification`, `.escalate`, and `.rejected`.
- Turn-outcome counters tied to context version used, surfaced via `/status` as `composeControlPlane.turns.outcomesByContextVersionToday[]`.

Follow-up items deferred:

- Parked-turn expiry UX is shipped: `turn.clarification_expired` publishes `code="clarification_expired"`, `ComposeWorkspace` shows the toolbar error, and `ChatPanel` keeps an inline composer-adjacent alert until the user sends a fresh message or opens another session.
- Full removal of legacy executor path — post-Phase 9, once error/latency parity is verified.

---

## Phase 10 — Handoff Bundle and Draft Pipeline Enrichment

- Plan section: `§6 Phase 10`; handoff builder `§25`.
- Work Order: not lettered explicitly in plan `§34`; owned by the coordinator team downstream of Work Order J.
- Status: FEATURE-FLAGGED SHIPPED. `src/spec-factory/agents/handoff-builder.ts` now builds deterministic Markdown + JSON handoff bundles and exposes the `handoff_build` agent-task executor. `ComposeService.handoff` can use its bounded summary and persists `handoff/handoff-v1.md` plus `handoff/handoff-v1.json` into the session workspace before creating a Spec Factory evidence snapshot when `SPEC_FACTORY_HANDOFF_ENRICHED=true`; with `SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true`, the route queues the worker executor to own artifact, evidence-snapshot, draft-generation work, and terminal `handoff.completed` / `handoff.failed` events. The queued executor confirms the active agent-task lease before each artifact, evidence-snapshot, and draft-generation side effect, so archive cancellation stops stale handoff workers before they advance outputs. With `SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS=true` and `SPEC_FACTORY_LLM_GATEWAY=true`, the queued executor calls LLM Gateway purpose `handoff_synthesis@v1` to add executive summary, implementation brief, evidence map, and open-question fields to the persisted Markdown/JSON artifacts before evidence snapshot creation.

Summary. Phase 10 improves the Compose-to-draft handoff quality. The handoff builder assembles a bundle from the latest known session context, including selected source summaries, generated research, decisions, and open questions. The shipped slice writes a richer bounded `source_summary` to the synthetic `COMPOSE-<sessionId>` source, persists Markdown/JSON artifacts through the two-phase workspace writer, creates an evidence snapshot that points at those artifacts, and preserves the existing draft job path (Louise / Jira pipeline in `src/spec-factory/routes.ts` and downstream). The queued executor uses the same bundle and manifest helpers so the opt-in worker path does not fork the handoff evidence format. `DraftGenerator` recognizes `handoff-v1.md` / `handoff-v1.json` in the evidence manifest and prompts the drafting agent to read those artifacts before generic attachments.

Ship criteria:

- Handoff summary is built from the guarded session plus converted/generated source metadata.
- `COMPOSE-<sessionId>` source contains a richer bounded summary.
- Markdown and JSON bundle artifacts are persisted before draft generation is queued.
- Evidence snapshot contains the handoff artifact references.
- Existing draft-generation path continues to work end to end.

Prerequisites: none for deterministic service-side enrichment. The queued deterministic executor depends on Phase 5 agent tasks and Phase 4 workspace artifact writes. LLM-authored handoff narrative fields still depend on Phase 8/9 rollout maturity.

Files added / changed:

- `src/spec-factory/agents/handoff-builder.ts` — deterministic bundle/summary builder.
- `src/spec-factory/compose-service.ts` — feature-flagged handoff summary enrichment, queued handoff task scheduling, workspace artifact writes, and evidence snapshot creation.
- `src/spec-factory/server.ts` — routes new handoffs through `handoff_build` when `SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true`, registers handoff and critic executors whenever a worker claims their capability, and fails startup when any claimed capability lacks its executor.
- `src/spec-factory/evidence.ts` — optional artifact URI fields for persisted handoff artifacts.

Migrations added: none; the artifact references live in `spec_factory_evidence_snapshots.artifacts_json`.

Feature flags introduced: `SPEC_FACTORY_HANDOFF_ENRICHED=true` enables bounded source-summary enrichment plus deterministic handoff artifact persistence. `SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true` routes artifact/evidence/draft generation through the queued `handoff_build` executor. `SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS=true` enables worker-only narrative generation and requires `SPEC_FACTORY_LLM_GATEWAY=true`; `SPEC_FACTORY_HANDOFF_SYNTHESIS_MAX_COST_USD` and `SPEC_FACTORY_HANDOFF_SYNTHESIS_TIMEOUT_MS` bound that gateway call.

Metrics added: the durable `handoff.completed` event now includes `artifactBytes.markdown`, `artifactBytes.json`, and `artifactBytes.total` when enriched handoff artifacts are written. In queued mode, `ComposeService.handoff` emits `task.queued` and the `handoff_build` worker emits the terminal `handoff.completed` / `handoff.failed` event after artifact/evidence/draft work succeeds or fails, making success/failure counters derivable from the session event stream.

Follow-up items deferred:

- Longer-term draft-learning from accepted/rejected Jira output and operator edits remains post-Phase 10.

---

## Phase 11 — Optional Specialists and Critic

- Plan section: `§6 Phase 11`; specialists `§14` / `§21`.
- Work Order: not lettered explicitly in plan `§34`; downstream of `F`/`I`/`J`.
- Status: PARTIALLY SHIPPED; `critic_review` executor and product-path scheduling exist behind `SPEC_FACTORY_ENABLE_CRITIC=true` plus `SPEC_FACTORY_LLM_GATEWAY=true`. Successful, non-deduplicated assistant finals enqueue non-blocking critic tasks. Config Research and DevOps Research now reuse the generated-research executor; Architect remains deferred until observed demand justifies it.

Summary. Phase 11 adds the Critic Agent through the LLM Gateway, and optionally Architect capabilities on demand. Config Research and DevOps Research are now first-class research-family capabilities dispatched through the Phase 5 capability registry and executed by the hardened generated-research executor; the shared SDK runner uses capability-specific stages and guidance so config/devops tasks do not inherit code-only prompts. Specialists are not free-form chat participants (plan `§35`). The current Critic slice validates structured review input, schedules reviews after successful assistant finals, calls the LLM Gateway with `purpose='critic_review'`, and writes structured review output back through `compose_agent_tasks.output_json`.

Ship criteria:

- Critic Agent exists as a first-class capability behind `SPEC_FACTORY_ENABLE_CRITIC=true` and `SPEC_FACTORY_LLM_GATEWAY=true`.
- Architect capability exists only after observed demand justifies it; Config Research and DevOps Research already ship through the research-family executor.
- No agent participates in the chat surface directly; all specialist output flows through the coordinator.

Prerequisites: Phases 5, 6, 7, 8, 9.

Files added / changed (target):

- `src/spec-factory/agents/critic-agent.ts` (new).
- Additional capability implementations only if scheduled.

Migrations added: none unless critic-output tables are needed.

Feature flags introduced:

- `SPEC_FACTORY_ENABLE_CRITIC=true`.
- `SPEC_FACTORY_CRITIC_MAX_COST_USD` (optional per-call cap).
- `SPEC_FACTORY_CRITIC_TIMEOUT_MS` (optional per-call timeout).
- Per-specialist flags only when the specialist is scheduled.

Metrics added: per-capability queue depth and terminal counters surfaced via `/status` as `composeControlPlane.agentTasks.byCapability.<capability>`; LLM cost attribution is surfaced via `composeControlPlane.llm.byPurposeToday.<purpose>` and remains queryable in `spec_factory_llm_calls`.

Follow-up items deferred: further specialists are opt-in; do not batch-schedule.

---

## Scale and Reliability v4 — Work Order B: latency truth

Status: IMPLEMENTED. This work order adds the production observability baseline
required before direct-provider and distributed-queue changes.

Files added / changed:

- `src/spec-factory/telemetry/*` owns request correlation, HTTP middleware,
  OpenTelemetry initialization, spans, and bounded metric instruments.
- API request IDs propagate through Pino logs and durable processing, source,
  turn, task, event, and LLM-audit rows. Durable workers restore the original
  request context after process handoff.
- Turn, agent-task, conversion, and draft workers record current queue-entry age,
  attempt duration, terminal outcome, lease expiry, and fence rejection.
- The LLM Gateway records purpose/provider/model latency, tokens, cost,
  success/failure/throttle outcomes; coordinator routing records selected,
  rejected, and legacy-fallback decisions.
- Every Spec Factory ECS task includes an optional CloudWatch Agent OTLP
  sidecar. Terraform provisions the `<environment>-spec-factory` percentile
  dashboard, four p95 latency alarms, and a coordinator success-rate alarm.

Migration added:

- `068_spec_factory_correlation_ids.sql` adds nullable indexed `request_id`
  columns without rewriting existing rows. The migration is expand-only and
  idempotent for staged deployment.

Metrics added:

- `spec_factory.work.*`, `spec_factory.provider.*`,
  `spec_factory.coordinator.*`, `spec_factory.http.*`, and
  `spec_factory.lease.events`.
- Dimensionless `spec_factory.slo.*` histograms/counters are the stable alarm
  contract; identifiers remain in logs, traces, and durable rows only.

Rollout gate: apply migration 068 before deploying the application image, then
confirm the sidecar starts and the four p95 series receive datapoints before
arming notifications or using the dashboard as a release gate.

---

## Scale and Reliability v4 — Work Order C: direct Bedrock provider

Status: IMPLEMENTED; production canary pending. Tool-free LLM Gateway calls can
now bypass Claude Agent SDK process and scratch-repository initialization via a
purpose-scoped Bedrock Converse transport.

Files added / changed:

- `src/spec-factory/llm/bedrock-converse-provider.ts` owns Converse request,
  timeout, native JSON-schema output, token usage, and cost estimation.
- `src/spec-factory/llm/llm-gateway.ts` retains budget, prompt-registry, audit,
  retry, redaction, and metric ownership while routing configured purposes to
  the direct transport.
- `SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES` is fail-fast validated and exposed
  on primary and split-worker ECS task definitions.
- Coordinator provenance is backend-owned: the frozen bundle version replaces
  any LLM-authored `contextVersionUsed` value after decision validation.

Initial rollout: route only `chat_coordinator_fast`, run single-session and
concurrent canaries, compare p50/p95/provider failures against the Work Order B
baseline, then add other tool-free purposes individually. Removing a purpose
from the CSV returns it to the Agent SDK transport without changing durable
state. Research remains on Claude Agent SDK because it requires tools.

Migrations added: none.

---

## Requirements Workspace — Work Order V

Status: IMPLEMENTED; deployment and browser certification pending.

Summary. Compose now centers the session on requirements rather than
implementation decisions. New sources continue directly into the existing
conversion/distillation/context pipeline, and the dashboard no longer exposes
Analyze Sources or repository selection. Once a problem statement exists, an
inline consent prompt can queue code research; repository grounding and
workspace attachment happen behind the service boundary. User-facing questions
are filtered to business/functional clarification at model, persistence,
service, and client boundaries.

The Sources rail now includes a separate Artifacts section for committed
context, problem, solution, business and functional requirements, challenges,
stories, conversation decisions, and generated research. The context summary
above chat is removed. Sources, Requirements, Research, and Draft markers are
derived from authoritative workflow state. Context/handoff schemas carry the
new requirements fields, and the draft validator normalizes Epic and child
acceptance criteria to full Gherkin. Context repair reuses ready/approved drafts
instead of regenerating them. Spec Factory repository cache startup now probes
a dedicated writable EFS path before workers accept tasks.

Migrations added: none. The fields are stored in existing JSON context/readiness
and immutable handoff artifacts.

Terraform changes: enable the shipped context-merge and enriched handoff/draft
paths and set a dedicated Spec Factory repository cache path for primary and
research-capable workers.

Acceptance contract: [`requirements-workspace.md`](./requirements-workspace.md).

---

## Cross-cutting workstreams

These do not map to a single phase but must land alongside the phases indicated.

### Retention and Artifact GC (Work Order K)

- Plan section: `§34 Work Order K`; retention behavior `§30.4`.
- Status: PARTIALLY SHIPPED. Archived workspace/S3 cleanup already exists in `compose-retention.ts`; the same sweep purges expired stream tokens and stale `spec_factory_worker_heartbeats` rows; `compose-artifact-gc.ts` removes stale `.tmp` entries under `COMPOSE_WORKSPACE_BASE` with dry-run, age, limit, and depth controls; `compose-s3-reachability-gc.ts` optionally purges S3 objects under `COMPOSE_S3_PREFIX` that are outside every live `compose_sessions.s3_prefix`; `llm-audit-retention.ts` deletes file-backed LLM prompt/response audit artifacts under `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE` and clears DB URIs only after the delete succeeds; `compose-hard-delete.ts` adds an archived-session-only DSR hard-delete with dry-run, exact confirmation, artifact-root validation, and FK-safe DB cascade. `/status` now surfaces `composeControlPlane.retention.pendingWorkspaceCleanup`, `.failedWorkspaceCleanup`, `.oldestPendingArchivedAt`, `.latestCleanupErrorAt`, `.pendingLlmAuditArtifacts`, and `.oldestPendingLlmAuditArtifactAt` for cleanup backlog alerting.
- Landing point: alongside Phase 4 (workspace) at earliest; must ship before Phase 6 generated research goes to prod because generated artifacts create new orphan-risk paths.

Deliverables:

- Retention policy module owning per-artifact-class TTLs.
- Orphan temp artifact scanner over EFS paths and optional S3 reachability scan under `COMPOSE_S3_PREFIX`.
- DSR / hard-delete cascade for every new table and artifact URI introduced in Phases 1-8. Implemented for Compose session child tables and session-root artifacts; downstream `spec_factory_sources` / draft DSR remains separate.
- Audit logs and dry-run mode for every deletion path.
- `/status` archived-workspace cleanup backlog counters for pending and failed retention work.

Follow-up: tune retention defaults per environment after production volume is measured. Current code defaults to 30-day archived workspace retention, 7-day worker-heartbeat retention, 24-hour temp artifact retention, 30-day file-backed LLM audit artifact retention, dry-run-capable cleanup, and optional S3 reachability GC.

### Observability, SLOs, and alerts

- Plan section: `§30`.
- Status: PARTIAL — Phase 0 keeps existing Compose logs; each subsequent phase adds its own metrics as listed above.

Rollout gates before Phase 2, Phase 6, and Phase 8 enable outside dev (plan `§30.4`):

- Durable turn claim latency p95 < 5s for queued chat turns.
- Duplicate final assistant messages = 0.
- Lost durable events = 0 in replay audit.
- Lease-lost final-write attempts = 0 successful writes.
- Research task abandoned rate < 1% outside explicit worker restarts.
- LLM/coordinator budget denials visible in logs / metrics.

Initial alerts to arm as each phase ships:

- Running turn lease expired without retry/abandon within two lease windows (Phase 2).
- `legacy_inflight > 0` during drain for more than the configured drain timeout (Phase 2).
- `compose.events.publish` failures after DB insert (Phase 1).
- `compose.turns.duplicate_suppressed` above normal retry baseline (Phase 2).
- `compose.llm.cost_usd` above session/day cap threshold (Phase 8/9).
- Artifact GC backlog growing for more than one retention interval (Cross-cutting retention).

### Security and redaction

- Plan section: `§31`; redaction module `§29.2`.
- Status: SHIPPED — `src/spec-factory/security/redaction.ts` is used by research traces and LLM audit artifacts.

Non-negotiables (plan `§35`):

- Never store raw Claude SDK traces or unredacted prompt artifacts.
- All paths must be rooted under session workspace; no path traversal in workspace operations.
- Research workers must not run arbitrary shell commands; tool allowlist is enforced before execution.

### Terraform and infra shape changes

- Plan section: `§12` (runtime), `§13` (workspace).
- Status: SCAFFOLDED for Terraform/ECS split; app-code runtime selection, workspace attach helpers, and disabled-by-default worker/research/conversion ECS services are present. Today the primary service still owns active production traffic and keeps the single-replica alarm until the API/worker cutover is explicit. Terraform now exposes the shipped Phase 5-11 feature flags and caps on both the primary and split worker task definitions with safe defaults, so staged rollout does not require manual ECS task-definition edits.

Landing points:

- Phase 1/3 turns the CloudWatch alarm `spec_factory_running_tasks_high` off after live fanout, durable turns, and the primary service runs `SPEC_FACTORY_MODE=api`. Split worker services already have scoped running-task health alarms when their desired counts are raised.
- Phase 3 raises the disabled worker-service desired counts in rollout order, watches `spec_factory_worker_running_tasks_low`, then disables the primary single-replica alarm only after legacy all-local execution is gone.
- The split-worker ECS task definitions now expose the shipped turn-worker, agent-task-worker, and LLM Gateway purpose-routing knobs with code-default values. Turn and agent-task worker IDs derive from the hostname-aware `SPEC_FACTORY_WORKER_ID` plus queue-specific suffixes, avoiding PID-only `active_worker_id` collisions when Fargate runs more than one worker task.

---

## Resolved decisions and remaining open item

These decisions mirror plan `§38` and are updated as the implementation lands.

Resolved:

1. Archived sessions are hidden from normal get/list/stream/message routes. DSR deletion uses the explicit hard-delete service and requires the session to already be archived.
2. `ActorContext.roles` uses `SPEC_FACTORY_ADMIN_IDS` as the authoritative Phase 0 admin source.
3. Stream tokens are DB-backed in `compose_stream_tokens`, stored as SHA-256 hashes, revoked before archive commits, and purged by the retention cleaner after TTL.
4. SSE replay uses the global `compose_session_events.id` cursor, emits `id:` lines, honors `Last-Event-ID`, and bridges replay to live fanout with duplicate suppression.
5. Turn jobs and agent tasks use MySQL as the durable queue. Redis can be added later only as a wakeup/cache assist, not as canonical turn state.
6. Context and audit artifacts use MySQL metadata plus S3/EFS artifact bodies; active executors use local scratch where needed.
7. Research workers default to read-only `Read`, `Grep`, and `Glob`; the safe `rg` alias normalizes to the SDK `Grep` tool; Bash is fail-closed unless explicitly enabled with anchored, metacharacter-free command patterns.
8. LLM and research budgets are enforced at the gateway and research-enqueue layers with per-turn, per-session, 24h, and optional global env-configurable ceilings.
9. Prompt registry storage is `spec_factory_prompt_versions`; static registry mode remains available for local/dev and DB bootstrap failure isolation.
10. Clarification expiry UX is shipped in the dashboard and no longer blocks Phase 9 rollout.
11. `compose_session_events.turn_job_id` and `agent_task_id` are FK-backed with `ON DELETE SET NULL`; `context_version` remains a semantic snapshot correlation.

Remaining open item:

12. Vector retrieval status: keep out of the v1 coordinator contract until a provider, interface, rollout phase, and tests are selected.

Cross-links: [README](./README.md), [architecture](./architecture.md), [operations](./operations.md), [testing conventions](./dev-guide.md#testing-conventions).
