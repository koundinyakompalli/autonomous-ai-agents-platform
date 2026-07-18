# Spec Factory Scale, Correctness, and Experience Plan v4

**Status:** Approved target-state and active implementation plan. Work Orders A
through S and V have code-complete implementations. Work Order T automation is
code-complete but environment certification has not run. Work Order U
fail-closed removal gates are implemented; irreversible legacy deletion remains
blocked until T evidence is accepted. The target runtime architecture is not
yet fully certified.

**Date:** 2026-07-09

**Audience:** Spec Factory implementers, platform engineers, reviewers, and
operators.

**Relationship to v3:** This plan preserves the durable-session, idempotency,
lease-fencing, archive, event, task, and Working Context principles from
`spec_factory_transformation_plan_v3.md`. Once approved, v4 supersedes v3 for
runtime topology, horizontal scaling, queue dispatch, Working Context merge
semantics, Compose-to-draft handoff, user experience, and rollout sequencing.

### Implementation snapshot (2026-07-10)

The implementation was delivered through the merged rollout PR series. Work
Order V is the requirements-workspace experience slice. Merge history changes
review packaging, not dependency order or rollout gates; current environment
state must be proven from live schema, Terraform, ECS, and certification
evidence.

| Work orders | Code state                                                                                                                                                     | Environment state                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A-C         | Implemented: blocking CI/metrics and direct Bedrock routing                                                                                                    | Verify deployed image, model routes, and latency baseline                           |
| D-F         | Implemented: frozen coordinator context, cumulative v4 reducer, source revisions/chunks, conversation patches, explicit removals                               | Verify migration history and accepted context-repair report                         |
| G-L         | Implemented: transactional outbox, SQS receipts/quarantine, split runtimes, concurrent turns, capability boundaries, immutable S3 artifacts                    | Verify live queues, Valkey, services, IAM, and routing mode                         |
| M-P         | Implemented: immutable handoff aggregate, durable draft stages, canonical events, Valkey fanout, authoritative UI state/cancel/retry/stale handling            | Verify handoff shadow comparison and user-flow canaries                             |
| Q           | Terraform implemented: autoscaling, optional Aurora/RDS Proxy, Valkey, queues/DLQs, role images, task-local scratch, alarms                                    | Verify current plan/state and deployed task definitions                             |
| R-S         | Implemented: retention/GC/DSR, bounded budgets/rounds, repair/backfill/reconcile/acceptance gates                                                              | Verify live cleanup, repair, and acceptance evidence                                |
| T           | Certification manifest/evaluator, k6 harness, CI artifact, and evidence contract implemented                                                                   | Functional, load, 24-hour soak, chaos, security, and DR evidence pending            |
| U           | Runtime and Terraform fail closed unless certification, repair, HA, budgets, retention, primary SQS, immutable artifacts, and digest pins are present          | Actual legacy-path deletion and rollback-window closure pending accepted T evidence |
| V           | Requirements-first Compose UX, clarification policy, research consent, Artifacts, agent markers, Gherkin drafting, and approved-draft preservation implemented | Deployment and user-flow certification pending                                      |

“Code complete” here means the implementation, migrations, Terraform,
documentation, and automated repository tests exist. It does not mean production
is migrated, Terraform has been applied, or the Section 29 gates have passed.

**Primary objective:** Build a highly available Spec Factory that can serve a
large number of simultaneous Compose sessions without cross-session
head-of-line blocking, information loss between stages, or dependence on one
ECS process. Interactive requests should remain responsive while conversion,
research, distillation, context merge, handoff, and draft work scale
independently.

---

## 1. Executive Decision

Spec Factory should become a collection of stateless APIs and independently
autoscaled worker pools. MySQL remains the authoritative state and fencing
store. SQS becomes the durable wake-up and dispatch substrate. A transactional
outbox closes every database-to-queue crash window. Redis/Valkey provides only
low-latency live event fanout; durable replay remains backed by the event log.
Session workspaces become immutable, checksummed artifact snapshots in S3,
hydrated into task-local scratch space only when a worker needs them.

The target system deliberately separates five concerns:

1. **Control plane:** sessions, jobs, leases, idempotency, context pointers,
   handoff state, and workflow state in MySQL.
2. **Dispatch plane:** SQS queues and DLQs, fed only through a transactional
   outbox relay.
3. **Artifact plane:** versioned source, context, research, handoff, and draft
   artifacts in S3; EFS is an optional read-through repository cache, not
   canonical mutable session state.
4. **Execution plane:** API, turn, light-agent, research, conversion, and draft
   ECS services with different scaling policies, IAM roles, tools, and secrets.
5. **Experience plane:** one correlated event envelope and a stage-aware UI
   driven by durable workflow state instead of transient spinners.

Vertical scaling is useful for individual research, conversion, and draft
tasks, but it is not the primary capacity mechanism. Horizontal scaling across
sessions is the primary mechanism. Per-session ordering remains strict.

---

## 2. Design Envelope

The initial production architecture must be load-tested against this envelope.
These are engineering targets, not permanent limits.

| Dimension                       | Initial design target |    Stress target |
| ------------------------------- | --------------------: | ---------------: |
| Persisted Compose sessions      |               100,000 |        1,000,000 |
| Simultaneously open sessions    |                10,000 |           50,000 |
| Concurrent SSE connections      |                 5,000 |           25,000 |
| Accepted chat/analyze turns     |             20/second | 100/second burst |
| Concurrent direct LLM turns     |                   100 |              500 |
| Concurrent source distillations |                   100 |              500 |
| Concurrent research tasks       |                    25 |              100 |
| Concurrent conversions          |                    20 |               75 |
| Concurrent draft workflows      |                    20 |               75 |
| Durable events                  |        10 million/day |   50 million/day |

The architecture must not assume that all open sessions are active. API/SSE
capacity scales with connections and request rate. Worker capacity scales with
arrival rate, queue age, and service time.

Capacity planning uses:

```text
required worker tasks =
  ceil(arrival_rate_per_second * average_service_seconds
       / target_utilization
       / concurrency_per_task)
```

Use `target_utilization = 0.65` for interactive turns and `0.75` for batch
work. Bedrock account/model quotas must be raised before worker scaling is
enabled; extra ECS tasks cannot compensate for a provider concurrency limit.

---

## 3. Service-Level Objectives

| User-visible operation                  | SLO                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| Create/resume/list session API          | p95 < 300 ms, p99 < 750 ms                                   |
| Accept chat/analyze request             | p95 < 250 ms                                                 |
| Interactive queue age under design load | p95 < 2 seconds, p99 < 10 seconds                            |
| Fast acknowledgement                    | p95 < 500 ms after acceptance                                |
| Coordinator direct answer               | p50 < 4 seconds, p95 < 10 seconds, p99 < 20 seconds          |
| First durable progress event            | p95 < 1 second after acceptance                              |
| Source conversion start                 | p95 queue age < 5 seconds                                    |
| Source distillation                     | p95 < 30 seconds per bounded source/chunk                    |
| Context merge                           | p95 < 3 seconds deterministic; < 15 seconds with summary LLM |
| Research                                | progress < 2 seconds; terminal target < 3 minutes            |
| Draft workflow queue age                | p95 < 5 seconds                                              |
| Draft workflow terminal time            | p50 < 2 minutes, p95 < 5 minutes                             |
| SSE reconnect/replay                    | p95 < 2 seconds                                              |
| Monthly API availability                | >= 99.95%                                                    |
| Lost accepted turns/final responses     | 0                                                            |
| Duplicate final responses               | 0                                                            |

