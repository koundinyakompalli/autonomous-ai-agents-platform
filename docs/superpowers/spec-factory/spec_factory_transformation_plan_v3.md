# Spec Factory Next-Generation Architecture and Migration Plan v3

> **Requirements-first amendment:** The v4 plan §18.5 and
> [`requirements-workspace.md`](../../spec-factory/requirements-workspace.md)
> supersede v3 wherever this document implies that business users should answer
> implementation questions, manually analyze sources, select repositories, or
> inspect context in a panel above chat. User-facing clarification is limited to
> business/functional behavior and explicit research consent; implementation
> findings remain internal; stories use full Gherkin acceptance criteria.

**Status:** Canonical implementation blueprint. This document supersedes `spec_factory_transformation_plan.md` and `spec_factory_transformation_plan_v2.md`.

**Audience:** Coding agent / implementation agent working inside the Spec Factory codebase.

**Primary objective:** Transform Spec Factory from a single-replica, process-memory Compose chat service into a distributed, durable, worker-pool based session orchestration system with replayable session events, durable turn jobs, generated research sources, async distillation, versioned working context, and a stateless Chat Coordinator.

**Important v3 correction:** The first implementation phase is **not** the LLM Gateway. The first implementation phase is externalizing volatile session state and enforcing session lifecycle correctness. The LLM Gateway and stateless coordinator come later, after the durable control plane exists.

---

## 1. Current System Summary

Spec Factory currently has two intake lanes that converge into the same draft/Jira/OneShot pipeline:

```text
Louise Jira board ──> spec_factory_sources ─┐
                                             ├─> draft job ─> qualifier ─> repo context ─> draft ─> Jira Epic/children ─> OneShot request + PFOS
Compose session ──> compose_sessions ───────┘
```

Pre-v3 baseline strong points:

- Louise/Jira intake already persists parent state in `spec_factory_sources`.
- Draft generation already uses durable MySQL jobs through `spec_factory_processing_jobs`.
- Compose source conversion is already close to the desired model because it uses DB-backed row leases.
- Compose handoff already creates or reuses a synthetic `COMPOSE-<sessionId>` source and queues the shared draft-generation path.
- Existing draft/Jira/OneShot pipeline should be preserved.

Pre-v3 baseline scaling blockers:

- Compose turn serialization is in process memory: `activeTurns`, `queuedTurns`, `queuedDepth`.
- SSE subscribers/replay are in process memory.
- Protected session stream tokens are in process memory.
- Compose chat turns are not durable jobs.
- In-flight or queued turns are lost during restart/deploy.
- The service is intentionally single-replica because user-visible session state is tied to one ECS process.

Pre-v3 baseline lifecycle/security concerns:

- Archive behaves mostly as a UI/listing boundary, not a hard access boundary.
- Some endpoints and service methods can still operate on archived sessions unless each path explicitly checks.
- Archiving a session does not reliably revoke existing stream tokens.
- Protected-read checks should be centralized and hardened.

Current migration baseline note:

- Do **not** assume the latest migration is `037_compose_sessions`.
- The current repo has later migrations through at least `053_spec_factory_multiple_child_stories_per_repo.sql`.
- Before writing migrations, inspect `db/migrations` and use the next available migration number.
- Update `db/schema.sql` and any migration snapshots consistently.

---

## 2. Target Architecture

The target architecture is:

```text
Spec Factory API
  - Express routes
  - auth/password resume
  - session CRUD
  - SSE/WebSocket/EventSource streaming
  - no user-visible session state stored only in process memory

Durable orchestration
  - source conversion leases
  - Compose turn jobs
  - agent tasks
  - context patch jobs
  - context merge jobs
  - draft jobs

Worker pool
  - claims durable jobs with leases
  - runs legacy Compose chat during migration
  - later runs Chat Coordinator turns
  - runs research workers
  - runs distillation workers
  - runs context merger

Session intelligence
  - source artifacts
  - generated research sources
  - source distillation outputs
  - context patches
  - versioned working context
  - conversation summary
  - open questions
  - decisions
  - evidence map

Runtime adapters
  - LLM Gateway for direct provider-agnostic calls
  - Agent Executor for long-running agentic loops
  - Claude Agent SDK as v1 code-research executor
```

The core invariant is:

```text
No user-visible session state may live only inside one ECS process.
```

A session can move between workers. Workers are ephemeral. Product state is durable.

---

## 3. Architectural Invariants

These rules are non-negotiable. The coding agent must not violate them for local convenience.

### 3.1 Session Ownership

A Compose session is the product boundary.

```text
Workers are ephemeral.
Sessions are durable.
```

Workers may attach to a session, process work, detach, fail, restart, or be replaced. The session must remain valid and resumable.

No worker owns a session.

### 3.2 Multi-Tenancy Stance

Current Compose schema has `compose_sessions.created_by` and `created_by_display`, but no authoritative tenant/org column. The v3 plan must not invent tenant IDs in child tables.

Rules:

- New Compose tables are scoped by `session_id` and inherit user/tenant context through `compose_sessions` and `ActorContext`.
- Add tenant/org columns only after the auth/session model exposes an authoritative tenant source and backfill plan.
- Until then, budget and rollout controls that say "tenant" must support a `global` or `unknown` tenant bucket plus per-session/per-user limits.

### 3.3 Durable State

Never store user-visible product state exclusively in:

- process memory
- Claude provider session memory
- Claude SDK local session files
- SSE connections
- Redis-only structures
- worker-local scratch directories

All durable state must survive:

- ECS task restart
- deployment
- worker replacement
- scale-out
- failover

### 3.4 Context

Working Context is the canonical session intelligence.

Conversation history provides conversational continuity.

Generated research becomes sources.

Research workers never mutate Working Context directly.

Working Context is always versioned.

A chat turn always uses a specific committed context version.

### 3.5 Agent Responsibilities

```text
Chat Coordinator
  - user-facing
  - stateless per turn
  - reads context bundle
  - decides whether to answer, clarify, or dispatch work
  - does not explore repositories directly

Research Worker
  - code/config/repo investigation
  - uses Claude Agent SDK in v1
  - writes generated research artifact
  - creates generated source

Distillation Agent
  - consumes user and generated sources
  - extracts facts, requirements, constraints, decisions, open questions
  - produces context patches

Context Merger
  - merges patches
  - resolves conflicts
  - preserves provenance
  - commits Working Context versions
```

### 3.6 Provider Independence

Business logic must not reference providers directly.

Direct model calls go through LLM Gateway.

Long-running agentic loops go through Agent Executor adapters.

Provider-agnostic does not mean every model must be interchangeable. It means the system can route each capability to the best provider/runtime without rewriting product logic.

### 3.7 Workspace

Research executes against worker-local ephemeral workspace.

EFS/S3 hold durable source artifacts, generated artifacts, snapshots, and context files.

EFS should not be the hot execution filesystem for heavy `rg`/`git`/tool loops when local scratch is available.

### 3.8 Evidence

Every durable conclusion should be traceable to at least one of:

- uploaded source
- converted Markdown source
- generated research source
- code evidence
- config evidence
- Jira/Confluence source
- tool output
- explicit user message

Working Context should not silently convert unsupported assumptions into facts.

### 3.9 Scalability

Every queue is lease-based.

Every worker is replaceable.

Every session can migrate to another worker.

No singleton runtime components.

### 3.10 Artifact Safety

Do not perform S3/EFS/external artifact writes inside DB transactions.

Use two-phase artifact protocols:

```text
reserve DB row as building
write temp artifact outside transaction
verify artifact
commit DB metadata/status
finalize artifact URI if needed
```

---

## 4. Goals

### 4.1 Operational Goals

- Allow more than one Spec Factory API task.
- Allow more than one worker task.
- Survive ECS restarts without losing queued or in-flight Compose turns.
- Support replayable SSE/EventSource streams.
- Support shared stream auth/token validation across replicas.
- Remove process-memory as a session source of truth.
- Preserve the existing durable draft/Jira/OneShot pipeline.

### 4.2 Product Goals

- Preserve Compose interactive intake.
- Preserve current handoff behavior into draft generation.
- Improve session continuity across restarts.
- Allow background research to enrich future context.
- Make generated research auditable and reusable.
- Eventually provide a stateless Chat Coordinator that works from Working Context + chat history + evidence.

### 4.3 Agentic Goals

- Treat background research output as generated sources.
- Distill user sources and generated sources into structured context patches.
- Commit versioned Working Context.
- Use Claude Agent SDK for heavy codebase/repo exploration.
- Use LLM Gateway for direct provider-agnostic model calls.
- Avoid making LangChain, ADK, AutoGen, or any generic framework the durable system spine.

---

## 5. Non-Goals for the Initial Pass

Do not attempt all of this in the first coding pass.

Initial pass should **not**:

- Replace the existing ComposeChatAgent immediately.
- Build a full stateless Chat Coordinator immediately.
- Add Architect/DevOps/Config agents immediately.
- Fully implement LLM Gateway before durable turns/events exist.
- Rewrite the Louise/draft/Jira/OneShot pipeline.
- Replace MySQL job leases with LangGraph/ADK/AutoGen state.
- Force Claude Agent SDK through a generic LLM endpoint.
- Make Redis the source of truth for session state.
- Move all artifact storage into DB.
- Run heavy repo research directly on EFS if local scratch is available.

---

## 6. Revised Implementation Order

This v3 plan intentionally reorders the v2 phases.

The old plan was too architecture-forward. This plan is migration-safe.

### Phase 0: Baseline, Lifecycle, and Safety

Purpose: fix security/lifecycle boundaries and prepare the codebase.

Tasks:

1. Inspect current migrations and choose next migration number after current repo baseline.
2. Add centralized session lifecycle guard functions.
3. Enforce archived-session behavior consistently.
4. Revoke or invalidate stream tokens on archive/delete.
5. Add idempotency fields needed by later durable turns.
6. Add feature flags in disabled mode.
7. Add tests around archive/read/write/stream behavior.

### Phase 1: Replayable Session Events and Shared Stream Tokens

Purpose: remove SSE and stream-token single-replica assumptions.

Tasks:

1. Add `compose_session_events` table.
2. Add session event publisher abstraction.
3. Persist replayable events before or alongside live fanout.
4. Bridge durable replay to the live SSE hub; Redis pub/sub can be added later only as an optimization.
5. Move stream tokens to the DB-backed shared token table.
6. Update existing `/stream` route to emit SSE `id:` from durable event id and honor `Last-Event-ID`.
7. Keep existing in-process SSE path behind feature flag during migration.

### Phase 2: Durable Compose Turn Jobs While Keeping Legacy ComposeChatAgent

Purpose: remove in-memory turn queue without changing intelligence behavior.

Tasks:

1. Add `compose_turn_jobs` table.
2. Include `turn_kind`, nullable `user_message_id`, required idempotency key, `lease_generation`, and attempt fields.
3. Replace `activeTurns`, `queuedTurns`, `queuedDepth` with DB-backed job queue and leases.
4. Add `off|shadow|drain|on` cutover and wait for `legacy_inflight==0`.
5. Add session-level turn locking.
6. Run the existing ComposeChatAgent from a claimed durable turn job.
7. Link assistant messages to turn jobs.
8. Enforce one final assistant response per turn job.
9. Support stale job recovery.
10. Support cancellation/abandonment semantics.

### Phase 3: Runtime Split and Worker Modes

Purpose: prepare for scale-out.

Tasks:

1. Add runtime modes: `api`, `worker`, `research-worker`, optionally `conversion-worker`.
2. Keep local/dev ability to run all modes in one process.
3. Move processors into mode-specific bootstrap paths.
4. Add worker heartbeat and worker identity.
5. Add deployment feature flags but do not require separate ECS services on day one.
6. Do not enable production non-`all-local` modes until Phase 4 workspace attach is ready.

### Phase 4: Workspace Manager

Purpose: centralize attach/detach/hydrate/sync semantics before research workers exist.

Tasks:

1. Add `WorkspaceManager` abstraction.
2. Add durable workspace manifest.
3. Support local scratch hydration from EFS/S3.
4. Support artifact sync back to EFS/S3.
5. Support cleanup and retention hooks.
6. Ensure existing ComposeChatAgent can still use current materialized workspace path.

### Phase 5: Agent Task Queue and Capability Registry

Purpose: introduce durable specialist work without changing the default chat path yet.

Tasks:

1. Add `compose_agent_tasks` table.
2. Add capability registry.
3. Add executor registry.
4. Add task claim/lease/recovery behavior.
5. Add task output JSON and artifact references.
6. Add status events for task progress.

