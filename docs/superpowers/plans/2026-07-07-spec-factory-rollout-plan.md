# Spec Factory Gated Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for task-by-task rollout execution. This plan is an operations rollout plan, not a feature implementation plan; still execute the checklist in order and update each checkbox as evidence is collected.

**Goal:** Roll out the hardened Spec Factory control plane in a staged sequence that preserves the legacy user path until durable turns, generated research, and the chat coordinator are each proven stable.

**Architecture:** Treat durable turns as the control-plane foundation, generated research as the first worker-backed capability, and the chat coordinator as the final routing layer. Each stage has a forward flag change, a health gate, a rollback move, and SQL/status checks.

**Tech Stack:** TypeScript services, MySQL durable state, ECS/Terraform runtime flags, Bedrock-only LLM Gateway, Claude Agent SDK research executor, dashboard `/api/spec-factory/status` health payload.

---

## Current Rollout Position

Code baseline: commit `770fba26` or later on the target branch.

Already reviewed as ship-ready:

- Session archive guards, stream token revocation, durable SSE replay, durable turn jobs, idempotency-key conflict handling, lease fencing, mid-turn archive cancellation, and heartbeat/recovery paths.
- Research executor hardening: redaction, task lease checks, generated-source idempotency, research ingress split, safe default tools, fail-closed Bash allowlist, and research spend accounting.
- LLM Gateway hardening: audit writes and artifact writes are off the product path, error codes are truncated, prompt artifacts can be retained/erased safely.
- Coordinator hardening: durable-only research dispatch, budget reservation, authoritative context provenance, attempt-count reset on non-failure requeue, and cumulative research spend checks.

Known config note:

- Code and plan docs support `SPEC_FACTORY_COORDINATOR_MAX_COST_USD`.
- Terraform currently passes `SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN` but does not pass `SPEC_FACTORY_COORDINATOR_MAX_COST_USD` into ECS.
- This does not block the first coordinator canary if the default reservation `0.25` USD per coordinator call is accepted. Add the Terraform variable/env mapping before production rollout if operators need a different coordinator reservation.

---

## Rollout Rules

- Do not skip durable-turn states. The only allowed forward order is `off -> shadow -> drain -> on`.
- Do not enable generated research ingress until the research executor and agent-task worker are already running with ingress closed.
- Do not enable the chat coordinator unless `SPEC_FACTORY_DURABLE_TURNS` is `drain` or `on`, the durable worker path is healthy, generated research is healthy, and a research budget is configured.
- Do not enable Bash in the research executor during this rollout. Keep `SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS=Read,Grep,Glob` unless a separate security review approves Bash.
- Roll back one layer at a time. Prefer disabling the newest layer first instead of tearing down the durable foundation.
- Keep every canary at least one staging traffic window or one explicit scripted smoke suite before advancing. The default production-like soak window is 24 hours.

---

## Preflight Checklist

- [ ] Confirm the target branch is clean and includes commit `770fba26` or later.

  ```bash
  git rev-parse HEAD
  git status --short
  ```

- [ ] Confirm migrations through the current Spec Factory migration set are applied in the target database before any flag flips.

  ```sql
  SELECT version, description, success, installed_on
  FROM flyway_schema_history
  WHERE description LIKE '%compose%'
     OR description LIKE '%spec_factory%'
  ORDER BY installed_rank DESC
  LIMIT 20;
  ```

- [ ] Confirm `/api/spec-factory/status` is reachable from the dashboard and returns `composeControlPlane`.

  ```text
  dashboard -> Spec Factory -> health strip
  GET /api/spec-factory/status
  ```

- [ ] Capture a baseline status snapshot before changing flags.

  ```sql
  SELECT status, COUNT(*) AS count
  FROM compose_turn_jobs
  GROUP BY status
  ORDER BY status;

  SELECT status, capability, COUNT(*) AS count
  FROM compose_agent_tasks
  GROUP BY status, capability
  ORDER BY status, capability;
  ```