Error budgets are defined per workflow class. A research or draft provider
outage must not consume the interactive API availability budget.

---

## 4. Non-Negotiable Invariants

1. Every accepted unit of work has a durable database row before HTTP returns.
2. Every database transition that requires asynchronous work writes an outbox
   row in the same transaction.
3. Queue delivery is at-least-once. Every consumer is idempotent.
4. Lease generation is checked in the same transaction as every authoritative
   side effect.
5. Archive cancels or fences all non-terminal work atomically.
6. One session has at most one active user turn, but different sessions run in
   parallel.
7. LLM-emitted values are advisory. Backend-frozen identifiers, context
   versions, budgets, state, and provenance are authoritative.
8. Working Context version `N+1` starts from committed version `N` and applies
   explicit patch operations. It never silently reconstructs state from only
   the newest patches.
9. A handoff references one immutable session/context/message/source snapshot.
   Draft generation never reads a mutable live workspace.
10. MySQL is authoritative for workflow state. SQS and Redis may be rebuilt
    from durable state.
11. Workspace files are projections. Deleting a worker or task-local workspace
    cannot lose product state.
12. API replicas do not execute long-running work.
13. No runtime receives tools, secrets, network access, or capabilities it does
    not need.
14. A deployment is not healthy until migrations, canaries, workers, queue
    consumers, and user-facing APIs all pass their gates.

---

## 5. Current Problems This Plan Must Close

The implementation work is complete only when all of these are closed:

- The Haiku coordinator request is invalid and silently falls back to legacy
  Agent SDK execution.
- One `ComposeTurnWorker` serializes all sessions globally.
- Draft processing and conversion processing are globally serial per process.
- Source distillation schemas permit excessive output and have no useful item
  bounds.
- Working Context versions drop parent facts and source IDs.
- Coordinator bundles do not load the committed Working Context artifacts.
- `requested_context_version` and `context_version_used` are not populated on
  turn jobs.
- Conversation decisions do not reliably become context patches.
- Handoff can depend on stale `chat.md` and can omit database messages.
- A linked synthetic source is presented as if an Epic/draft already exists.
- Durable rich events do not reach the Compose UI event reducer.
- The primary and research services claim the same agent-task capabilities.
- The API process still runs conversion, turn, draft, and agent-task loops.
- EFS mutable workspace state remains load-bearing.
- CI runs only a subset of Spec Factory tests and dashboard checks are
  non-blocking.
- Deployments use mutable `latest` image references and do not gate application
  rollout on schema compatibility.
- Retention, global LLM budgets, and durable-event strict mode are disabled.
- Runtime task roles share broad secrets and unrestricted egress.

---

## 6. Target Architecture

```text
                                +----------------------+
Browser / API client ---------->| ALB                  |
                                +----------+-----------+
                                           |
                              +------------v------------+
                              | Spec Factory API x3+     |
                              | auth, CRUD, SSE, accept  |
                              | no long-running work     |
                              +-----+---------------+----+
                                    |               |
                         transactions|               |live subscribe
                                    v               v
                         +----------+---+     +------+----------------+
                         | Aurora MySQL |     | ElastiCache Valkey    |
                         | + RDS Proxy  |     | live event fanout only|
                         +------+-------+     +-----------------------+
                                |
                                | transactional outbox
                                v
                         +------+----------+
                         | Outbox relay x2 |
                         +------+----------+
                                |
                +---------------+-------------------------------+
                |               |             |                 |
                v               v             v                 v
        +-------+------+ +------+-------+ +---+----------+ +----+-------+
        | Turn FIFO    | | Agent queues | | Conversion   | | Draft      |
        | group=session| | by capability| | queue + DLQ  | | queue+DLQ  |
        +-------+------+ +------+-------+ +---+----------+ +----+-------+
                |               |             |                 |
                v               v             v                 v
        +-------+------+ +------+-------+ +---+----------+ +----+-------+
        | Turn workers | | Light agents | | Conversion   | | Draft      |
        | direct LLM   | | context/etc. | | workers      | | workers    |
        +--------------+ +------+-------+ +--------------+ +------------+
                               |
                     +---------+----------+
                     | Research workers  |
                     | Agent SDK + tools |
                     +---------+----------+
                               |
                               v
                     +---------+----------+
                     | S3 artifact store |
                     | immutable versions|
                     +--------------------+

Optional read-through repository cache: EFS, never authoritative.
Scheduled maintenance: EventBridge-triggered ECS tasks, not an always-on API loop.
```

---

## 7. ECS Service Topology

Initial task sizes are intentionally generous and must be tuned with load-test
evidence. Minimum counts provide multi-AZ availability. Maximum counts protect
the database and provider quotas.

| ECS service                | Image                         | Initial CPU/memory               | Min/max tasks | Concurrency/task | Scale signal                              |
| -------------------------- | ----------------------------- | -------------------------------- | ------------: | ---------------: | ----------------------------------------- |
| `SPEC-FACTORY-API`         | minimal Node API              | 1 vCPU / 2 GiB                   |        3 / 30 |       HTTP + SSE | ALB requests, CPU, active SSE connections |
| `SPEC-FACTORY-EVENT-RELAY` | core Node worker              | 0.5 vCPU / 1 GiB                 |         2 / 8 |        8 batches | outbox age and undispatched rows          |
| `SPEC-FACTORY-TURN`        | core Node worker              | 2 vCPU / 4 GiB                   |       4 / 100 |          4 turns | turn queue age and backlog/task           |
| `SPEC-FACTORY-CONTEXT`     | core Node worker              | 2 vCPU / 4 GiB                   |       4 / 100 |      2 LLM tasks | distill/merge/handoff queue age           |
| `SPEC-FACTORY-RESEARCH`    | hardened research image       | 4 vCPU / 8 GiB, 100 GiB scratch  |        2 / 50 |           1 task | research queue age and Bedrock quota      |
| `SPEC-FACTORY-CONVERSION`  | converter + ffmpeg/MarkItDown | 4 vCPU / 16 GiB, 100 GiB scratch |        2 / 30 |     1 conversion | conversion queue age and bytes queued     |
| `SPEC-FACTORY-DRAFT`       | core/draft image              | 4 vCPU / 8 GiB, 100 GiB scratch  |        3 / 40 | 1 workflow stage | draft queue age and backlog/task          |
| Maintenance tasks          | core Node worker              | 1 vCPU / 2 GiB                   |     scheduled |    bounded batch | EventBridge schedule and backlog          |

The API, core worker, research, and conversion images should be distinct:

- **API image:** Express, database client, auth, SSE, no Claude Agent SDK, git,
  shell, ffmpeg, or conversion packages.
- **Core worker image:** direct Bedrock provider, context/handoff/draft code, no
  general shell tools.
- **Research image:** Claude Agent SDK, git, `rg`, read-only workspace tooling,
  and explicit command/network policy.
- **Conversion image:** Python MarkItDown, ffmpeg, media libraries, and no Jira
  or GitHub credentials.

Use immutable image digests in task definitions. A single source commit can
build multiple images, but each image has an independent SBOM and vulnerability
scan.

### 7.1 Runtime capability sets

Capabilities are configured per service, never through one shared CSV:

```text
API:                none
Turn:               durable_turn_worker, chat_coordination
Context:            source_distillation, context_merge,
                    conversation_summary, handoff_build, critic_review
Research:           code_research, config_research, devops_research
Conversion:         source_conversion
Draft:              evidence_collect, qualify, repo_context, draft_generate,
                    jira_publish, oneshot_submit
Maintenance:        retention, artifact_gc, token_gc, heartbeat_gc, repair
```

Startup must fail if an enabled ingress or workflow can enqueue a capability
that no configured service can claim. Runtime heartbeats provide a second,
continuous alarm for capability coverage.

---

## 8. Queue and Dispatch Design

SQS is a dispatch/wakeup layer, not the source of product truth. A queue message
contains only immutable routing data:

```json
{
  "schemaVersion": 1,
  "jobType": "compose_turn",
  "jobId": 12345,
  "sessionId": 81,
  "enqueuedAt": "2026-07-09T22:00:00.000Z",
  "outboxId": 67890
}
```

### 8.1 Queues

| Queue                             | Type                 | Ordering/deduplication                                      |
| --------------------------------- | -------------------- | ----------------------------------------------------------- |
| `spec-factory-turn.fifo`          | high-throughput FIFO | `MessageGroupId=sessionId`; dedupe by outbox id             |
| `spec-factory-context-distill`    | Standard             | task id; DB lease and idempotent patch key fence duplicates |
| `spec-factory-context-merge.fifo` | FIFO                 | `MessageGroupId=sessionId`; coalesce ready patches          |
| `spec-factory-handoff.fifo`       | FIFO                 | `MessageGroupId=sessionId`; one active handoff snapshot     |
| `spec-factory-research`           | Standard             | agent task id; DB lease generation fences                   |
| `spec-factory-conversion`         | Standard             | source revision id; conversion lease fences                 |
| `spec-factory-draft`              | Standard             | workflow stage id; stage output key fences                  |
| `spec-factory-publish.fifo`       | FIFO                 | `MessageGroupId=sourceId`; Jira/OneShot idempotency         |

Every queue has a DLQ, redrive policy, age alarm, visible poison-message
metadata, and an operator redrive command that first checks the authoritative
database state.

### 8.2 Transactional outbox

Add `spec_factory_outbox` with at least:

```text
id, aggregate_type, aggregate_id, session_id, topic, message_group_key,
payload_json, dedupe_key, status, attempt_count, available_at,
claimed_by, claim_until, dispatched_at, last_error, created_at, updated_at
```

Rules:

1. Creating/requeueing a job and inserting its outbox row occur in one MySQL
   transaction.
2. `dedupe_key` is unique for one logical transition, for example
   `turn:123:queued:g4`.
3. Relays claim batches with `FOR UPDATE SKIP LOCKED` and short leases.
4. Publishing success records `dispatched_at`; duplicate SQS delivery is safe.
5. A repair task republishes stale undispatched rows.
6. No product request writes directly to SQS or Redis.

### 8.3 Worker consumption

For each SQS message a worker:

1. Reads the database job by id.
2. Treats missing/terminal/incompatible state as an idempotent no-op and deletes
   the message.
3. Claims or confirms the job lease in MySQL.
4. Runs with a heartbeat shorter than one-third of lease TTL.
5. Checks lease generation and active session in every final-side-effect
   transaction.
6. Writes state, artifacts, durable events, and any next-stage outbox rows.
7. Deletes the SQS message only after the transaction commits.

---

## 9. Database and Control Plane

### 9.1 Database platform

Move the Spec Factory schema to Aurora MySQL 3, Multi-AZ, with one writer and at
least two readers. Use RDS Proxy for API and non-claim traffic. Queue claimers
may use a writer endpoint pool sized explicitly for transaction pinning.

Initial database posture:

- Provisioned writer sized from load testing, not Serverless cold-start risk.
- I/O-Optimized storage when measured I/O cost/latency justifies it.
- Performance Insights and Enhanced Monitoring enabled.
- Automated backups, point-in-time recovery, deletion protection, and a tested
  restore runbook.
- Separate pools and credentials for API reads, API writes, worker claims,
  maintenance, and migrations.
- Reader endpoints only for stale-tolerant dashboards and history. Read-after-
  write session flows use the writer.

### 9.2 Required schema additions

Confirm the next migration number at implementation time. Planned additions:

- `spec_factory_outbox` for queue/event dispatch.
- `compose_handoffs` for handoff lifecycle and frozen provenance.
- `compose_handoff_snapshots` for immutable snapshot metadata/checksums.
- `spec_factory_workflows` for source-to-draft-to-publish lifecycle.
- `spec_factory_stage_runs` for retryable draft stages and stage artifacts.
- `compose_source_revisions` for content-hash/revision identity.
- `compose_source_chunks` for bounded distillation and retrieval units.
- Optional `compose_context_item_index` for stable context item ids and source
  provenance without parsing artifact JSON.

### 9.3 Existing table changes

- Populate `compose_turn_jobs.requested_context_version` during queue creation.
- Populate `compose_turn_jobs.context_version_used` atomically during claim.
- Add `queue_message_generation` where needed to reject stale queue messages.
- Add source revision/content hash to `compose_session_sources`.
- Link `spec_factory_sources` to `compose_handoffs.id` for Compose origin.
- Link every processing stage to one `workflow_id` and immutable input artifact.
- Add compact status/error indexes for queue health and repair queries.

### 9.4 Query/index requirements

Every queue table must support these index-leading access patterns:

```text
(status, available_at, priority, created_at, id)
(session_id, status, created_at, id)
(active_worker_id, lease_until)
(completed_at, status)
```

Event replay requires `(session_id, id)`. Retention requires timestamp-leading
indexes. Budget checks require `(session_id, created_at)` and global
`(created_at)` indexes.

Use keyset pagination everywhere. No control-plane endpoint may scan an entire
event, message, task, or source table.

### 9.5 Retention and partitioning

- Keep hot session events in MySQL for 30 days after session completion.
- Export older event/history records to compressed S3 Parquet before purge.
- Keep active-session messages and context indefinitely or per policy.
- Run retention and artifact GC as scheduled ECS tasks with dry-run reports.
- Purge stale heartbeats and expired stream tokens continuously.
- Set explicit storage/retention policy for redacted LLM audit artifacts.

---

## 10. Working Context Redesign

Working Context must be a cumulative, provenance-preserving reducer, not a
periodic reconstruction from the newest patches.