### Phase 6: Generated Research Sources

Purpose: make research output durable, auditable, and reusable.

Tasks:

1. Extend `compose_session_sources` for generated sources.
2. Add `generated_research` source kind and `source_origin`.
3. Add research artifact writer.
4. Add Claude Agent SDK research executor skeleton.
5. Run code research behind feature flag.
6. Store research output as generated source.
7. Do not yet require the chat path to depend on this.

### Phase 7: Source Distillation, Context Patches, and Context Versions

Purpose: create canonical versioned session intelligence.

Tasks:

1. Add source distillation tasks.
2. Add context patch artifacts.
3. Add `compose_context_versions` table.
4. Add two-phase context artifact write protocol.
5. Add context merger.
6. Add latest committed context pointer on `compose_sessions`.
7. Treat readiness as derived/projection state.

### Phase 8: LLM Gateway

Purpose: centralize direct model calls after durable control plane exists.

Tasks:

1. Add `LlmGateway` interface.
2. Add Bedrock provider adapter only.
3. Add model router by purpose/capability.
4. Add structured output support.
5. Add streaming normalization.
6. Add retries, budgets, rate handling, usage logging.
7. Add `spec_factory_llm_calls` audit table.

### Phase 9: Stateless Chat Coordinator

Purpose: replace legacy ComposeChatAgent with coordinator-driven orchestration.

Tasks:

1. Build Context Builder.
2. Build Coordinator Decision schema.
3. Initially route most turns to legacy agent adapter.
4. Gradually route direct-context turns to Chat Coordinator.
5. Route code/current-implementation questions to research tasks.
6. Use research result for immediate synthesis and generated-source pipeline for future context.
7. Remove dependency on `claude_session_id` as product memory.

### Phase 10: Handoff Bundle and Draft Pipeline Enrichment

Purpose: improve Compose-to-draft handoff quality.

Tasks:

1. Build handoff summary from guarded session, readiness, source inventory, generated research count, context version, and open questions.
2. Preserve existing draft job path and synthetic `COMPOSE-<sessionId>` idempotency.
3. Later slice: build full handoff bundle from latest Working Context.
4. Later slice: include selected source summaries, generated research, decisions, open questions, and artifact references.
5. Later slice: create or update synthetic `COMPOSE-<sessionId>` source with richer artifact.

### Phase 11: Optional Specialists and Critic

Purpose: add agents only after the core loop is stable.

Tasks:

1. Add Critic Agent through LLM Gateway.
2. Add Config Research capability if repeated demand exists.
3. Add DevOps capability if infra/config/deploy questions justify it.
4. Add Architect capability for solution design.
5. Do not turn agents into free-form chat participants.

---

## 7. Storage Model

### 7.1 MySQL

Use MySQL for durable product metadata and job state:

```text
compose_sessions
compose_session_sources
compose_session_messages
compose_stream_tokens          # §8.2 (Option B; hashed stream-token store)
compose_turn_jobs
compose_turn_outputs           # §8.4 (final-response idempotency)
compose_agent_tasks
compose_session_events
compose_context_patches
compose_context_versions
spec_factory_llm_calls
compose_agent_runtime_runs
spec_factory_processing_jobs
```

MySQL is the source of truth for:

- session status
- archive state
- source state
- message history
- turn jobs
- agent tasks
- context versions
- durable event sequence
- provider call audit metadata

### 7.2 Ephemeral Coordination

```text
live stream fanout
optional Redis pub/sub or streams
optional Redis locks/cache if later needed
worker heartbeats
cancellation flags
active worker routing cache
short-lived context bundle cache
```

The current implementation uses MySQL plus the in-process SSE hub for live
delivery and DB-backed stream tokens for protected-session auth. Redis may be
added later for pub/sub, locks, or caches, but it is not the source of truth for
session history, messages, context versions, stream-token validity, or final
assistant responses.

### 7.3 EFS/S3

Use EFS/S3 for durable artifacts:

```text
converted markdown sources
generated research markdown/json
context patches
working_context_vN.md
working_context_vN.json
handoff bundles
tool traces
workspace snapshots
source attachments
```

EFS/S3 artifact writes must not be inside DB transactions.

### 7.4 Local Scratch

Use worker-local ephemeral disk for active research execution:

```text
/scratch/spec-factory/<sessionId>/workspace
/scratch/spec-factory/<sessionId>/artifacts
/scratch/spec-factory/<sessionId>/tmp
```

Hydrate from EFS/S3 before work. Sync artifacts back after work. Clean up according to retention policy.

### 7.5 Optional Vector Store

Out of scope for the implementable v3 plan unless Open Decision 12 is resolved with a provider, interface, phase, and tests.

If added later, use vector retrieval only for recall over large artifacts, never as canonical memory. MySQL context versions and artifact URIs remain the source of truth.

---

## 8. Database Schema Plan

Migration numbers in this section are illustrative. The coding agent must inspect `db/migrations` and create the next actual migration after the current latest migration.

Schema house rules:

- Current Compose session IDs are numeric `BIGINT` values. New tables in this plan must use `BIGINT` `session_id` columns unless a separate, explicit migration first introduces opaque string session IDs.
- New timestamp columns must use the current Compose convention: `TIMESTAMP(3)` with millisecond precision. Mutable rows should use `updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`.
- Add named foreign keys for all same-database references unless the migration must be staged for online DDL. If staged, document the follow-up FK migration in the same work order.
- Durable event payloads must be capped by the publisher at 16 KB. Large content belongs in artifacts referenced by URI.
- Token hashes are SHA-256 hex strings and should be stored as `CHAR(64)`.

### 8.1 `compose_session_events`

Purpose: replayable session event log for SSE/EventSource and audit.

```sql
CREATE TABLE compose_session_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  sequence BIGINT NULL,
  payload_json JSON NOT NULL,
  payload_bytes INT NOT NULL DEFAULT 0,
  actor_type VARCHAR(32) NULL,
  actor_id VARCHAR(128) NULL,
  turn_job_id BIGINT NULL,
  agent_task_id BIGINT NULL,
  context_version BIGINT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_session_sequence (session_id, sequence),
  INDEX idx_session_created (session_id, created_at),
  INDEX idx_session_id (session_id, id),
  INDEX idx_turn_job (turn_job_id),
  INDEX idx_agent_task (agent_task_id),
  CONSTRAINT fk_compose_session_events_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id)
);
```

Sequence generation options:

1. Use a per-session sequence table/counter with transaction.
2. Use `id` as global sequence and replay by `id` per session.
3. Store both global `id` and logical `sequence` if existing SSE client needs session-local sequence.

Prefer simplest reliable implementation first. Phase 1 should use global `id` as the SSE `id:` value and leave `sequence` nullable unless the implementation commits to a real per-session counter. Do not create a non-null `sequence` column and then "use `id`" in the route.

### 8.2 Shared Stream Tokens

Chosen implementation: DB-backed token hashes.

The shared token store is `compose_stream_tokens`. Store SHA-256 token hashes,
never plaintext tokens. Revocation is a single session-scoped `UPDATE`, and the
retention worker purges expired rows.

```sql
CREATE TABLE compose_stream_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  session_id BIGINT NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at TIMESTAMP(3) NULL,
  revoked_at TIMESTAMP(3) NULL,
  INDEX idx_session (session_id),
  INDEX idx_expires (expires_at),
  CONSTRAINT fk_compose_stream_tokens_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id)
);
```

Recommendation:

- Store SHA-256 hex hashes, not raw tokens.
- Revoke all session tokens when archiving a protected session.
- Use `compose_stream_tokens` as the authoritative token store; Redis, if added later, is only a cache.

### 8.3 `compose_turn_jobs`

Purpose: durable Compose turn queue for both chat messages and system-initiated analysis.

```sql
CREATE TABLE compose_turn_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  turn_kind ENUM('chat', 'analyze') NOT NULL DEFAULT 'chat',
  user_message_id BIGINT NULL,
  status ENUM(
    'queued',
    'running',
    'waiting_on_research',
    'awaiting_user_input',
    'synthesizing',
    'completed',
    'failed',
    'cancelled',
    'abandoned'
  ) NOT NULL DEFAULT 'queued',
  requested_context_version BIGINT NULL,
  context_version_used BIGINT NULL,
  coordinator_run_id VARCHAR(128) NULL,
  active_worker_id VARCHAR(128) NULL,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMP(3) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  cancellation_requested_at TIMESTAMP(3) NULL,
  clarification_expires_at TIMESTAMP(3) NULL,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  UNIQUE KEY uniq_turn_idempotency (session_id, idempotency_key),
  INDEX idx_claim (status, lease_until, created_at),
  INDEX idx_session_status (session_id, status, created_at),
  INDEX idx_worker (active_worker_id),
  INDEX idx_user_message (user_message_id),
  CONSTRAINT fk_compose_turn_jobs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_turn_jobs_user_message
    FOREIGN KEY (user_message_id) REFERENCES compose_session_messages(id)
);
```

Rules:

- Chat turns have `turn_kind='chat'` and a non-null `user_message_id`.
- Analyze turns have `turn_kind='analyze'` and may have `user_message_id=NULL`, unless the implementation chooses to synthesize a system message row. The DDL must not make `user_message_id` mandatory.
- `idempotency_key` is required. For `POST /messages`, require a client `Idempotency-Key` and dedupe before inserting the user message row. For internal analyze requests, generate a deterministic server-side key such as `analyze:<sessionId>:<requestId>`.
- Do not add `UNIQUE(user_message_id)`. Retry after abandoned turn must be possible, and idempotency is the durable dedupe primitive.
- If `compose_session_messages.id` is not BIGINT today, adapt type to current schema.

### 8.4 Assistant Message Idempotency

Add turn linkage to messages.

```sql
ALTER TABLE compose_session_messages
  ADD COLUMN turn_job_id BIGINT NULL,
  ADD COLUMN context_version_used BIGINT NULL,
  ADD COLUMN agent_task_id BIGINT NULL,
  ADD COLUMN message_kind VARCHAR(32) NULL;
```

Enforce one final assistant message per turn job.

Options:

1. Add generated column/partial unique equivalent if MySQL version supports required pattern.
2. Add a dedicated `compose_turn_outputs` table.
3. Enforce with transaction + locking and defensive query.

Recommended robust option:

```sql
CREATE TABLE compose_turn_outputs (
  turn_job_id BIGINT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  assistant_message_id BIGINT NOT NULL,
  context_version_used BIGINT NULL,
  final_payload_json JSON NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_assistant_message (assistant_message_id),
  INDEX idx_session (session_id),
  CONSTRAINT fk_compose_turn_outputs_turn
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id),
  CONSTRAINT fk_compose_turn_outputs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_turn_outputs_assistant_message
    FOREIGN KEY (assistant_message_id) REFERENCES compose_session_messages(id)
);
```

Write final assistant message and `compose_turn_outputs` in the same DB transaction. If retry sees output exists, do not append a duplicate assistant message.

### 8.5 `compose_agent_tasks`

Purpose: durable specialist task queue.

```sql
CREATE TABLE compose_agent_tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  turn_job_id BIGINT NULL,
  capability VARCHAR(64) NOT NULL,
  executor_type VARCHAR(64) NULL,
  status ENUM(
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'abandoned'
  ) NOT NULL DEFAULT 'queued',
  priority INT NOT NULL DEFAULT 100,
  input_json JSON NOT NULL,
  output_json JSON NULL,
  context_version_used BIGINT NULL,
  output_source_id BIGINT NULL,
  active_worker_id VARCHAR(128) NULL,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMP(3) NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  cancellation_requested_at TIMESTAMP(3) NULL,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  INDEX idx_claim (capability, status, lease_until, priority, created_at),
  INDEX idx_session_created (session_id, created_at),
  INDEX idx_turn_job (turn_job_id),
  INDEX idx_worker (active_worker_id),
  CONSTRAINT fk_compose_agent_tasks_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_agent_tasks_turn
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id),
  CONSTRAINT fk_compose_agent_tasks_output_source
    FOREIGN KEY (output_source_id) REFERENCES compose_session_sources(id)
);
```

Use `capability`, not only `agent_type`, so routing remains flexible.

Phase 5 starts with the smallest useful capability set:

```text
legacy_compose_chat
source_distillation
context_merge
```

Add `chat_coordination`, `code_research`, `config_research`, `devops_research`, `critic_review`, and `handoff_build` in the phase that lands each executor.

### 8.6 Generated Source Support