- [ ] Confirm no unexpected active legacy turn load before the durable drain step.

  Gate:

  ```text
  composeControlPlane.turns.legacyInflight = 0 during the final drain-to-on check
  composeControlPlane.turns.legacyQueued = 0 during the final drain-to-on check
  ```

- [ ] Decide whether the coordinator can use the built-in `0.25` USD default reservation. If not, land a Terraform mapping for `SPEC_FACTORY_COORDINATOR_MAX_COST_USD` before Stage 9.

---

## Stage 1 - Durable Events And Stream Tokens Baseline

Purpose: verify the shared stream-token and durable event surfaces before turning execution over to durable workers.

Flag posture:

```text
SPEC_FACTORY_DURABLE_TURNS=off
SPEC_FACTORY_DURABLE_EVENTS_REQUIRED=false
SPEC_FACTORY_CHAT_COORDINATOR=false
SPEC_FACTORY_RESEARCH_EXECUTOR=none
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false
```

Checks:

- [ ] Protected session stream resume works across a fresh browser session.
- [ ] Archiving a protected session revokes stream tokens before archive commits.
- [ ] SSE reconnect replays durable events and bridges to live delivery without duplicate assistant finals.
- [ ] Status endpoint shows stable stream-token and event counters.

Health gates:

```text
composeControlPlane.events.durablePersistFailuresToday = 0
composeControlPlane.events.payloadTooLargeToday = 0
composeControlPlane.streamTokens.expiredUnrevokedTokens = 0
```

Rollback:

```text
No flag rollback required. Keep durable turns off and investigate token/event write failures.
```

---

## Stage 2 - Durable Turns Shadow

Purpose: write durable turn rows/events while legacy in-memory execution remains the product path.

Forward flag change:

```text
SPEC_FACTORY_DURABLE_TURNS=shadow
SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED=true
```

Terraform apply pattern:

```bash
terraform plan -var='spec_factory_durable_turns=shadow' -var='spec_factory_worker_heartbeat_enabled=true' -out=/tmp/spec-factory-durable-shadow.tfplan
terraform apply /tmp/spec-factory-durable-shadow.tfplan
```

Checks:

- [ ] Post a normal chat message with `Idempotency-Key`.
- [ ] Post a retry with the same `Idempotency-Key` and identical body. It must dedupe instead of appending a second user message.
- [ ] Post a retry with the same `Idempotency-Key` and different body. It must return `409`.
- [ ] Run analyze/reanalyze on a session that has previous chat messages.
- [ ] Archive a session while a turn is running. No assistant message should be appended after archive.

SQL probes:

```sql
SELECT status, COUNT(*) AS count
FROM compose_turn_jobs
GROUP BY status
ORDER BY status;

SELECT idempotency_key, COUNT(*) AS count
FROM compose_turn_jobs
WHERE idempotency_key IS NOT NULL
GROUP BY idempotency_key
HAVING COUNT(*) > 1;

SELECT turn_job_id, COUNT(*) AS assistant_count
FROM compose_session_messages
WHERE role = 'assistant'
  AND turn_job_id IS NOT NULL
GROUP BY turn_job_id
HAVING COUNT(*) > 1;
```

Health gates:

```text
composeControlPlane.turns.duplicateSuppressedToday increases only for deliberate retries
composeControlPlane.turns.leaseExpired = 0
composeControlPlane.turns.leaseFenceRejected = 0
duplicate assistant SQL query returns 0 rows
```

Rollback:

```text
SPEC_FACTORY_DURABLE_TURNS=off
```

---

## Stage 3 - Durable Turns Drain

Purpose: stop adding new legacy in-memory turns, let legacy active work finish, and prove durable workers can pick up work.

Forward flag change:

```text
SPEC_FACTORY_DURABLE_TURNS=drain
SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED=true
```

If using split workers, set:

```text
spec_factory_worker_desired_count=1
```

Checks:

- [ ] Watch the dashboard until legacy counters drain to zero.
- [ ] Submit a chat message after the drain flag is active. It should be claimed by durable execution.
- [ ] Restart one API task while a queued turn exists. The turn must remain queued/runnable after restart.
- [ ] Restart one worker while a running turn exists. Recovery should requeue or complete within two lease windows.

Gate before advancing:

```text
composeControlPlane.turns.legacyInflight = 0 across all API replicas
composeControlPlane.turns.legacyQueued = 0 across all API replicas
composeControlPlane.turns.durableQueued does not grow for more than 5 minutes under normal traffic
composeControlPlane.turns.leaseExpired = 0 outside intentional restart tests
composeControlPlane.turns.leaseFenceRejected = 0 after intentional restart tests settle
```

SQL probe:

```sql
SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
FROM compose_turn_jobs
WHERE status IN ('queued', 'running', 'waiting_on_research', 'awaiting_user_input', 'synthesizing')
GROUP BY status
ORDER BY status;
```

Rollback:

```text
SPEC_FACTORY_DURABLE_TURNS=shadow
```

Do not roll directly from `drain` to `off` while durable queued/running work exists.

---

## Stage 4 - Durable Turns On

Purpose: make durable execution the primary turn path.

Forward flag change:

```text
SPEC_FACTORY_DURABLE_TURNS=on
SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED=true
```

Checks:

- [ ] Run one full chat turn.
- [ ] Run one analyze turn.
- [ ] Run one clarification flow that requires at least two user replies.
- [ ] Archive during an active turn and confirm cancellation/discard events appear without assistant writes.
- [ ] Verify durable events replay after browser reconnect.

Health gates:

```text
composeControlPlane.turns.durableAbandoned = 0 outside intentional stale-recovery tests
composeControlPlane.turns.leaseExpired = 0 outside intentional worker restart tests
composeControlPlane.turns.leaseFenceRejected = 0 after restart tests settle
composeControlPlane.events.durablePersistFailuresToday = 0
composeControlPlane.streamTokens.expiredUnrevokedTokens = 0
```

Rollback:

```text
SPEC_FACTORY_DURABLE_TURNS=drain
```

Do not roll directly from `on` to `off`. Drain durable work first.

---

## Stage 5 - Research Executor Staged With Ingress Closed

Purpose: start worker-backed generated research without exposing user ingress.

Forward flag posture:

```text
SPEC_FACTORY_DURABLE_TURNS=on
SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED=true
SPEC_FACTORY_AGENT_TASKS=true
SPEC_FACTORY_WORKSPACE_MANAGER=true
SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false
SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS=Read,Grep,Glob
SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS=
SPEC_FACTORY_RESEARCH_MAX_COST_USD=3.0
SPEC_FACTORY_RESEARCH_COST_CEILING_USD=10.0
SPEC_FACTORY_RESEARCH_TASKS_PER_24H=10
SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION=2
SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD=
SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS=
SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H=
```

If using split research workers, set:

```text
spec_factory_agent_task_worker_enabled=true
spec_factory_research_worker_desired_count=1
```

Checks:

- [ ] Worker heartbeat appears under `composeControlPlane.workers.byMode.research-worker` or all-local worker heartbeat if staying all-local.
- [ ] Safe tools are limited to read/search/glob behavior. Bash remains unavailable.
- [ ] A controlled internal research task can run to completion without user ingress.
- [ ] Completed research writes one generated source, one runtime run, and one distillation task when distillation is enabled.

SQL probes:

```sql
SELECT capability, status, COUNT(*) AS count
FROM compose_agent_tasks
GROUP BY capability, status
ORDER BY capability, status;

SELECT generated_by_task_id, COUNT(*) AS source_count
FROM compose_session_sources
WHERE generated_by_task_id IS NOT NULL
GROUP BY generated_by_task_id
HAVING COUNT(*) > 1;

SELECT SUM(estimated_cost_usd) AS runtime_cost_usd
FROM compose_agent_runtime_runs
WHERE created_at >= UTC_DATE();
```