### 10.1 Patch contract

Replace free-form array blobs with bounded operations:

```ts
type ContextPatchOperation =
  | { op: "upsert"; section: ContextSection; item: ContextItem }
  | { op: "remove"; section: ContextSection; itemId: string; reason: string }
  | { op: "resolve_conflict"; conflictId: string; resolution: ContextItem };

interface ContextItem {
  id: string;
  text: string;
  sourceIds: number[];
  sourceRevisionIds: number[];
  evidenceRefs: EvidenceRef[];
  confidence: "low" | "medium" | "high";
  status: "active" | "superseded" | "rejected";
}
```

All arrays have `maxItems`; all strings have maximum lengths; evidence refs are
typed. The backend computes or validates stable item ids. The LLM does not
choose context version, patch id, source identity, or provenance columns.

### 10.2 Merge algorithm

For version `N+1`:

1. Lock the session merge guard.
2. Load and checksum-verify committed version `N`.
3. Load ready patches in stable order.
4. Apply deterministic `upsert/remove/resolve_conflict` operations.
5. Preserve all untouched parent items and source ids.
6. Compute conflicts deterministically.
7. Optionally call a direct LLM only to synthesize objective, problem statement,
   and recommended actions from the bounded structured result.
8. Write JSON and Markdown to temporary S3 keys.
9. Verify bytes/checksums.
10. Commit the version pointer, item metadata, patch states, durable event, and
    outbox row in one transaction.
11. Promote/finalize artifact keys idempotently.

Required test invariant:

```text
v1 sources [A, B] + patch for C -> v2 sources [A, B, C]
```

Source deletion creates explicit removal patches; it must not rely on omission
from a future version.

### 10.3 Conversation-to-context flow

Every completed turn writes a compact, bounded conversation patch containing:

- New user decisions and corrections.
- Clarification answers.
- New constraints, scope changes, and accepted assumptions.
- Open questions added, answered, or withdrawn.
- Assistant claims only when they have evidence/provenance.

This can use the fast `conversation_summary` model, but a deterministic fallback
must preserve the raw message ids. A conversation patch is keyed by turn job id
and cannot be produced twice.

### 10.4 Source distillation

Large source content is chunked by content structure and token budget. Chunks
are identified by source revision and SHA-256. Map tasks run in parallel;
results reduce into one source patch.

Initial bounds:

- 8,000-16,000 input tokens/chunk.
- At most 25 items per category per chunk.
- At most 500 characters/item, excluding evidence references.
- At most 2,048 output tokens/call.
- Deduplicate near-identical facts before context merge.

Use a fast direct Bedrock model for extraction. Reserve Sonnet 5 for ambiguous
or low-confidence escalation. Do not run an Agent SDK tool loop for extraction.

### 10.5 Turn context freeze

- API enqueue transaction records `requested_context_version`.
- Worker claim transaction reloads latest committed context and records
  `context_version_used`.
- One turn reads exactly one committed version.
- If versions differ, publish `context.version_drifted` with both values.
- Assistant messages, outputs, audit calls, research tasks, and handoffs use the
  worker-authoritative version.

---

## 11. LLM Execution Architecture

### 11.1 Provider split

Implement two distinct execution adapters behind `LlmGateway`:

1. **Direct Bedrock adapter:** `Converse`/streaming APIs, structured validation,
   retry, timeout, circuit breaker, audit, budgets, and token accounting. Used
   for coordinator, source distillation, context summary, conversation summary,
   critic, qualification, handoff narrative, and normal draft synthesis.
2. **Claude Agent SDK executor:** tool-using, workspace-bound work. Used only for
   code/config/DevOps research and exceptional repo-deep-dive tasks.

`disableTools: true` through Agent SDK is not an acceptable long-term direct
LLM implementation.

### 11.2 Model routing

Initial policy:

| Purpose                     | Primary                | Escalation                                      |
| --------------------------- | ---------------------- | ----------------------------------------------- |
| Intent/fast coordinator     | Haiku-class fast model | Sonnet 5 on schema/quality failure              |
| Conversation summary        | Haiku-class fast model | deterministic fallback                          |
| Source distillation         | Haiku-class fast model | Sonnet 5 for low confidence                     |
| Context summary fields      | Haiku-class fast model | Sonnet 5                                        |
| User-facing synthesis       | Sonnet 5               | stronger approved model only by policy          |
| Code/config/DevOps research | Sonnet 5 Agent SDK     | none without explicit policy                    |
| Draft generation            | Sonnet 5 direct        | Agent SDK only when evidence gap requires tools |

The model registry must include a startup canary for each enabled route. An
invalid model/thinking/output configuration prevents that route from becoming
healthy; it must not silently create a permanent fallback tax.

### 11.3 Reliability and latency

- One bounded retry for throttling/5xx before the interactive deadline.
- Exponential backoff with jitter for background work.
- Circuit breaker per model/region/purpose.
- Fail over to an explicitly compatible model route, never a generic legacy
  agent, when the direct provider is unhealthy.
- Optional hedged request after measured p99 threshold for stateless direct
  calls; accept one result and audit the duplicate cost.
- Stream user-facing answer text when the contract permits it.
- Cancel provider calls when the turn is cancelled/archived or lease is lost.

### 11.4 Budget and quota policy

Enable and enforce:

- Per-call token and USD reservation.
- Per-session rolling budget.
- Per-user/tenant daily budget.
- Global daily budget.
- Per-purpose concurrency limit.
- Bedrock quota utilization alarms.

Cost is not the primary constraint for this design, but unlimited accidental
loops are still correctness failures. Budgets protect reliability, not merely
spend.

### 11.5 Audit correctness

Record provider-reported input/output/cache tokens and latency. Reconcile audit
metrics against sampled Bedrock usage. Implausible values such as two input
tokens for a large source must alarm rather than silently undercount cost.

---

## 12. Chat Turn Control Flow

```text
POST /messages
  -> authenticate + authorize session
  -> validate/reuse client idempotency key
  -> transaction:
       insert user message
       insert compose_turn_jobs(requested_context_version)
       insert turn.queued event
       insert outbox(turn queue)
  -> 202 {messageId, turnJobId, status:'queued'}

Turn worker receives SQS message
  -> claim DB row + lease generation
  -> set context_version_used
  -> publish turn.started
  -> fast deterministic command OR direct coordinator
       answer -> fenced final write
       ask_clarification -> park awaiting_user_input
       dispatch_research -> transactionally create tasks + outbox, park turn
       escalate -> fenced policy response
  -> enqueue conversation patch
  -> commit assistant final + output + events + next outbox atomically
```

Turn workers process multiple sessions concurrently. The DB claim plus FIFO
message group enforces one active turn per session.

Interactive and batch work use separate queues and worker pools. Analyze cannot
block ordinary chat. If analyze remains expensive, give it a dedicated queue
and turn-worker service with lower priority.

---

## 13. Research Control Flow

1. Coordinator transaction creates bounded research tasks and outbox rows,
   then parks the turn.