Decision: extend `compose_session_sources`. It is already the session source inventory, owns conversion state and Markdown content, and has source intelligence metadata. Do not add a companion generated-source table in v3.

```sql
ALTER TABLE compose_session_sources
  MODIFY COLUMN kind ENUM('file','youtube','chat','note','jira','confluence','generated_research') NOT NULL,
  ADD COLUMN source_origin VARCHAR(32) NOT NULL DEFAULT 'user',
  ADD COLUMN generated_by_task_id BIGINT NULL,
  ADD COLUMN parent_source_ids_json JSON NULL,
  ADD COLUMN context_version_used BIGINT NULL,
  ADD COLUMN evidence_json JSON NULL,
  ADD COLUMN confidence VARCHAR(32) NULL,
  ADD COLUMN artifact_uri TEXT NULL,
  ADD COLUMN artifact_sha256 CHAR(64) NULL,
  ADD COLUMN artifact_bytes BIGINT NULL,
  ADD CONSTRAINT fk_compose_session_sources_generated_task
    FOREIGN KEY (generated_by_task_id) REFERENCES compose_agent_tasks(id);
```

Generated research rows enter with `kind='generated_research'`, `source_origin='agent'`, `converter='none'`, and `conversion_status='converted'` after the artifact write protocol verifies the artifact. User-created rows keep `source_origin='user'`.

### 8.7 Context Patches

```sql
CREATE TABLE compose_context_patches (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  source_id BIGINT NULL,
  agent_task_id BIGINT NULL,
  base_context_version BIGINT NULL,
  status ENUM('building', 'ready', 'failed', 'superseded') NOT NULL DEFAULT 'building',
  patch_uri TEXT NULL,
  artifact_sha256 CHAR(64) NULL,
  artifact_bytes BIGINT NULL,
  patch_json JSON NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_session_status (session_id, status, created_at),
  INDEX idx_source (source_id),
  INDEX idx_task (agent_task_id),
  CONSTRAINT fk_compose_context_patches_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_context_patches_source
    FOREIGN KEY (source_id) REFERENCES compose_session_sources(id),
  CONSTRAINT fk_compose_context_patches_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id)
);
```

### 8.8 Context Versions

```sql
CREATE TABLE compose_context_versions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  version BIGINT NOT NULL,
  status ENUM('building', 'committed', 'failed', 'superseded') NOT NULL DEFAULT 'building',
  parent_version BIGINT NULL,
  artifact_uri TEXT NULL,
  structured_artifact_uri TEXT NULL,
  summary_json JSON NULL,
  facts_json JSON NULL,
  open_questions_json JSON NULL,
  decisions_json JSON NULL,
  source_ids_json JSON NULL,
  patch_ids_json JSON NULL,
  created_by_task_id BIGINT NULL,
  artifact_sha256 CHAR(64) NULL,
  artifact_bytes BIGINT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  committed_at TIMESTAMP(3) NULL,
  UNIQUE KEY uniq_session_version (session_id, version),
  INDEX idx_latest (session_id, status, version),
  INDEX idx_task (created_by_task_id),
  CONSTRAINT fk_compose_context_versions_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_context_versions_task
    FOREIGN KEY (created_by_task_id) REFERENCES compose_agent_tasks(id)
);
```

Add to `compose_sessions`:

```sql
ALTER TABLE compose_sessions
  ADD COLUMN latest_context_version BIGINT NULL,
  ADD COLUMN context_status VARCHAR(32) NOT NULL DEFAULT 'dirty',
  ADD COLUMN conversation_summary_uri TEXT NULL;
```

### 8.9 Session Manifest

Do not add a third manifest storage surface in the database. Compute the session manifest on demand from typed tables, and materialize `session-manifest.json` only when a workspace is attached. If a later operational need requires caching, add a separate cache work order with invalidation rules.

### 8.10 LLM Call Audit

```sql
CREATE TABLE spec_factory_llm_calls (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NULL,
  turn_job_id BIGINT NULL,
  agent_task_id BIGINT NULL,
  purpose VARCHAR(64) NOT NULL,
  provider VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  prompt_version VARCHAR(64) NULL,
  context_version_used BIGINT NULL,
  input_tokens BIGINT NULL,
  output_tokens BIGINT NULL,
  total_tokens BIGINT NULL,
  latency_ms BIGINT NULL,
  estimated_cost_usd DECIMAL(12,6) NULL,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(128) NULL,
  redacted_prompt_uri TEXT NULL,
  redacted_response_uri TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_session (session_id, created_at),
  INDEX idx_turn (turn_job_id),
  INDEX idx_task (agent_task_id),
  INDEX idx_provider_model (provider, model, created_at)
);
```

If this table remains named `spec_factory_llm_calls`, treat `session_id`, `turn_job_id`, and `agent_task_id` as optional product correlation IDs and document nullability. If the table becomes Compose-only, rename it to `compose_llm_calls` and add the same named foreign keys as the other Compose tables.

### 8.11 Agent Runtime Runs

```sql
CREATE TABLE compose_agent_runtime_runs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  agent_task_id BIGINT NOT NULL,
  executor_type VARCHAR(64) NOT NULL,
  provider VARCHAR(64) NULL,
  model VARCHAR(128) NULL,
  workspace_uri TEXT NULL,
  trace_uri TEXT NULL,
  output_artifact_uri TEXT NULL,
  status VARCHAR(32) NOT NULL,
  started_at TIMESTAMP(3) NULL,
  completed_at TIMESTAMP(3) NULL,
  input_tokens BIGINT NULL,
  output_tokens BIGINT NULL,
  estimated_cost_usd DECIMAL(12,6) NULL,
  error_code VARCHAR(128) NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_task (agent_task_id),
  INDEX idx_session (session_id, created_at),
  CONSTRAINT fk_compose_agent_runtime_runs_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_agent_runtime_runs_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id)
);
```

---

## 9. Archive and Session Lifecycle Enforcement

Archive enforcement is P0.

### 9.1 Desired Semantics

Product states:

```text
draft
ready
handed_off
archived
```

Operational states:

```text
context_status: clean | dirty | building | failed
active_turn_started_at: NULL means idle; non-NULL means an in-process legacy turn started at that timestamp
```

Archive means:

```text
hidden from normal listing
read behavior depends on product decision
mutations rejected
turn creation rejected
source upload/conversion rejected
agent tasks rejected
handoff rejected
stream tokens revoked
live streams terminated or receive archived event
```

Recommended initial policy:

- Archived sessions are readable only through explicit archived-session read path or admin path.
- Normal `getSession`, source mutation, message creation, handoff, and stream resume reject archived sessions.
- Archive is not hard deletion.
- Retention cleanup can later purge EFS/S3.

### 9.2 Guard Functions

Add centralized guard functions, likely in `compose-service.ts` or new `session-guard.ts`.

Minimum `ActorContext` contract for Phase 0:

```ts
export interface ActorContext {
  id: string; // stable identity (OIDC sub or system worker id)
  display: string; // human-readable label for audit logs
  source: "oidc" | "system"; // where identity came from
  roles: Array<"user" | "admin">; // Phase 0 role set; extend per phase
}
```

Adapter from the current HTTP request:

- Compose routes already derive a `SpecFactoryActor { id, display }` from `x-amzn-oidc-identity` / `x-forwarded-user` in `src/spec-factory/routes.ts` (`actorFromRequest`). Phase 0 wraps this into `ActorContext` as `{ id, display, source: 'oidc', roles }`.
- `roles` is computed at wrap time: `roles = isAdminId(id) ? ['user', 'admin'] : ['user']`.
- Admin identity is sourced from a comma-separated env allowlist `SPEC_FACTORY_ADMIN_IDS`. This is intentionally boring for Phase 0 — OIDC group claims can replace it later without touching the guard contract.
- Background workers construct `ActorContext { id: 'worker:<worker_id>', display: <worker_id>, source: 'system', roles: ['user'] }`. System actors do not get `admin` unless the runbook explicitly whitelists a maintenance worker id.

Phase 0 authorization policy:

- Enforce existence, archived state, protected-session password/token validation, owner/admin visibility for actor-scoped routes, and admin-only archived reads where those routes exist.
- `assertSessionReadable` treats archived sessions as not found on normal routes. OIDC actors may access sessions they created; `SPEC_FACTORY_ADMIN_IDS` actors may access any non-archived session; system actors may access any session only through explicit internal service entry points. Sessions without `created_by` remain readable for backwards compatibility with legacy rows.
- System workers may mutate only through explicit internal service entry points, not by bypassing public route guards.

```ts
export async function assertSessionExists(
  sessionId: number,
): Promise<ComposeSession>;
export async function assertSessionReadable(
  sessionId: number,
  actor: ActorContext,
): Promise<ComposeSession>;
export async function assertSessionMutable(
  sessionId: number,
  actor: ActorContext,
): Promise<ComposeSession>;
export async function assertSessionStreamable(
  sessionId: number,
  actor: ActorContext,
): Promise<ComposeSession>;
export async function assertSessionHandoffAllowed(
  sessionId: number,
  actor: ActorContext,
): Promise<ComposeSession>;
```

Service methods must call these guards instead of duplicating archive checks.

### 9.3 Archive Flow

```text
archive request
  -> assert mutable/admin as needed
  -> lock compose_sessions row
  -> revoke stream tokens
  -> cancel queued/running turns if policy requires
  -> cancel queued agent tasks if policy requires
  -> mark compose_sessions.archived_at
  -> publish durable session.archived event
  -> fan out stream termination/update
```

Token revocation should happen before `archived_at` is committed so protected-session readers cannot keep a valid stream token across archive. Running workers must re-check archived state inside their final write transaction before appending any assistant message or generated artifact.

### 9.4 Tests

Add tests proving archived sessions reject:

- add source
- upload finalize
- conversion trigger
- message send
- turn job creation
- handoff
- stream resume
- protected token validation after archive

---

## 10. Session Events and Streaming

### 10.1 Event Types

