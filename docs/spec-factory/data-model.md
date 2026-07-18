# Data model

This document is the canonical schema reference for Spec Factory's Compose
lane. The repository schema is `db/schema.sql`; ordered migrations are the
deployable contract. The v4 plan is the design tiebreaker when an older phase
description below has not yet been rewritten.

## V4 migration tranche

Apply these after deployed migration `068`, strictly in order:

| Migration                                            | Durable contract                                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `069_spec_factory_context_v4.sql`                    | Adds bounded v4 context fields, patch provenance/idempotency, immutable source revisions/chunks, current revision pointers, source soft deletion, and constraints/indexes. |
| `070_spec_factory_outbox.sql`                        | Adds transactional outbox, leased queue receipts, and source-conversion triggers that insert wake-ups in the same source transaction.                                      |
| `071_spec_factory_handoffs.sql`                      | Adds handoff aggregate and immutable snapshot metadata with frozen context/message/source/repository watermarks.                                                           |
| `072_spec_factory_draft_workflows.sql`               | Adds durable draft workflow and stage-run ledgers plus workflow linkage from drafts.                                                                                       |
| `073_spec_factory_repair_and_bounds.sql`             | Adds context schema provenance, hard research-round bounds, repair runs/items, and explicit repair acceptance metadata.                                                    |
| `074_spec_factory_source_distillation_prompt_v2.sql` | Registers the strict source-distillation prompt contract.                                                                                                                  |
| `075_spec_factory_source_deletion_lifecycle.sql`     | Adds recoverable source-deletion batches, source purge markers, and claim indexes.                                                                                         |

The key ownership rule is unchanged across every table: MySQL stores
authoritative state, identities, checksums, and artifact pointers. Large or
immutable content lives in S3. SQS and Valkey never own product state.

### V4 aggregate map

| Aggregate | Tables and important relationships                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session   | `compose_sessions` with child messages, sources, events, turn jobs, agent tasks, context patches/versions, handoffs, and repair items                                 |
| Source    | `compose_session_sources` -> immutable `compose_source_revisions` -> bounded `compose_source_chunks`; `current_revision_id` is the active pointer                     |
| Turn      | `compose_turn_jobs` -> `compose_turn_outputs`; frozen requested/used context and research-round bounds remain backend-authoritative                                   |
| Dispatch  | `spec_factory_outbox` -> `spec_factory_queue_receipts`; outbox dedupe identifies a logical transition and receipt `(consumer_name,message_id)` fences delivery        |
| Context   | bounded `compose_context_patches` reduce cumulatively into immutable `compose_context_versions`; source/message/turn/revision provenance is retained                  |
| Handoff   | `compose_handoffs` -> `compose_handoff_snapshots` -> draft workflow; snapshot checksums bind every frozen input                                                       |
| Draft     | `spec_factory_draft_workflows` -> ordered `spec_factory_draft_stage_runs` -> `spec_factory_drafts`; each completed stage stores immutable artifact URI/checksum/bytes |
| Repair    | `spec_factory_repair_runs` -> `spec_factory_repair_items`; only a completed, zero-error, non-dry-run report may be accepted for startup removal gates                 |

### Lifecycle and deletion rules

- Session archive atomically revokes access and cancels active turn/task work;
  it does not hard-delete audit state.
- DSR hard-delete walks dependent rows in FK-safe order, explicitly deletes
  exact referenced S3 artifacts, and removes orphan repair-run parents.
- Immutable reachability GC runs only when S3 is the canonical artifact store,
  lists only `<SPEC_FACTORY_ARTIFACT_PREFIX>/workspaces/`, and deletes
  unreferenced objects older than the crash-recovery grace window. The cleaner
  rejects the broader product prefix so Jira attachments and raw Compose
  uploads can never enter this deletion set.
- Retention purges terminal outbox/receipt history after configured windows;
  non-terminal rows are never retention candidates.
- Every timestamp uses `TIMESTAMP(3)`. Every durable artifact pointer has a
  SHA-256 and byte count when the artifact protocol owns it.

## Contents