2. Research worker claims one task, hydrates immutable context/repository
   snapshots into local scratch, and runs Agent SDK with capability-scoped
   tools.
3. Network access is denied by default and enabled only through an audited
   egress proxy/allowlist.
4. The worker writes redacted research artifact and evidence metadata to S3.
5. A fenced transaction creates the generated source, completes the task,
   records runtime usage, emits events, and queues source distillation.
6. Context merge commits generated evidence.
7. When all linked research tasks are terminal, one outbox row requeues the
   parked turn for synthesis.

Add a hard maximum research-round count separate from failure attempts. Prior
research remains in the context bundle, but LLM observation alone is not a hard
loop bound.

---

## 14. Compose-to-Draft Handoff

### 14.1 Handoff aggregate

Add `compose_handoffs` with lifecycle:

```text
requested -> snapshot_building -> snapshot_ready -> draft_queued -> drafting
          -> draft_ready -> approved -> publishing -> published
          -> failed | cancelled
```

The row contains:

```text
id, session_id, source_id, requested_by, status,
requested_context_version, context_version_used,
message_high_watermark_id, source_revision_set_hash,
repository_manifest_hash, snapshot_id, draft_workflow_id,
error_code, error_message, created_at, updated_at, completed_at
```

### 14.2 Immutable snapshot contract

The handoff snapshot includes:

- Session id/name/owner and actor.
- Frozen Working Context JSON and Markdown.
- All conversation messages through `message_high_watermark_id`, or a verified
  summary plus raw-message artifact reference.
- User decisions, clarification answers, open questions, risks, assumptions,
  and readiness.
- Source revision inventory and checksums.
- Generated research and confidence/evidence.
- Repository ids, commit SHAs, selected paths, and grounding manifest.
- Handoff schema version, build timestamp, checksums, and byte counts.

The draft workflow receives `handoff_snapshot_id`; it never re-reads mutable
`chat.md`, a live session row, or changing source files.

### 14.3 Handoff API

`POST /sessions/:id/handoff` returns:

```json
{
  "handoffId": 44,
  "sourceId": 1665,
  "status": "snapshot_building",
  "contextVersion": 4,
  "messageHighWatermarkId": 562
}
```

Retries with one idempotency key return the same handoff. A new handoff after
new messages/context creates a new immutable snapshot and draft workflow.

---

## 15. Draft Workflow Redesign

Replace one monolithic `processQueuedJobs()` execution with persisted stages:

```text
evidence_snapshot
  -> qualify
  -> repository_context
  -> draft_synthesize
  -> validate
  -> persist_draft
  -> approval_wait
  -> jira_publish
  -> oneshot_submit
```

Each stage run records:

- Immutable input artifact/checksum.
- Attempt number and lease generation.
- Provider/model/prompt version where relevant.
- Output artifact/checksum.
- Token/cost/timing metrics.
- Error code and retry classification.
- Next-stage outbox row in the completion transaction.

A retry resumes at the failed stage. It does not repeat successful evidence
collection, qualification, or repo analysis unless their immutable input hash
changed.

Draft synthesis should use the direct Bedrock adapter against bounded evidence
and repo-context summaries. Agent SDK deep dive is an explicit side task, not
the default draft engine. Validation runs before persistence and may invoke one
bounded repair call.

Louise and Compose continue to converge on this same workflow. Their only
difference is the immutable evidence snapshot producer.

---

## 16. Artifact and Workspace Architecture

### 16.1 S3 as canonical artifact store

Use versioned, KMS-encrypted S3 prefixes:

```text
spec-factory/sessions/<sessionId>/sources/<sourceId>/revisions/<revisionId>/...
spec-factory/sessions/<sessionId>/context/v<version>/...
spec-factory/sessions/<sessionId>/research/<taskId>/...
spec-factory/sessions/<sessionId>/handoffs/<handoffId>/...
spec-factory/workflows/<workflowId>/stages/<stage>/<attempt>/...
```

Every artifact metadata row stores URI, SHA-256, bytes, content type, schema
version, creator job/task, and retention class.

### 16.2 Task-local hydration

Workers receive a manifest, hydrate only required artifacts into Fargate
ephemeral storage, verify checksums, and delete scratch on completion. No worker
assumes another worker wrote a local/EFS file.

### 16.3 EFS role

EFS may remain as a read-through cache for large Git repository clones. Cache
entries are keyed by repository id and commit SHA, immutable after completion,
and guarded by checksums/locks. Session chat/context/source state must not depend
on EFS.

---

## 17. Event and SSE Architecture

### 17.1 Canonical event envelope

All session events use one envelope:

```json
{
  "id": 91234,
  "eventType": "handoff.snapshot_ready",
  "occurredAt": "2026-07-09T22:00:00.000Z",
  "sessionId": 81,
  "correlation": {
    "turnJobId": null,
    "agentTaskId": 88,
    "handoffId": 44,
    "workflowId": 301,
    "sourceId": 1665,
    "contextVersion": 4
  },
  "data": {}
}
```

Do not require domain-event payloads to masquerade as one of four chat UI
types. The frontend reducer maps canonical events into messages, activity,
progress, readiness, and workflow stages.

### 17.2 Durable and live paths

1. Domain transaction inserts event + outbox.
2. Relay publishes event to a session-specific Valkey channel.
3. Any API replica with a subscriber forwards it immediately.
4. EventSource reconnect sends `Last-Event-ID`.
5. API replays durable MySQL events, then bridges to live fanout without gaps.

Redis/Valkey outage increases latency but cannot lose events. API replicas need
no sticky sessions.

### 17.3 Event retention

Archive old events to S3 and retain enough hot history for reconnect and
support. Consumers must tolerate unknown future event types.

---

## 18. Compose User Experience

### 18.1 Replace spinner state with workflow state

For every accepted turn show:

- Accepted timestamp and durable `turnJobId`.
- `queued`, `running`, `waiting for clarification`, `researching`,
  `synthesizing`, `completed`, `failed`, or `cancelled`.
- Queue age and approximate position when available.
- Current stage and elapsed time.
- Retry attempt only when a retry is actually occurring.
- Cancel action for non-terminal work.
- Explicit reconnect/stale-data status.

Never clear a spinner solely because a timer elapsed. Reconcile from the turn
status endpoint.

### 18.2 Handoff experience

The primary action follows real state:

```text
Prepare handoff
Building evidence snapshot...
Draft queued
Drafting...
Review draft
Approved
Publishing to Jira...
View Epic
```

`View Epic` appears only after a Jira Epic key exists. `Review draft` appears
only when a ready draft exists.

### 18.3 Idempotent client actions

Generate one idempotency key per optimistic action and retain it until a
terminal HTTP response or authoritative reconciliation. A network retry reuses
the same key. Store `turnJobId` on the optimistic message instead of deduping by
role and content.

### 18.4 Error and stale-state behavior

- Do not silently swallow list/session/source/message/context refresh errors.
- Preserve the last data but show `Last updated`, stale state, and retry.
- Distinguish provider outage, queue delay, source conversion failure, context
  failure, and handoff/draft failure.
- Offer stage-specific retry when safe.
- Preserve user input across reconnects and failures.

