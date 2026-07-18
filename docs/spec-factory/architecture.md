# Architecture

This document is the canonical architecture reference for Spec Factory. The v4
implementation below supersedes older phase-state descriptions in this file.
Repository behavior and deployed behavior are separate: PR `#468` contains the
v4 code, migrations, and Terraform, but activation still requires the rollout
and certification gates in `operations.md`.

## V4 implemented architecture

### Control plane and execution flow

```text
Browser
  | authenticated/idempotent HTTP + resumable SSE
  v
API replicas
  | one MySQL transaction: state + frozen versions + outbox
  v
MySQL (authoritative state, leases, fencing, event replay)
  |
  | relay claims committed outbox rows
  v
SQS queues + DLQs + quarantine
  |
  | receipt lease + visibility heartbeat
  v
turn | context | research | conversion | draft workers
  | capability-scoped provider/tool execution
  | fenced DB commit + immutable S3 artifact pointer + event/outbox
  v
MySQL + S3
  |
  +--> Valkey live fanout --> any API replica --> SSE client
  +--> durable event replay --------------------> SSE reconnect
```

The queue is a wake-up plane, not state. A consumer validates the versioned
envelope, acquires a database receipt lease, heartbeats SQS visibility, and
claims the authoritative job row. Every final mutation checks the job lease
generation and session archive state in the same transaction. Duplicate or
late deliveries therefore become no-ops. Unsupported envelopes go to the
quarantine queue instead of retrying forever.

### Session management

A Compose session is the aggregate boundary. `compose_sessions` owns actor,
archive, context pointer/status, workspace manifest pointer, readiness, and
activity metadata. Child messages, sources/revisions/chunks, events, turns,
agent tasks, handoffs, and draft workflows all carry `session_id` directly or
through an immutable parent.

1. The API derives `ActorContext` from OIDC and applies the centralized readable,
   mutable, streamable, or handoff guard. Non-admin callers cannot distinguish
   another user's or archived session from a missing session.
2. Password-protected resumes mint SHA-256-hashed database stream tokens.
   Archive revokes tokens and atomically cancels active turns/tasks before the
   session becomes invisible.
3. Turn acceptance validates `Idempotency-Key`, appends the user message,
   freezes `requested_context_version`, records the durable turn, and inserts
   its outbox wake-up in one transaction. Same-key/same-body requests return the
   winner; changed bodies return `409`.
4. Workers enforce per-session turn ordering while allowing unrelated sessions
   to execute concurrently. `context_version_used` is worker-authoritative and
   never trusted from LLM output.
5. The coordinator can answer, request clarification, or dispatch bounded
   research. Clarification and research park the same durable turn and resume it
   without counting a successful wait as a failed attempt.
6. Archive is an atomic work-cancellation operation. There is intentionally no
   public bare-archive repository method that can strand running jobs.

### Context, handoff, and draft flow

- Source ingestion creates immutable revisions and bounded chunks. Successful
  conversion queues distillation transactionally through the outbox.
- Distillation and conversation extraction create bounded v4 patch operations
  with source/message provenance. The cumulative reducer starts from the parent
  version, applies add/update/remove/conflict operations deterministically,
  writes a checksummed artifact, and advances the latest pointer atomically.
- A handoff freezes context version, message high-watermark, source revision
  set, repository manifest, and artifact checksums. It never reads a moving
  session workspace after the freeze.
- Draft v2 is a durable stage graph: qualification, repository context,
  synthesis, validation, persist, approval wait, Jira publish, and OneShot
  submit. Completed stage artifacts are immutable and retries resume at the
  first incomplete stage.

### Runtime ownership

| Runtime             | Primary ownership                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `api`               | HTTP/auth/session guards, transaction acceptance, SSE replay/live bridge; no worker loops |
| `turn-worker`       | Durable ordered chat/analyze turns and coordinator decisions                              |
| `context-worker`    | Source distillation, conversation patches, cumulative merges, handoff snapshot builds     |
| `research-worker`   | Claude Agent SDK research with scoped tools, redaction, cost/round bounds                 |
| `conversion-worker` | MarkItDown/Voxtral conversion and source revision/chunk materialization                   |
| `draft-worker`      | Durable handoff/draft stages, Jira publish, OneShot submit                                |
| `relay-worker`      | Outbox publication, event relay, and stranded-dispatch repair                             |
| `retention-worker`  | Retention, DSR support, artifact reachability GC, repair reconciliation                   |
| `worker`            | Compatibility role during rollout only; forbidden by final legacy-disabled gates          |

Role-specific ECS task definitions use separate IAM roles, queue access,
secrets, images, and heartbeat capabilities. Research does not receive Jira
credentials; conversion receives neither Jira nor GitHub; mutable EFS mounts
disappear once legacy runtime is disabled. Task-local scratch can be lost at any
time because S3 manifests and MySQL pointers are canonical.

### Events and user experience

Every user-visible transition uses one correlated event envelope containing
event, session, turn/task/handoff/workflow, causation/correlation, schema,
timestamp, and payload fields. MySQL preserves replay order. Valkey reduces live
latency but may be unavailable without losing correctness. The dashboard does
not clear activity from elapsed timers; it projects `/workflow-state` plus SSE
events and exposes cancel, retry, stale, failed, and terminal states.

The remaining sections preserve detailed v3-era rationale and contracts. Where
they describe a single all-local process, mutable EFS workspace, or optional
split runtime as current, treat that text as historical rollout context.

## Table of Contents