- [Conventions](#conventions)
- [MySQL tables — present today](#mysql-tables--present-today)
  - [compose_sessions](#compose_sessions)
  - [compose_session_sources](#compose_session_sources)
  - [compose_session_messages](#compose_session_messages)
  - [compose_session_events](#compose_session_events)
  - [compose_stream_tokens](#compose_stream_tokens)
- [MySQL tables — target](#mysql-tables--target)
  - [compose_turn_jobs](#compose_turn_jobs-target)
  - [compose_turn_outputs](#compose_turn_outputs-target)
  - [compose_agent_tasks](#compose_agent_tasks)
  - [compose_context_patches](#compose_context_patches)
  - [compose_context_versions](#compose_context_versions)
  - [compose_workspace_manifests](#compose_workspace_manifests)
  - [spec_factory_prompt_versions](#spec_factory_prompt_versions-target)
  - [spec_factory_worker_heartbeats](#spec_factory_worker_heartbeats-target)
  - [spec_factory_llm_calls](#spec_factory_llm_calls-target)
  - [compose_agent_runtime_runs](#compose_agent_runtime_runs)
  - [compose_sessions column additions](#compose_sessions-column-additions)
  - [compose_session_sources generated-source columns](#compose_session_sources-generated-source-columns)
- [Valkey live fanout](#valkey-live-fanout)
- [EFS/S3 artifacts](#efss3-artifacts)
- [Two-phase artifact write protocol](#two-phase-artifact-write-protocol)
- [Cross-table lifecycle](#cross-table-lifecycle)
- [Migration numbering](#migration-numbering)
- [Naming and typing rules](#naming-and-typing-rules)
- [Idempotency and NOT NULL rules](#idempotency-and-not-null-rules)

## Conventions

Terms used throughout this document match the glossary in [`./README.md`](./README.md): Session, Turn, Source, Working Context, Coordinator, Research Worker, Distillation, Capability, Runtime Mode. Do not invent synonyms.

Status callouts:

- **Status: Today** — the row/column exists on `main` and can be read from `db/schema.sql`.
- **Status: Phase N — target design** — the row/column is defined in plan v3 §M.N but is not on `main` yet.

## MySQL tables — present today

The five tables below are shipping today. The DDL blocks reproduce the current definitions from `db/schema.sql`; the migration files that introduced them are cross-linked.

### compose_sessions

**Status: Today.** DDL: `db/schema.sql:1209-1238`. First-introduced migration: `db/migrations/037_compose_sessions.sql`. Latest evolution: `db/migrations/052_compose_intelligence_metadata.sql`.

```sql
CREATE TABLE IF NOT EXISTS compose_sessions (
  id                     BIGINT AUTO_INCREMENT PRIMARY KEY,
  name                   VARCHAR(200) NOT NULL,
  created_by             VARCHAR(120) NULL,
  created_by_display     VARCHAR(200) NULL,
  agent_persona_key      VARCHAR(80)  NULL,
  agent_persona_name     VARCHAR(120) NULL,
  status                 ENUM('draft','ready','handed_off','archived') NOT NULL DEFAULT 'draft',
  archived_at            TIMESTAMP(3) NULL,
  claude_session_id      VARCHAR(120) NULL,
  source_id              BIGINT       NULL,
  readiness_json         JSON         NULL,
  last_active_at         TIMESTAMP(3) NULL,
  last_action            VARCHAR(80)  NULL,
  last_actor             VARCHAR(120) NULL,
  active_turn_started_at TIMESTAMP(3) NULL,
  password_hash          VARCHAR(255) NULL,
  s3_prefix              VARCHAR(300) NOT NULL,
  workspace_path         VARCHAR(400) NOT NULL,
  workspace_cleaned_at   TIMESTAMP(3) NULL,
  workspace_cleanup_error TEXT        NULL,
  created_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_sessions_source
    FOREIGN KEY (source_id) REFERENCES spec_factory_sources(id),
  UNIQUE KEY uk_compose_sessions_source_id (source_id),
  INDEX idx_compose_sessions_status_updated (status, updated_at, id),
  INDEX idx_compose_sessions_cleanup (status, archived_at, workspace_cleaned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Notes:

- `id` is the numeric Session identifier used everywhere else. Plan §8 (`db/schema.sql:574`) mandates `BIGINT session_id` on all Compose child tables until a separate migration introduces opaque string IDs.
- `status` transitions today: `draft -> ready | handed_off | archived`. The archived state is enforced by `assertSessionMutable/Readable/Streamable/HandoffAllowed` in `src/spec-factory/session/session-guard.ts`.
- `claude_session_id` is the SDK resume handle written by `ComposeChatAgent.run` (`src/spec-factory/compose-chat-agent.ts:327`). Plan §9 drops this field as product memory; it will remain nullable until then.
- `source_id` is the FK to the synthetic `COMPOSE-<sessionId>` `spec_factory_sources` row created on handoff (`src/spec-factory/compose-service.ts:1319`). The `UNIQUE KEY` prevents double-handoff.
- `readiness_json` shape is the legacy readiness envelope published on `readiness.updated` events. It remains authoritative when present; when it is `NULL`, `ComposeService` projects a conservative readiness response from the latest committed `compose_context_versions` row.
- `idx_compose_sessions_cleanup` supports the retention worker discovering archived sessions whose workspaces have not yet been cleaned.

### compose_session_sources

**Status: Today.** DDL: `db/schema.sql:1247-1290`. Introduced by `037_compose_sessions.sql`; grew via `038_compose_markdown_content.sql`, `039_compose_awaiting_upload.sql`, `041_compose_conversion_leases.sql`, `043_compose_live_source_kinds.sql`, `052_compose_intelligence_metadata.sql`, and `068_spec_factory_correlation_ids.sql`.

```sql
CREATE TABLE IF NOT EXISTS compose_session_sources (
  id                          BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id                  BIGINT       NOT NULL,
  request_id                  VARCHAR(128) NULL,
  kind                        ENUM('file','youtube','chat','note','jira','confluence') NOT NULL,
  original_filename           VARCHAR(400) NULL,
  mime_type                   VARCHAR(160) NULL,
  size_bytes                  BIGINT       NULL,
  source_url                  VARCHAR(2000) NULL,
  s3_key_raw                  VARCHAR(500) NULL,
  converter                   ENUM('markitdown','voxtral','none') NOT NULL DEFAULT 'none',
  markdown_path               VARCHAR(500) NULL,
  markdown_content            MEDIUMTEXT   NULL,
  source_summary              TEXT         NULL,
  source_entities_json        JSON         NULL,
  source_usefulness           VARCHAR(40)  NULL,
  source_contribution         TEXT         NULL,
  conversion_status           ENUM('awaiting_upload','pending','converting',
                                   'converted','unsupported','failed') NOT NULL DEFAULT 'pending',
  conversion_started_at       TIMESTAMP(3) NULL,
  conversion_attempts         INT          NOT NULL DEFAULT 0,
  conversion_lease_expires_at TIMESTAMP(3) NULL,
  error_message               TEXT         NULL,
  created_at                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_sources_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_session_sources_session (session_id, id),
  INDEX idx_compose_session_sources_request (request_id, id),
  INDEX idx_compose_sources_status_id (conversion_status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Conversion status enum:

| Value             | Meaning                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `awaiting_upload` | Source row minted; presigned PUT issued; client has not confirmed upload yet.                         |
| `pending`         | Content available; not yet claimed by a conversion lease.                                             |
| `converting`      | Held under a lease by `ComposeConversionWorker.drain` (`src/spec-factory/compose-conversion.ts:303`). |
| `converted`       | Markdown written; `markdown_content` (or `markdown_path`) populated.                                  |
| `unsupported`     | Conversion pipeline recognized the input but declined it (unsupported format).                        |
| `failed`          | Conversion errored after retries; retriable via `POST /sources/:id/reconvert`.                        |

The lease-based pipeline uses `converter`, `conversion_started_at`, `conversion_attempts`, and `conversion_lease_expires_at`. Failure classification lives in `isTransientConversionError` (`src/spec-factory/compose-conversion.ts:68`).
`request_id` follows source conversion across API and worker processes; it is
updated when upload completion or an explicit reconvert request becomes the
new queueing action.

Migration `075_spec_factory_source_deletion_lifecycle.sql` adds `deletion_id`
and `purged_at`. Normal reads require `deleted_at IS NULL`. Rows under an active
deletion batch retain metadata for audit/Undo while their content becomes
eligible for physical purge after the grace period.

Phase 6 (plan §8.6) extends `kind` with `generated_research` and adds provenance columns; see [column additions](#compose_session_sources-column-additions-target).

### compose_source_deletions

**Status: Today.** Introduced by
`075_spec_factory_source_deletion_lifecycle.sql`.

One row records a recoverable source-deletion batch. `source_id` identifies the
user-selected root, while `invalidated_source_ids_json` captures the root plus
the transitive generated-research closure and
`invalidated_handoff_ids_json` captures affected handoffs. The lifecycle is:

```text
undoable -> restored
undoable | restored | failed -> purging -> purged
purging -> failed
```

`undo_until` is the authoritative grace deadline. The purge index
`(status, undo_until, id)` supports bounded multi-replica claiming with
`FOR UPDATE SKIP LOCKED`; stale `purging` claims are recoverable after 15
minutes. The source FK prevents deletion-ledger orphans, so reset and DSR paths
delete ledger rows before source rows.

### compose_session_messages

**Status: Today.** DDL: `db/schema.sql:1270-1280`. Introduced by `037_compose_sessions.sql`.

```sql
CREATE TABLE IF NOT EXISTS compose_session_messages (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id  BIGINT       NOT NULL,
  role        ENUM('user','assistant','system') NOT NULL,
  content     MEDIUMTEXT   NOT NULL,
  turn_job_id BIGINT       NULL,
  context_version_used BIGINT NULL,
  agent_task_id BIGINT     NULL,
  message_kind VARCHAR(32) NULL,
  clarification_idempotency_key VARCHAR(128) NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_messages_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  UNIQUE KEY uniq_compose_messages_clarification_idem
    (session_id, clarification_idempotency_key),
  INDEX idx_compose_session_messages_session (session_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Phase 2 (plan §8.4): `ALTER TABLE compose_session_messages ADD COLUMN turn_job_id BIGINT NULL, ADD COLUMN context_version_used BIGINT NULL, ADD COLUMN agent_task_id BIGINT NULL, ADD COLUMN message_kind VARCHAR(32) NULL;` shipped in `db/migrations/054_compose_turn_jobs.sql` so assistant messages can be tied back to the turn job that produced them and the context version they saw. Durable finals populate these through `completeTurnWithAssistantMessage`; active-session finals use the archive-fenced `appendAssistantMessageIfSessionActive` path and persist the backend-frozen `contextVersionUsed` when available.

Migration `076_compose_clarification_answer_history.sql` adds nullable
`clarification_idempotency_key` plus a session-scoped unique index. Every
clarification answer round stores its own client key on its transcript row.
This lets one durable turn ask multiple questions while delayed retries still
resolve to the original answer instead of being applied to a later question.

### compose_session_events

**Status: Today.** DDL: `db/schema.sql:1543-1568`. Introduced by `db/migrations/053_compose_session_events_and_stream_tokens.sql`; `066_compose_session_event_correlation_fks.sql` adds reset-safe turn/task FKs. Plan reference: §8.1 (spec_factory_transformation_plan_v3.md:580).

```sql
CREATE TABLE IF NOT EXISTS compose_session_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT       NOT NULL,
  event_type      VARCHAR(64)  NOT NULL,
  sequence        BIGINT       NULL,
  payload_json    JSON         NOT NULL,
  payload_bytes   INT          NOT NULL DEFAULT 0,
  actor_type      VARCHAR(32)  NULL,
  actor_id        VARCHAR(128) NULL,
  turn_job_id     BIGINT       NULL,
  agent_task_id   BIGINT       NULL,
  context_version BIGINT       NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  CONSTRAINT fk_compose_session_events_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  CONSTRAINT fk_compose_session_events_turn_job
    FOREIGN KEY (turn_job_id) REFERENCES compose_turn_jobs(id) ON DELETE SET NULL,
  CONSTRAINT fk_compose_session_events_agent_task
    FOREIGN KEY (agent_task_id) REFERENCES compose_agent_tasks(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_compose_session_events_session_sequence (session_id, sequence),
  INDEX idx_compose_session_events_session_created (session_id, created_at),
  INDEX idx_compose_session_events_session_id (session_id, id),
  INDEX idx_compose_session_events_turn_job (turn_job_id),
  INDEX idx_compose_session_events_agent_task (agent_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Rules:

- SSE `id:` values use `compose_session_events.id` (global row id). `sequence` is nullable and reserved for a per-session counter if the implementation later commits to one. Plan §8.1 forbids "non-null `sequence` and then use `id` in the route".
- `payload_bytes` is filled by the publisher and capped at 16 KB. Large content remains in its authoritative message, session, context, or artifact row; the durable event stores a compact `invalidate` projection that tells clients what to reload.
- `turn_job_id` and `agent_task_id` are optional FK-backed correlations with `ON DELETE SET NULL` so reset/reanalyze can delete old jobs and tasks without deleting the durable event row. `context_version` remains a semantic snapshot number rather than a FK because a composite `(session_id, context_version)` FK would conflict with event retention and cleanup semantics.
- Event catalog and semantic ordering: plan §10.1 (spec_factory_transformation_plan_v3.md:1093). Do not introduce parallel CamelCase names; the durable log uses `dot.snake` verbatim. Runtime chat events still flow through `ComposeSseHub.durableEventType` (`assistant.final`, `message.created`, `readiness.updated`, `turn.status`, `error`), while session/source/turn/task/context lifecycle events are written directly by the service and background workers through `appendSessionEvent`.

### compose_stream_tokens

**Status: Today.** DDL: `db/schema.sql:1305-1316`. Introduced by `053_compose_session_events_and_stream_tokens.sql`. Plan reference: §8.2 Option B (spec_factory_transformation_plan_v3.md:616).

```sql
CREATE TABLE IF NOT EXISTS compose_stream_tokens (
  token_hash   CHAR(64)     PRIMARY KEY,
  session_id   BIGINT       NOT NULL,
  expires_at   TIMESTAMP(3) NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at TIMESTAMP(3) NULL,
  revoked_at   TIMESTAMP(3) NULL,

  CONSTRAINT fk_compose_stream_tokens_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id),
  INDEX idx_compose_stream_tokens_session (session_id),
  INDEX idx_compose_stream_tokens_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Notes:

- `token_hash` is SHA-256 hex; raw tokens are never stored. The mint path is `ComposeRepository.createStreamToken` (`src/spec-factory/compose-service.ts:975`), and verification is `verifyStreamTokenHash` (`src/spec-factory/compose-service.ts:950`).
- The `session_id` reverse index supports "revoke all tokens for this session" on archive (`src/spec-factory/compose-service.ts:989`).
- Retention: rows expire by TTL; archive cascades a soft-revoke via `revoked_at`. Hard purge runs from the retention worker; see [Retention and DSR](#cross-table-lifecycle).
- Stream-token verification and revocation remain MySQL-only. Valkey live event fanout does not cache or authorize stream tokens.

## MySQL tables — durable/target

The tables below are specified by plan v3 §8. Several now ship on `main`; each block gives the target DDL shape, the phase that landed or owns it, and any deviations from the baseline table conventions.

### compose_turn_jobs (target)

**Status: Phase 2 — schema and worker-owned execution shipped behind `SPEC_FACTORY_DURABLE_TURNS=drain|on`; production rollout and eventual legacy queue removal remain.** Plan reference: §8.3 (spec_factory_transformation_plan_v3.md:654).

Purpose: durable Compose Turn queue for both chat messages and system-initiated analyze runs. Replaces `ComposeService.activeTurns` / `queuedTurns` / `queuedDepth` (`src/spec-factory/compose-service.ts:738-743`) and the `MAX_QUEUED_TURNS_PER_SESSION` in-memory cap (`src/spec-factory/compose-service.ts:87`).

```sql
CREATE TABLE compose_turn_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  turn_kind ENUM('chat', 'analyze') NOT NULL DEFAULT 'chat',
  user_message_id BIGINT NULL,
  status ENUM(
    'queued', 'running', 'waiting_on_research', 'awaiting_user_input',
    'synthesizing', 'completed', 'failed', 'cancelled', 'abandoned'
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
  clarification_answer_message_id BIGINT NULL,
  clarification_answer_idempotency_key VARCHAR(128) NULL,
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

Rules from plan §8.3:

- Chat turns: `turn_kind='chat'` with non-null `user_message_id`.
- Analyze turns: `turn_kind='analyze'`; `user_message_id` MUST NOT be forced by DDL. Server generates a deterministic key like `analyze:<sessionId>:<requestId>`.
- `idempotency_key` is `NOT NULL`. `POST /messages` requires an `Idempotency-Key` header and dedupes before inserting the user message row (plan §11.2).
- No `UNIQUE(user_message_id)`. Retry after an abandoned turn must be possible; idempotency is the durable dedupe primitive.
- Session-level serialization is enforced by lease acquisition, not by DB constraint. See plan §11.4.

### compose_turn_outputs (target)

**Status: Phase 2 — schema and fenced final-write execution shipped behind `SPEC_FACTORY_DURABLE_TURNS=drain|on`; active-session fallback also archive-checks final assistant writes.** Plan reference: §8.4 (spec_factory_transformation_plan_v3.md:712).

Purpose: enforce "one final assistant message per turn job" durably. Recommended over generated-column or in-code enforcement because MySQL versions differ.

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

Contract: write the final assistant message row and the `compose_turn_outputs` row in the same DB transaction. If a retry sees the output row already exists, do not append a duplicate assistant message. Plan §11.5 spells out the transactional shape.

### compose_agent_tasks

**Status: Phase 5 — shipped in migration `055_compose_agent_tasks.sql`.** Plan reference: §8.5 (spec_factory_transformation_plan_v3.md:755).

Purpose: durable specialist Capability queue (research, distillation, merge, critic, handoff builder). Sits alongside `compose_turn_jobs`; a chat turn may dispatch multiple agent tasks.

```sql
CREATE TABLE compose_agent_tasks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  turn_job_id BIGINT NULL,
  capability VARCHAR(64) NOT NULL,
  executor_type VARCHAR(64) NULL,
  status ENUM(
    'queued', 'running', 'completed', 'failed', 'cancelled', 'abandoned'
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

Capability rules from plan §8.5 and §14:

- `capability` (not `agent_type`) is the routing key. Executor mapping happens through the Capability Registry (plan §14.2).
- Shipped set: `legacy_compose_chat`, `chat_coordination`, `source_distillation`, `context_merge`, `code_research`, `config_research`, `devops_research`, `critic_review`, and `handoff_build`.
- Later phases add only specialists that have a real product need. Never introduce a capability without landing its executor and queue behavior in the same PR.
- `output_source_id` back-links to a `compose_session_sources` row when the task produced a generated research source.

### compose_context_patches

**Status: Phase 7 — shipped in migration `057_compose_context_versions.sql`.** Plan reference: §8.7 (spec_factory_transformation_plan_v3.md:838).

Purpose: intermediate distillation output from a source or agent task; consumed by the Context Merger to produce a new Working Context version.

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

Two-phase artifact write applies: `patch_uri`/`artifact_sha256`/`artifact_bytes` must be written to the row only after the artifact has been verified. See [Two-phase artifact write protocol](#two-phase-artifact-write-protocol).

### compose_context_versions

**Status: Phase 7 — partially shipped.** Plan reference: §8.8 (spec_factory_transformation_plan_v3.md:867).

Purpose: durable, immutable Working Context snapshots. Every chat Turn reads a specific committed version; `compose_sessions.latest_context_version` points at the most recent committed row. Session read APIs synthesize readiness from the latest committed `summary_json` and `open_questions_json` when the legacy `compose_sessions.readiness_json` field is empty.

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
  conflicts_json JSON NULL,
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

Advancement rule (plan §11 + §13.5): `latest_context_version` on `compose_sessions` advances only after the corresponding artifact URI has been verified against the SHA-256 in the row. Failed artifact writes must not advance the pointer.

### compose_workspace_manifests

**Status: Phase 4 — shipped.** Plan reference: §13.

Purpose: durable index of the latest derived `session-manifest.json` written by `ComposeWorkspaceManager.prepare`. The file remains in the materialized workspace for SDK runs; this row gives operations and future replay tooling a DB-visible checksum, byte count, and source inventory without reading EFS first.

```sql
CREATE TABLE compose_workspace_manifests (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id BIGINT NOT NULL,
  workspace_path VARCHAR(1024) NOT NULL,
  manifest_json JSON NOT NULL,
  manifest_bytes BIGINT NOT NULL,
  manifest_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_compose_workspace_manifests_session (session_id),
  INDEX idx_compose_workspace_manifests_updated (updated_at),
  CONSTRAINT fk_compose_workspace_manifests_session
    FOREIGN KEY (session_id) REFERENCES compose_sessions(id)
);
```

Lifecycle: one row per active session, upserted only after the workspace file is written and hashed. `resetSessionProgress` deletes the row because the conversation/context materialization was reset; hard delete purges it with the rest of the session-owned metadata.

### spec_factory_prompt_versions (target)

**Status: Phase 8 — partially shipped.** Plan reference: §15.4.

Purpose: durable prompt-version registry used by the LLM Gateway when `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=db`. The in-code registry remains the default; DB mode resolves active defaults and validates explicit `purpose@vN` values before a paid provider call.

```sql
CREATE TABLE spec_factory_prompt_versions (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  prompt_version VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  purposes_json JSON NOT NULL,
  source VARCHAR(255) NOT NULL,
  changelog_json JSON NOT NULL,
  schema_expectation VARCHAR(128) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_spec_factory_prompt_versions_version (prompt_version),
  INDEX idx_spec_factory_prompt_versions_active (active, version)
);
```

Operational rule: new prompt rows are additive. To roll a new prompt, insert `purpose@vN`, mark it active, and deactivate older defaults only after the new version has passed canary traffic. Explicit historical versions remain valid for replay/audit as long as the row exists.

### spec_factory_worker_heartbeats (target)

**Status: Phase 3 — partially shipped.** Plan reference: §12.6.

Purpose: process inventory for runtime modes and worker lease runbooks. The row is keyed by `worker_id` and refreshed by the running process. It is not session-owned and has no FKs.

```sql
CREATE TABLE spec_factory_worker_heartbeats (
  worker_id VARCHAR(128) PRIMARY KEY,
  mode VARCHAR(32) NOT NULL,
  hostname VARCHAR(255) NULL,
  process_id INT NULL,
  capabilities_json JSON NOT NULL,
  started_at TIMESTAMP(3) NOT NULL,
  heartbeat_at TIMESTAMP(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_spec_factory_worker_heartbeats_mode (mode, heartbeat_at),
  INDEX idx_spec_factory_worker_heartbeats_heartbeat (heartbeat_at)
);
```

Operational rule: stale heartbeat rows are diagnostic only. Lease fencing still uses `lease_generation` on the turn/task row; operators use this table to decide which process to restart or scale. `/api/spec-factory/status` derives `composeControlPlane.workers` from this table, marking a row stale when `heartbeat_at` is more than 45 seconds old.

### spec_factory_llm_calls (target)

**Status: Phase 8 — partially shipped.** Plan reference: §8.10 (spec_factory_transformation_plan_v3.md:914).

Purpose: LLM Gateway usage audit. Every provider call (Bedrock in Phase 8; other adapters later) inserts one row with redacted prompt/response artifact pointers. `/api/spec-factory/status` derives its UTC-day `composeControlPlane.llm` call/token/cost/failure summary from this table.

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
  INDEX idx_created (created_at),
  INDEX idx_provider_model (provider, model, created_at)
);
```

Naming decision (plan §8.10): if this table stays named `spec_factory_llm_calls`, the correlation columns are nullable and no FKs are added. If the table becomes Compose-only it is renamed to `compose_llm_calls` and the same `fk_compose_*` FKs added.

Redaction is mandatory when prompt/response artifact logging is enabled:
`redacted_prompt_uri`/`redacted_response_uri` point at filesystem or S3/EFS
artifacts that were pushed through `security/redaction.ts` before write (plan
§31.3, spec_factory_transformation_plan_v3.md:2816). When
`SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE` is unset, the gateway still records the
usage row and leaves these URI columns null.

### compose_agent_runtime_runs

**Status: Phase 5 — shipped in migration `064_compose_agent_runtime_runs.sql`.** Plan reference: §8.11 (spec_factory_transformation_plan_v3.md:946).

Purpose: per-executor invocation ledger. One agent task can retry across multiple runtime runs; this table records each attempt.

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

`trace_uri` and `output_artifact_uri` are S3/EFS paths under the session workspace prefix. Both must be redacted before write (plan §31.3).

### compose_sessions column additions

**Status: Phase 7 — partially shipped.** Plan reference: §8.8 (spec_factory_transformation_plan_v3.md:900).

```sql
ALTER TABLE compose_sessions
  ADD COLUMN latest_context_version BIGINT NULL,
  ADD COLUMN context_status VARCHAR(32) NOT NULL DEFAULT 'dirty',
  ADD COLUMN conversation_summary_uri TEXT NULL;
```

`context_status` enum: `clean | dirty | building | failed` (plan §9.1 lists operational states).
Turn state is derived from non-terminal `compose_turn_jobs` rows. The only session-level turn hint is the existing `active_turn_started_at` timestamp, which legacy paths use for activity display and stale-recovery cleanup; do not add a redundant `active_turn_status` column.

### compose_session_sources generated-source columns

**Status: Phase 6 — shipped.** Plan reference: §8.6 (spec_factory_transformation_plan_v3.md:816). Migration `056_compose_generated_sources.sql` added the generated-source columns and FK; migration `059_compose_generated_research_idempotency.sql` deduplicates existing rows and adds `UNIQUE KEY uk_compose_session_sources_generated_task (generated_by_task_id)`.

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
  ADD UNIQUE KEY uk_compose_session_sources_generated_task (generated_by_task_id),
  ADD CONSTRAINT fk_compose_session_sources_generated_task
    FOREIGN KEY (generated_by_task_id) REFERENCES compose_agent_tasks(id);
```

Semantics:

- User-created rows keep `source_origin='user'`.
- Generated research rows use `kind='generated_research'`, `source_origin='agent'`, `converter='none'`, and reach `conversion_status='converted'` only after the artifact write protocol verifies the artifact.
- Do not add a companion generated-source table (plan §8.6 rejects a third source inventory).

## Valkey live fanout

**Status: implemented and required by the legacy-removal gate.** API replicas publish and pattern-subscribe to `spec-factory:session-events:<sessionId>` through `ValkeySessionEventFanout`. Payloads are parsed with the canonical event schema before delivery.

Valkey is a latency layer, not an authority. `compose_session_events` remains the durable replay log; stream tokens remain hashed rows in `compose_stream_tokens`; turn ordering, cancellation, worker identity, and lease ownership remain MySQL records. A malformed or unavailable Valkey message is ignored/retried while durable polling and `Last-Event-ID` replay preserve correctness.

## EFS/S3 artifacts

**Status: mixed.** Plan reference: §7.3 (spec_factory_transformation_plan_v3.md:530). Some artifacts exist today (converted markdown, workspace files); the rest arrive in the phase noted below.

Workspace layout on EFS today (per `ComposeWorkspaceManager.prepare`, `src/spec-factory/compose-workspace.ts:230-343`):

```
${COMPOSE_WORKSPACE_BASE}/<sessionId>/
  chat.md            # conversation history handed to the SDK
  context.md         # human-readable working context; will be replaced by working_context_vN.md in Phase 7
  repositories.md    # registered repo snapshots
  sources/*.md       # one file per converted compose_session_sources row
```

`COMPOSE_WORKSPACE_BASE` is `/mnt/efs/specter-repo/spec-factory/compose` in prod (see `terraform/spec-factory-ecs.tf` env block). Local scratch (Phase 4) lives under `/scratch/spec-factory/<sessionId>/{workspace,artifacts,tmp}` (plan §7.4).

Target artifact catalog:

| Artifact                               | Location                                                                                                        | Producer                                          | Phase | Plan §       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----- | ------------ |
| Converted markdown source              | `<workspace>/sources/<sourceId>.md` (EFS) + `s3_key_raw` (S3)                                                   | `ComposeConversionWorker`                         | Today | §17.1        |
| `working_context_v<N>.md`              | `s3://.../spec-factory/compose/<sessionId>/context/`                                                            | Context Merger                                    | 7     | §7.3, §8.8   |
| `working_context_v<N>.json`            | Same directory as above                                                                                         | Context Merger                                    | 7     | §7.3, §8.8   |
| Context patches                        | `s3://.../spec-factory/compose/<sessionId>/patches/<patchId>.json`                                              | Distillation task                                 | 7     | §7.3, §8.7   |
| Research artifacts                     | `s3://.../spec-factory/compose/<sessionId>/research/<taskId>.md`                                                | Research worker (Claude SDK)                      | 6     | §7.3, §18    |
| Tool traces                            | `s3://.../spec-factory/compose/<sessionId>/traces/<runId>.jsonl`                                                | Agent runtime run                                 | 5     | §7.3, §8.11  |
| Handoff bundles                        | `file://<workspace>/handoff/handoff-v1.{md,json}` with refs in `spec_factory_evidence_snapshots.artifacts_json` | `ComposeService.handoff` / future Handoff builder | 10    | §7.3         |
| Workspace snapshots                    | `s3://.../spec-factory/compose/<sessionId>/snapshots/`                                                          | Workspace Manager detach                          | 4     | §7.3, §13    |
| Source attachments (raw uploads)       | `s3://.../spec-factory/compose/<sessionId>/uploads/`                                                            | Presigned client PUT                              | Today | §17.1        |
| Redacted LLM prompt/response artifacts | `s3://.../spec-factory/compose/<sessionId>/llm/<callId>.{req,res}.json`                                         | LLM Gateway                                       | 8     | §8.10, §31.3 |

Rules:

- EFS/S3 writes must never happen inside a DB transaction (plan §7.3, spec_factory_transformation_plan_v3.md:546).
- Filenames use monotonic version numbers (`vN`) or entity IDs. Do not use timestamps in artifact names — those live in DB rows.
- Redaction is mandatory before write for anything derived from raw LLM prompts/traces (plan §31.3, spec_factory_transformation_plan_v3.md:2816). Redaction targets: API keys, tokens, passwords, `.env` values, certificates/private keys, AWS credentials, database URLs, bearer tokens.

## Two-phase artifact write protocol

**Status: Phase 4 onward — target design.** Plan reference: §13.5 (spec_factory_transformation_plan_v3.md:1506).

Every artifact-bearing row (context patches, context versions, generated sources, agent runtime runs, LLM call redacted prompt/response, handoff bundles) MUST use this protocol or an equivalent "write verified artifact first, then insert pointer row" variant when the table has no per-artifact status column:

1. Insert DB row with `status='building'` and no artifact URI.
2. Write artifact to a temp URI: `s3://.../.tmp/<uuid>.<ext>`.
3. Re-read (or `HEAD`) the temp object; recompute SHA-256; compare byte length against what the writer intended.
4. In a single DB `UPDATE`, set `artifact_uri`, `artifact_sha256`, `artifact_bytes`, and `status='ready'` (or `'committed'` for `compose_context_versions`).
5. Optionally copy/rename to a final URI (mostly used for versioned context files).
6. Best-effort `DELETE` of the temp artifact.

Never hold a DB transaction while writing to S3/EFS. Temporary EFS artifacts under `.tmp` directories are cleaned by `compose-artifact-gc.ts`; S3 objects under `COMPOSE_S3_PREFIX` that are outside all live `compose_sessions.s3_prefix` roots are cleaned by `compose-s3-reachability-gc.ts` when enabled. If the SHA-256 or byte length verification fails, the row stays `building` (or transitions to `failed`); the pointer on `compose_sessions.latest_context_version` does not advance.

## Cross-table lifecycle

**Status: mixed (Phase 0 archive behavior is live; retention worker is Phase 5+).** Plan references: §9 (spec_factory_transformation_plan_v3.md:979), §31.6 (spec_factory_transformation_plan_v3.md:2846).

### Archive cascade

When a session transitions to `archived` (via `DELETE /sessions/:sessionId`, handled by `src/spec-factory/compose-routes.ts:createComposeRouter` and enforced by `assertSessionMutable` / `assertSessionHandoffAllowed` at `src/spec-factory/session/session-guard.ts:11`):

- `compose_sessions.status='archived'`, `archived_at=NOW()`.
- All `compose_stream_tokens` rows for the session are soft-revoked (`revoked_at=NOW()`). Today: `ComposeService.deleteSession` at `src/spec-factory/compose-service.ts:983` (stream-token revocation at `src/spec-factory/compose-service.ts:989`).
- Live SSE subscribers receive a terminal `error` or `session.archived` event and disconnect.
- All future mutation endpoints reject with `session_archived` (plan §9.1 required rejections list).
- **Phase 2+**: any `compose_turn_jobs` in `queued|running|waiting_on_research|awaiting_user_input` transition to `abandoned` or `cancelled`. When a final assistant write loses the archive race, `turn.discarded_due_to_archive` and `assistant.discarded_due_to_archive` are published instead of `assistant.final`.
- **Phase 5+**: `compose_agent_tasks` in flight receive cancellation flags.
- Workspace files on EFS remain until the retention worker prunes them (indexed via `idx_compose_sessions_cleanup`).

Archive is not DSR deletion (plan §31.6).

### Reset semantics

An analyze turn with `reset=true` (Phase 2+ `POST /sessions/:sessionId/analyze` payload) discards the prior conversation but preserves sources:

- Prior `compose_session_messages`, `compose_turn_jobs`, `compose_turn_outputs`, and `compose_agent_tasks` are deleted in one transaction so the next analyze/chat turn starts from a clean conversation lane. Durable `compose_session_events` remain the lifecycle audit trail.
- `compose_sessions.claude_session_id` is cleared. (Phase 9 removes this field entirely.)
- `readiness_json` is reset to `NULL`.
- User-authored `compose_session_sources` are preserved; agent-generated research sources (`source_origin='agent'`) are deleted with the task rows that produced them.
- `compose_workspace_manifests` is deleted because the workspace materialization was reset.
- Phase 7+: `compose_sessions.latest_context_version` is NOT rewound. A new version can be created on top of the previous one; `parent_version` links preserve history.

Today, `ComposeService.runTurn` (`src/spec-factory/compose-service.ts:2336`) implements reset for analyze turns; the equivalent target-design behavior is enforced by the turn worker reading `turn_kind='analyze'` and treating the previous conversation as summarized-only input.

### Retention and DSR matrix

Plan §31.6 (spec_factory_transformation_plan_v3.md:2852). Archived
workspace/S3 cleanup, stale `.tmp` artifact GC, expired stream-token purge, and
archived-session DSR hard-delete, and optional S3 DB-reachability scanning are
implemented.

| Table                            | Retention                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose_session_events`         | Retain with session; purge on hard delete.                                                                                                                                |
| `compose_session_sources`        | Active rows remain current. Deleted rows are recoverable until `undo_until`; source-specific content is scrubbed after purge; metadata remains until session hard delete. |
| `compose_source_deletions`       | Retain deletion/restore/purge audit with the session; purge on hard delete.                                                                                               |
| `compose_session_messages`       | Retain with transcript; purge on hard delete.                                                                                                                             |
| `compose_stream_tokens`          | TTL expiry; revoke on archive; purge expired rows.                                                                                                                        |
| `compose_turn_jobs`              | Retain with session audit; purge on hard delete.                                                                                                                          |
| `compose_turn_outputs`           | Retain with messages; purge on hard delete.                                                                                                                               |
| `compose_agent_tasks`            | Retain with session audit; purge on hard delete.                                                                                                                          |
| `compose_agent_runtime_runs`     | Retain redacted trace URI; purge on hard delete.                                                                                                                          |
| `compose_context_patches`        | Retain until superseded window; purge on hard delete.                                                                                                                     |
| `compose_context_versions`       | Retain committed versions with session; purge on hard delete.                                                                                                             |
| `spec_factory_prompt_versions`   | Retain indefinitely as audit/config metadata; never cascade with a session.                                                                                               |
| `spec_factory_worker_heartbeats` | Retain short-term process inventory; purge stale rows by retention policy.                                                                                                |
| `spec_factory_llm_calls`         | Retain redacted usage audit; purge prompt/response artifacts by policy.                                                                                                   |
| S3/EFS artifacts                 | Delete by DB reachability plus retention policy.                                                                                                                          |

DSR / hard delete cascades through Compose DB rows and artifact URIs covered by
the session S3 prefix, workspace root, or configured
`SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE`. A handed-off `spec_factory_sources` row
and downstream drafts are outside the Compose child-table cascade and must use
the separate source/draft DSR path when applicable.

## Migration numbering

**Status: Today.**

Migration files live under `db/migrations/`. Numbering is a monotonic three-digit prefix (`NNN_snake_name.sql`). Collisions are common because parallel branches pick the same next number; the reviewer/merger resolves by renaming to the next unused prefix during merge.

Canonical Compose migration sequence, including this change:

```
037_compose_sessions.sql
038_compose_markdown_content.sql
039_compose_awaiting_upload.sql
040_compose_handoff_idempotency.sql
041_compose_conversion_leases.sql
042_compose_session_passwords.sql
043_compose_live_source_kinds.sql
046_compose_retention_cleanup.sql
052_compose_intelligence_metadata.sql
053_compose_session_events_and_stream_tokens.sql
054_compose_turn_jobs.sql
055_compose_agent_tasks.sql
056_compose_generated_sources.sql
057_compose_context_versions.sql
058_spec_factory_llm_calls.sql
059_compose_generated_research_idempotency.sql
060_compose_clarification_answers.sql
061_spec_factory_llm_calls_budget_index.sql
062_spec_factory_prompt_versions.sql
063_spec_factory_worker_heartbeats.sql
064_compose_agent_runtime_runs.sql
065_compose_context_version_conflicts.sql
066_compose_session_event_correlation_fks.sql
067_compose_workspace_manifests.sql
068_spec_factory_correlation_ids.sql
069_spec_factory_context_v4.sql
070_spec_factory_outbox.sql
071_spec_factory_handoffs.sql
072_spec_factory_draft_workflows.sql
073_spec_factory_repair_and_bounds.sql
074_spec_factory_source_distillation_prompt_v2.sql
075_spec_factory_source_deletion_lifecycle.sql
076_compose_clarification_answer_history.sql
```

Current migration tail: `076_compose_clarification_answer_history.sql`; the
next new migration must use `077_*` after re-checking `db/migrations/`.

Numbering rules for future migrations:

1. Before authoring a migration, `ls db/migrations/ | sort` and pick the first unused three-digit prefix strictly greater than the highest used prefix at the moment of authoring.
2. Compose-scoped migrations use the `compose_` prefix in the filename slug (e.g., `054_compose_turn_jobs.sql`).
3. Global Spec Factory migrations use `spec_factory_`.
4. Multi-table migrations may bundle related DDL only if they land together in the same PR; otherwise split.
5. Never renumber a merged migration. If two branches collide before merge, rebase the losing branch onto a higher number.
6. Every migration must be idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER TABLE` via `information_schema.columns`, as in `037_compose_sessions.sql:4-18`).

## Naming and typing rules

Plan §8 opening rules (spec_factory_transformation_plan_v3.md:572):

- Session identifiers are `BIGINT`. Do not introduce string session IDs on new tables until a dedicated migration introduces them platform-wide.
- Timestamp columns use `TIMESTAMP(3)` with millisecond precision. Mutable rows use `updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`.
- Named foreign keys are required for all same-database references. Naming convention:
  - Compose tables: `fk_compose_<table>_<referenced>` (e.g., `fk_compose_turn_jobs_session`).
  - Spec Factory-scoped tables: `fk_spec_factory_<table>_<referenced>`.
- Index names use `idx_<table>_<columns>` (e.g., `idx_compose_session_events_session_created`).
- Unique constraints use `uniq_<table>_<slug>` or `uk_<table>_<slug>`.
- Durable event payloads are capped by the publisher at 16 KB. Large state projections use compact invalidation events; large standalone content lives in artifacts referenced by URI.
- Token hashes are SHA-256 hex and stored as `CHAR(64)`.
- Artifact URIs use `TEXT`, not `VARCHAR`, because S3 keys can exceed 400 characters.
- Enums are used only when the value set is small, stable, and product-owned. `status`, `kind`, `converter`, `role`, `event_type` are enum candidates; free-form identifiers like `capability` and `executor_type` use `VARCHAR`.

## Idempotency and NOT NULL rules

Idempotency is the durable deduplication primitive across the entire Compose lane. `UNIQUE` constraints on natural keys are preferred to application-level checks.

- **`compose_turn_jobs.idempotency_key` is `NOT NULL`** with `UNIQUE KEY uniq_turn_idempotency (session_id, idempotency_key)`. `POST /messages` MUST require a client `Idempotency-Key` header; internal analyze requests generate `analyze:<sessionId>:<requestId>`. Plan §8.3 forbids `UNIQUE(user_message_id)` — retry after an abandoned turn must be legal.
- **`compose_turn_outputs.assistant_message_id` is `NOT NULL`** with `UNIQUE KEY uniq_assistant_message`. The `PRIMARY KEY (turn_job_id)` provides the "one final message per turn" invariant.
- **`compose_session_events.sequence` is `NULL`-able** with `UNIQUE KEY uniq_compose_session_events_session_sequence (session_id, sequence)`. Phase 1 leaves it null and uses `id` as the SSE cursor; do not populate `sequence` unless the implementation commits to a real per-session counter (plan §8.1).
- **`compose_stream_tokens.token_hash` is the `PRIMARY KEY`**. Raw tokens are hashed with SHA-256 and never stored.
- **Two-phase artifact rows require `artifact_sha256 CHAR(64)` and `artifact_bytes BIGINT`** to become `ready`/`committed`. `compose_context_patches`, `compose_context_versions`, and generated `compose_session_sources` rows all follow this rule. Verification happens outside any DB transaction (plan §13.5).
- **Foreign keys are `NOT NULL` when the parent relationship is required** (e.g., `compose_session_sources.session_id`), and `NULL`-able only when the relationship is optional (e.g., `compose_turn_jobs.user_message_id` for analyze turns).
- **`payload_json` on `compose_session_events` is `NOT NULL`** because a durable event with no payload cannot be replayed correctly. Empty envelopes use `{}` explicitly.

## Cross references

- Architecture, control flow, and session lifecycle: [`./architecture.md`](./architecture.md).
- SSE event names, durable event contract, and turn queue semantics: [`./api-reference.md`](./api-reference.md).
- Operations, retention, and workspace cleanup: [`./operations.md`](./operations.md).
- Local development and testing: [`./dev-guide.md`](./dev-guide.md).
- Canonical target design: [`../superpowers/spec-factory/spec_factory_transformation_plan_v3.md`](../superpowers/spec-factory/spec_factory_transformation_plan_v3.md).