### 18.5 Requirements-first workspace

- Treat the user as a business stakeholder, product owner, product manager, or
  domain expert. Ask only business and functional clarification questions.
- Keep method, class, API, schema, repository, architecture, deployment, and
  other implementation decisions out of user-facing questions.
- Automatically convert, distill, and merge each new source. Do not require an
  Analyze Sources action or repository picker.
- When a clear problem statement exists, ask explicit consent before bounded
  code research. Repository grounding is backend-owned.
- Separate user Sources from generated Artifacts. Artifacts expose current
  context, problem, solution, business/functional requirements, challenges,
  stories, conversation decisions, and generated research without reducing chat
  height.
- Show authoritative Sources, Requirements, Research, and Draft agent status in
  the toolbar.
- Produce professional PM/PO stories with complete `Scenario`, `Given`, `When`,
  and `Then` acceptance criteria.
- Reuse ready/approved drafts during context repair and preserve published Epic
  identity.

The canonical interaction and acceptance contract is
[`requirements-workspace.md`](../../spec-factory/requirements-workspace.md).

---

## 19. Fairness and Admission Control

Large-session support requires preventing one actor or session from consuming
all capacity.

- One active user turn per session.
- Configurable active-turn limit per user and tenant.
- Separate interactive, analyze, research, conversion, and draft capacity.
- Weighted fair admission by tenant/user, backed by Valkey token buckets and
  authoritative DB quotas.
- Interactive queue always has reserved worker/model capacity.
- Source upload and research fanout have per-session and global limits.
- Return `429` with retry metadata before accepting work that cannot meet an
  explicit queue-age ceiling.

When tenant identity is unavailable, use actor id plus a conservative global
bucket. Do not silently treat every request as unlimited.

---

## 20. Security Architecture

### 20.1 Task roles and secrets

| Runtime     | Required secrets/access                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| API         | DB API credential, stream-token signing/hashing material, S3 presign         |
| Turn        | DB worker credential, Bedrock direct invoke, context artifact read           |
| Context     | DB worker credential, Bedrock direct invoke, session artifact read/write     |
| Research    | DB task credential, Bedrock Agent SDK, GitHub read token/App, scoped S3      |
| Conversion  | DB conversion credential, source/result S3, no Jira/GitHub                   |
| Draft       | DB workflow credential, Bedrock, Jira publish credential, repo artifact read |
| Event relay | outbox/event DB credential, SQS send, Valkey publish                         |
| Maintenance | scoped delete/list permissions plus maintenance DB credential                |

Use separate Secrets Manager entries, IAM task roles, and database users.

### 20.2 Network

- Private subnets only.
- VPC endpoints for S3, Secrets Manager, CloudWatch, ECR, SQS, STS, and Bedrock
  where supported.
- No default `0.0.0.0/0` task egress.
- Research outbound traffic goes through an authenticated, logged egress proxy
  with destination allowlists.
- Conversion workers cannot reach Jira/GitHub.
- API cannot execute shell or repo tools.

### 20.3 Data protection

- KMS encryption for S3, Aurora, EFS, SQS, logs, and secrets.
- Redaction before database, artifact, event, trace, or log persistence.
- Session ownership/admin policy applied at API boundaries and hard-delete.
- DSR hard-delete covers every artifact prefix and archived event export.
- CloudTrail/data-event coverage for sensitive artifact buckets.

---

## 21. Observability and Operations

### 21.1 Correlation

Every log, trace, audit call, event, and metric carries available identifiers:

```text
request_id, actor_id, session_id, turn_job_id, agent_task_id,
handoff_id, workflow_id, stage_run_id, source_id, context_version,
worker_id, lease_generation, outbox_id, queue_message_id
```

Use OpenTelemetry through ADOT to CloudWatch/X-Ray or the platform-standard
backend. Never put source/message content in span attributes.

### 21.2 Required metrics

Per queue and work type:

- accepted/completed/failed/cancelled/abandoned.
- queue age p50/p95/p99 and oldest age.
- run latency p50/p95/p99.
- retries, lease expiries, fence rejections, duplicate suppression.
- active workers, concurrency, utilization, and heartbeat age.
- DLQ depth and redrive count.
- outbox undispatched count/age and dispatch failures.
- provider latency, tokens, cost, throttles, and circuit state.
- SSE connections, replay count, replay latency, disconnects, fanout lag.
- context patch/merge lag and version drift.
- handoff/draft stage conversion and failure rates.

### 21.3 Alarms

At minimum:

- Interactive queue p95 age > 5 seconds for 5 minutes.
- Any accepted turn older than its terminal SLO.
- Coordinator route success < 99%.
- Outbox oldest undispatched > 10 seconds.
- DLQ depth > 0.
- Worker capability has no live heartbeat.
- Lease/fence rejection anomaly.
- Aurora connections/CPU/lock waits/replica lag thresholds.
- Bedrock throttle/quota utilization threshold.
- Durable event persistence failure > 0.
- Context latest version missing parent content invariant.
- Handoff snapshot or draft stage failure-rate threshold.

### 21.4 Operator controls

Provide authenticated control-plane endpoints or CLI commands for:

- Inspect/requeue/cancel a turn or task.
- Redrive one DLQ message after DB-state validation.
- Rebuild one session context.
- Rebuild one handoff snapshot.
- Retry one draft stage.
- Pause one workflow class without disabling unrelated traffic.
- Drain one ECS service before deployment.
- Report queue, worker, model, and cost health.

---

## 22. CI/CD and Migration Safety

### 22.1 Required PR checks

- Node version matches production.
- Build and lint/typecheck are blocking.
- All Spec Factory backend tests are blocking; no hand-maintained subset.
- All dashboard Spec Factory tests and typecheck are blocking.
- Migration/schema consistency tests.
- Terraform format/validate/plan checks.
- Container vulnerability and secret scans.
- Contract tests for event envelope, queue message, context patch, handoff
  snapshot, and workflow stage schemas.
- Integration tests against real MySQL semantics, SQS-compatible test services,
  and S3 artifact behavior.

### 22.2 Image/deploy policy

- Tag images with commit SHA and record digest.
- Terraform/ECS task definitions reference digest, not `latest`.
- Use ECS blue/green or canary deployment with automated rollback.
- API and each worker service deploy independently but from a compatibility
  matrix generated by the release.
- Graceful drain stops new claims, renews/finishes active leases, and reports
  zero in-flight work before termination when possible.

### 22.3 Schema policy

Use expand/migrate/contract:

1. Apply backward-compatible schema expansion.
2. Verify schema and indexes.
3. Deploy dual-compatible code.
4. Backfill/repair asynchronously.
5. Switch readers/writers.
6. Remove old columns/paths only in a later release.

The deployment workflow must run a schema compatibility preflight. Migrations
may run in a dedicated approval-gated workflow before application rollout, but
the application workflow must refuse to deploy against an incompatible schema.

---

## 23. Terraform Work

Create or update Terraform for:

- Four immutable ECR repositories/images: API, core worker, research,
  conversion.
