# Spec Factory documentation index

Spec Factory is the Specter platform's spec intake and drafting service. It
exposes two intake lanes: Compose (interactive multi-turn sessions with uploads,
transcripts, context, and repository grounding) and Louise (Jira intake). Both
lanes converge on durable draft workflows that produce Jira Epics/Stories and
can hand off to OneShot. This directory describes the implemented repository
contracts and the operator-controlled rollout required to activate them.

> **Canonical plan:** The [v4 scale, correctness, and experience plan](../superpowers/spec-factory/spec_factory_scale_and_reliability_plan_v4.md) supersedes v3 for runtime topology, queue dispatch, context, handoff/draft durability, scale, experience, and rollout. Repository state never proves deployed state; use the environment certification and rollout evidence for that decision.

## V4 implementation snapshot

- MySQL is authoritative for sessions, frozen turn context, leases, events,
  outbox rows, queue receipts, handoffs, draft stage runs, and repair reports.
- SQS is the wake-up plane through a transactional outbox. Consumers are
  receipt-fenced and support visibility heartbeats, quarantine, DLQ redrive,
  and repair of acknowledged-but-unclaimed work.
- The runtime is split into API, turn, context, research, conversion, draft,
  event-relay, retention, and compatibility worker services. Each role has a
  scoped image, IAM role, secrets, queue, heartbeat capabilities, and scaling
  policy.
- S3 content-addressed artifacts and manifests are canonical. In the
  legacy-disabled configuration, mutable EFS session state is not mounted.
- Working Context v4 is cumulative, bounded, revision/chunk aware, and preserves
  message/source provenance and explicit removals.
- Handoff snapshots and draft workflows are immutable, correlated, leased, and
  resumable. Jira publish and OneShot submission are durable stages.
- The dashboard reads authoritative workflow state and supports cancellation,
  retry, stale-state display, durable replay, and correlated events.
- Compose is requirements-first: sources process automatically, only business
  and functional clarifications reach users, code research requires consent,
  generated outputs appear as Artifacts, and draft criteria use Gherkin.
- Migrations `069`-`073`, Terraform, repair tooling, certification manifests,
  k6 load scenarios, startup removal gates, and CI checks are included but must
  be executed through the rollout runbook.

Older phase-by-phase passages in this documentation remain useful history. When
they conflict with this snapshot or the v4 plan, the v4 contract wins.

## Table of contents