Health gates:

```text
composeControlPlane.agentTasks.leaseExpired = 0 outside intentional restart tests
composeControlPlane.agentTasks.leaseFenceRejected = 0
composeControlPlane.research.failedToday = 0 during controlled canary
generated_by_task_id duplicate SQL query returns 0 rows
```

Rollback:

```text
SPEC_FACTORY_RESEARCH_EXECUTOR=none
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false
SPEC_FACTORY_AGENT_TASKS=false
```

---

## Stage 6 - Research Ingress Canary

Purpose: allow authenticated manual research requests while the chat coordinator remains off.

Forward flag change:

```text
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=true
```

Checks:

- [ ] Run one authenticated manual research request from a test session.
- [ ] Confirm generated research appears as `kind='generated_research'` and `source_origin='agent'`.
- [ ] Confirm redacted markdown/evidence/confidence are persisted without obvious secrets.
- [ ] Confirm research cost includes `compose_agent_runtime_runs.estimated_cost_usd`.
- [ ] Confirm session archive during research cancels or fences follow-up writes.

Budget gates:

```text
Per-task research cap = 3.0 USD
Per-session rolling research cap = 10.0 USD
Per-session in-flight cap = 2
Per-session 24h task cap = 10
```

SQL probe:

```sql
SELECT
  s.id AS session_id,
  SUM(COALESCE(r.estimated_cost_usd, 0)) AS research_runtime_cost_usd,
  COUNT(t.id) AS task_count
FROM compose_agent_tasks t
LEFT JOIN compose_agent_runtime_runs r ON r.agent_task_id = t.id
LEFT JOIN compose_sessions s ON s.id = t.session_id
WHERE t.created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
  AND t.capability = 'code_research'
GROUP BY s.id
ORDER BY research_runtime_cost_usd DESC
LIMIT 20;
```

Health gates:

```text
composeControlPlane.research.runningTasks returns to 0 after each canary
composeControlPlane.research.failedToday = 0 or every failure has a known input cause
composeControlPlane.agentTasks.abandoned = 0 outside intentional worker-stop tests
```

Rollback:

```text
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false
```

---

## Stage 7 - Context Versions Shadow

Purpose: prove source distillation and context merge state before the coordinator relies on frozen context provenance.

Forward flag posture:

```text
SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED=true
SPEC_FACTORY_WORKSPACE_MANAGER=true
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=true
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=false
SPEC_FACTORY_ENABLE_CONTEXT_MERGE=true
SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=false
SPEC_FACTORY_LLM_GATEWAY=false
```

Checks:

- [ ] Add or convert one normal operator source and confirm a `source_distillation` task is queued/completed.
- [ ] Confirm at least one `compose_context_patches` row reaches `ready`.
- [ ] Confirm context merge commits a `compose_context_versions` row.
- [ ] Confirm `compose_sessions.latest_context_version` advances only after artifacts are written.
- [ ] Confirm `context_status` remains `patch_ready` when multiple ready patches exist and becomes `clean` only when no ready patches remain.

SQL probes:

```sql
SELECT status, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
FROM compose_context_patches
GROUP BY status
ORDER BY status;

SELECT status, COUNT(*) AS count, MAX(version) AS max_version
FROM compose_context_versions
GROUP BY status
ORDER BY status;

SELECT context_status, COUNT(*) AS sessions
FROM compose_sessions
GROUP BY context_status
ORDER BY context_status;
```

Health gates:

```text
composeControlPlane.context.patchesFailed = 0
composeControlPlane.context.versionsFailedToday = 0
composeControlPlane.context.versionsBuilding returns to 0 after each canary
composeControlPlane.context.patchesReady does not grow without merge progress
```

Rollback:

```text
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=false
SPEC_FACTORY_ENABLE_CONTEXT_MERGE=false
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=false
SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=false
```

---

## Stage 8 - LLM Gateway Canary