Recommended event types:

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
context.merge.degraded
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
policy_denied
coordinator.decision.rejected
assistant.delta
assistant.final
assistant.discarded_due_to_archive
readiness.updated
handoff.started
handoff.completed
error
```

Event names are dot.snake and versioned by shape, not by name. This catalog is canonical for the durable event log and for SSE fanout. Do not introduce a parallel CamelCase vocabulary; §26 references these names verbatim.

### 10.2 Event Publisher Contract

```ts
export interface SessionEventPublisher {
  publish(event: PublishSessionEventInput): Promise<PublishedSessionEvent>;
  replay(
    sessionId: number,
    afterEventId?: string | number,
  ): AsyncIterable<SessionEvent>;
  subscribe(sessionId: number): AsyncIterable<SessionEvent>;
}
```

`publish()` should:

1. Persist event to `compose_session_events`.
2. Publish to the live SSE hub.
3. Return durable event id/sequence.

If live fanout fails after DB insert, do not roll back event. Clients can replay.

### 10.3 SSE Route

New SSE route behavior:

```text
validate stream token/session access
replay missed events from durable store
subscribe to live SSE events
send heartbeat
on disconnect, unsubscribe only
```

Client should be able to resume with `Last-Event-ID` or query parameter.

Replay-to-live bridge algorithm:

```text
1. Resolve resume cursor from Last-Event-ID or ?after=<eventId>.
2. Validate access with assertSessionStreamable.
3. Replay compose_session_events where session_id=? and id > cursor ordered by id.
4. Emit each durable event as SSE with id: <compose_session_events.id>.
5. Subscribe to live fanout for the same session with a paused/max cursor so concurrent live fanout cannot duplicate the gap replay.
6. After subscribe is active, query once more for events with id > lastSentId to close the replay/live race.
7. Emit the gap replay, advance the subscriber's live cursor to the final lastSentId, then emit live events only if event.id > subscriber cursor.
8. Send heartbeat comments until disconnect.
```

Keep the current `/api/spec-factory/compose/sessions/:sessionId/stream` URL as the canonical browser EventSource route and make any `/events` route an alias. EventSource reconnects the same URL, so durable replay must live behind the route the client already uses.

### 10.4 Event Idempotency

Do not rely on client receiving every live event. Clients should tolerate duplicate event ids and missed live fanout by replaying.

---

## 11. Durable Turn Jobs

### 11.1 Current Behavior to Preserve Initially

Current Compose turn flow:

```text
route accepts /messages
service appends user message
publishes SSE
queues in-process promise chain
materializes chat.md/sources/*.md/repositories.md/context.md
runs ComposeChatAgent
stores claude_session_id
appends assistant response
updates readiness
publishes SSE
```

Phase 2 preserves the existing ComposeChatAgent behavior while changing only the turn execution substrate.

### 11.2 New Flow

```text
POST /messages
  -> assertSessionMutable
  -> require/derive idempotency key
  -> transaction:
       find existing job by (session_id, idempotency_key)
       if found, return existing queued/running/completed state
       append user message
       create compose_turn_jobs row
  -> publish message.created + turn.queued events
  -> return accepted/queued response or stream handle

POST /analyze or internal analyze request
  -> assertSessionMutable
  -> require/derive idempotency key
  -> transaction:
       find existing job by (session_id, idempotency_key)
       if found, return existing queued/running/completed state
       if reset=true, delete compose_turn_outputs, compose_turn_jobs, and compose_session_messages for the session
       create compose_turn_jobs row with turn_kind='analyze'
  -> user_message_id may be NULL unless implementation synthesizes a system message row
  -> publish turn.queued event

turn worker
  -> claim queued turn job with lease
  -> mark running
  -> publish turn.started
  -> run legacy ComposeChatAgent adapter
  -> append assistant message idempotently
  -> write compose_turn_outputs row
  -> mark job completed
  -> publish assistant.final + turn.completed
```

### 11.3 Claim Semantics

Use DB transaction or conditional update:

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

The claim query must return the new `lease_generation`. Workers carry `(turn_job_id, lease_generation, worker_id)` through every side-effect boundary.

Heartbeat/renewal:

```sql
UPDATE compose_turn_jobs
SET lease_until = ?,
    updated_at = CURRENT_TIMESTAMP(3)
WHERE id = ?
  AND active_worker_id = ?
  AND lease_generation = ?
  AND status IN ('running', 'waiting_on_research', 'synthesizing');
```

If heartbeat renewal affects zero rows, the worker lost the lease and must stop before the next side effect. Before Bedrock calls, workspace attach/write, `setClaudeSessionId`, generated-source insert, and SSE final publish, reload the job and confirm the same `lease_generation`.

For stale `running` jobs:

```text
if lease expired and no final output exists:
  reset to queued or mark abandoned depending attempt_count/max_attempts
```

Retry fields are part of the Phase 2 DDL. Do not add them as an afterthought because stale recovery and observability depend on them.

### 11.4 Session-Level Serialization

Only one active turn per session unless explicitly designing otherwise.

Options:

1. DB session lock table.
2. Redis lock with DB fallback.
3. Claim query only selects sessions without active running turn.

Recommended simple approach:

- Prefer deriving active state from non-terminal `compose_turn_jobs` where practical.
- If `active_turn_started_at` is kept as a denormalized in-progress marker, never treat it as the only source of truth.
- In transaction, claim next queued turn only if no non-terminal turn exists for session.
- Worker clears `active_turn_started_at` on completion/failure/cancel.
- Stale-job recovery must repair the job row and the session row in the same transaction. If a worker dies after setting `active_turn_started_at`, the stale sweep must either requeue/abandon the expired job and clear the marker, or recompute it from remaining non-terminal jobs.

### 11.5 Idempotent Final Response

Final response write must be idempotent.

Transaction:

```text
begin
  select compose_turn_jobs where id = ? for update
  verify active_worker_id and lease_generation still match
  select compose_sessions.archived_at where id = ? for update
  if archived_at is not null:
    mark turn cancelled
    commit
    publish turn.cancelled/session.archived replay-safe event if needed
    return

  select compose_turn_outputs where turn_job_id = ? for update
  if exists:
    mark turn completed if needed
    commit
    return existing assistant_message_id

  insert assistant message with turn_job_id
  insert compose_turn_outputs(turn_job_id, assistant_message_id)
  mark turn completed
commit
```

Never append an assistant final message before the idempotency guard.

This transaction is the final fence for mid-turn archive and lease races. It prevents stale workers from appending final assistant messages after another worker has claimed the turn or after the session was archived.

### 11.6 Cancellation

Support cancellation flags even if UI does not expose them immediately.

```text
cancel request
  -> set cancellation_requested_at
  -> publish turn.cancelling
  -> worker polls between major steps
  -> mark cancelled if safe
```

Legacy ComposeChatAgent may not be interruptible at fine granularity. Still support cancellation before start and between turns.

---

## 12. Runtime Split

### 12.1 Modes

Use same container image with mode selection.

```text
SPEC_FACTORY_MODE=api
SPEC_FACTORY_MODE=worker
SPEC_FACTORY_MODE=research-worker
SPEC_FACTORY_MODE=conversion-worker
SPEC_FACTORY_MODE=all-local
```

`all-local` is allowed for development only.

Production cutover rule: do not enable `worker`, `research-worker`, or `conversion-worker` modes in separate replicas until the Phase 4 Workspace Manager can attach a materialized shared workspace. The legacy chat executor still depends on a hydrated workspace under `config.workspaceBase`; splitting processes before `WorkspaceManager.attach()` exists creates missing-file and split-brain failures.

### 12.2 API Mode

Runs:

- Express routes
- auth/session validation
- SSE/EventSource route
- public API response streaming

Does not run long processors unless `all-local`.

### 12.3 Worker Mode

Runs:

- durable turn job processor
- agent task processor for light capabilities
- context merge processor
- distillation processor if not split separately

### 12.4 Research Worker Mode

Runs:

- workspace hydration
- Claude Agent SDK research executor
- heavy repo/code/config investigation
- generated source artifact creation

### 12.5 Conversion Worker Mode

Optional split from existing conversion poller:

- MarkItDown sidecar integration
- media conversion
- document conversion
- source state updates

### 12.6 Worker Identity

Every worker should have:

```text
worker_id
mode
task_arn/hostname
started_at
heartbeat_at
capabilities
```

Store in Redis or DB if operational visibility is required.

---

## 13. Workspace Manager

### 13.1 Purpose

Avoid scattering workspace logic across agents.

The Workspace Manager owns:

- session workspace paths
- local scratch paths
- hydration from EFS/S3
- artifact sync
- cleanup
- workspace manifests
- attach/detach metadata
- local lock protection

### 13.2 Interface

```ts
export interface WorkspaceManager {
  getDurableWorkspace(sessionId: number): Promise<DurableWorkspaceRef>;
  attach(input: AttachWorkspaceInput): Promise<AttachedWorkspace>;
  detach(input: DetachWorkspaceInput): Promise<void>;
  syncArtifacts(input: SyncArtifactsInput): Promise<ArtifactSyncResult>;
  writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef>;
  cleanupLocal(sessionId: number): Promise<void>;
}
```

### 13.3 Attach Flow

```text
claim task
  -> workspaceManager.attach(sessionId, purpose)
  -> create /scratch/spec-factory/<sessionId>/<taskId>
  -> hydrate required sources/repo context
  -> produce local workspace manifest
  -> run agent/tool loop
  -> sync generated artifacts
  -> detach
```

### 13.4 Workspace Manifest

`session-manifest.json` example:

```json
{
  "sessionId": 123,
  "latestContextVersion": 17,
  "workspaceVersion": 5,
  "durableWorkspaceUri": "efs://compose/123/workspace",
  "sourceInventory": [
    {
      "sourceId": 1001,
      "kind": "file",
      "status": "converted",
      "markdownUri": "s3://.../sources/1001.md"
    }
  ],
  "generatedResearch": [
    {
      "sourceId": 2001,
      "taskId": 501,
      "artifactUri": "s3://.../generated/research/501.md"
    }
  ],
  "pendingConversions": [],
  "pendingResearch": [],
  "openQuestions": [],
  "updatedAt": "2026-07-05T00:00:00Z"
}
```

The manifest is a derived index. Do not let it become the only source of truth.

### 13.5 Artifact Write Protocol

Use two-phase writes.

```text
1. Create DB row status=building.
2. Write artifact to temp URI:
   s3://.../.tmp/<uuid>.md
3. Verify size/checksum.
4. Update DB row with artifact_uri, artifact_sha256, artifact_bytes, and status=ready/committed.
5. Optionally copy/rename to final URI.
6. Delete temp artifact best-effort.
```

Never hold DB transaction while writing to S3/EFS.

Artifact verification means re-reading or statting the written object, recalculating SHA-256, and comparing byte length before the DB row is marked ready. Trace and prompt artifacts must pass through shared `security/redaction.ts` before this protocol writes them. Temporary artifacts that are not linked from ready/committed DB rows are cleaned by `compose-artifact-gc.ts`.

---

## 14. Capability Registry and Agent Executors

### 14.1 Why Capability Registry Exists

Do not hardcode product logic to `Claude SDK` or `OpenAI`.

Use capabilities:

```text
code_research
config_research
devops_research
source_distillation
context_merge
critic_review
chat_coordination
legacy_compose_chat
handoff_build
```

Map capabilities to executors through configuration.

### 14.2 Capability Registry

This is the target union over the full roadmap, not the Phase 5 starting set. Add capability names in the same PR that lands their executor and queue behavior.

```ts
export type CapabilityName =
  | "legacy_compose_chat"
  | "chat_coordination"
  | "code_research"
  | "config_research"
  | "devops_research"
  | "source_distillation"
  | "context_merge"
  | "critic_review"
  | "handoff_build";

export interface CapabilityDefinition {
  name: CapabilityName;
  executorType: string;
  queue: "turn" | "agent-task" | "research" | "context";
  defaultPriority: number;
  maxRuntimeSeconds: number;
  maxAttempts: number;
  requiresWorkspace: boolean;
  requiresContextVersion: boolean;
  producesGeneratedSource: boolean;
}
```

### 14.3 Agent Executor Interface

```ts
export interface AgentExecutor<TInput, TOutput> {
  run(
    input: TInput,
    ctx: AgentExecutionContext,
  ): AsyncIterable<AgentExecutionEvent<TOutput>>;
}

export type AgentExecutionEvent<TOutput> =
  | { type: "status"; message: string }
  | { type: "tool_call"; tool: string; summary: string; raw?: unknown }
  | { type: "partial"; text: string }
  | { type: "artifact"; artifact: TOutput }
  | {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }
  | { type: "error"; error: string };
```

### 14.4 Initial Executors

```text
LegacyComposeChatExecutor
  - wraps existing ComposeChatAgent
  - used by durable turn jobs during migration

ClaudeAgentSdkResearchExecutor
  - uses Claude Agent SDK
  - code/config/repo investigation
  - writes generated research source

ContextMergeExecutor
  - deterministic merge plus optional LLM assist
```

Do not add a separate `DirectLlmExecutor` wrapper in v1. Distillation, critic, context patching, and coordinator code should depend on `LlmGateway` directly. Add an executor wrapper only if direct LLM work later needs queue/runtime behavior that the gateway does not provide.

### 14.5 Routing Rule

Use this rule:

```text
If the task is "think over provided context and produce structured output", use LLM Gateway.

If the task is "explore a codebase with tools over many turns", use Agent Executor, with Claude Agent SDK as v1 implementation.

If the task is "coordinate durable session state", use Spec Factory DB/jobs/events, not an agent framework.
```

---

## 15. LLM Gateway

### 15.1 Placement in Plan

LLM Gateway is Phase 8, not Phase 0.

Before Phase 8, define interfaces if needed, but do not restructure live chat around it until durable turns/events exist.

### 15.2 Purpose

LLM Gateway centralizes direct LLM calls for:

- Chat Coordinator
- Distillation Agent
- Critic Agent
- context patching
- context merge assist
- conversation summary
- handoff synthesis

It should not own Claude Agent SDK internals.

### 15.3 Interface

```ts
export interface LlmGateway {
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>;
  streamText(req: StreamTextRequest): AsyncIterable<LlmStreamEvent>;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;
}
```

### 15.4 Provider Adapters

Initial adapters:

```text
BedrockProvider
```

Provider-specific APIs stay behind adapters. Ship Bedrock-only in Phase 8 because the current runtime constraint is Bedrock-only. Add OpenAI or direct Anthropic adapters only after a real reliability, availability, or product requirement justifies them.

### 15.5 Model Router

Route by purpose, not hardcoded model references.

```ts
export type LlmPurpose =
  | "chat_coordinator_fast"
  | "chat_coordinator_strong"
  | "source_distillation"
  | "context_merge"
  | "critic_review"
  | "handoff_synthesis"
  | "conversation_summary";
```

Example config:

```ts
const modelRoutes = {
  chat_coordinator_fast: {
    primary: { provider: "bedrock", model: "claude-fast" },
    fallback: [],
    requireStructuredOutput: true,
  },
  source_distillation: {
    primary: { provider: "bedrock", model: "claude-strong" },
    fallback: [],
    requireStructuredOutput: true,
  },
};
```

### 15.6 Logging and Redaction

Every direct LLM call writes `spec_factory_llm_calls`.

Prompt/response artifacts must be redacted before storage unless `SPEC_FACTORY_LLM_PROMPT_LOGGING=full` and `SPEC_FACTORY_LLM_SECURE_DEBUG=true` are explicitly enabled in a non-production debug environment. The gateway must reject full logging when `NODE_ENV=production`.

Never log secrets from source files, configs, environment variables, credentials, or access tokens.

Gateway pre-flight must enforce model allowlist, per-call max tokens, per-session budget, and per-day tenant/user budget before making the Bedrock request.

### 15.7 LLM Gateway as Library First

Start as in-process TypeScript module.

Do not create a separate HTTP microservice unless there is a clear need for:

- multi-language clients
- org-wide model governance
- centralized key custody
- shared quotas across products
- independent LLM operations team

A central service adds latency and operational dependency. Library first is the right v1.

---

## 16. Framework Decision

### 16.1 Recommended Stack

```text
Spec Factory durable orchestration
  - MySQL jobs + leases
  - live SSE fanout, with optional Redis pub/sub/locks later
  - EFS/S3 artifacts
  - versioned working context
  - session/task state owned by Spec Factory

LLM Gateway module
  - Bedrock direct calls first
  - provider adapter boundary for future expansion
  - structured output
  - streaming
  - retries
  - telemetry
  - cost/rate controls

Claude Agent SDK research workers
  - heavy codebase exploration
  - rg/git/read/shell tools
  - ephemeral workspace
  - generated research artifact output
```

### 16.2 Do Not Use as System Spine

Do not make these the durable orchestration backbone:

- LangChain/LangGraph
- Google ADK
- AutoGen
- Microsoft Agent Framework
- OpenAI Agents SDK

They may be useful inside a worker later, but they should not own Spec Factory session state.

### 16.3 Claude Agent SDK Usage

Use Claude Agent SDK for heavy codebase/repo research only.

It is a runtime adapter, not the product state store.

Research worker owns:

```text
workspace hydration
tool permissions
Claude Agent SDK run
trace capture
artifact writing
generated source creation
```

### 16.4 Framework Escape Hatch

Future worker-local frameworks are acceptable only inside a claimed task after Spec Factory owns durable state, leases, artifacts, events, and retries. They must not become the system spine.

---

## 17. Source Ingestion and Conversion

Existing conversion is already near target.

### 17.1 Existing Flow to Preserve

```text
source row pending/converting
  -> DB lease claim
  -> MarkItDown sidecar / ffmpeg / Voxtral as needed
  -> write converted Markdown
  -> update source status converted|failed|unsupported
  -> retry with future lease/backoff
```

### 17.2 Add Post-Conversion Events

When conversion completes:

```text
same DB transaction:
  update source conversion_status
  insert source.conversion.completed event
  insert source_distillation task if feature flag enabled
  mark context dirty
```

If the process crashes after conversion status commit but before task enqueue, the session silently misses context distillation. Avoid that by using the same transaction or an outbox row consumed by the task processor.

### 17.3 Source States

Preserve current source lifecycle but ensure events are emitted for meaningful transitions.

Current `compose_session_sources.conversion_status` is conversion state, not source lifecycle. Preserve the current conversion status set:

```text
awaiting_upload
pending
converting
converted
failed
unsupported
```

Generated sources may enter as `converted` immediately because artifact already exists.

If per-source archive/soft-delete is needed later, add a separate source lifecycle field such as `source_status`, `deleted_at`, or `archived_at`. Do not add `archived` to `conversion_status`.

### 17.4 Degraded Conversion Policy

Failed or oversized conversions remain visible to the coordinator as degraded sources:

```text
converted source -> include markdown/artifact in context
failed source -> include filename/type/error summary in readiness and coordinator prompts
unsupported source -> include metadata only, with user-visible remediation
oversized media -> include size/provider limit and no retry until user changes input
```

The coordinator must not assume every uploaded source has converted Markdown. Readiness should distinguish "not ready because conversion is running" from "ready with degraded evidence because conversion failed or is unsupported."

---

## 18. Generated Research Sources

### 18.1 Principle

Research output is not transient assistant chatter.

It is a generated source artifact.

```text
research task
  -> research artifact markdown/json
  -> generated_research source row
  -> source_distillation task
  -> context patch
  -> context merge
  -> working_context_vN+1
```

### 18.2 Artifact Shape

Markdown artifact:

```md
# Research Artifact

## Task

## Context Version Used

## Summary

## Findings

Each finding should include claim, evidence, confidence, and caveats.

## Evidence

- file paths and line numbers
- command outputs
- source references

## Files Inspected

## Commands / Tools Used

## Open Questions

## Suggested Next Tasks
```

JSON sidecar:

```json
{
  "taskId": 501,
  "sessionId": 123,
  "contextVersionUsed": 17,
  "capability": "code_research",
  "summary": "...",
  "findings": [
    {
      "claim": "Retry count is overridden in staging config.",
      "evidence": [
        {
          "type": "code",
          "path": "config/staging/retry.yml",
          "lineStart": 14,
          "lineEnd": 14
        }
      ],
      "confidence": "high"
    }
  ],
  "openQuestions": [],
  "suggestedNextTasks": []
}
```

### 18.3 Immediate vs Durable Use

A research result can be used immediately for the current answer.

It still must enter the generated-source pipeline for future context.

```text
interactive path:
  research result -> coordinator synthesis -> assistant answer

memory path:
  research result -> generated source -> distillation -> context merge
```

---

## 19. Working Context System

### 19.1 Purpose

Working Context is the canonical session intelligence consumed by the future Chat Coordinator and handoff builder.

It should not be a random growing essay.

### 19.2 Markdown Shape

```md
# Working Context

## Objective

## Problem Statement

## Known Facts

Each fact should include evidence and confidence.

## Current Implementation Findings

## User Requirements

## Constraints

## Decisions

## Open Questions

## Conflicts

## Risks and Unknowns

## Source Inventory

## Generated Research Inventory

## Recommended Next Actions
```

### 19.3 Structured Sidecar

Store JSON sidecar with:

```json
{
  "objective": "...",
  "problemStatement": "...",
  "facts": [],
  "implementationFindings": [],
  "requirements": [],
  "constraints": [],
  "decisions": [],
  "openQuestions": [],
  "risks": [],
  "sources": [],
  "generatedResearch": [],
  "recommendedNextActions": []
}
```

### 19.4 Context Patch Flow

```text
source converted/generated
  -> source_distillation task
  -> context patch artifact
  -> context patch row status=ready
  -> context_merge task
  -> context version row status=building
  -> write working_context temp artifact
  -> verify
  -> commit context version
  -> update compose_sessions.latest_context_version
  -> publish context.updated
```

### 19.5 Conflict Handling

Context Merger must detect:

- new source contradicts old fact
- research contradicts prior assistant answer
- generated research lacks evidence
- source is stale/deprecated
- claim has low confidence

Conflicts should appear in Working Context, not be silently resolved by overwriting.

---

## 20. Context Merge Two-Phase Protocol

Do not write artifacts inside DB transactions.

### 20.1 Safe Protocol

```text
1. Claim context_merge task.
2. Load latest committed context metadata.
3. Load ready patches.
4. Acquire session-level merge exclusion by inserting/claiming a single running merge task for the session.
5. Insert compose_context_versions row status=building.
6. Build markdown/json in memory or local temp file.
7. Write temp artifacts to S3/EFS outside DB transaction.
8. Verify artifact exists/checksum/size.
9. In DB transaction:
     - update context version artifact URIs and status=committed
     - update compose_sessions.latest_context_version only where latest_context_version < new_version
     - mark consumed patches superseded/merged if needed
     - update context_status clean/dirty as appropriate
10. Publish context.updated event.
```

The merge claim must coalesce duplicate ready patches for a session. Use a unique active-merge guard, for example `INSERT ... SELECT ... WHERE NOT EXISTS(active merge for session)`, so N ready patches do not create N racing context merges.

### 20.2 Failure Modes

If artifact write fails:

```text
mark context version failed
leave latest_context_version unchanged
retry or surface context build failure
```

If DB commit fails after artifact write:

```text
leave temp artifact orphaned
retry task may create new artifact
compose-artifact-gc.ts removes orphan temp artifacts later
```

If publish fails:

```text
DB is source of truth
clients can poll/replay later
```

---

## 21. Chat Coordinator Design

### 21.1 Placement

Do not replace ComposeChatAgent until durable turns/events, agent tasks, generated sources, context versions, and LLM Gateway exist.

### 21.2 Migration Strategy

Introduce `ChatCoordinator` as a compatibility layer.

Initial routing:

```text
100% -> LegacyComposeChatExecutor
```

Intermediate routing:

```text
simple summary/status questions -> ChatCoordinator direct answer
implementation/repo questions -> research task + synthesis
unsupported/legacy cases -> LegacyComposeChatExecutor
```

Final routing:

```text
all turns -> ChatCoordinator
research dispatched as needed
legacy agent removed or retained as fallback
```

### 21.3 Context Bundle

Coordinator input is built by backend, not by reading arbitrary folder files.

```ts
export interface CoordinatorContextBundle {
  sessionId: number;
  userMessage: string;
  requestedContextVersion: number | null;
  contextVersionUsed: number | null;
  workingContextMarkdown?: string;
  workingContextStructured?: unknown;
  recentMessages: ComposeMessage[];
  conversationSummary?: string;
  sourceStatus: SourceStatusSummary;
  generatedResearch: GeneratedResearchSummary[];
  // Includes queued/running and recent terminal linked research tasks so
  // resumed turns do not blindly redispatch failed or completed work.
  pendingTasks: AgentTaskSummary[];
  capabilities: CapabilityDefinition[];
}
```

Do not include vector-retrieved `relevantArtifacts` in the v1 coordinator contract. Add retrieval only after a vector provider, interface, and phase are selected.

### 21.4 Coordinator Decision Schema

```ts
export type CoordinatorDecision =
  | {
      action: "answer";
      answer: string;
      confidence: "low" | "medium" | "high";
      contextVersionUsed: number | null;
    }
  | {
      action: "dispatch_research";
      userVisibleStatus: string;
      researchTasks: Array<{
        capability: "code_research" | "config_research" | "devops_research";
        question: string;
        requiredEvidence: boolean;
        maxCostUsd: number;
      }>;
      synthesisInstructions: string;
    }
  | {
      action: "ask_clarification";
      question: string;
      reason: string;
      expiresAt: string;
    }
  | {
      action: "escalate";
      reason: string;
    };
```

`researchTasks.length` is capped at `SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN` (default 3) and enforced after the coordinator returns a decision, before any task rows are inserted. Over-limit decisions are rejected and a `coordinator.decision.rejected` event is published. `maxCostUsd` is per task; coordinator-driven research also checks the session's rolling committed LLM spend, completed research runtime spend, and queued/running task reservations before enqueue. If the product lacks a tenant identifier, tenant budget enforcement MUST use a conservative `global` or `unknown` bucket and must not replace the per-session guard.

`use_legacy` is a migration router decision, not a durable coordinator action. Route to `LegacyComposeChatExecutor` before invoking the coordinator. The coordinator's permanent escape hatch is `escalate`, which means "cannot answer safely with current tools/context."

For `ask_clarification`, the turn transitions to `awaiting_user_input`, clears the active lease, stores `clarification_expires_at`, and publishes `turn.awaiting_user_input`. Stale sweep must not requeue this turn until the expiry passes. When the user answers, create a new message linked to the parked turn or create a follow-up turn according to product UX.

### 21.5 Per-Turn Context Freeze

At queue time:

```text
record requested_context_version from latest committed context visible to the API
```

At worker claim time:

```text
reload latest committed context version
set context_version_used to the worker-authoritative version selected for execution
record both requested_context_version and context_version_used on the job
```

If context updates mid-turn, do not mix versions inside the same answer. Use new version next turn or explicitly notify user after completion. If `requested_context_version` and `context_version_used` differ, the event payload should expose the drift so the UI/debugger can explain why the answer used newer context than the request originally saw.

---

## 22. Legacy Compose Agent Compatibility

### 22.1 Why It Stays Temporarily

The current ComposeChatAgent can directly inspect the materialized workspace and attached repos. Removing it too early would regress code-grounded answers.

### 22.2 Legacy Adapter

Wrap current behavior in `LegacyComposeChatExecutor`.

```text
turn job -> legacy executor -> existing workspace materialization -> ComposeChatAgent -> assistant response
```

### 22.3 Required Changes

Even while legacy agent remains:

- turn execution must be durable
- final assistant output must be idempotent
- SSE events must be durable/replayable
- archive checks must be enforced
- `claude_session_id` must not be treated as product source of truth

### 22.4 Deprecation

Once Chat Coordinator + research worker handles implementation questions reliably, gradually reduce legacy path.

---

## 23. Research Worker Design

### 23.1 Purpose

Research worker performs heavy investigation:

- codebase RCA
- current implementation inspection
- config analysis
- repository search
- evidence-backed findings

### 23.2 Runtime

Use Claude Agent SDK for v1 research loops.

Do not use Claude Agent SDK for Chat Coordinator/direct distillation calls.

### 23.3 Input Contract

```json
{
  "taskId": 501,
  "sessionId": 123,
  "capability": "code_research",
  "question": "Check current implementation of retry behavior.",
  "contextVersionUsed": 17,
  "workingContextUri": "s3://.../working_context_v17.md",
  "workspaceRef": {
    "durableUri": "efs://.../123/workspace"
  },
  "constraints": {
    "readOnly": true,
    "maxRuntimeSeconds": 180,
    "maxTurns": 40,
    "maxToolCalls": 80,
    "maxCostUsd": 3.0
  }
}
```

### 23.4 Tool Policy

Initial allowlist is narrow and tool-based. Allowed by default:

```text
Read
Grep (also accepted as rg/ripgrep in SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS)
Glob
```

`Bash` is denied by default. If an operator explicitly includes `Bash`, commands
must match anchored, metacharacter-free patterns in
`SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS`. Examples that may be allowlisted
for controlled read-only environments:

```text
git grep
git status
git diff --stat
cat
sed
head
tail
find with bounded scope
ls
tree with bounded depth
language-specific read-only inspection commands
```

Restricted or denied by default:

```text
rm
mv
chmod
chown
curl
wget
ssh
aws
docker
kubectl
terraform apply
package install commands
commands that write outside workspace
network access unless explicitly allowed
```

Enforcement primitives:

- Use Claude Agent SDK tool permission hooks such as `canUseTool` or `PreToolUse` if available in the pinned SDK version.
- Execute read-only research workspaces with network disabled by default.
- Treat `readOnly` as more than `allowWrite=false`; shell commands must be filtered before execution.
- Deny metadata service access (`169.254.169.254`) even when general network is enabled for a specific task.
- Persist denied tool attempts in the task trace after redaction.

### 23.5 Output

The research worker writes:

- Markdown artifact
- JSON sidecar
- redacted tool trace JSONL
- generated source row
- task output JSON
- session events

Trace capture must use the shared redaction module before the two-phase artifact write. Raw SDK traces can contain copied `.env`, token, or config output and must not be persisted directly.

---

## 24. Distillation Agent

### 24.1 Purpose

Distillation consumes user sources and generated research sources and produces structured context patches.

It is a ghost agent. It does not speak directly in chat.

### 24.2 Input

```json
{
  "sessionId": 123,
  "sourceId": 2001,
  "sourceKind": "generated_research",
  "sourceMarkdownUri": "s3://.../research_501.md",
  "baseContextVersion": 17
}
```

### 24.3 Output

```json
{
  "problemStatementAdditions": [],
  "facts": [],
  "implementationFindings": [],
  "requirements": [],
  "constraints": [],
  "decisions": [],
  "openQuestions": [],
  "risks": [],
  "conflicts": []
}
```

### 24.4 Rules

- Preserve provenance.
- Separate facts from hypotheses.
- Do not treat generated research as unquestionably true.
- Include confidence and evidence.
- Flag contradictions.

---

## 25. Handoff Builder

### 25.1 Current Behavior to Preserve

Existing handoff creates/reuses `COMPOSE-<sessionId>`, links once, sets session status `handed_off`, and queues the shared draft job.

Keep this behavior.

### 25.2 Shipped Bounded Summary

`SPEC_FACTORY_HANDOFF_ENRICHED=true` enables a deterministic service-side builder that writes a bounded `spec_factory_sources.source_summary` value for `COMPOSE-<sessionId>`. The summary is capped to the legacy `VARCHAR(255)` column and includes:

```text
session name
readiness state
source count
generated research count
latest context version
first open question
```

The same flag also writes deterministic handoff artifacts under the session
workspace and stores them in the evidence snapshot for the synthetic Compose
source. When a committed Working Context exists, the artifacts include its
structured projection: objective, problem statement, facts, context open
questions, decisions, source ids, patch ids, and artifact URIs.

```text
handoff/handoff-v1.md
handoff/handoff-v1.json
```

### 25.3 Handoff Narrative Fields

The queued `handoff_build` worker can add generated narrative fields and
evidence maps on top of the deterministic session/readiness/source inventory
and Working Context projection when both flags are enabled:

```text
SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true
SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS=true
SPEC_FACTORY_LLM_GATEWAY=true
```

```text
latest working context
problem statement
known facts
decisions
requirements
constraints
open questions
source inventory
generated research summaries
evidence map
chat summary
```

Artifacts:

```text
compose/<sessionId>/handoff/handoff_v1.md
compose/<sessionId>/handoff/handoff_v1.json
```

`SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true` moves the deterministic artifact,
evidence-snapshot, and draft-generation work onto the `handoff_build`
agent-task executor after `COMPOSE-<sessionId>` is created or reused. The route
still returns the synthetic source id immediately; the worker writes the same
`handoff-v1.md` / `handoff-v1.json` artifacts and requests draft generation
after the evidence snapshot is committed. When
`SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS=true`, the worker first calls LLM Gateway
purpose `handoff_synthesis@v1` for executive summary, implementation brief,
evidence map, and open-question fields, then persists those fields in both
handoff artifacts before creating the evidence snapshot.

### 25.4 Handoff Flow

```text
handoff request
  -> assertSessionHandoffAllowed
  -> ensure no blocked sources
  -> optionally build bounded summary when SPEC_FACTORY_HANDOFF_ENRICHED=true
     and queued handoff is off
  -> load latest committed Working Context projection if present
  -> optionally create handoff bundle artifacts
  -> create/reuse COMPOSE-<sessionId> source
  -> link once
  -> either queue handoff_build when SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true
     or queue existing draft job synchronously
  -> publish handoff.started and handoff.completed events
```

---

## 26. Event Integration Discipline

### 26.1 Why

Do not add a second "event bus" layer separate from `SessionEventPublisher`, `compose_session_events`, and `compose_agent_tasks`. Use those existing abstractions as the integration surface:

- `compose_session_events` is the durable user/session replay log.
- The SSE hub is live fanout only.
- `compose_agent_tasks` is durable background work.
- Same-transaction inserts or an outbox pattern connect state transitions to task creation.

### 26.2 Event Vocabulary

The canonical event catalog lives in §10.1. All handler names, DB rows, SSE frames, and log messages use those `dot.snake` identifiers verbatim. Do not introduce a parallel CamelCase or PascalCase vocabulary (e.g. `SourceConverted`, `TurnQueued`) — those names are not recognized by any component in this plan.

If a new event type is needed, add it to §10.1 and reference it from here.

### 26.3 Event Handler Examples

Handlers are ordinary functions that react to a durable event or to a task-completion transition. Each handler MUST either (a) run in the same DB transaction as the state change that triggered it, or (b) be safely retryable via a reconciler because durable state is authoritative.

```text
on source.conversion.completed:
  same-transaction outbox (see §17.2):
    UPDATE compose_session_sources SET conversion_status='converted'
    INSERT compose_agent_tasks (capability='source_distillation', ...)
    INSERT compose_session_events (event_type='source.conversion.completed', ...)
  post-commit best-effort:
    live fanout of the event row
    mark compose_sessions.context_status='dirty'

on task.completed WHERE capability='code_research':
  create generated source (source_origin='agent')
  INSERT compose_agent_tasks (capability='source_distillation', ...)
  publish task.completed (already inserted; this note is for clarity)

on context.patch.created:
  coalesced enqueue (see §20.3):
    INSERT compose_agent_tasks (capability='context_merge', ...)
      WHERE NOT EXISTS (queued/running merge for the same session)

on context.updated:
  live SSE fanout (durable row already exists)
  invalidate workspace manifest cache; regenerate on next attach
```

### 26.4 Event Discipline

Events should not contain huge payloads. Store artifacts in S3/EFS and reference them by URI.

Publisher must reject or artifact-spill event payloads over 16 KB, and the database schema records `payload_bytes`.

Events should be idempotent. Handlers must tolerate duplicate delivery.

---

## 27. API Changes

### 27.1 Message Send

Current route can keep same public shape but internally creates a durable turn job.

Response options:

```json
{
  "messageId": 123,
  "turnJobId": 456,
  "status": "queued"
}
```

If existing clients expect immediate response, keep compatibility by returning queued state and streaming the final answer through SSE.

#### Idempotency-Key contract

Every turn-producing mutation (`POST /messages`, `POST /analyze`, any future `POST` that enqueues a turn) MUST accept a client `Idempotency-Key` header:

- Format: opaque ASCII string, 1–128 chars, `[A-Za-z0-9._~+/-]+`. Clients typically use a UUIDv4 or ULID.
- Requirement: header is REQUIRED. Requests without it are rejected with `400 idempotency_key_required` starting in Phase 2. Legacy clients that cannot set the header MAY be granted a temporary server-derived key of `sha256(session_id + user_message_id + wallclock_bucket)`; feature-flag this bridge (`SPEC_FACTORY_IDEMPOTENCY_KEY_OPTIONAL`) and remove it before durable turns flip to `on`.
- Uniqueness: `(session_id, idempotency_key)` is unique. `idempotency_key` is `NOT NULL` in `compose_turn_jobs` — see §8.3.
- Server behavior: turn creation looks up the key BEFORE inserting a user-message row. If the key already resolved a turn, return the prior `{ messageId, turnJobId, status }` verbatim. Otherwise, in a single transaction, insert the user-message row, the `compose_turn_jobs` row, and (if implementing a companion table instead of the plain `UNIQUE`) the idempotency-mapping row. This preserves durable idempotency before queueing rather than relying on the legacy `appendMessage → enqueueTurn` order.
- Retention: keep resolved keys for at least 24h. After that clients must generate a new key for a genuinely new request.
- Conflict semantics: if the same `Idempotency-Key` is reused with a different request body, respond `409 idempotency_key_reused` and do not create a second turn. Body comparison MAY use a hash of the normalized payload stored alongside the mapping row.
- Bridge to `/analyze`: internal analyze requests generate a deterministic server-side key of the form `analyze:<sessionId>:<requestId>` and follow the same dedup path as external POSTs.

### 27.2 SSE Resume

Support:

```text
GET /api/spec-factory/compose/sessions/:sessionId/stream?after=<eventId>&token=<streamToken>
```

or standard `Last-Event-ID`.

Keep `/api/spec-factory/compose/sessions/:sessionId/stream` as the canonical EventSource route. A separate `/events` URL may exist only as an alias.

### 27.3 Archive

Archive route must revoke tokens and reject future normal reads/mutations.

### 27.4 Task Status

Optional internal/debug endpoint:

```text
GET /api/spec-factory/compose/sessions/:sessionId/tasks
```

Use with permission controls.

---

## 28. Feature Flags

Recommended flags:

```text
SPEC_FACTORY_DURABLE_EVENTS=false
SPEC_FACTORY_DURABLE_TURNS=off|shadow|drain|on
SPEC_FACTORY_MODE=all-local
SPEC_FACTORY_AGENT_TASKS=false
SPEC_FACTORY_WORKSPACE_MANAGER=false
SPEC_FACTORY_GENERATED_RESEARCH=false
SPEC_FACTORY_CONTEXT_VERSIONS=false
SPEC_FACTORY_LLM_GATEWAY=false
SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS=<optional positive integer global cap>
SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD=<optional numeric per-session ceiling>
SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD=<optional numeric global UTC-day ceiling>
SPEC_FACTORY_CHAT_COORDINATOR=false
SPEC_FACTORY_RESEARCH_EXECUTOR=none|claude_agent_sdk
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=false
SPEC_FACTORY_ENABLE_CONTEXT_MERGE=false
SPEC_FACTORY_ENABLE_CRITIC=false
SPEC_FACTORY_CRITIC_MAX_COST_USD=<optional numeric per-call ceiling>
SPEC_FACTORY_CRITIC_TIMEOUT_MS=<optional integer ms>
SPEC_FACTORY_HANDOFF_ENRICHED=false
SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=false
SPEC_FACTORY_LLM_PROMPT_LOGGING=none|redacted|full
SPEC_FACTORY_LLM_SECURE_DEBUG=false
SPEC_FACTORY_ADMIN_IDS=<comma-separated OIDC sub ids>
SPEC_FACTORY_IDEMPOTENCY_KEY_OPTIONAL=false
SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN=3
SPEC_FACTORY_COORDINATOR_MAX_COST_USD=<optional numeric per-call ceiling; defaults to 0.25 when LLM Gateway cost ceilings are enabled>
SPEC_FACTORY_RESEARCH_MAX_COST_USD=3.0
SPEC_FACTORY_RESEARCH_COST_CEILING_USD=<numeric per-session ceiling>
SPEC_FACTORY_RESEARCH_TASKS_PER_24H=<numeric per-session rolling ceiling>
SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION=3
SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD=<optional numeric global 24h ceiling>
SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H=<optional numeric global rolling ceiling>
SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS=<optional numeric global in-flight ceiling>
COMPOSE_RETENTION_CLEANUP_ENABLED=false
COMPOSE_WORKSPACE_RETENTION_DAYS=30
COMPOSE_CLEANUP_LIMIT=50
COMPOSE_CLEANUP_DRY_RUN=false
COMPOSE_RETENTION_SWEEP_MS=21600000
COMPOSE_ARTIFACT_TMP_RETENTION_HOURS=24
COMPOSE_ARTIFACT_GC_LIMIT=500
COMPOSE_ARTIFACT_GC_MAX_DEPTH=6
COMPOSE_S3_REACHABILITY_GC_ENABLED=false
COMPOSE_S3_REACHABILITY_GC_LIMIT=1000
```

`SPEC_FACTORY_MODE` is a runtime selector, not a boolean feature flag; it appears here only so operators see the full env surface in one place. See §12.1 for its enum.

Flags should allow incremental rollout and rollback.

Stream-token storage is no longer feature-gated. Protected-session resume always
mints a random plaintext token once, stores only its SHA-256 hash in
`compose_stream_tokens`, verifies against that table, and revokes active rows
before archive commits. There is no remaining in-process token verifier in this
branch; rolling upgrades should therefore deploy the DB-backed code before
relying on protected-session cross-replica continuity.

Durable turn cutover:

```text
off    -> legacy in-memory queue only
shadow -> write durable turn rows/events, but legacy queue executes
drain  -> stop accepting new legacy in-memory turns, wait until legacy_inflight==0
on     -> durable workers execute turns
```

Expose `legacy_inflight`, `durable_queued`, `durable_running`, and `durable_abandoned` metrics. Do not advance from `drain` to `on` until `legacy_inflight==0` across all API replicas.

---

## 29. Module Refactor Plan

### 29.1 Keep Public Service Layer Thin

`compose-service.ts` should stop being the god object.

Target responsibilities:

```text
createSession
getSession
addSource
postMessage
handoff
archiveSession
```

It should delegate to specialized services.

### 29.2 New Modules

```text
src/spec-factory/session/session-guard.ts
src/spec-factory/session/session-store.ts
src/spec-factory/session/context-builder.ts
src/spec-factory/session/context-version-service.ts
src/spec-factory/session/session-events.ts
src/spec-factory/session/retention-policy.ts

src/spec-factory/streaming/session-event-publisher.ts
src/spec-factory/streaming/session-event-store.ts
src/spec-factory/streaming/redis-session-pubsub.ts
src/spec-factory/streaming/stream-token-store.ts
src/spec-factory/streaming/sse-router.ts

src/spec-factory/jobs/turn-job-store.ts
src/spec-factory/jobs/turn-job-processor.ts
src/spec-factory/jobs/agent-task-store.ts
src/spec-factory/jobs/agent-task-processor.ts
src/spec-factory/jobs/context-merge-processor.ts

src/spec-factory/workspace/workspace-manager.ts
src/spec-factory/workspace/workspace-sync.ts
src/spec-factory/workspace/workspace-manifest.ts
src/spec-factory/compose-artifact-gc.ts

src/spec-factory/agents/capability-registry.ts
src/spec-factory/agents/executor-registry.ts
src/spec-factory/agents/executors/agent-executor.ts
src/spec-factory/agents/executors/legacy-compose-chat-executor.ts
src/spec-factory/agents/executors/claude-agent-sdk-research-executor.ts
src/spec-factory/agents/distillation-agent.ts
src/spec-factory/agents/context-merger.ts
src/spec-factory/agents/chat-coordinator.ts
src/spec-factory/agents/critic-agent.ts

src/spec-factory/llm/llm-gateway.ts
src/spec-factory/llm/model-router.ts
src/spec-factory/llm/provider-adapters/bedrock-provider.ts
src/spec-factory/llm/llm-usage-recorder.ts
src/spec-factory/llm/prompt-registry.ts

src/spec-factory/security/redaction.ts
```

Prompt registry must resolve prompts by stable `purpose@vN` identifiers. Current implementation ships both a static in-code registry and durable `spec_factory_prompt_versions` storage. `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=static|db` selects the source; DB mode resolves active defaults by purpose and rejects provider calls when the registry store is unavailable.

### 29.3 Existing Modules to Adapt

```text
compose-routes.ts
  - call session guards
  - create durable turn jobs
  - use new SSE router/token store

compose-service.ts
  - remove in-memory queues eventually
  - delegate events/jobs/tokens/workspaces

compose-sse.ts
  - replace or wrap with durable event publisher/subscriber

compose-database.ts
  - add stores for new tables
  - keep conversion lease logic

compose-conversion.ts
  - emit events
  - enqueue distillation when enabled

compose-chat-agent.ts
  - preserve behind LegacyComposeChatExecutor until migration complete
```

---

## 30. Observability

### 30.1 Required Logs

Every important operation logs structured fields:

```text
session_id
turn_job_id
agent_task_id
context_version
source_id
worker_id
capability
executor_type
status
latency_ms
attempt_count
error_code
```

### 30.2 Metrics

Track:

```text
compose.turns.queued
compose.turns.running
compose.turns.completed
compose.turns.failed
compose.turns.duplicate_suppressed
compose.turns.legacy_inflight       # gauge, per API replica; used by drain->on cutover gate
compose.turns.durable_queued        # gauge; durable path queue depth
compose.turns.durable_running       # gauge; durable path in-flight
compose.turns.durable_abandoned     # counter; turns marked 'abandoned' by stale sweep
compose.turns.lease_expired         # counter; lease-expiry reclaim events
compose.turns.lease_fence_rejected  # counter; worker-side pre-side-effect fence rejections
compose.events.published
compose.events.replayed
compose.streams.connected
compose.streams.disconnected
compose.stream_tokens.created
compose.stream_tokens.revoked
compose.agent_tasks.queued
compose.agent_tasks.completed
compose.context_versions.committed
compose.context_versions.failed
compose.research.runtime_seconds
compose.llm.tokens.input
compose.llm.tokens.output
compose.llm.cost_usd
```

The `/api/spec-factory/status` payload and dashboard health strip surface the
operator-facing subset of these gauges today: durable turn queue/running counts,
abandoned/lease-expired turn counts, and agent-task queue/running/completed/
abandoned/lease-expired counts. Prometheus/exporter wiring should use the same
repository summaries rather than issuing a second set of ad hoc SQL queries.

### 30.3 Tracing

Propagate correlation id:

```text
session_id + turn_job_id + agent_task_id
```

Across:

- route request
- event publishing
- job processing
- LLM calls
- artifact writes
- research runtime runs

### 30.4 Initial SLOs and Alerts

Define concrete rollout gates before Phase 2, Phase 6, and Phase 8 are enabled outside dev.

Initial gates:

```text
durable turn claim latency p95 < 5s for queued chat turns
duplicate final assistant messages = 0
lost durable events = 0 in replay audit
lease-lost final write attempts = 0 successful writes
research task abandoned rate < 1% outside explicit worker restarts
LLM gateway budget denials visible in logs/metrics
```

Initial alerts:

```text
running turn lease expired without retry/abandon within 2 lease windows
legacy_inflight > 0 during drain for more than configured drain timeout
compose.events.publish failures after DB insert
compose.turns.duplicate_suppressed > normal retry baseline
compose.llm.cost_usd exceeds session/day cap threshold
artifact GC backlog grows for more than one retention interval
```

### 30.5 Debug Artifacts

Store redacted traces only.

Never store unredacted prompts/tool output unless `SPEC_FACTORY_LLM_SECURE_DEBUG=true` is enabled in an access-controlled non-production environment; the gateway must reject unredacted prompt logging when `NODE_ENV=production`.

---

## 31. Security and Isolation

### 31.1 Workspace Isolation

All paths must be rooted under session workspace.

Reject path traversal.

Do not allow user-controlled absolute paths.

### 31.2 Tool Isolation

Research worker tool allowlist is mandatory.

Default mode is read-only.

Network access denied unless capability explicitly requires it.

### 31.3 Secrets

Redact:

- API keys
- tokens
- passwords
- `.env` values
- certificates/private keys
- AWS credentials
- database URLs
- bearer tokens

### 31.4 Access Control

Session guards must enforce:

- archive state
- protected session stream token
- password/session access rules
- mutation permissions

### 31.5 Token Storage

Store token hashes, not raw stream tokens.

Expire and revoke tokens.

Invalidate tokens on archive.

### 31.6 Retention and DSR Matrix

The retention worker and policy module are implemented in `compose-retention.ts`, `compose-artifact-gc.ts`, and `session/retention-policy.ts`. Retention defaults are centralized in `resolveSpecFactoryRetentionPolicy` and are shared by scheduled sweeps and the standalone cleanup command.

Initial matrix:

```text
compose_session_events        retain with session, purge on hard delete
compose_stream_tokens         expire by TTL, revoke on archive, purge expired
compose_turn_jobs             retain with session audit, purge on hard delete
compose_turn_outputs          retain with messages, purge on hard delete
compose_agent_tasks           retain with session audit, purge on hard delete
compose_agent_runtime_runs    retain redacted trace links, purge on hard delete
compose_context_patches       retain until superseded retention window, purge on hard delete
compose_context_versions      retain committed versions with session, purge on hard delete
spec_factory_llm_calls        retain redacted usage audit, purge prompt/response artifacts by policy
S3/EFS artifacts              delete by DB reachability plus retention policy
```

DSR/hard-delete must cascade through DB rows and artifact URIs. Archive is not DSR deletion.

---

## 32. Testing Plan

### 32.1 Phase 0 Tests

- Archived session rejects message send.
- Archived session rejects source add.
- Archived session rejects handoff.
- Archived protected session rejects old stream token.
- Unarchived protected session still works with valid token.
- Session guard functions are used by routes/service methods.

### 32.2 Phase 1 Tests

- Event is persisted before live fanout.
- SSE reconnect replays missed events.
- Duplicate replay does not break client.
- Stream token from one API replica works on another.
- Token expiry is enforced.
- DB token rows store SHA-256 hashes, not plaintext.
- Archive revokes all active DB-backed stream tokens for the session.

### 32.3 Phase 2 Tests

- Message send creates durable turn job.
- Message retry with same `Idempotency-Key` does not append a second user message.
- Analyze creates a durable turn job without requiring a user message row.
- Worker claims queued job.
- In-memory queues are not used when durable flag enabled.
- `shadow -> drain -> on` cutover waits for `legacy_inflight==0`.
- Restart simulation recovers queued job.
- Expired running lease is retried.
- Lost lease prevents Bedrock call, workspace write, `setClaudeSessionId`, and final SSE publish.
- Mid-turn archive prevents final assistant message write.
- Duplicate final assistant messages are prevented.
- `compose_turn_outputs` suppresses duplicate final writes.
- Turns for same session serialize.
- Different sessions can run concurrently.
- `awaiting_user_input` turns are not stale-requeued before clarification expiry.

### 32.4 Phase 3/4 Tests

- API mode does not start processors.
- Worker mode starts processors.
- all-local starts all processors.
- Workspace attach creates local scratch.
- Workspace detach syncs artifacts.
- Cleanup removes local scratch but leaves durable artifacts.

### 32.5 Phase 5/6 Tests

- Agent task is claimed with lease.
- Failed task retries according to attempts.
- Generated research source is created from task output.
- Generated source has provenance fields.
- Research artifact exists and matches DB URI.

### 32.6 Phase 7 Tests

- Converted source queues distillation task.
- Distillation creates context patch.
- Context merge commits new context version.
- Concurrent context merges for one session coalesce or serialize.
- Latest context pointer updates only after artifact exists.
- Failed artifact write does not advance latest context.
- Context artifact checksum and byte count are verified before commit.
- Conflicting facts are represented as conflicts.

### 32.7 Phase 8/9 Tests

- LLM Gateway records usage.
- LLM Gateway enforces per-session/day budget before provider call.
- Coordinator records requested and used context versions per turn.
- Migration router can route to legacy path before coordinator invocation.
- Coordinator can dispatch research task.
- Coordinator caps research task fan-out.
- Coordinator `ask_clarification` parks the turn and releases the lease.
- Research result can be synthesized without waiting for context merge.

---

## 33. Rollout Plan

### 33.1 Local/Dev

Run `SPEC_FACTORY_MODE=all-local`.

Enable features one at a time.

### 33.2 Staging

Suggested order:

```text
1. Archive enforcement
2. Durable events read-only shadow mode
3. DB-backed protected stream tokens
4. Durable events active
5. Durable turns shadow mode with legacy executor still executing
6. Durable turns drain mode until legacy_inflight==0
7. Durable turns on with legacy executor running from durable workers
8. Workspace manager attach/detach for existing workspace behavior
9. Runtime split only after workspace attach is production-ready
10. Agent tasks
11. Generated research behind manual trigger
12. Context versions shadow mode
13. LLM Gateway shadow mode
14. Chat Coordinator limited routing
```

### 33.3 Production

Use feature flags and per-session/tenant rollout.

Never enable:

```text
Chat Coordinator replacing legacy agent
```

before durable turn jobs and generated research path are stable.

For Phase 2, "stable" means the SLO/alert gates in Section 30.4 are clean for the agreed staging window, duplicate final messages are zero, and drain has demonstrated `legacy_inflight==0` during a rolling deploy.

---

## 34. Coding Agent Work Order

### Work Order A: Baseline and Guards

1. Inspect migrations and schema.
2. Confirm current timestamp/FK conventions and numeric session IDs.
3. Add `ActorContext` contract and guard module.
4. Update routes/service methods to call guards.
5. Revoke stream tokens before archive commit.
6. Add tests.

### Work Order B: Durable Events and Shared Tokens

1. Add event table migration.
2. Add event publisher/store.
3. Add DB-backed stream-token table and shared token verifier.
4. Update the existing `/stream` route for replay-to-live bridging and `Last-Event-ID`.
5. Store protected stream-token hashes in DB and revoke them before archive commit.
6. Add tests.

### Work Order C: Durable Turns With Legacy Executor

1. Add turn job tables and output idempotency table.
2. Include `turn_kind`, nullable `user_message_id`, required `idempotency_key`, attempt fields, and `lease_generation`.
3. Add turn job store.
4. Add turn processor with heartbeat renewal and lease fencing.
5. Wrap current ComposeChatAgent in legacy executor.
6. Add `off|shadow|drain|on` durable-turn cutover.
7. Replace in-memory queue only after drain reaches `legacy_inflight==0`.
8. Add analyze, duplicate-message, lease-lost, archive-race, and duplicate-final tests.

### Work Order D: Runtime Modes

1. Add mode bootstrap.
2. Keep production non-`all-local` modes disabled until Work Order E workspace attach is ready.
3. Move processors into worker mode.
4. Keep all-local mode.
5. Add worker id/heartbeat.

### Work Order E: Workspace Manager

1. Add workspace manager interface.
2. Implement existing EFS workspace compatibility.
3. Add local scratch attach/detach.
4. Add manifest writer.
5. Add cleanup.

### Work Order F: Agent Tasks and Capabilities

1. Add agent task table.
2. Add capability registry.
3. Add executor registry.
4. Add processor and leases.
5. Add events and tests.

### Work Order G: Generated Research

1. Add generated source fields to `compose_session_sources`.
2. Add research artifact writer.
3. Add shared redaction for SDK traces and artifacts.
4. Add Claude Agent SDK executor behind feature flag with enforced tool allowlist.
5. Add source creation from research output.
6. Add distillation queue hook disabled by default.

### Work Order H: Context Versions

1. Add context patch/version tables.
2. Add distillation agent.
3. Add context merger two-phase artifact protocol with checksum/byte verification.
4. Add session-level merge exclusion and monotonic latest pointer update.
5. Add latest context pointer.
6. Add readiness projection.

### Work Order I: LLM Gateway

1. Add LLM Gateway interface.
2. Add Bedrock adapter only.
3. Add model router.
4. Add usage recorder.
5. Add structured output support.
6. Add prompt registry with `purpose@vN` resolution.
7. Add gateway-side cost budget enforcement.
8. Add redaction.

### Work Order J: Chat Coordinator

1. Add context builder.
2. Add coordinator decision schema.
3. Route safe/simple turns to coordinator.
4. Route implementation questions to research task.
5. Keep legacy fallback in the migration router before coordinator invocation.
6. Add `ask_clarification` parked-turn state.
7. Gradually expand coordinator ownership.

### Work Order K: Retention and Artifact GC

1. Retention policy module shipped in `src/spec-factory/session/retention-policy.ts`.
2. Orphan temp artifact scanner for EFS `.tmp` paths shipped in `compose-artifact-gc.ts`.
3. S3 DB-reachability artifact scanner shipped in `compose-s3-reachability-gc.ts` behind `COMPOSE_S3_REACHABILITY_GC_ENABLED`.
4. DSR/hard-delete cascade shipped in `ComposeHardDeleteService` and `hardDeleteArchivedSession`; it rejects non-archived sessions, inventories artifact roots, deletes covered S3/EFS objects, then removes rows in FK-safe order.
5. Dry-run mode shipped for workspace/S3/temp-artifact cleanup; add structured audit logs when the operational metrics backend is available.

---

## 35. Things the Coding Agent Must Not Do

Do not:

- replace ComposeChatAgent before durable turns/events are stable
- store final assistant response only in SSE stream
- append assistant final messages without turn idempotency guard
- write S3/EFS artifacts inside DB transactions
- store stream tokens only in process memory
- use Redis as canonical history/context store
- directly mutate Working Context from research worker
- let research worker update `compose_sessions.latest_context_version`
- use Claude session id as product memory
- hardcode provider/model names inside business logic
- make agents free-form chat participants
- add Architect/DevOps/Config agents before core pipeline is stable
- weaken archive access control to preserve old UI behavior
- run arbitrary shell commands from research worker
- allow path traversal in workspace operations
- store raw Claude SDK traces or unredacted prompt artifacts
- enable durable turns with a boolean flip that skips shadow and drain
- enable split worker modes before workspace attach works on shared storage
- add OpenAI/Anthropic providers before Bedrock-only gateway is stable and a real requirement exists

---

## 36. Definition of Done

### Initial Durable Foundation Done

- Multiple API tasks can serve sessions without losing SSE/token state.
- Stream tokens are shared and revocable.
- Session events are durable and replayable.
- Compose turn queue is durable.
- Durable-turn rollout has passed `shadow -> drain -> on`.
- Analyze turns work without requiring a user message row.
- Lease generation fencing prevents stale workers from writing side effects.
- Restart does not lose queued turns.
- Duplicate final assistant responses are prevented.
- Archive is consistently enforced.
- Existing ComposeChatAgent still works through durable turn jobs.

### Agentic Research Foundation Done

- Research tasks are durable.
- Research workers can run on separate worker pool.
- Research output becomes generated source.
- Generated source has provenance and artifact URI.
- Research artifacts can be distilled later.
- Research tool allowlist is enforced before shell/tool execution.
- Research traces and artifacts are redacted before storage.

### Context Foundation Done

- Sources produce context patches.
- Context merge commits versioned Working Context.
- Latest context pointer updates only after artifacts exist.
- Context artifacts carry verified checksum and byte count.
- Coordinator records requested and used context versions per turn.

### Coordinator Done

- Chat Coordinator answers from context bundle.
- Coordinator can dispatch research.
- Coordinator can synthesize research result.
- Coordinator can park a turn for clarification without stale requeue.
- Legacy agent is fallback, not primary path.
- `claude_session_id` is no longer required for product continuity.

---

## 37. Suggested First Coding-Agent Prompt

Use this prompt for the first implementation pass:

```text
You are working in the Spec Factory codebase.

Implement Phase 0 and only Phase 0 from `spec_factory_transformation_plan_v3.md`.

Historical Phase 0 coding-agent prompt:

Do not implement LLM Gateway, Chat Coordinator, generated research, or context versions in Work Order A.

Goals:
1. Inspect the current migration baseline and choose the next migration number.
2. Add the Phase 0 `ActorContext` type from the plan without inventing new ownership/RBAC policy.
3. Add centralized session guard functions for readable, mutable, streamable, and handoff-allowed session access.
4. Apply those guards consistently to Compose routes/service methods.
5. Treat archived sessions as non-mutable and non-streamable by default.
6. Revoke/invalidate protected stream tokens before archive/delete commit.
7. Add tests proving archived sessions reject reads/mutations/streams according to the new policy.
8. Preserve existing public behavior for non-archived sessions.

Do not change the Compose chat agent behavior.
Do not change source conversion behavior except where archive guards are required.
Do not introduce new LLM calls.
Do not introduce generic agent frameworks.

Return a concise implementation summary, tests run, and any migration/schema changes.
```

---

## 38. Resolved Decisions and Remaining Open Items

Resolved implementation decisions:

1. Archived sessions are hidden from normal get/list/stream/message routes. Archive is reversible-retention state, not hard delete; DSR deletion uses the explicit hard-delete service and requires the session to already be archived.
2. `ActorContext.roles` uses `SPEC_FACTORY_ADMIN_IDS` as the authoritative Phase 0 admin source. OIDC group/tenant claims can replace this adapter later without changing the guard contract.
3. Stream tokens are DB-backed in `compose_stream_tokens`, stored as SHA-256 hashes, revoked before archive commits, and purged by the retention cleaner after TTL.
4. SSE replay uses the global `compose_session_events.id` cursor, emits `id:` lines, honors `Last-Event-ID`, and bridges replay to live fanout with duplicate suppression.
5. Turn jobs and agent tasks use MySQL as the durable queue. Redis can be added later only as a wakeup/cache assist, not as canonical turn state.
6. Context and audit artifacts use the configured artifact/workspace stores: MySQL tracks metadata and checksums, S3/EFS hold large artifact bodies, and local scratch is used for active executor work.
7. Local scratch hydration is capability-scoped: research gets attached repositories and required evidence artifacts; broad full-workspace copies are avoided unless an executor explicitly needs them.
8. Research workers default to read-only `Read`, `Grep`, and `Glob`. The safe `rg` alias normalizes to the SDK `Grep` tool. `Bash` is fail-closed unless explicitly enabled with anchored, metacharacter-free command patterns.
9. LLM and research budgets are enforced at the gateway/coordinator layer with per-turn, per-session, 24h, and optional global env-configurable ceilings.
10. Prompt registry storage is `spec_factory_prompt_versions`; static registry mode remains available for local/dev and DB bootstrap failure isolation.
11. Clarification expiry dashboard affordance is resolved. The durable worker
    publishes `code="clarification_expired"`, the workspace shows the toolbar
    error, and ChatPanel keeps an inline composer-adjacent alert until the user
    sends a fresh message or opens another session.

Remaining open item:

12. Vector retrieval stays out of the v1 coordinator contract until a provider, interface, rollout phase, and tests are selected.

---

## 39. Final Architecture Summary

The destination remains:

```text
Spec Factory durable control plane
  -> MySQL jobs/events/context metadata
  -> replayable MySQL events plus live SSE fanout
  -> DB-backed stream tokens and durable lease fencing
  -> EFS/S3 durable artifacts/workspaces
  -> local scratch for active research

Agent model
  -> legacy ComposeChatAgent during migration
  -> flag-gated Chat Coordinator for routed user-facing orchestration
  -> Claude Agent SDK research workers for code/repo exploration
  -> Distillation Agent for source-to-context patches
  -> Context Merger for committed Working Context versions
  -> LLM Gateway for provider-agnostic direct LLM calls

Product invariant
  -> sessions are durable
  -> workers are replaceable
  -> context is versioned
  -> research is generated source
  -> final answers are idempotent
  -> archive is enforced
```

The most important migration correction is:

```text
Fix volatile state and lifecycle boundaries first.
Only then introduce new LLM/coordinator architecture.
```