- Seven ECS services and scheduled maintenance task definitions.
- Separate task roles, execution roles, log groups, security groups, and
  Secrets Manager bindings.
- SQS queues, FIFO settings where required, DLQs, redrive policies, encryption,
  queue-age alarms, and dashboards.
- ElastiCache Valkey Multi-AZ/serverless live fanout.
- Aurora MySQL cluster, readers, parameter groups, RDS Proxy, alarms, backups,
  and secrets if migration from current RDS is approved.
- S3 artifact bucket/prefix policy, versioning, lifecycle, KMS, and access logs.
- VPC endpoints and egress proxy controls.
- ECS Application Auto Scaling policies per service.
- CloudWatch dashboards, metric filters, alarms, and SNS/PagerDuty routing.
- Bedrock service-quota requests documented as deployment prerequisites.

Autoscaling policies use queue age as the primary signal and backlog/task as a
secondary target. CPU alone is insufficient because most workers wait on
external model calls.

---

## 24. Data Repair and Backfill

Existing rows cannot simply be declared correct after the new code deploys.

1. Preserve all historical context versions as immutable audit history.
2. For every active session, enqueue a `context_rebuild_v4` job that reads all
   active source revisions and relevant conversation messages.
3. Create a new cumulative context version; never mutate an old version.
4. Compare source coverage, item counts, provenance, and summary quality against
   prior versions.
5. Mark sessions `context_status='clean'` only after verification.
6. Historical null turn provenance remains null unless it can be proven; do not
   fabricate versions.
7. Rebuild handoff snapshots for linked Compose sources that have no ready draft
   or whose draft was generated from stale workspace evidence.
8. Reconcile queued/running jobs before enabling SQS dispatch so one DB job has
   at most one current queue generation.
9. Export a repair report with per-session/source outcomes and exceptions.

Because there are currently no active Spec Factory users, a planned maintenance
window may be used for the initial queue/topology cutover. The design must still
remain safe for future zero-downtime deployments.

---

## 25. Dependency-Ordered Work Orders

Each work order should be one reviewable PR or a small, explicitly named PR
series. Do not combine unrelated phases into one handoff.

| ID  | Work order                                                                 | Depends on | Exit criteria                                                                                                 |
| --- | -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| A   | Make backend/dashboard CI complete and blocking; align Node runtime        | none       | All current tests run; no `continue-on-error`; build green                                                    |
| B   | Add latency/correlation metrics and production baseline dashboards         | A          | Queue/run/provider p50/p95/p99 visible and alarmable                                                          |
| C   | Implement direct Bedrock LLM provider and route canary                     | A, B       | Haiku/Sonnet canaries pass; no Agent SDK for direct calls                                                     |
| D   | Fix coordinator bundle hydration and turn context freeze                   | C          | Context artifacts loaded; both turn version fields populated                                                  |
| E   | Introduce bounded v4 context patch schema and cumulative reducer           | A          | Parent facts survive; delete/conflict tests pass                                                              |
| F   | Add conversation patches and source chunk/revision pipeline                | C, E       | Decisions/answers appear once in context with message provenance                                              |
| G   | Add transactional outbox and relay in shadow mode                          | A, B       | No undispatched crash window; repair and duplicate tests pass                                                 |
| H   | Add SQS queues/DLQs and dual-dispatch consumers                            | G          | DB/SQS duplicate, delay, redrive, and outage tests pass                                                       |
| I   | Split API from all-local execution                                         | H          | API executes no worker loop; three API replicas pass SSE tests                                                |
| J   | Add concurrent turn workers with per-session exclusion                     | D, H, I    | Different sessions parallel; same session ordered; load SLO passes                                            |
| K   | Split capability-specific workers, IAM, secrets, and network               | I          | Heartbeats show exact capabilities; forbidden access tests pass                                               |
| L   | Move source/context/research workspaces to immutable S3 manifests          | K          | Kill/restart/local-disk-loss tests preserve all work                                                          |
| M   | Add handoff aggregate and immutable snapshot                               | E, F, G, L | Snapshot contains frozen context/messages/sources/repos and checksum                                          |
| N   | Refactor draft pipeline into durable stage runs                            | G, H, L, M | Stage retry resumes without rerunning successful stages                                                       |
| O   | Add canonical event envelope and Valkey fanout                             | G, I       | Multi-replica SSE gap/duplicate/outage tests pass                                                             |
| P   | Rebuild Compose UI around correlated turn/handoff/workflow state           | J, M, N, O | No timeout-cleared false idle; cancel/retry/stale states work                                                 |
| Q   | Add autoscaling, Aurora/RDS Proxy, immutable image rollout                 | H, I, K    | Scale and failover tests meet SLOs                                                                            |
| R   | Enable retention, budgets, strict durable events, and repair jobs          | B, G, K, L | No stale-token/heartbeat growth; budget and GC alarms clean                                                   |
| S   | Backfill cumulative contexts and handoff snapshots                         | E, F, M, R | Repair report accepted; active sessions clean                                                                 |
| T   | Full load, soak, chaos, security, and disaster-recovery certification      | all        | Section 28 gates pass                                                                                         |
| U   | Remove legacy queue, mutable workspace, direct enqueue, and `latest` paths | T          | No runtime reference; rollback window closed intentionally                                                    |
| V   | Rebuild Compose as a requirements-first workspace                          | F, M, P    | Only business/functional questions render; consented research, Artifacts, agent state, and Gherkin flows pass |

### 25.1 First implementation tranche

Start with A-F. These close correctness and direct-LLM latency before adding
distributed complexity.

### 25.2 Second implementation tranche

G-L create the scalable execution substrate and security boundaries.

### 25.3 Third implementation tranche

M-P repair the end-to-end handoff and product experience.

### 25.4 Final implementation tranche

Q-U complete production scale, repair, certification, and legacy removal. V is
an experience slice over F, M, and P and may deploy before U deletion after its
user-flow tests pass.

---

## 26. Rollout Sequence

### Stage 0: Baseline and freeze

- Merge CI and observability first.
- Capture seven-day latency/error/cost baselines.
- Stop introducing new feature flags or queue paths during control-plane work.

### Stage 1: Correctness release

- Direct LLM provider.
- Coordinator canaries.
- Cumulative context reducer.
- Context freeze/provenance.
- Conversation patches.
- Keep legacy fallback available but alert on every use.

Gate: coordinator route success >= 99%, no context coverage regressions, and
interactive answer p95 materially below legacy.

### Stage 2: Outbox and queue shadow

- Write outbox rows for every transition.
- Relay to SQS shadow queues.
- Shadow consumers validate but do not execute side effects.
- Reconcile DB jobs against queue messages continuously.

Gate: zero missing transitions and duplicate/no-op behavior proven.

### Stage 3: Worker cutover

- Deploy API, turn, context, research, conversion, draft, and relay services.
- Set all-local primary to drain.
- Route one workflow class at a time to SQS consumers.
- Verify zero legacy in-flight work before disabling its claim loop.

Gate: multi-replica SSE, worker heartbeat coverage, queue age, and fence metrics
within thresholds.