- [Two intake lanes](#two-intake-lanes)
- [Requirements-first experience](./requirements-workspace.md)
- [Documents in this directory](#documents-in-this-directory)
- [Status snapshot](#status-snapshot)
- [Glossary](#glossary)
- [Repository layout for this service](#repository-layout-for-this-service)
- [Phased roadmap at a glance](#phased-roadmap-at-a-glance)
- [Key invariants](#key-invariants)
- [Data-plane touchpoints](#data-plane-touchpoints)
- [Reading paths for common tasks](#reading-paths-for-common-tasks)
- [How to contribute](#how-to-contribute)
- [For coding agents](#for-coding-agents)
- [Change tracking for this index](#change-tracking-for-this-index)

## Two intake lanes

Spec Factory has two intake lanes that persist different shapes of source material and converge on the same downstream draft/Jira/OneShot pipeline. The ASCII diagram below is copied from plan §1 and is the canonical shape of the system today:

```text
                         ┌───────────────────────────┐
Louise Jira board ─────> │ spec_factory_sources      │ ──┐
                         └───────────────────────────┘   │
                                                          │   ┌──────────┐   ┌────────────┐   ┌───────────┐   ┌──────────┐   ┌──────────────────────┐
                                                          ├─> │ draft    │ ─>│ qualifier  │ ─>│ repo ctx  │ ─>│ draft    │ ─>│ Jira Epic + children │ ─> OneShot request + PFOS
                                                          │   │ job      │   └────────────┘   └───────────┘   │ generate │   └──────────────────────┘
                                                          │   └──────────┘                                     └──────────┘
                         ┌───────────────────────────┐   │
Compose session ───────> │ compose_sessions          │ ──┘
   uploads / links       │  + compose_session_sources│
   chat turns            │  + compose_session_events │
   handoff request       └───────────────────────────┘
```

- **Louise lane.** A scheduled job polls a configured Jira board, upserts parent tickets into `spec_factory_sources`, and enqueues `spec_factory_processing_jobs` rows against them. The draft path is already durable — Louise is out of scope for the Phase 1–11 transformation except as an unchanged consumer of the shared pipeline.
- **Compose lane.** An operator starts a durable session, uploads files, pastes links, and iterates through chat/analyze turns. Sources are converted asynchronously by the conversion worker and materialized into an EFS workspace for the chat agent. On operator handoff, `ComposeService.handoff` synthesizes or reuses a `COMPOSE-<sessionId>` row in `spec_factory_sources` and enters the same draft job.
- **Convergence point.** The draft job is the join. Anything downstream — qualifier, repo context, Jira Epic/children, OneShot request, PFOS — is the same code path regardless of which lane produced the source.

- Louise polls a configured Jira board and persists parents in `spec_factory_sources`. Existing draft generation is already durable via `spec_factory_processing_jobs` (see plan §1).
- Compose is a durable session (`compose_sessions`) that accepts operator uploads, YouTube/Jira/Confluence links, notes, and interactive chat turns; on handoff it materializes a synthetic `COMPOSE-<sessionId>` source and enters the same draft pipeline (see [`src/spec-factory/compose-service.ts:1319`](../../src/spec-factory/compose-service.ts) `handoff`, plan §1).
- Both lanes converge on the shared draft job → qualifier → repo context → draft → Jira Epic/children → OneShot request + PFOS chain. The draft pipeline itself is out of scope for these docs except at the Compose handoff boundary.

## Documents in this directory

Read these in order. Each doc has a purpose statement and — where relevant — cites `file:line` for every code claim and plan `§N.M` for every target-design claim.

| Doc                                                        | Purpose                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](./architecture.md)                     | High-level structure: intake lanes, target components (API, Workers, LLM Gateway, Chat Coordinator, Working Context), and how today's `ComposeService` maps into that target.                                                 |
| [`requirements-workspace.md`](./requirements-workspace.md) | Canonical product contract for non-technical clarification, automatic source processing, research consent, Artifacts, agent status, professional requirements, Gherkin stories, and handoff preservation.                     |
| [`data-model.md`](./data-model.md)                         | MySQL tables that back Spec Factory (`compose_sessions`, `compose_session_sources`, `compose_session_events`, target `compose_turn_jobs`, `compose_context_versions`, etc.), with column-level notes and phase markers.       |
| [`runtime-and-workers.md`](./runtime-and-workers.md)       | Process/container topology: the v4 API plus eight worker services, four role-specific Node images, the conversion sidecar, scaling boundaries, and the compatibility rollback path. Canonical owner of the runtime-mode enum. |
| [`api-reference.md`](./api-reference.md)                   | HTTP surface exposed by `createComposeRouter` (session CRUD, uploads, SSE `/stream`, handoff, analyze/messages). Contract-level, request/response shapes, protected-read semantics.                                           |
| [`operations.md`](./operations.md)                         | Deploy, feature-flag rollout stages (`off`/`shadow`/`drain`/`on`), CloudWatch alarms, EFS retention, stream-token revocation runbook, incident response for stuck turns/leases.                                               |
| [`dev-guide.md`](./dev-guide.md)                           | Local dev workflow, running against MySQL with optional Valkey fanout, invoking the Compose UI, adding a migration, writing tests, and tracing an SSE session end-to-end.                                                     |
| [`migration-log.md`](./migration-log.md)                   | Chronological record of what shipped in each phase (Phase 0 today, Phase 1..11 target), with concrete acceptance criteria and links back to plan sections.                                                                    |

## Status snapshot

**Repository state:** Work Orders A-S, V, and the T/U automation and gates are
implemented. The complete repository test suite, dashboard build, schema
verifier, Terraform validation, and requirements-workspace user flows are
blocking release checks.

**Deployed state:** do not infer deployment from repository state. Schema,
Terraform data-plane resources, split-worker desired counts, queue routing,
context repair acceptance, certification, and legacy disablement remain
operator-observed facts. A deployed environment may still use earlier task
definitions, routing flags, or compatibility paths.

**Migration baseline:** apply every checked-in migration strictly in order and
verify the schema-history table before enabling a consumer that depends on it.

**Target:** the v4 topology is the destination and the contract. MySQL remains
authoritative; SQS and Valkey are accelerators/dispatch planes; S3 artifacts are
immutable; workers are independently scalable; and certification gates legacy
removal.

## Glossary

These terms are canonical across every doc in this directory. Use them verbatim. If a term needs to change, change it here first and update every consumer.

| Term                     | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Session**              | A durable Compose product boundary persisted in `compose_sessions` (created via `POST /sessions`); scoped by `session_id` in all child tables and used as the SSE + turn-queue partition; owns workspace paths, S3 prefix, optional password hash, readiness, and `claude_session_id` today (dropped as product memory in Phase 9).                                                                                                                                                                                            |
| **Turn**                 | One clarification exchange bound to a session — today a `runTurn` invocation ([`compose-service.ts:2336`](../../src/spec-factory/compose-service.ts)) serialized per session via `enqueueTurn` ([`compose-service.ts:3648`](../../src/spec-factory/compose-service.ts)) while legacy execution remains enabled; in the target model a durable `compose_turn_jobs` row (`turn_kind ∈ {chat, analyze}`) with `idempotency_key`, `lease_generation`, and one final assistant message per job enforced via `compose_turn_outputs`. |
| **Source**               | A converted piece of session input material persisted in `compose_session_sources` — either operator-provided (upload / youtube / jira / confluence / note) or, in Phase 6, generated by a research worker (`kind='generated_research'`, `source_origin` set). Converted Markdown is materialized to workspace `sources/*.md` and is the substrate for evidence citations.                                                                                                                                                     |
| **Working Context**      | Canonical session intelligence tracked in `compose_context_versions` and pointed to by `compose_sessions.latest_context_version`; assembled by the Context Merger from context patches and read by chat turns as a specific committed version when the context pipeline is enabled. The dashboard can read the latest committed projection through `GET /compose/sessions/:sessionId/context`; normal session reads also synthesize a conservative readiness view from that projection when legacy readiness JSON is empty.    |
| **Coordinator**          | The stateless per-turn router that reads a frozen context bundle and chooses answer, clarification, durable research, or escalation. Research dispatch is lease-fenced and budgeted; clarification parks and resumes the same durable turn. During the rollback window, rejected/failed routes may use `ComposeChatAgent`; with `SPEC_FACTORY_LEGACY_RUNTIME=disabled`, every such branch fails closed and the startup gates require the complete v4 control plane.                                                            |
| **Organizational Context** | The versioned MHK orientation resource in `src/spec-factory/context/mhk-organizational-context.md`. Every user-facing coordinator prompt includes its safety/evidence baseline plus bounded relevant-section retrieval. Legacy SDK workspaces also contain the complete file for selective read-only lookup. It never overrides session evidence, current code/configuration, or verified runtime state. |
| **Research Worker**      | A durable worker introduced in Phase 6 that runs code/config/repo investigations (initially via Claude Agent SDK), writes an artifact into the durable research store, and emits a generated source. Research workers never mutate Working Context directly — their output flows through Distillation → Context Merger.                                                                                                                                                                                                        |
| **Distillation**         | Phase 7 background task that consumes user and generated sources and extracts facts, requirements, constraints, decisions, and open questions into context patches (`compose_context_patches`) that the Context Merger later commits into a new Working Context version.                                                                                                                                                                                                                                                       |
| **Capability**           | A named unit of work in the Phase 5 agent task queue (e.g. code research, config research, DevOps, Architect, Critic). Stored on `compose_agent_tasks.capability` and dispatched by the capability registry to a specific executor via `executor_type`.                                                                                                                                                                                                                                                                        |
| **Runtime Mode**         | The process-role selector for one compiled Spec Factory application. Production uses `api` plus dedicated turn, context, research, conversion, draft, relay, and retention workers; `worker` is compatibility-only and `all-local` is dev-only. Canonical definitions live in [`runtime-and-workers.md`](./runtime-and-workers.md).                                                                                                                                                                                            |
| **Handoff**              | The operator-initiated transition from Compose session to the shared draft pipeline — synthesizes or reuses a `COMPOSE-<sessionId>` row in `spec_factory_sources`, queues a draft job, can enrich the bounded source summary plus persist `handoff/handoff-v1.md` / `.json` evidence artifacts when `SPEC_FACTORY_HANDOFF_ENRICHED=true`, and the draft generator prioritizes those handoff artifacts when present.                                                                                                            |
| **Readiness**            | The projection of a session's clarification maturity. Legacy turns still write a JSON blob on `compose_sessions`; when that blob is absent, `ComposeService` projects problem, next actions, and open questions from the latest committed Working Context for `listSessions`, `getSession`, and `resumeSession`. Removing the legacy JSON column remains a later cutover.                                                                                                                                                      |
| **Stream Token**         | A short-lived, SHA-256-hashed opaque token minted by password-protected session resume and required by `GET /sessions/:sessionId/stream`. Persisted, verified, revoked, and purged through MySQL `compose_stream_tokens`; Valkey is not an authorization store.                                                                                                                                                                                                                                                                |
| **Idempotency Key**      | Client-supplied dedupe key added in Phase 0 to turn-creating endpoints (`POST /sessions/:sessionId/messages`, `POST /sessions/:sessionId/analyze`) and enforced as a uniqueness constraint on `compose_turn_jobs` in Phase 2.                                                                                                                                                                                                                                                                                                  |
| **Lease Generation**     | Monotonically increasing per-turn/task lease counter used by Phase 2/5 workers to fence stale claims. A worker whose lease has been superseded must abort and not commit outputs.                                                                                                                                                                                                                                                                                                                                              |
| **Feature Flag Cutover** | Phase 2 rollout schema — `off` (behavior disabled), `shadow` (execute in parallel, ignore result), `drain` (finish outstanding, refuse new), `on` (canonical path). Every phase that swaps a runtime component uses this vocabulary.                                                                                                                                                                                                                                                                                           |
| **LLM Gateway**          | Phase 8 abstraction (`LlmGateway`) that centralizes model routing, structured output, streaming normalization, retries, budgets, prompt-version validation, optional DB prompt registry resolution, usage logging, and the `spec_factory_llm_calls` audit trail. Bedrock is the only adapter at introduction.                                                                                                                                                                                                                  |
| **Workspace Manager**    | The Phase 4 abstraction that owns attach/detach of a session's `sources/`, `chat.md`, `context.md`, and the complete `mhk-organizational-context.md` reference for a given runtime mode — EFS today, capable of local-scratch or object-store hydration for `research-worker` mode; today's concrete implementation is `ComposeWorkspaceManager`. |
| **Conversion Worker**    | The lease-based background loop `ComposeConversionWorker.drain` ([`compose-conversion.ts:303`](../../src/spec-factory/compose-conversion.ts)) that pulls unconverted `compose_session_sources` rows, dispatches documents to the `compose-markitdown` sidecar and audio/video to Voxtral, and writes `conversion_status`, `conversion_lease_expires_at`, and `error_message` back on the row.                                                                                                                                  |
| **SSE Hub**              | The API-local subscriber bridge. MySQL `compose_session_events` is the durable replay source; Valkey Pub/Sub carries low-latency canonical events across replicas, and cursor-batched MySQL polling remains the recovery path when fanout is absent or interrupted.                                                                                                                                                                                                                                                            |
| **Session Guard**        | The centralized precondition module `session-guard.ts:11` exposing `assertSession{Exists,Readable,Mutable,Streamable,HandoffAllowed}` — archive, owner, admin, system-worker, and legacy-unowned access checks live here; password token checks still live in the route/service read path.                                                                                                                                                                                                                                     |
| **Context Version**      | An immutable row in `compose_context_versions` produced by the Context Merger from a batch of `compose_context_patches`; the pointer `compose_sessions.latest_context_version` names the version that new chat turns read.                                                                                                                                                                                                                                                                                                     |
| **Correlation ID**       | The identifier propagated through SSE `event.id`, DB rows, and CloudWatch logs so that operators can join a single user-visible turn or handoff across the API, worker, and downstream pipelines.                                                                                                                                                                                                                                                                                                                              |

## Repository layout for this service

The runtime code and infrastructure for Spec Factory live under a small set of paths. Doc citations use these prefixes throughout.

| Path                                                                                 | Purpose                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/spec-factory/`](../../src/spec-factory)                                        | TypeScript service source: API/session orchestration, worker processors, outbox/SQS control plane, event fanout, context, draft, repair, storage, and certification modules. |
| [`db/migrations/`](../../db/migrations)                                              | Ordered `NNN_*.sql` migrations. The repository tail is `075_spec_factory_source_deletion_lifecycle.sql`. Never re-use a number.                                             |
| [`db/schema.sql`](../../db/schema.sql)                                               | Fresh-install schema snapshot. It must change with every migration and is checked against repository SQL by CI.                                                              |
| [`terraform/spec-factory-ecs.tf`](../../terraform/spec-factory-ecs.tf)               | ECS task definitions, split services, networking, runtime configuration, autoscaling, and alarms.                                                                            |
| [`terraform/spec-factory-data-plane.tf`](../../terraform/spec-factory-data-plane.tf) | Optional Valkey, Aurora, and RDS Proxy resources plus fail-closed legacy-removal checks.                                                                                     |
| [`docs/spec-factory/`](.)                                                            | This directory. `README.md` is the entry point; the seven sibling docs listed above cover architecture, data, runtime, API, ops, dev, and migration history.                 |
| [`docs/superpowers/spec-factory/`](../superpowers/spec-factory)                      | The canonical v4 scale plan and historical design documents.                                                                                                                 |

## Phased roadmap at a glance

The phase table below is retained for v3 history. The v4 Work Orders A-U and
their dependency/rollout order are authoritative for the current system.

| Phase  | One-line goal                                                                                                                                                                                                                                                        | Primary doc                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **0**  | Baseline: single-replica Compose + Louise service, EFS workspaces, in-memory turn queue, and SSE hub. Complete today; stream tokens have since moved to the Phase 1 DB-backed `compose_stream_tokens` store.                                                         | [`architecture.md`](./architecture.md), [`migration-log.md`](./migration-log.md)         |
| **1**  | Persist SSE events and stream tokens in MySQL, emit durable cursors through `/stream`, bridge replay to Valkey live fanout, and cursor-batch durable recovery reads across active subscribers.                                                                       | [`architecture.md`](./architecture.md), [`operations.md`](./operations.md)               |
| **2**  | Durable turn jobs backed by `compose_turn_jobs` with idempotency, lease fencing, stale recovery, archive/operator cancellation, and a `ComposeTurnWorker` behind `SPEC_FACTORY_DURABLE_TURNS=drain\|on`; final production cutover still gated.                       | [`data-model.md`](./data-model.md), [`runtime-and-workers.md`](./runtime-and-workers.md) |
| **3**  | Historical runtime split, superseded by the v4 ten-mode API plus eight-worker topology; application and Terraform are code-ready, while deployment and certification remain operational gates.                                                                       | [`runtime-and-workers.md`](./runtime-and-workers.md)                                     |
| **4**  | Workspace Manager local-scratch attach/detach, research executor scratch runs, durable `compose_workspace_manifests`, session manifests, and verified artifact writes.                                                                                               | [`runtime-and-workers.md`](./runtime-and-workers.md)                                     |
| **5**  | Agent task queue and capability registry (`compose_agent_tasks.capability`, `executor_type`) with leased worker execution for context, research, and critic slices.                                                                                                  | [`data-model.md`](./data-model.md)                                                       |
| **6**  | Research workers producing `kind='generated_research'` sources with recorded `source_origin`, redacted artifacts, and safe tool allowlists behind flags.                                                                                                             | [`architecture.md`](./architecture.md)                                                   |
| **7**  | Distillation into `compose_context_patches` + Context Merger producing `compose_context_versions`; latest-context projection endpoint; session reads and dashboard surfaces show context version/status and fall back to committed context when readiness is absent. | [`data-model.md`](./data-model.md)                                                       |
| **8**  | LLM Gateway with Bedrock adapter, structured output, streaming, budgets, durable prompt registry, and the `spec_factory_llm_calls` audit trail.                                                                                                                      | [`architecture.md`](./architecture.md)                                                   |
| **9**  | Stateless Chat Coordinator on top of Working Context; retire `claude_session_id` as product memory.                                                                                                                                                                  | [`architecture.md`](./architecture.md)                                                   |
| **10** | Handoff enrichment. Feature-flagged bounded `COMPOSE-<sessionId>` summary enrichment plus deterministic `handoff-v1.md/json` evidence artifacts; draft generation now treats those artifacts as first-class evidence.                                                | [`api-reference.md`](./api-reference.md)                                                 |
| **11** | Optional specialists (Critic and future Architect) as additional capabilities; DevOps research is part of the generated-research capability family.                                                                                                                  | [`architecture.md`](./architecture.md)                                                   |

## Key invariants

These properties hold on `main` today and must hold across every phase. Break one and you have a P1 incident, not a feature.

- **Runtime isolation and HA.** Production API and HA worker roles scale independently. Legacy-disabled startup and Terraform checks require at least two API, turn, context, research, conversion, draft, and relay tasks, with a singleton-or-greater retention service.
- **Idempotency at the intake.** Every turn-creating endpoint accepts an `Idempotency-Key` header (Phase 0). Retries with the same key must return the same turn id, not create a duplicate turn or side effect.
- **Lease fencing on workers.** Any worker that mutates a leased row (turn job, agent task, conversion) must compare its captured `lease_generation` before commit and abort if superseded. There is no "at least once" fallback that also mutates.
- **Stream-token revocation.** Session archive/delete revokes the hashed DB token rows before committing archive state; the caller must never be able to reuse a token after an archive event has fanned out.
- **Guarded state transitions.** All read/mutate/stream/handoff transitions go through `SessionGuard`. Do not open-code the gate checks in a new endpoint.
- **Migration ordering.** Migrations are strictly monotonic. Never re-use a number; always read `db/migrations/` and pick the next unused value. Update `db/schema.sql` in the same PR.
- **Doc anchoring.** Every claim in this directory that references code has a `file:line` citation; every claim about target design has a plan `§N.M` citation. Drop the citation and it is a claim about intent, not a claim about reality.

## Data-plane touchpoints

The docs frequently cross-reference the following storage systems. Naming them once here lets other docs stay concise.

- **MySQL.** Authoritative state and fencing store for sessions, sources, messages, events, turns, tasks, context, outbox, receipts, handoffs, workflows, audit, and repair.
- **SQS.** Durable wake-up substrate fed only by committed outbox rows. Queue messages never replace the MySQL job row.
- **Valkey.** Low-latency canonical-envelope fanout. MySQL event replay remains authoritative during loss or reconnect.
- **EFS.** Compatibility/repository-cache substrate only. It is absent from legacy-disabled task definitions and is never canonical session state.
- **S3.** Content-addressed originals, context, research, handoff, draft, runtime, and audit artifacts plus immutable manifests.
- **Bedrock.** Tool-free calls use the audited LLM Gateway/direct provider; tool loops remain capability-scoped research execution.
- **CloudWatch Logs.** Log groups `/ecs/specter/spec-factory` (stream `spec-factory`) and `/ecs/specter/spec-factory` (stream `compose-markitdown`) are the primary operator surface. Correlation IDs come from SSE `event.id` and are stamped into structured log lines.

## Reading paths for common tasks

Not every reader needs every doc. These paths get you productive fast for a specific goal.

- **Debug a stuck turn or an SSE gap.** Start with the "Turn" and "Stream Token" glossary entries above, then jump to [`api-reference.md`](./api-reference.md) for the `/stream` contract, and finish in [`operations.md`](./operations.md) for the stuck-turn/lease runbook. Correlation IDs come from SSE `event.id`.
- **Add or change a schema column.** Read [`data-model.md`](./data-model.md) first (column-level notes and phase markers), then [`migration-log.md`](./migration-log.md) to see how prior migrations were staged, then update `db/migrations/` and `db/schema.sql` together per the "How to contribute" rules below.
- **Add a new intake type (e.g. a new upload class or link kind).** Start in [`architecture.md`](./architecture.md) to place the ingestion point, then [`data-model.md`](./data-model.md) for `compose_session_sources.kind` conventions, then [`dev-guide.md`](./dev-guide.md) for local test coverage.
- **Move code out of the single container.** Read [`runtime-and-workers.md`](./runtime-and-workers.md) end-to-end — it owns the runtime-mode enum and the Phase 3/4 split — before touching `terraform/spec-factory-ecs.tf` or `src/spec-factory/main.ts`.
- **Change a v4 subsystem.** Read the [v4 plan](../superpowers/spec-factory/spec_factory_scale_and_reliability_plan_v4.md), then the owning document and migration log before changing a contract.

## How to contribute

- **Bugs and feature requests.** File tickets against the Spec Factory Jira project. Include session id, turn id (if any), and correlation id from the SSE `event.id`. Attach relevant lines from CloudWatch log group `/ecs/specter/spec-factory` (streams `spec-factory` and `compose-markitdown`).
- **Code changes.** Follow the general repo contribution rules in [`docs/12-CONTRIBUTING.md`](../12-CONTRIBUTING.md). In addition:
  - Never claim behavior that does not exist today in these docs without a `Status:` marker naming the phase.
  - Cite `file:line` for every code claim you add. Cite plan `§N.M` for every target-design claim.
  - When adding a migration, take the next unused number after inspecting `db/migrations` (plan §1) and update `db/schema.sql` in the same PR.
  - When adding a new SSE event type, register it in `durableEventType` ([`compose-sse.ts:65`](../../src/spec-factory/compose-sse.ts)) so replay stays consistent.
  - When adding a new endpoint, keep protected-read/mutation gating in `SessionGuard` and document the endpoint in [`api-reference.md`](./api-reference.md).
- **Docs changes.** Keep the glossary in this file the single source of truth. When you rename or redefine a term, update every consumer under `docs/spec-factory/`.

## For coding agents

If you are an implementation agent working on Spec Factory:

1. Read the [v4 plan](../superpowers/spec-factory/spec_factory_scale_and_reliability_plan_v4.md). It is canonical for scale, correctness, runtime, and rollout.
2. Confirm repository versus deployed state from [`migration-log.md`](./migration-log.md) and [`operations.md`](./operations.md).
3. Use the glossary above verbatim. Do not invent synonyms.
4. Anchor every code change to a `file:line` reference and every design decision to a plan section. If the plan is ambiguous, resolve it in a PR that updates the plan first, then the docs, then the code.
5. Respect the feature-flag cutover vocabulary (`off`/`shadow`/`drain`/`on`) for every runtime swap. Do not remove the old path in the same PR that introduces the new one.
6. Do not increase the primary `spec_factory_desired_count` above 1 until Phase 1/3 rollout gates have moved live fanout, durable turns, and split-runtime services out of the single-task assumption, and `spec_factory_running_tasks_high` is explicitly disabled as part of the API-mode cutover. Raise split worker desired counts through their role-specific variables instead; enabled worker services are covered by `spec_factory_worker_running_tasks_low`.
7. When you introduce a durable component that replaces an in-memory one (turn queue, SSE ring, runtime-local cache), ship the schema and worker under the feature-flag cutover states first (`off` → `shadow` → `drain` → `on`) with the in-memory path still runnable. Only remove the in-memory path in a follow-up PR after `on` has been the default in production for a full soak window.
8. Any file you cite in a doc must exist and must contain what you say it contains at the cited `file:line` at the moment of the PR merge. Line-drift is a legitimate reason to re-cite; guessing is not.
9. Never invent a synonym for a canonical term. If you think the glossary term is wrong, edit the glossary first (in this file), then every consumer, then the code.
10. Never re-use a migration number. `075_spec_factory_source_deletion_lifecycle.sql` is the repository tail; inspect the directory again before choosing `076_*`.

For everything else, start with [`architecture.md`](./architecture.md).

## Environment variables at a glance

The Spec Factory service reads a small, stable set of environment variables. Full descriptions live in [`runtime-and-workers.md`](./runtime-and-workers.md) and [`operations.md`](./operations.md); the summary here exists to name them once.

| Variable                              | Purpose                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SPEC_FACTORY_MODE`                   | Runtime-mode selector. Dev defaults to `all-local`; production uses `api` plus dedicated split worker roles. Canonical definitions live in [`runtime-and-workers.md`](./runtime-and-workers.md). |
| `WORKSPACE_ROOT`                      | Filesystem prefix under which per-session workspaces are materialized. On production ECS this is an EFS mount; in local dev it is a repo-relative directory.                                     |
| `S3_PREFIX`                           | Root prefix for raw uploads and Phase 2+ output blobs. Session-scoped keys append `sessions/${sessionId}/...` under this prefix.                                                                 |
| `COMPOSE_MARKITDOWN_URL`              | URL of the MarkItDown sidecar (loopback in the same task in Phase 0; a separate service post-Phase 3).                                                                                           |
| `BEDROCK_REGION` / `BEDROCK_MODEL_ID` | Underlying LLM provider config. Phase 8 replaces direct reads with an LLM Gateway that owns these.                                                                                               |
| `SPEC_FACTORY_FEATURE_FLAGS`          | Comma-separated `flag=state` list where `state` is one of `off`/`shadow`/`drain`/`on`. Used by every phase that swaps a runtime component.                                                       |
| `LOG_LEVEL`                           | `debug`/`info`/`warn`/`error`. `info` in production; `debug` for a targeted operator investigation.                                                                                              |

## Feature-flag cutover reference

Every phase in the roadmap that swaps a runtime component uses the same rollout vocabulary. This is intentional — operators and on-call engineers should never need to learn a new state machine per phase.

| State    | Meaning                                                                                                   | Operator posture                                                 |
| -------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `off`    | New path is compiled but never executed. Old path is canonical.                                           | Default outside of active rollouts. Safe to leave indefinitely.  |
| `shadow` | New path executes alongside old path; new-path results are logged but not committed or observed by users. | Compare metrics; fix parity gaps. No end-user impact.            |
| `drain`  | New path is canonical for new work; old path finishes outstanding units and refuses new ones.             | Watch old-path queue depth; hold rollback until it reaches zero. |
| `on`     | New path is canonical; old path is compiled-out or gated behind a break-glass toggle.                     | Steady state. Removal of the old path lives in a follow-up PR.   |

Every rollout starts at `off`, walks the states in order, and lives at each state long enough to confirm parity. Never skip `shadow` when the new path has side effects (durable rows, external calls, workspace mutations); the shadow window is the parity gate.

## Cross-doc citation conventions

Every sibling doc in this directory follows the same citation rules. Learn them once here and skim faster everywhere else.

- **Code references.** Rendered as ``[`path/from/repo/root.ts:LINE`](../../path/from/repo/root.ts)`` — the line number is inline in the label so a grep on the doc surface picks it up, and the URL points at the file so a click lands the reader on it. When multiple citations point at the same file, group by symbol rather than by line: prefer three separate citations to a comma-joined line list, unless the lines truly represent a single call site.
- **Plan references.** Rendered as plan `§N.M`. Do not invent letters (`§P1-A.3` is fine because the plan itself uses the letter form; `§4.2.a` is not because the plan does not). If the plan uses a named header, quote the header verbatim in addition to the section number: `plan §12.1 ("Runtime modes")`.
- **Doc-to-doc references.** Rendered as `[`sibling.md`](./sibling.md)` for a whole-doc link and `[`sibling.md#anchor`](./sibling.md#anchor)` for a targeted link. Never use raw filenames without the code fence.
- **Terraform references.** Always `terraform/spec-factory-ecs.tf:LINE`. There is no `terraform/environments/dev/spec-factory-ecs.tf` — do not invent one. Per-environment values are driven by variables inside the single module.
- **Migration references.** Always cite by filename (`054_compose_turn_jobs.sql`), not by ordinal ("migration 54"). The number and the intent both matter and should stay together.

## Change tracking for this index

- The glossary is the source of truth. When adding or renaming a term, edit the glossary in this file first, grep for old-term consumers under `docs/spec-factory/`, and update every hit in the same PR.
- The status snapshot is code-anchored. Treat it as stale the moment a `file:line` reference no longer points at the claimed symbol; the [`migration-log.md`](./migration-log.md) doc is the authoritative acceptance-criteria ledger, not this snapshot.
- The doc index table above must stay in sync with the actual sibling files in this directory. If you add a doc, add a row; if you remove one, remove the row.
- The migration baseline note (`067_compose_workspace_manifests.sql` today) must be bumped in this file, in [`data-model.md`](./data-model.md), and in [`migration-log.md`](./migration-log.md) whenever a new migration lands. These three references drift together or not at all.
- Terminology drift is the leading indicator of doc rot. If you see `latest_committed_context`, `all-in-one`, or a `runtime.md` link anywhere under `docs/spec-factory/`, treat it as a bug: the canonical names are `latest_context_version`, `all-local`, and `runtime-and-workers.md`.
- When adding a screenshot or diagram, prefer inline ASCII over an image binary — this repo's docs are grepable, and images are not.