- [System Overview](#system-overview)
- [Requirements-First Experience](#requirements-first-experience)
- [Runtime Modes](#runtime-modes)
- [Session Lifecycle](#session-lifecycle)
- [Turn Lifecycle](#turn-lifecycle)
- [Working Context System](#working-context-system)
- [Agent Model](#agent-model)
- [Event System](#event-system)
- [Idempotency Contract](#idempotency-contract)
- [Data Flows](#data-flows)
  - [Flow A — Upload a PDF Source](#flow-a--upload-a-pdf-source)
  - [Flow B — User Sends a Chat Message](#flow-b--user-sends-a-chat-message)
  - [Flow C — Operator Archives a Session](#flow-c--operator-archives-a-session)
- [Cross-References](#cross-references)

---

## System Overview

Spec Factory is a session-oriented service that ingests operator sources, builds versioned context, runs interactive clarification/research turns, freezes immutable handoffs, and executes a durable draft/publish workflow. The v4 topology splits the API from seven dedicated processing roles plus a compatibility worker. MySQL is the transactional source of truth, SQS carries role-scoped wakeups, content-addressed S3 stores immutable artifacts, Valkey provides live event fanout, and RDS Proxy bounds database connections.

```text
 Browser / CLI ---> API (HTTP, durable enqueue, SSE replay/live)
                         |               ^
                         v               | Valkey canonical-event fanout
                   MySQL + outbox -------+
                         |
                         v
                    Role SQS queues
                         |
       +---------+-------+---------+----------+---------+
       |         |       |         |          |         |
      turn    context research conversion   draft    relay/retention
       |         |       |         |          |         |
       +---------+-------+---------+----------+---------+
                         |
               Bedrock / Jira / OneShot

 Durable state: MySQL through RDS Proxy
 Immutable artifacts: content-addressed S3
 Task-local scratch: ephemeral and reconstructable
```

Anything outside this envelope — process memory, SDK-local session files, or worker-local scratch — is not the source of truth.

**Status: v4 code-ready; live certification is authoritative.** Runtime isolation, queues, immutable storage, outbox, Valkey, RDS Proxy, autoscaling, repair, and certification gates are represented in code and Terraform. Nothing in this document proves which migrations, task definitions, flags, or Terraform resources are active in an environment; operators must verify every rollout gate before disabling the legacy runtime.

---

## Requirements-First Experience

Compose is a requirements workspace for non-developers, not an architecture
questionnaire. The user supplies evidence and clarifies business outcomes and
functional behavior. The system owns repository grounding, implementation
research, architecture choices, and durable execution.

- New sources automatically enter conversion, distillation, and context merge;
  there is no manual Analyze Sources step.
- User-facing questions are classified and filtered to business, functional,
  or explicit research-consent questions. Technical questions are retained only
  as implementation findings or research tasks.
- Once the problem statement is clear, code research requires explicit consent.
  The backend selects and attaches relevant repositories.
- The left rail separates user Sources from generated Artifacts, including the
  current context, problem, solution, requirements, challenges, stories,
  conversation decisions, and generated research.
- The toolbar projects Sources, Requirements, Research, and Draft agent states
  from `GET /workflow-state`; elapsed timers never manufacture completion.
- Story and Epic acceptance criteria are complete Gherkin scenarios.

The complete contract and examples are in
[`requirements-workspace.md`](./requirements-workspace.md).

---

## Runtime Modes

The v4 runtime contract defines ten `SPEC_FACTORY_MODE` values: `api`, compatibility `worker`, dedicated `turn-worker`, `context-worker`, `research-worker`, `conversion-worker`, `draft-worker`, `relay-worker`, `retention-worker`, and dev-only `all-local`. The canonical ownership and service matrix is maintained in [`runtime-and-workers.md`](./runtime-and-workers.md#4-spec_factory_mode--the-runtime-knob).

Every non-`api` mode carries a durable **worker identity** — `worker_id`, `mode`, `task_arn/hostname`, `started_at`, `heartbeat_at`, `capabilities` — persisted so operators can see which worker holds which lease. Turn jobs, agent tasks, outbox delivery, conversions, and draft stages use role-appropriate durable leases and fencing.

Production cutover is guarded rather than inferred from code presence. Split roles require the workspace substrate and immutable S3 artifacts; disabling the legacy runtime additionally requires primary SQS dispatch, strict durable events, accepted context repair and certification, active retention/budgets, Valkey, RDS Proxy, digest-pinned images, and highly available role counts. Repository status is **code-ready; deployment pending** until Terraform/ECS and the environment certification prove those gates.

---

## Session Lifecycle

A session is the product boundary (plan §3.1). Every child row references `session_id`; every SSE subscription and every lease partitions on `session_id`. Sessions carry two independent status axes.

### Product States

Plan §9.1 enumerates the product states:

- `draft` — session is being iterated on; user is adding sources and running turns.
- `ready` — Working Context is complete enough that handoff is offered.
- `handed_off` — a draft job has been queued via the synthetic `COMPOSE-<sessionId>` source.
- `archived` — hidden from normal listing, mutations rejected, tokens revoked, streams terminated.

Archive is not hard deletion. Retention cleanup can later purge EFS/S3 (plan §9.1, "Archive means:" block; plan §31.6).

### Operational States

Plan §9.1 also defines two operational fields that ride on the product state:

- `context_status`: `clean | dirty | building | failed` — reflects whether the latest committed Working Context matches accumulated patches.
- turn activity — derived from non-terminal `compose_turn_jobs` rows; the session row only stores `active_turn_started_at` as a legacy activity hint.

Operational state is derived from the durable job/patch/version rows. Denormalized session columns are conveniences and must never be the sole source of truth (plan §11.4).

### Guard Functions

Every read/mutation route funnels through five guard functions (plan §9.2, `src/spec-factory/session/session-guard.ts:38-82`):

```ts
assertSessionExists(session, sessionId): ComposeSessionSummary
assertSessionReadable(session, sessionId, actor)
assertSessionMutable(session, sessionId, actor)
assertSessionStreamable(session, sessionId, actor)
assertSessionHandoffAllowed(session, sessionId, actor)
```

Guards take an `ActorContext { id, display, source: 'oidc' | 'system', roles }` (plan §9.2, guard file `src/spec-factory/session/session-guard.ts:4-9`). The Compose routes derive it from the OIDC-forwarded headers `x-amzn-oidc-identity` / `x-forwarded-user` via `actorFromRequest` in `src/spec-factory/routes.ts` and adapt to `ActorContext` through `actorContextFromSpecFactoryActor` (`src/spec-factory/session/session-guard.ts:18-34`). Admin roles come from a comma-separated `SPEC_FACTORY_ADMIN_IDS` allowlist; background workers use `SYSTEM_ACTOR` (`src/spec-factory/session/session-guard.ts:11-16`).

Service methods must call these guards instead of duplicating archive checks. `ComposeService` today does so through `assertSessionReadable/Mutable/Streamable/HandoffAllowed` helpers at `compose-service.ts:4000-4039`.

### Archive Flow

Plan §9.3 mandates this order:

1. Assert mutable/admin as needed.
2. Lock the `compose_sessions` row.
3. Revoke stream tokens (**before** `archived_at` is committed, so a resumer cannot mint a fresh subscription during the window).
4. Cancel queued/running turns and queued agent tasks per policy.
5. Set `compose_sessions.archived_at`.
6. Publish `session.archived` durably.
7. Fan out stream termination/update events.

Running workers must re-check archived state inside their **final** write transaction before appending any assistant message or generated artifact (plan §11.5 "Idempotent Final Response" fence). Context patch creation and context-version commit both lock the active session row before mutating their durable tables, so archive races fail before the artifact pointer becomes authoritative. Source creation/deletion, conversion claiming, source-status mutations, context-dirty/reset updates, and handoff linking require an active parent session, so archive races do not keep creating sources, executing conversion work, changing source lifecycle state, or handing off the session after archive. The queued handoff-build executor also confirms the active task lease before each artifact, evidence-snapshot, and draft-generation side effect; archive cancellation clears that lease, so stale workers stop before advancing handoff outputs.

**Status: Phase 0+.** Guards now hide archived sessions and sessions owned by another non-admin OIDC actor; `SYSTEM_ACTOR` keeps workers functional and rows with `created_by IS NULL` remain accessible for legacy compatibility (plan §9.2). Archive on `main` revokes stream tokens, atomically cancels non-terminal turn jobs and agent tasks, archives the session row, records durable `turn.cancelling` / `turn.cancelled` / `task.cancelled` / `session.archived` events, publishes the live `session.archived` event, and records a `session_archived` activity row in `ComposeService.deleteSession`.

---

## Turn Lifecycle

A turn is one clarification exchange bound to a session. The target model (plan §11) is a durable, lease-based state machine over `compose_turn_jobs`; the current model is an in-memory serial chain over `queuedTurns`.

### Target State Machine

```text
                         +---------------------+
   POST /messages -----> |  queued             |
   POST /analyze         | (row created,       |
                         |  turn.queued event) |
                         +----------+----------+
                                    |
                                    | worker claim SQL
                                    | (UPDATE ... WHERE status='queued'
                                    |  AND lease expired,
                                    |  lease_generation++)
                                    v
                         +---------------------+
                         |  running            |
                         |  turn.started       |
                         +----+----------+-----+
                              |          |
                dispatched    |          | direct
                to research   |          | answer
                              v          v
                +--------------------+  +--------------------+
                | waiting_on_research|  |    synthesizing    |
                |  (research task    |  |                    |
                |   in flight)       |  |                    |
                +---------+----------+  +----+---------------+
                          |                  |
                          v                  |
                    (research done)          |
                          |                  |
                          +--------+---------+
                                   v
                +-------------------+---------------------+
                |                                         |
   final fence  |  idempotent write:                      |
   (plan §11.5) |  - reload job FOR UPDATE                |
                |  - verify lease_generation, worker_id   |
                |  - check archived_at                    |
                |  - insert assistant message             |
                |  - insert compose_turn_outputs          |
                +-------------------+---------------------+
                                    |
                                    v
                         +---------------------+
                         |  completed          |
                         |  assistant.final    |
                         |  turn.completed     |
                         +---------------------+

   Alternate terminal states:
     cancelled                     — cancellation requested + worker safe-stopped
     discarded_due_to_archive      — final fence saw archived_at != NULL
     awaiting_user_input           — ask_clarification decision, lease cleared
```

Every side-effect boundary (Bedrock call, workspace attach/write, `setClaudeSessionId`, generated-source insert, SSE final publish) reloads the job and confirms `lease_generation` still matches (plan §11.3). If the heartbeat UPDATE affects zero rows, the worker has lost the lease and must stop before the next side effect. Stale-job recovery resets the job and clears `compose_sessions.active_turn_started_at` when no active durable turn remains (plan §11.4).

### Idempotent Final Response Fence

The final assistant write is a single transaction (plan §11.5):

```text
begin
  select compose_turn_jobs where id = ? for update
  verify active_worker_id and lease_generation still match
  select compose_sessions.archived_at where id = ? for update
  if archived_at is not null:
    mark turn cancelled/discarded_due_to_archive
    commit; publish; return
  select compose_turn_outputs where turn_job_id = ? for update
  if exists:
    mark turn completed if needed; commit; return existing assistant_message_id
  insert assistant message with turn_job_id
  insert compose_turn_outputs(turn_job_id, assistant_message_id)
  mark turn completed
commit
```

This is the sole authorized site for appending a durable-turn assistant final message. Legacy bridge turns without a durable `turn_job_id` must use the same service-level write helper, which falls back to the archive-fenced `appendAssistantMessageIfSessionActive` path. Never append an assistant final before one of those fences.

### Session-Level Serialization

Plan §11.4 mandates one active turn per session. The claim query must only select sessions without a non-terminal turn:

```sql
UPDATE compose_turn_jobs
SET status = 'running',
    active_worker_id = ?,
    lease_generation = lease_generation + 1,
    lease_until = ?,
    attempt_count = attempt_count + 1,
    started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
    updated_at = CURRENT_TIMESTAMP(3)
WHERE id = ?
  AND status = 'queued'
  AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP(3));
```

Deriving turn state from non-terminal `compose_turn_jobs` rows is the canonical approach (plan §11.4). `compose_sessions.active_turn_started_at` is only a legacy activity hint; stale sweep clears it after requeue/abandon when no active durable turn remains.

### Cancellation

Plan §11.6 defines cooperative cancellation: `cancellation_requested_at` is set, cancellation events are recorded, workers poll between major steps, and final writes are blocked by the lease/status fence. The legacy `ComposeChatAgent` is not fine-grained interruptible, so cancellation is honored between turns and before final output.

**Status: Phase 2 — partially shipped.** Durable turn job tables landed in migration `054_compose_turn_jobs.sql` (`compose_turn_jobs`, output idempotency via `compose_turn_outputs`, and `compose_session_messages.turn_job_id` / `context_version_used`). `SPEC_FACTORY_DURABLE_TURNS=off|shadow` still executes through the in-process per-session queue for legacy safety. In `drain|on`, HTTP turn creation returns after the durable job is queued; `ComposeTurnWorker` claims `compose_turn_jobs`, renews/validates leases through `ComposeService.executeClaimedTurn`, and final writes are fenced by `compose_turn_outputs` plus the session archive/cancel checks. `POST /sessions/:sessionId/turns/:turnJobId/cancel` cancels a non-terminal durable turn and linked queued/running agent tasks without archiving the session. `activeTurns` still prevents re-entrant execution inside one process, but the durable row is the canonical queued/running state for worker-owned turns. Remaining Phase 2 work is production rollout/metrics validation and eventual removal of the legacy queue path after `legacy_inflight == 0`.

---

## Working Context System

Working Context is the canonical session intelligence and the input to every chat turn and to the handoff bundle (plan §3.4, §19.1). It is **versioned** — a chat turn always uses a specific committed version, and mid-turn context updates never mix into an in-flight answer (plan §21.5).

### Pipeline

```text
source arrives
  (upload, youtube, jira, confluence, note, generated_research)
    |
    v
+-------------------+
| conversion / gen  |  (lease-based worker; plan §17)
| -> Markdown       |
+---------+---------+
          |
          v  source.conversion.completed OR generated_research.ready
+-------------------+
|  distillation     |  (plan §24)
|  -> context patch |
|     (facts,       |
|      requirements,|
|      constraints, |
|      decisions,   |
|      open Qs)     |
+---------+---------+
          |
          v  context.patch.created
+---------------------+
|  context merge      |  (plan §20, two-phase artifact write)
|  1. insert version  |     row status=building
|  2. write temp      |     artifact (S3/EFS) outside txn
|  3. verify checksum |
|  4. commit metadata |     status=committed
|  5. bump            |     compose_sessions.latest_context_version
+---------+-----------+
          |
          v  context.updated
+------------------------+
| Working Context        |
| version N (committed)  |
|                        |
| Read by:               |
|  - Chat Coordinator    |
|    (context bundle)    |
|  - Handoff Builder     |
|  - Critic (§21, §11)   |
+------------------------+
```

Sources may be operator-provided or **generated** by the Research Worker (plan §6 Phase 6, §18). Research workers never mutate Working Context directly — their output flows through Distillation → Context Merger (plan §3.4, §18.1).

### Version Semantics

- Each chat turn records both `requested_context_version` (visible to the API at queue time) and `context_version_used` (worker-authoritative at claim time). Drift is exposed in the event payload so the UI can explain why the answer used newer context than the request originally saw (plan §21.5).
- `compose_sessions.latest_context_version` is updated only when `latest_context_version < new_version` in the merge commit transaction (plan §20.1 step 9).
- Context patches are coalesced by the merge claim: `INSERT ... SELECT ... WHERE NOT EXISTS (active merge for session)` prevents N ready patches from creating N racing merges (plan §20.1).

### Two-Phase Artifact Write Protocol

Plan §20 (and §13.5 for workspace artifacts) forbids S3/EFS writes inside DB transactions. The safe sequence:

1. Claim merge task, load latest committed context + ready patches, acquire session-level merge exclusion.
2. Insert `compose_context_versions` row with `status=building`.
3. Build markdown + JSON in memory or local temp.
4. Write to `s3://.../.tmp/<uuid>.md` outside any DB transaction.
5. Verify artifact size + SHA-256 checksum.
6. In DB transaction: update the version row to `status=committed` with `artifact_uri`, `artifact_sha256`, `artifact_bytes`; conditionally bump `latest_context_version`; mark consumed patches superseded.
7. Publish `context.updated`.
8. `compose-artifact-gc.ts` collects orphaned temp artifacts (plan §13.5).

### Markdown Shape

The requirements-first Working Context presents `Problem Statement`, `Solution`,
`Business Requirements`, `Functional Requirements`, `Challenges`, `Decisions`,
business/functional `Open Questions`, sequenced `Stories` with Gherkin criteria,
`Risks and Unknowns`, `Source Inventory`, and `Generated Research Inventory`.
`Current Implementation Findings` remains internal evidence and never becomes a
business-user decision. A structured JSON sidecar mirrors these fields so
downstream code does not parse Markdown headings.

**Status: Phase 7 — partially shipped.** `compose_context_patches` and `compose_context_versions` exist, the distillation and context-merge executors write checksummed artifacts, and `compose_sessions.latest_context_version` points at the newest committed context. `ComposeWorkspaceManager.prepare` still materializes `chat.md`, `context.md`, `repositories.md`, `sources/*.md`, and `session-manifest.json` into the EFS-backed workspace at turn time (`src/spec-factory/compose-workspace.ts:230-343`) for legacy execution, and `compose_sessions.readiness_json` remains authoritative when present. When that legacy readiness JSON is empty, `ComposeService` projects session-read readiness from the latest committed Working Context summary and open questions.

---

## Agent Model

Plan §3.5 partitions agent responsibilities. Each agent has a narrow contract; agents never share a chat-participant role in the target.

### Chat Coordinator (plan §21)

User-facing, stateless per turn. Input is a `CoordinatorContextBundle` (plan §21.3) built by the backend from `compose_sessions.latest_context_version` + recent messages + source status + pending tasks + capability list. Output is a `CoordinatorDecision` (plan §21.4):

Every coordinator call also receives the versioned standard MHK organizational
context from
`src/spec-factory/context/mhk-organizational-context.md`. The prompt boundary
always includes the operating contract, company/product mental model, and alias
map, then deterministically retrieves up to two detailed sections relevant to
the current conversation. This keeps the normal prompt bounded while making the
coordinator aware of MHK domains and vocabulary. The organizational snapshot is
orientation, not runtime attestation: session evidence, current code, effective
configuration, and verified runtime state take precedence. The legacy SDK path
receives the same bounded prompt context and can selectively read the complete
`mhk-organizational-context.md` materialized in its session workspace.

- `answer` — direct answer with a `confidence` and `contextVersionUsed`.
- `dispatch_research` — enqueue up to `SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN` (default 3) research tasks with per-task `maxCostUsd`; over-limit decisions and budget/quota failures are rejected with `coordinator.decision.rejected`.
- `ask_clarification` — allowed only for business, functional, or explicit
  research-consent questions; the turn parks at `awaiting_user_input`, clears
  its lease, sets `clarification_expires_at`, and later expires without
  requeueing. Technical questions are converted to implementation findings or
  a consent request for bounded research.
- `escalate` — permanent escape hatch ("cannot answer safely with current tools/context").

The Coordinator does not explore repositories directly (plan §3.5). Code/current-implementation questions are delegated to the Research Worker.

### Research Worker (plan §23)

Runs heavy code/config/repo investigation. In v1 the executor is the Claude Agent SDK. Runtime split:

- `SPEC_FACTORY_MODE=research-worker` process attaches a local-scratch workspace via `WorkspaceManager.attach` (plan §13.3).
- Reads the assigned Working Context version + task instructions.
- Uses `rg`, `git`, allowed shell tools per the tool policy (plan §23.4).
- Writes a research artifact (plan §18.2 Markdown template: Task, Context Version Used, Summary, Findings, Evidence, Files Inspected, Commands / Tools Used, Open Questions, Suggested Next Tasks) to S3/EFS via the two-phase protocol.
- Emits a `generated_research` source row (plan §6 Phase 6, §18.3).

### Distillation Agent (plan §24)

Consumes user and generated sources and extracts facts, problem candidates,
business requirements, functional requirements, constraints, decisions, and
business/functional questions into a `compose_context_patches` row. Technical
uncertainty is recorded as implementation findings. It defaults to a
deterministic extractor and can run the same patch contract through the LLM
Gateway. It never writes Working Context directly.

### Context Merger (plan §20)

Runs the two-phase merge protocol above. Detects and preserves conflicts rather than silently overwriting (plan §19.5): new source contradicts old fact, research contradicts prior assistant answer, generated research lacks evidence, source is stale/deprecated, claim has low confidence. Conflicts surface in Working Context. The default merge is deterministic; `SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=true` can route semantic synthesis through LLM Gateway, but backend code still owns version, patch, and source identity.

Context bounds are enforced before durable commit. Multi-chunk source
distillation is compacted to the v4 patch-operation limit with fair allocation
across semantic sections. Aggregate section overflow is compacted across source
provenance while user-authored claims and message-backed items are protected.
The worker records dropped counts in task output and logs; original source
chunks and immutable patches remain the authoritative evidence. The strict
context reducer still rejects overflow unless the runtime merge path explicitly
requests bounded compaction.

### Critic (plan §6 Phase 11, §11.7 in the plan's phase-11 subsection)

Optional Phase 11 specialist. Reviews Working Context / assistant answers against evidence and flags unsupported claims. When `SPEC_FACTORY_ENABLE_CRITIC=true` and `SPEC_FACTORY_LLM_GATEWAY=true`, successful, non-deduplicated assistant finals enqueue a non-blocking `critic_review` task through `compose_agent_tasks`; the executor then runs through LLM Gateway and records structured review output on the task.

### Capability Registry and Executor Registry (plan §14)

Capabilities (`code_research`, `config_research`, `devops_research`, `source_distillation`, `context_merge`, `critic_review`, `chat_coordination`, `legacy_compose_chat`, `handoff_build`) are named units of work routed through the turn or agent-task queues. Agent-task capabilities are stored on `compose_agent_tasks.capability`; turn capabilities are selected by the turn executor path. Each maps to an executor boundary (plan §14.3) with a stable interface for the queue that owns it.

**Status: coordinator code-ready with an explicit rollback window.** Answer/escalate finals, clarification parking, bounded and budgeted durable research fanout, research fan-in, context provenance, lease fencing, and decision-rejection events are implemented. While legacy execution remains enabled, rejected or failed coordinator routes may use `LegacyComposeChatExecutor`. With `SPEC_FACTORY_LEGACY_RUNTIME=disabled`, coordinator absence, errors, unsupported decisions, invalid clarification state, or rejected research dispatch fail closed; startup and database gates prevent that mode before the full v4 control plane is ready.

---

## Event System

Every session-visible state change publishes a durable event. Plan §10.1 fixes the canonical vocabulary; §26 forbids parallel CamelCase names.

### Canonical Event Vocabulary (plan §10.1)

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
source.deleted
source.invalidated
source.restored
source.purged
context.patch.created
context.merge.started
context.updated
message.created
turn.queued
turn.started
turn.status
turn.completed
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

Event names are `dot.snake`. Versioning happens on payload shape, not on name (plan §10.1 trailer).

### Publisher Contract (plan §10.2)

```ts
interface SessionEventPublisher {
  publish(event: PublishSessionEventInput): Promise<PublishedSessionEvent>;
  replay(
    sessionId: number,
    afterEventId?: string | number,
  ): AsyncIterable<SessionEvent>;
  subscribe(sessionId: number): AsyncIterable<SessionEvent>;
}
```

`publish()` persists through the transactional event path, publishes the canonical event to Valkey live fanout, and returns the durable event id. If live fanout fails after DB insert, it does not roll back; clients and the cursor-batched poller replay from MySQL.

### SSE Route (plan §10.3)

```text
1. Resolve resume cursor from Last-Event-ID or ?after=<eventId>.
2. Validate access with assertSessionStreamable.
3. Replay compose_session_events where session_id=? and id > cursor.
4. Emit each durable event as SSE with id: <compose_session_events.id>.
5. Subscribe to live fanout for the same session with a paused cursor.
6. Query once more for events with id > lastSentId to close the replay/live race.
7. Lower the subscriber cursor to the last durable event written.
8. Query once more and skip rows already delivered live, so bursts larger than the in-process replay buffer are still delivered from the durable log.
9. Send heartbeat comments until disconnect.
```

The canonical browser EventSource URL is `/api/spec-factory/compose/sessions/:sessionId/stream`. Any `/events` alias is optional (plan §10.3 trailer, plan §27.2).

Clients tolerate duplicate event ids and missed live fanout by replaying (plan §10.4).

**Status: v4 event path code-ready.** MySQL stores the canonical durable sequence, the transactional outbox decouples publication, Valkey provides cross-replica live delivery, and the SSE bridge preserves `Last-Event-ID` replay. Active subscriber recovery uses cursor-batched MySQL reads, so a Valkey interruption affects latency rather than correctness.

---

## Idempotency Contract

Plan §27.1 defines a client-observable `Idempotency-Key` header on every turn-producing mutation (`POST /messages`, `POST /analyze`, any future POST that enqueues a turn) plus a server-side lease-generation fence inside the worker (plan §11.5).

### Client-Facing Rules (plan §27.1)

- **Format:** opaque ASCII, 1–128 chars, `[A-Za-z0-9._~+/-]+`. Typical value: UUIDv4 or ULID.
- **Requirement:** REQUIRED. Requests without it are rejected with `400 idempotency_key_required`.
- **Uniqueness:** `(session_id, idempotency_key)` is UNIQUE; `idempotency_key NOT NULL` in `compose_turn_jobs` (plan §8.3).
- **Server behavior:** The API layer requires the key before inserting a user-message row. On a hit, return the prior `{ messageId, turnJobId, status }` verbatim. On a miss, in a single transaction, insert the user-message row + `compose_turn_jobs` row (+ optional mapping row) atomically. This is the current HTTP path in `ComposeService.postMessage` (`src/spec-factory/compose-service.ts:3808-3993`).
- **Retention:** at least 24h.
- **Conflict:** same `Idempotency-Key` + different body → `409 idempotency_key_reused`; do not create a second turn.
- **Bridge to `/analyze`:** internal analyze requests generate `analyze:<sessionId>:<requestId>` and follow the same dedup path.

### Worker-Side Lease Fence (plan §11.5)

The final assistant write is fenced by:

1. Reloading the turn job `FOR UPDATE`.
2. Verifying `active_worker_id` and `lease_generation` still match the values the worker claimed with.
3. Checking `compose_sessions.archived_at` in the same transaction.
4. Looking up `compose_turn_outputs` for the job; if present, returning the existing `assistant_message_id`.
5. Only then inserting the assistant message + `compose_turn_outputs` row + marking the job `completed`.

This prevents (a) two workers appending duplicate finals if a lease expired mid-turn, (b) a stale worker appending after the session was archived, (c) a replay resurfacing a completed turn as new.

**Status: Phase 2 partially shipped.** `POST /messages` reads and requires `Idempotency-Key` before calling `ComposeService.postMessage`. The service uses `compose_turn_jobs` for deduplication and atomic user-message/turn creation on every HTTP message turn. In `SPEC_FACTORY_DURABLE_TURNS=drain|on`, worker-owned execution uses the final-write fence above; remaining Phase 2 work is production rollout validation and legacy-path removal.

---

## Data Flows

Three end-to-end narratives, target-first with a Phase 0 comparison. File:line citations use `src/spec-factory/` unless otherwise noted.

### Flow A — Upload a PDF Source

**Target.**

```text
1. Client POST /sessions/:sessionId/uploads
     - assertSessionMutable(session, actor)
     - insert compose_session_sources status=awaiting_upload
     - mint presigned S3 PUT URL
     - publish source.added
   Response: { sourceId, uploadUrl }

2. Client PUT to S3 (out of band).

3. Client POST /sessions/:sessionId/sources/:sourceId/uploaded
     - assertSessionMutable
     - transition source to status=uploaded
     - insert compose_agent_tasks row for source_conversion (or lease-based conversion queue)
     - publish source.uploaded

4. Conversion worker (SPEC_FACTORY_MODE=conversion-worker or worker)
     - claim conversion lease
     - publish source.conversion.started
     - drive MarkItDown sidecar / Voxtral / etc.
     - two-phase write markdown artifact
     - update source status=converted
     - publish source.conversion.completed

5. Distillation worker
     - source.conversion.completed fires
     - claim distillation task
     - LLM Gateway call
     - insert compose_context_patches row status=ready
     - publish source.distillation.completed + context.patch.created

6. Context Merger
     - claim single active merge per session
     - build new Working Context version (two-phase artifact write, plan §20.1)
     - commit compose_context_versions status=committed
     - bump compose_sessions.latest_context_version
     - publish context.updated
```

Every step is durable, replayable, and cross-replica. A worker crash between steps 4 and 5 is recovered by lease expiry.

#### Source deletion and Undo

Source deletion is a durable lifecycle, not a direct row/file delete:

1. The API locks the active session and its active source set.
2. It computes the transitive generated-research closure from
   `parent_source_ids_json` and marks the root plus descendants deleted under
   one `compose_source_deletions` batch.
3. It creates `source_removal` patches, cancels active turns and invalidated
   tasks, supersedes building context and handoff outputs, and queues one
   context merge in the same transaction.
4. `source.deleted` and per-descendant `source.invalidated` events drive browser
   reconciliation. Deleted rows disappear from normal source reads immediately.
5. Undo clears the deletion marker only on the original source, publishes
   `source.restored`, and re-runs conversion or distillation as appropriate.
   Derived research remains deleted so old conclusions cannot re-enter context
   without fresh execution.
6. After the configured grace period, the retention worker claims the batch,
   deletes source-specific EFS/S3 artifacts, scrubs source/revision/chunk
   content, and publishes `source.purged`. Committed historical context and
   handoff snapshots remain immutable audit records but are superseded and are
   not current state.

Generated-research creation follows the same session-first lock order and locks
all active parent sources. A concurrent delete therefore either includes the
new research row in its closure or causes the research insert to fail before it
becomes authoritative.

**Today (Phase 0).**

- Step 1 corresponds to `POST /sessions/:sessionId/uploads`. `ComposeService.confirmUpload` at `compose-service.ts:1815-1844` is the confirm handler, and `compose-routes.ts` wires the presigned URL flow.
- Step 3 kicks `kickConversionDrain` (`compose-service.ts:3619`), which does not go through a lease queue but directly invokes `ComposeConversionWorker.drain` (`src/spec-factory/compose-conversion.ts:303-316`). Conversion is lease-based at the source-row level.
- Step 4 uses the same conversion worker but runs in-process. Retry classification is `isTransientConversionError` at `compose-conversion.ts:68`.
- Steps 5 and 6 do not exist. Instead, the next chat turn re-materializes `sources/*.md` from the converted `markdownContent` column in `ComposeWorkspaceManager.prepare` (`compose-workspace.ts:230-343`). There is no distillation, no patch, no versioned context.

Distillation, patches, and merge arrive with Phase 6/7 (plan §6, §19, §20, §24).

### Flow B — User Sends a Chat Message

**Target.**

```text
1. Client POST /api/spec-factory/compose/sessions/:sessionId/messages
   Headers: Idempotency-Key: <UUIDv4>
   Body:    { content, ... }
     - assertSessionMutable
     - lookup (session_id, idempotency_key) in compose_turn_jobs
         - hit: return prior { messageId, turnJobId, status } (plan §27.1)
         - miss: single transaction
            insert compose_session_messages(role=user, session_id, ...)
             insert compose_turn_jobs(session_id, turn_kind=chat,
                                       user_message_id, idempotency_key,
                                       requested_context_version = latest_committed)
     - publish message.created + turn.queued (durable)
   Response: 202 { messageId, turnJobId, status: "queued" }

2. Turn worker (SPEC_FACTORY_MODE=turn-worker) polls compose_turn_jobs:
     UPDATE ... SET status='running', active_worker_id=?, lease_generation++
     WHERE status='queued' AND (lease_until IS NULL OR lease_until < NOW())
     - publish turn.started
     - reload latest committed context; record context_version_used
     - build CoordinatorContextBundle (plan §21.3)
     - call ChatCoordinator (plan §21.2/21.4)
       - answer            -> synthesize; go to step 3
       - dispatch_research -> if durable worker + budget gates pass, insert compose_agent_tasks and publish turn.status waiting_on_research; otherwise fall back/reject
       - ask_clarification -> mark turn awaiting_user_input; clear lease; publish
       - escalate          -> mark turn completed with escalation payload

3. Research fan-in (if dispatched)
     - research worker claims task; runs Claude Agent SDK
     - writes research artifact (two-phase); creates generated_research source
     - publishes task.completed; turn transitions to synthesizing
     - Coordinator synthesizes using research summary

4. Final fence (plan §11.5) in a single DB transaction:
     - SELECT compose_turn_jobs FOR UPDATE; verify active_worker_id + lease_generation
     - SELECT compose_sessions.archived_at FOR UPDATE
         if archived -> mark turn discarded_due_to_archive; publish; return
     - SELECT compose_turn_outputs FOR UPDATE
         if exists -> mark completed; return existing assistant_message_id
    - INSERT compose_session_messages(role=assistant, turn_job_id=?, ...)
     - INSERT compose_turn_outputs(turn_job_id, assistant_message_id)
     - UPDATE compose_turn_jobs SET status='completed'
     - COMMIT
     - publish assistant.final + turn.completed durably
     - update readiness if applicable; publish readiness.updated
```

Every SSE consumer sees the same event stream via replay + live fanout/durable polling. Retries with the same `Idempotency-Key` are absorbed at step 1; worker restarts mid-step-2 are absorbed by lease expiry.

**Today (Phase 0).**

- Step 1: `POST /sessions/:sessionId/messages` at `compose-routes.ts:711` calls `ComposeService.postMessage` (`compose-service.ts:3808-3993`). Header-backed requests create/dedupe a durable `compose_turn_jobs` row before enqueue; header-absent bridge requests still append the user message directly.
- Step 2: `SPEC_FACTORY_DURABLE_TURNS=off|shadow` uses `enqueueTurn` to chain a Promise onto the per-session `queuedTurns` map. `drain|on` returns after the `compose_turn_jobs` row is queued; `ComposeTurnWorker` claims and executes it.
- Step 3: `runTurn` (`compose-service.ts:2336-2643`) publishes intermediate `turn.status` events (`Reading sources`, `Updating brief`, `Saving response`), calls `ComposeWorkspaceManager.prepare` (`compose-workspace.ts:230-343`) to materialize `chat.md`/`context.md`/`repositories.md`/`sources/*.md` and durable manifest metadata, then either routes through `ChatCoordinator` or falls back to `ComposeChatAgent.run` (`compose-chat-agent.ts:327-389`).
- Step 4: Assistant writes use the final-write fence when a durable `turn_job_id` is present; legacy bridge turns use the same write helper with an archive check. The SSE hub publishes `message` / `readiness` / `status: idle`.

Durable turns land in Phase 2, Coordinator + research routing in Phase 9, generated-source-based research artifacts in Phase 6 (plan §6, §11, §18, §21).

### Flow C — Operator Archives a Session

**Target.**

```text
1. DELETE /api/spec-factory/compose/sessions/:sessionId
     - assertSessionMutable(session, actor)  (owner/admin guard; system workers internal only)
     - BEGIN
         SELECT compose_sessions WHERE id=? FOR UPDATE
        UPDATE compose_stream_tokens SET revoked_at=NOW() WHERE session_id=?
         UPDATE compose_turn_jobs SET status='cancelling', cancellation_requested_at=NOW()
           WHERE session_id=? AND status IN ('queued','running','waiting_on_research','synthesizing')
         UPDATE compose_agent_tasks SET status='cancelling'
           WHERE session_id=? AND status IN ('queued','running')  (per policy)
         UPDATE compose_sessions SET archived_at=NOW(), status='archived'
       COMMIT
     - publish session.archived durably (compose_session_events)
     - publish turn.cancelling / turn.discarded_due_to_archive per running turn
     - live SSE fanout: connected streams receive session.archived and terminate

2. Running turn worker sees archived state at the final fence (plan §11.5).
   - Instead of appending the assistant message, mark turn discarded_due_to_archive
   - Publish assistant.discarded_due_to_archive

3. DB-backed stream-token verification rejects revoked rows, so a client that
   reconnects with a stale token gets rejected by assertSessionStreamable.

4. Retention cleanup (later, out of band) purges EFS/S3 per §31.6.
```

Token revocation MUST precede `archived_at` (plan §9.3 trailer) so a protected-session reader cannot mint a fresh stream token during the archive window. Running workers must re-check archived state inside the final write transaction before appending any assistant message or generated artifact (plan §11.5).

**Today (Phase 0).**

- `ComposeService.deleteSession`:
  1. Calls `requireAuthorizedSession(input, "mutable")` (`compose-service.ts:657`).
  2. Calls `composeRepository.revokeSessionStreamTokens`.
  3. Calls `archiveSessionWithWorkCancellation`, which locks the session, cancels non-terminal turn jobs and agent tasks, clears their worker leases, and archives the session in one transaction.
  4. Records durable `turn.cancelling` / `turn.cancelled` / `task.cancelled` events for the cancelled work and publishes `session.archived` through `ComposeSseHub`.
  5. Records a `session_archived` activity row.
- A running durable worker whose turn was cancelled by archive loses the status/lease fence before final output and cannot append an assistant final. Legacy in-memory turns still rely on the final archive check and their own `.finally` cleanup.

---

## Cross-References

- Public HTTP surface, request/response shapes, and route-level guards: [api-reference.md](./api-reference.md).
- Storage schema (MySQL tables, Valkey fanout, task-local scratch, and S3 layout): [data-model.md](./data-model.md).
- Operational runbook (feature flags, deploy modes, rollout cutovers): [operations.md](./operations.md).
- Local development, testing strategy, and repo layout: [dev-guide.md](./dev-guide.md).
- Runtime modes, worker identity, and process topology: [runtime-and-workers.md](./runtime-and-workers.md).
- Migration history and schema baselines: [migration-log.md](./migration-log.md).
- Plan v3 canonical source: [`docs/superpowers/spec-factory/spec_factory_transformation_plan_v3.md`](../superpowers/spec-factory/spec_factory_transformation_plan_v3.md).
- Terminology glossary: [README.md](./README.md#glossary).