### Stage 4: Handoff/draft cutover

- Build immutable snapshots in shadow and compare evidence coverage.
- Route new handoffs to staged draft workflows.
- Keep old draft path read-only for rollback until comparison passes.

Gate: no conversation/source/repository coverage loss; stage retry proven.

### Stage 5: Scale and repair

- Run backfills.
- Increase autoscaling maximums gradually.
- Execute load/soak/chaos tests.
- Enable strict durable events, budgets, retention, and full alarms.

### Stage 6: Legacy removal

- Remove in-process queues, all-local production mode, mutable session workspace
  dependence, old handoff fallback, monolithic draft loop, and mutable image
  tags.
- Update v3/current-state docs to match deployed truth.

---

## 27. Rollback Rules

- Roll back routing, not durable rows. Never delete accepted work to revert.
- A worker version may be rolled back only if it understands current schema and
  queue-message versions.
- Queue messages carry schema version; unsupported versions move to a
  quarantine queue, not a generic failure loop.
- Keep expand-schema changes through the rollback window.
- Outbox relay can be paused independently while DB writes continue.
- Redis can be bypassed; clients replay durable events.
- SQS dispatch can be paused; repair republishes authoritative queued rows.
- Direct LLM route can fail over to another compatible direct route. Legacy
  Agent SDK fallback is break-glass and explicitly metered.
- Handoff/draft rollback resumes from immutable snapshots/stage artifacts.

---

## 28. Verification Plan

### 28.1 Functional invariants

- Same idempotency key/body returns same turn; changed body returns 409.
- Two sessions execute in parallel.
- Two turns in one session execute in order.
- Worker death after provider call cannot create duplicate final/artifact.
- Archive during every stage prevents authoritative post-archive writes.
- Context v2 contains untouched v1 items plus v2 changes.
- Deleting a source creates explicit context removals.
- Handoff contains all messages through its high-watermark.
- Draft retry resumes at the failed stage.
- SQS duplicate/redelivery is a no-op after completion.
- Redis outage loses no durable event.
- API replica loss reconnects and replays without gap or duplicate.

### 28.2 Load tests

Run at design and stress envelopes:

1. 5,000 then 25,000 long-lived SSE clients with reconnect churn.
2. 20 then 100 turn accepts/second across distinct sessions.
3. Hot-session test with repeated turns proving per-session ordering/fairness.
4. Mixed workload: chat, analyze, conversion, distillation, research, handoff,
   draft, and publish concurrently.
5. Large-source fanout with chunked distillation.
6. Draft burst from Louise plus interactive Compose traffic; chat SLO must hold.
7. 24-hour soak at 60% design load.

### 28.3 Chaos tests

- Kill workers before/after provider response and before/after DB commit.
- Kill API replicas with active SSE clients.
- Delay/drop/duplicate SQS messages.
- Make Redis unavailable.
- Force Aurora failover and reader lag.
- Expire leases during long research.
- Return Bedrock throttles, malformed JSON, long latency, and route-specific
  incompatibility.
- Make S3 temporarily unavailable after artifact temp write.
- Revoke GitHub/Jira secret during a task.
- Fill task-local disk and verify bounded failure.

### 28.4 Security tests

- API image cannot execute research tools.
- Research cannot read Jira secret or unrelated S3 prefixes.
- Conversion cannot reach GitHub/Jira.
- Bash remains unavailable unless explicitly enabled and policy-tested.
- Redaction corpus covers DSNs, cloud keys, PATs, JWTs, PEM, bearer tokens, and
  unknown-key secret values.
- DSR removes database rows, S3 artifacts, archived events, and audit artifacts.

### 28.5 Disaster recovery

- Restore Aurora to a new environment.
- Rehydrate queue messages from queued DB rows/outbox.
- Rebuild Valkey fanout state from active connections.
- Verify S3 artifact checksums.
- Resume non-terminal workflows without duplicate side effects.

---

## 29. Production Readiness Gates

The large-scale rollout is approved only when:

1. All Section 28 functional invariants pass.
2. Design-envelope load test meets Section 3 SLOs with 35% capacity headroom.
3. 24-hour soak has no lost/duplicate work, lease leak, memory leak, or growing
   undispatched outbox.
4. Coordinator route success is >= 99.5% and legacy fallback < 0.5%.
5. Context source coverage is monotonic except explicit removal operations.
6. Every enabled capability has at least two healthy workers where HA matters.
7. DLQs are empty and redrive procedure is tested.
8. Aurora failover and worker/API termination tests pass.
9. No task has unnecessary secrets or unrestricted egress.
10. Full backend/dashboard test suites are blocking.
11. Task definitions use immutable digests.
12. Schema compatibility preflight and rollback are demonstrated.
13. Cost/token metrics reconcile with provider data.
14. Retention, DSR, backup, restore, and incident runbooks are exercised.

---

## 30. Implementation Handoff and Operational Sequence

The code tranche is assembled in PR `#468`. After review and merge, progress one
operator-controlled gate at a time:

1. Build and push all role-specific immutable images from the merge SHA.
2. Apply migrations `069` through `073` in order and run the schema verifier.
3. Run a local Terraform plan with the merge SHA, inspect resource replacement,
   IAM, security-group, secret, queue, and task-definition changes, then apply.
4. Deploy split services with queue dispatch in `shadow`; confirm heartbeats,
   outbox parity, receipt fencing, SSE replay, and empty quarantine/DLQs.
5. Move durable turns and each capability queue to `primary`, preserving the
   database as the authoritative state and observing queue-age/error SLOs.
6. Run and reconcile the v4 context repair; accept its report only when every
   active session has a clean committed v4 context.
7. Run Work Order T certification against the exact release SHA/environment and
   retain its evidence bundle. A passing evaluator emits `sfv4-<sha256>`.
8. Only then set `SPEC_FACTORY_LEGACY_RUNTIME=disabled`; startup and Terraform
   gates reject incomplete certification, repair, HA, retention, budget, queue,
   artifact, or image-pin configuration.

Production migration application, Terraform apply, certification execution,
and irreversible legacy deletion are deliberately outside the code PR.

---

## 31. Definition of Done

Spec Factory is complete under this plan when:

- API replicas are stateless and horizontally scalable.
- Every workflow class has a durable queue, independent worker pool, DLQ,
  autoscaling policy, and SLO.
- Interactive work has no global cross-session serialization.
- Tool-free LLM work uses the direct provider.
- Working Context is cumulative, bounded, version-frozen, and provenance-safe.
- Conversation decisions survive into handoff and draft.
- Handoffs and draft stages are immutable, correlated, retryable workflows.
- The UI renders authoritative stages and never invents completion from a
  linked source or elapsed timer.
- Users resolve business and functional ambiguity while implementation choices
  remain internal; sources process automatically, research is consented, all
  generated work is inspectable as Artifacts, and criteria use Gherkin.
- Mutable EFS session state, mutable image tags, all-local production mode, and
  partial/non-blocking CI are gone.
- Load, chaos, security, retention, DSR, backup, and restore tests pass at the
  approved design envelope.