Purpose: prove audited Bedrock calls, prompt registry resolution, and cost accounting before routing coordinator decisions through it.

Forward flag posture:

```text
SPEC_FACTORY_LLM_GATEWAY=true
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=true
SPEC_FACTORY_ENABLE_CONTEXT_MERGE=true
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=true
SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=false
SPEC_FACTORY_LLM_PROMPT_LOGGING=redacted
SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE=
SPEC_FACTORY_LLM_SECURE_DEBUG=false
SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=static
SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD=
SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD=
SPEC_FACTORY_CHAT_COORDINATOR=false
```

Checks:

- [ ] Run one LLM-assisted source distillation canary with `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=true`.
- [ ] Confirm `spec_factory_llm_calls` records purpose, model id, estimated cost, and failure status.
- [ ] Force an audit-write failure in a non-production environment and confirm the product response still returns.
- [ ] If enabling `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE`, run a hard-delete erasure test for a session with LLM audit artifacts.

SQL probe:

```sql
SELECT purpose, status, COUNT(*) AS calls, SUM(estimated_cost_usd) AS estimated_cost_usd
FROM spec_factory_llm_calls
WHERE created_at >= UTC_DATE()
GROUP BY purpose, status
ORDER BY purpose, status;
```

Health gates:

```text
composeControlPlane.llm.failedToday = 0 during canary unless the failure was deliberately induced
composeControlPlane.llm.estimatedCostUsdToday is within the rollout budget
composeControlPlane.retention.failedWorkspaceCleanup = 0
```

Rollback:

```text
SPEC_FACTORY_LLM_GATEWAY=false
SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM=false
SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM=false
SPEC_FACTORY_CHAT_COORDINATOR=false
```

---

## Stage 9 - Chat Coordinator Limited Canary

Purpose: route selected turns through the coordinator after durable turns, generated research, and LLM Gateway are already healthy.

Preconditions:

```text
SPEC_FACTORY_DURABLE_TURNS=on
SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk
SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=true
SPEC_FACTORY_LLM_GATEWAY=true
SPEC_FACTORY_CHAT_COORDINATOR=false before this stage starts
```

Initial coordinator posture:

```text
SPEC_FACTORY_CHAT_COORDINATOR=true
SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN=1
```

Cost posture:

```text
Coordinator max cost per call = 0.25 USD default unless Terraform is patched to pass SPEC_FACTORY_COORDINATOR_MAX_COST_USD.
Research per-task max cost = 3.0 USD.
Research per-session rolling cap = 10.0 USD.
Research per-session in-flight cap = 2.
```

Checks:

- [ ] Ask a simple summary/status question. Coordinator should choose `answer`.
- [ ] Ask an ambiguous question. Coordinator should choose `ask_clarification` and park the durable turn without exhausting attempts.
- [ ] Ask a research-heavy question. Coordinator should choose `dispatch_research`, enqueue at most one research task, park, and requeue after terminal research.
- [ ] Confirm the follow-up synthesis sees `generatedResearch` in the coordinator bundle and answers instead of dispatching indefinitely.
- [ ] Force an over-budget research request and confirm `coordinator.decision.rejected` behavior is visible.
- [ ] Confirm persisted `context_version_used` is the worker-frozen bundle value, not an LLM-emitted value.

Status gates:

```text
composeControlPlane.coordinator.decisionsToday.answer increases for direct answers
composeControlPlane.coordinator.decisionsToday.dispatchResearch increases only for research-heavy turns
composeControlPlane.coordinator.decisionsToday.askClarification increases only for ambiguous turns
composeControlPlane.coordinator.decisionsToday.rejected increases only for deliberate budget/fanout tests
composeControlPlane.turns.byStatus.waiting_on_research returns to 0 after research fan-in
composeControlPlane.turns.byStatus.awaiting_user_input reflects only active clarification waits
```

SQL probes:

```sql
SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
FROM compose_turn_jobs
WHERE status IN ('waiting_on_research', 'awaiting_user_input', 'queued', 'running', 'synthesizing')
GROUP BY status
ORDER BY status;

SELECT context_version_used, COUNT(*) AS assistant_messages
FROM compose_session_messages
WHERE role = 'assistant'
  AND created_at >= UTC_DATE()
GROUP BY context_version_used
ORDER BY context_version_used;
```

Rollback:

```text
SPEC_FACTORY_CHAT_COORDINATOR=false
```

After rollback, keep durable turns, LLM Gateway, and research executor on unless their own health gates fail.

---

## Stage 10 - Expand Coordinator

Purpose: raise the coordinator fan-out from limited canary to normal operation.

Forward flag change after 24 hours clean:

```text
SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN=3
```

Checks:

- [ ] Verify budget denials are understandable and rare.
- [ ] Verify no session loops through repeated research fan-out without an assistant answer.
- [ ] Verify generated research remains in the coordinator bundle.
- [ ] Verify average research runtime and max runtime stay within operational expectations.
- [ ] Verify no stale worker or retention backlog appears after the traffic increase.

Health gates:

```text
composeControlPlane.research.failedToday does not exceed the known external/input failure baseline
composeControlPlane.turns.durableAbandoned = 0 outside known restarts
composeControlPlane.workers.stale = 0
composeControlPlane.retention.pendingLlmAuditArtifacts does not grow without cleanup progress
```

Rollback:

```text
SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN=1
SPEC_FACTORY_CHAT_COORDINATOR=false if user-visible failures continue
```

---

## Emergency Kill Switch Order

Use this order for user-visible incidents:

1. Disable coordinator routing.

   ```text
   SPEC_FACTORY_CHAT_COORDINATOR=false
   ```

2. Stop new user-triggered research.

   ```text
   SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false
   ```

3. Stop research execution if workers are failing or cost is rising unexpectedly.

   ```text
   SPEC_FACTORY_RESEARCH_EXECUTOR=none
   ```

4. Keep durable turns on if they are healthy. If durable execution itself is failing, step down one state.

   ```text
   SPEC_FACTORY_DURABLE_TURNS=drain
   ```

5. Disable LLM Gateway only if its product callers are failing and coordinator is already off.

   ```text
   SPEC_FACTORY_LLM_GATEWAY=false
   ```

---

## Rollout Success Criteria

The rollout is complete when all of these are true for a full production-like traffic window:

- [ ] `SPEC_FACTORY_DURABLE_TURNS=on`.
- [ ] `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk`.
- [ ] `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=true`.
- [ ] `SPEC_FACTORY_LLM_GATEWAY=true`.
- [ ] `SPEC_FACTORY_CHAT_COORDINATOR=true`.
- [ ] Duplicate assistant-message SQL query returns 0 rows.
- [ ] Generated-source duplicate SQL query returns 0 rows.
- [ ] `composeControlPlane.turns.leaseFenceRejected = 0` outside intentional restart tests.
- [ ] `composeControlPlane.agentTasks.leaseFenceRejected = 0` outside intentional restart tests.
- [ ] `composeControlPlane.events.durablePersistFailuresToday = 0`.
- [ ] `composeControlPlane.streamTokens.expiredUnrevokedTokens = 0`.
- [ ] Research and LLM costs are within the approved rollout budget.
- [ ] Archive-during-turn, archive-during-research, clarification, and research fan-in smoke tests pass.

---

## Follow-Up Work Before Broad Production

- [ ] Add Terraform support for `SPEC_FACTORY_COORDINATOR_MAX_COST_USD` if the default `0.25` USD reservation is not the desired production value.
- [ ] Add a short code comment or guard around the bare `archiveSession` repository method so future callers use `archiveSessionWithWorkCancellation`.
- [ ] Create a dedicated runbook for DSR hard-delete with LLM audit artifacts enabled.
- [ ] Add alert thresholds for the status fields used in this rollout plan.
- [ ] Decide whether global research caps should remain disabled or be set after observing the first production traffic window.
