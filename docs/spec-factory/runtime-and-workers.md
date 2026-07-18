# Runtime and workers

How the Spec Factory binary is packaged, scheduled, isolated, and scaled. The
v4 contract is ten runtime modes across one API service and eight split worker
services, with four role-specific Node image targets and one conversion
sidecar. The v4 plan and the rollout runbook are canonical; older four-service
descriptions later in this file are historical.

## Table of contents

- [1. Terminology](#1-terminology)
- [2. Container inventory](#2-container-inventory)
- [3. ECS service inventory](#3-ecs-service-inventory)
- [4. `SPEC_FACTORY_MODE` — the runtime knob](#4-spec_factory_mode--the-runtime-knob)
- [5. Capability registry](#5-capability-registry)
- [6. Agents are not containers](#6-agents-are-not-containers)
- [7. API service](#7-api-service)
- [8. Worker service](#8-worker-service)
- [9. Research worker service](#9-research-worker-service)
- [10. Conversion worker service](#10-conversion-worker-service)
- [11. Worker lifecycle](#11-worker-lifecycle)
- [12. LLM Gateway is a library, not a service](#12-llm-gateway-is-a-library-not-a-service)
- [13. Scaling axes](#13-scaling-axes)
- [14. Cross-references](#14-cross-references)

## 1. Terminology

Terms used here match the glossary in [`README.md`](./README.md). Additions specific to runtime topology:

| Term         | Definition                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime mode | The value of `SPEC_FACTORY_MODE`. Selects which subsystems the binary boots. Enum from plan §12.1.                                                                                    |
| ECS service  | One independently deployable/autoscaled Fargate service. Terraform defines API plus compatibility, turn, context, research, conversion, draft, relay, and retention worker services.  |
| Container    | One image instance in a task. Most tasks have one Node container; conversion also has the MarkItDown sidecar.                                                                         |
| Worker       | Any processing runtime. SQS wakes it, but it claims and fences authoritative work in MySQL.                                                                                           |
| Agent        | An in-process module that implements one capability (Distillation, Context Merger, Critic, Chat Coordinator, Legacy Compose Chat, research executors). Not a deployment unit. See §6. |
| Capability   | A named unit of work dispatched by the capability registry. Nine values in the target set (plan §14.2). One capability runs on exactly one queue on exactly one worker service class. |

## 2. Container inventory

`Dockerfile.spec-factory` produces four immutable role targets from one compiled
application. This removes tools from roles that do not need them while avoiding
separate codebases.

| Image target / ECR repository                       | Used by                                               | Included tools                                                 |
| --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `api` / `specter/spec-factory-api`                  | API                                                   | Node runtime and HTTP health tooling only                      |
| `core` / `specter/spec-factory`                     | compatibility, turn, context, draft, relay, retention | Node runtime; no Git, ripgrep, or Claude CLI                   |
| `research` / `specter/spec-factory-research`        | research                                              | Git, safe ripgrep-backed search, Claude Code/Agent SDK tooling |
| `conversion` / `specter/spec-factory-conversion`    | conversion orchestrator                               | Minimal Node runtime; media dependencies stay in sidecar       |
| `compose-markitdown` / `specter/compose-markitdown` | conversion sidecar only                               | Python MarkItDown and ffmpeg on task-local port 8080           |

All images use the merge SHA and are deployed by digest. The LLM Gateway,
coordinator, context reducers, and draft processors are libraries inside the
appropriate Node role, not network services.

### Base image and toolchain in `spec-factory`

- `node:26-slim` (`Dockerfile.spec-factory:1`). Node 26 is the pinned major.
- `curl` is present in the shared base for health checks. Git, ripgrep, and the
  Claude CLI are added only by the `research` target.
- The research target marks repository scratch as safe for Git. Other targets
  cannot execute repository tooling even if application code attempts it.
- `CLAUDE_CODE_USE_BEDROCK=1` (`Dockerfile.spec-factory:17`) — Claude Agent SDK routes through Bedrock, not Anthropic public API.

### Base image and toolchain in `compose-markitdown`

- `python:3.13-slim` + `ffmpeg` (`Dockerfile.compose-markitdown:5`).
- Non-root `appuser` (`Dockerfile.compose-markitdown:14-16`).
- Health check hits `http://localhost:8080/health` (`Dockerfile.compose-markitdown:22`).

## 3. ECS service inventory

Terraform defines nine services. The compatibility worker exists only for
staged migration and is rejected by the final legacy-disabled configuration.

| Service                   | Mode                | Node target  | Sidecar | Primary scaling signal                           |
| ------------------------- | ------------------- | ------------ | ------- | ------------------------------------------------ |
| `SPEC-FACTORY`            | `api`               | `api`        | no      | ALB requests, CPU/memory, SSE capacity           |
| `SPEC-FACTORY-WORKER`     | `worker`            | `core`       | no      | compatibility backlog during rollout             |
| `SPEC-FACTORY-TURN`       | `turn-worker`       | `core`       | no      | turn queue age/depth and provider concurrency    |
| `SPEC-FACTORY-CONTEXT`    | `context-worker`    | `core`       | no      | context/handoff task queue age/depth             |
| `SPEC-FACTORY-RESEARCH`   | `research-worker`   | `research`   | no      | research queue age/depth and Bedrock/tool quotas |
| `SPEC-FACTORY-CONVERSION` | `conversion-worker` | `conversion` | yes     | conversion queue age/depth                       |
| `SPEC-FACTORY-DRAFT`      | `draft-worker`      | `core`       | no      | draft queue age/depth and Jira/OneShot quotas    |
| `SPEC-FACTORY-RELAY`      | `relay-worker`      | `core`       | no      | unpublished outbox age/depth and event lag       |
| `SPEC-FACTORY-RETENTION`  | `retention-worker`  | `core`       | no      | scheduled maintenance; normally fixed count      |

Every service has a deployment circuit breaker, role-specific IAM/task role,
heartbeat capability set, CloudWatch logs/alarms, and independent desired/min/
max capacity. The API is the only ALB target. Conversion alone co-locates the
MarkItDown sidecar. Legacy-disabled tasks use local scratch and omit EFS.

Repository Terraform is code-ready, not applied. Actual desired counts and
routing are environment state and must be verified from Terraform plan/ECS.

## 4. `SPEC_FACTORY_MODE` — the runtime knob

> **Canonical reference for the runtime mode enum.** Other docs (`README.md`, `operations.md`, `dev-guide.md`) link here rather than restating the value set. Update this section first; propagate summaries after.

`resolveSpecFactoryRuntime` reads one environment variable and starts only the
processors owned by that role:

```text
SPEC_FACTORY_MODE=api
SPEC_FACTORY_MODE=worker
SPEC_FACTORY_MODE=turn-worker
SPEC_FACTORY_MODE=context-worker
SPEC_FACTORY_MODE=research-worker
SPEC_FACTORY_MODE=conversion-worker
SPEC_FACTORY_MODE=draft-worker
SPEC_FACTORY_MODE=relay-worker
SPEC_FACTORY_MODE=retention-worker
SPEC_FACTORY_MODE=all-local   # dev only
```

Semantics:

- `api` — boot Express routes, session guards, SSE fan-out, stream-token verification. Do not start any long-running processor. All turn/task work is enqueued into MySQL and served by workers.
- `worker` — compatibility processor during migration; not part of the final topology.
- `turn-worker` — durable ordered turn processor and coordinator execution.
- `context-worker` — distillation, cumulative merge, and handoff-build agent tasks.
- `research-worker` — boot only the research capability executor (Claude Agent SDK) and the Workspace Manager attach loop. Heavy repo hydration and tool traces live here. Kept separate from `worker` so long research tasks do not stall short direct-LLM calls.
- `conversion-worker` — boot only the source conversion pipeline (`ComposeConversionWorker`, `src/spec-factory/compose-conversion.ts:220`). The markitdown sidecar is expected on `http://localhost:8080`.
- `draft-worker` — durable draft stages, approval, Jira publish, and OneShot submit. Handoff construction remains on `context-worker`.
- `relay-worker` — outbox publisher, canonical event relay, and control-plane dispatch repair.
- `retention-worker` — retention, DSR support, context repair reconciliation, and reachability GC.
- `all-local` — dev-only. Boots every subsystem in one process, matching today's `main.ts` behavior. Never enabled in production.

Production cutover follows `shadow` then `primary` queue dispatch. Startup and
Terraform reject legacy disablement unless all split roles, immutable storage,
strict events, accepted repair/certification, budgets, retention, Valkey, RDS
Proxy, digest pins, and HA counts are present.

Startup dispatch (shipped shape, plan §12):

```ts
const runtime = resolveSpecFactoryRuntime();
if (runtime.httpApi) app.use("/api/spec-factory", createComposeRouter(...));
if (runtime.composeTurnWorker) setInterval(() => composeTurnWorker.drain(), ...);
if (runtime.composeAgentTaskWorker) setInterval(() => composeAgentTaskWorker.drain(), ...);
if (runtime.composeConversion) setInterval(() => composeConversionWorker.drain(), ...);
```

Remaining work is deployment-side: apply infrastructure, raise desired counts,
validate per-role heartbeats/queues, complete repair and certification, and then
close the rollback window intentionally.

## 5. Capability registry

Status: Phase 5 partial (plan §14.2). `compose_agent_tasks` and the typed capability/executor registries exist for context tasks, the research family (`code_research`, `config_research`, `devops_research`), critic review, queued handoff build, and the `legacy_compose_chat` turn adapter. Legacy chat fallback now routes through `LegacyComposeChatExecutor`, so the turn path has a named capability boundary even while durable chat execution still lives inside `ComposeService`.

The target registry (plan §14.2) enumerates nine capabilities. Every unit of durable work belongs to exactly one. Each capability names its executor, its queue, and its worker class.

| Capability            | Queue      | Worker service  | Executor                                                                                                     | Requires workspace     | Produces generated source |
| --------------------- | ---------- | --------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------- |
| `legacy_compose_chat` | `turn`     | turn-worker     | `LegacyComposeChatExecutor` (rollback path only)                                                             | yes                    | no                        |
| `chat_coordination`   | `turn`     | turn-worker     | `ChatCoordinationExecutor` (wraps `ChatCoordinator.decide`, direct `LlmGateway` call inside the coordinator) | no                     | no                        |
| `code_research`       | `research` | research-worker | `ClaudeAgentSdkResearchExecutor` with code-specific SDK stage and file/function evidence guidance            | yes (per-task scratch) | yes                       |
| `config_research`     | `research` | research-worker | `ClaudeAgentSdkResearchExecutor` with config-specific SDK stage and deployment/config evidence guidance      | yes                    | yes                       |
| `devops_research`     | `research` | research-worker | `ClaudeAgentSdkResearchExecutor` with DevOps-specific SDK stage and operational evidence guidance            | yes                    | yes                       |
| `source_distillation` | `context`  | context-worker  | `SourceDistillationExecutor` (direct `LlmGateway`)                                                           | no                     | no                        |
| `context_merge`       | `context`  | context-worker  | `ContextMergeExecutor`                                                                                       | no                     | no                        |
| `critic_review`       | `context`  | context-worker  | `CriticExecutor` (direct `LlmGateway`)                                                                       | no                     | no                        |
| `handoff_build`       | `context`  | context-worker  | `HandoffBuildExecutor` over frozen context/message/source/repository watermarks                              | yes                    | no                        |

Registry shape (plan §14.2):

```ts
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

Routing rule (plan §14.5):

- "Think over provided context and produce structured output" → LLM Gateway direct call (distillation, critic, coordinator decisions).
- "Explore a codebase with tools over many turns" → Agent Executor (Claude Agent SDK for v1).
- "Coordinate durable session state" → Spec Factory DB/jobs/events. No agent framework owns session state.

The registry is the single dispatch table. A worker mode's processor picks its queue(s), claims a row, looks up the capability, resolves the executor, and runs it. New capabilities land in the same PR as their executor and their queue behavior (plan §14.2).

## 6. Agents are not containers

Every agent in Spec Factory is a TypeScript module compiled into the `spec-factory` image. Deployment topology is set by `SPEC_FACTORY_MODE`, not by adding services. This is the single most misread part of the plan; the callout below is deliberate.

| Agent                      | Capability            | Runs inside service                             |
| -------------------------- | --------------------- | ----------------------------------------------- |
| Legacy Compose Chat        | `legacy_compose_chat` | `SPEC-FACTORY-TURN` during rollback window only |
| Chat Coordinator           | `chat_coordination`   | `SPEC-FACTORY-TURN`                             |
| Distillation Agent         | `source_distillation` | `SPEC-FACTORY-CONTEXT`                          |
| Context Merger             | `context_merge`       | `SPEC-FACTORY-CONTEXT`                          |
| Critic Agent               | `critic_review`       | `SPEC-FACTORY-CONTEXT`                          |
| Handoff Builder            | `handoff_build`       | `SPEC-FACTORY-CONTEXT`                          |
| Research Executor (code)   | `code_research`       | `SPEC-FACTORY-RESEARCH`                         |
| Research Executor (config) | `config_research`     | `SPEC-FACTORY-RESEARCH`                         |
| Research Executor (devops) | `devops_research`     | `SPEC-FACTORY-RESEARCH`                         |

Agents remain modules, not services. The runtime partition groups latency-sensitive
turn coordination separately from context/handoff work and isolates research
tool loops. Adding a capability normally adds a registry entry and executor to
an existing role, not a new network service.

Anti-patterns explicitly rejected by the plan:

- "Let's give the Critic its own image so it can scale independently." No. Critic runs inside `SPEC-FACTORY-CONTEXT`. If context throughput is not enough, scale that service's desired count.
- "Let's put the LLM Gateway behind an HTTP endpoint so all agents share a rate limiter." No. Gateway is a library (§12).
- "Let's spin up a dedicated Distillation service so we can rate-limit its Bedrock calls." No. Rate limiting lives in the Gateway library; distillation runs where every other direct-LLM task runs.

## 7. API service

Status: Phase 3 target for the service split; API code exists today inside the single ECS service.

### 7.1 Responsibilities

Runs (plan §12.2):

- Express routes (`src/spec-factory/compose-routes.ts:289` today; `createComposeRouter`).
- Session guards (`src/spec-factory/session/session-guard.ts:11`).
- SSE fan-out over `GET /sessions/:sessionId/stream` (`compose-routes.ts:746`).
- Stream-token minting on `POST /sessions/:sessionId/resume`.
- Enqueue-only handlers for `POST /sessions/:sessionId/messages` and `POST /sessions/:sessionId/analyze` — these return `202 Accepted` (or `429 queue_full`) after inserting a `compose_turn_jobs` row and never process a turn locally.

Does not run:

- The turn job processor.
- Any agent-task processor.
- The conversion drain loop.
- Workspace hydration.

### 7.2 SSE fan-out

`ComposeSseHub` maintains API-local subscribers and a bounded no-store replay buffer. Durable events are written to `compose_session_events`; Valkey Pub/Sub delivers canonical events across API replicas, while cursor-batched durable-log polling closes fanout gaps. MySQL remains authoritative and reconnects replay by durable event id.

`Last-Event-ID` and `?after=` replay hit `compose_session_events` for durable catch-up; the stream route pauses live delivery until the durable gap is replayed, then dedupes the final catch-up against the subscriber cursor. Valkey reduces latency but is never required for recovery.

### 7.3 Stream token verification

Today, stream tokens are minted with a SHA-256 hash persisted in `compose_stream_tokens` (`compose-service.ts:900-980`) and revoked on archive (`compose-service.ts:983-989`). The verification code path is inside the API service and only requires DB access; there is no per-replica in-memory token map on `main`.

## 8. Worker service

Status: Phase 3+ target. Today the equivalent work runs inline inside the API process — `ComposeService.runTurn` (`compose-service.ts:2336`) is called from an in-memory queue chained per session by `enqueueTurn` (`compose-service.ts:3648`) with `MAX_QUEUED_TURNS_PER_SESSION = 3` (`compose-service.ts:87`).

### 8.1 Responsibilities

Runs (plan §12.3 + §14.2 for the capability set):

- Durable turn job processor — claims `compose_turn_jobs` rows (plan §11, §8.3). Session-level serialization via `compose_session_turn_locks` (plan §11.4).
- Light-capability agent-task processor — claims `compose_agent_tasks` where `queue IN ('agent-task', 'context')`.
- Distillation, context merge, critic, handoff build — all direct-LLM calls through the LLM Gateway library.
- Chat Coordinator — reads the current committed `compose_context_versions` row, calls the LLM Gateway, either responds directly, asks for clarification, or dispatches a research-family task to the research queue.
- Legacy Compose Chat adapter — `src/spec-factory/agents/legacy-compose-chat-executor.ts` wraps `ComposeChatAgent.run` (`compose-chat-agent.ts:327`) as the `legacy_compose_chat` executor for turns that have not been migrated off the legacy path (plan §22).

### 8.2 What it does not run

- The Claude Agent SDK research loop. That belongs on `SPEC-FACTORY-RESEARCH` because it is long-running and requires workspace scratch and controlled egress.
- The conversion pipeline. That belongs on `SPEC-FACTORY-CONVERSION` because it needs the markitdown sidecar and ffmpeg.

### 8.3 Session-level serialization

The plan invariant "one active turn per session" (plan §11.4) is enforced with a MySQL row lock on `compose_session_turn_locks` claimed inside the same transaction that claims the `compose_turn_jobs` row. Any worker replica can process any session; two replicas cannot process the same session concurrently. This replaces today's in-process chaining at `compose-service.ts:3648`.

### 8.4 Idempotency

Turn jobs carry `idempotency_key` and `lease_generation` (plan §8.3, §11.5). Every final assistant message is written through a `compose_turn_outputs` uniqueness guard (plan §8.4) so a re-claimed lease cannot append a duplicate final message. See [`architecture.md`](./architecture.md) for the lifecycle overview and [`data-model.md`](./data-model.md) for `compose_turn_jobs` + `compose_turn_outputs` schemas.

## 9. Research worker service

Status: Phase 6 partial. `code_research`, `config_research`, and `devops_research` exist as gated `compose_agent_tasks` capabilities with a shared read-only Claude Agent SDK executor, redaction, lease fencing, runtime-run recording, generated-source idempotency, and optional coordinator dispatch. Grounded legacy chat can still pull repo context lazily through `ComposeRepoGrounding` inside the API/turn process (`src/spec-factory/compose-repo-grounding.ts`, wired at `src/spec-factory/server.ts:22`) while the research-worker rollout remains gated.

### 9.1 Responsibilities

Runs (plan §12.4, §23):

- Workspace hydration via `WorkspaceManager.attach()` (plan §13.3) into a task-scoped local scratch path.
- Claude Agent SDK research executor — the SDK loop that uses `Read`, `Glob`, and the safe `rg` search surface (`Grep`, ripgrep-backed) by default. Bash-backed commands require explicit tool policy and command allowlisting (plan §23.4).
- Heavy repo/code/config investigation.
- Generated research source artifact writing (plan §18, `kind='generated_research'`, `source_origin` set).
- Task trace capture (redacted, plan §23.5).

### 9.2 Runtime constraints

- Uses the Claude Agent SDK CLI baked into the image (`Dockerfile.spec-factory:12`). The Chat Coordinator and direct distillation callers do **not** use the SDK — they use `LlmGateway` directly (plan §23.2).
- Local scratch: `/scratch/spec-factory/<sessionId>/<taskId>` (plan §13.3). Hydrated from the durable workspace on EFS. Detached and cleaned when the task completes. Local scratch is per-task, not per-session, so two research tasks for the same session on two replicas do not corrupt each other.
- Read-only by default (`readOnly: true` on the research input contract, plan §23.3). Enforced in three layers:
  1. Claude Agent SDK tool permission hooks (`canUseTool` / `PreToolUse`).
  2. Shell command allowlist filtering before execution.
  3. Workspace path rooting — all writes are rejected unless targeted at the task's own scratch directory (plan §31.1).

### 9.3 Tool policy

From plan §23.4, Claude SDK tools allowed by default:

```text
Read
Grep (also accepted as rg/ripgrep in SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS)
Glob
```

`Bash` is denied by default. If an operator explicitly adds `Bash` to
`SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS`, commands still fail closed unless they
match anchored, metacharacter-free patterns in
`SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS`. Examples of read-only commands
that may be allowlisted for a controlled environment:

```text
git grep
git status
git diff --stat
cat
sed
head
tail
find (bounded scope)
ls
tree (bounded depth)
language-specific read-only inspection commands
```

Denied by default:

```text
rm  mv  chmod  chown
curl  wget  ssh
aws  docker  kubectl
terraform apply
package install commands
anything writing outside the task workspace
network access unless explicitly allowed
```

Denied attempts are persisted (redacted) in the task trace (plan §23.5).

### 9.4 Network egress control

Plan §31.2:

- Research workspaces run with network disabled by default.
- If a capability requires network (rare), the metadata service (`169.254.169.254`) remains denied to prevent IAM credential exfiltration.
- Egress control is enforced at the awsvpc security-group level (a distinct SG per research task ENI is not required — one restricted SG for `SPEC-FACTORY-RESEARCH` tasks is enough) plus at the process level (SDK tool policy).

### 9.5 Bounded run

Every research task carries a `constraints` block (plan §23.3):

```json
{
  "readOnly": true,
  "maxRuntimeSeconds": 180,
  "maxTurns": 40,
  "maxToolCalls": 80,
  "maxCostUsd": 3.0
}
```

`maxCostUsd` is capped by `SPEC_FACTORY_RESEARCH_MAX_COST_USD` (default 3.0)
per task. Rolling session/global spend ceilings are separate enqueue gates and
do not raise the per-task SDK budget.

Exceeded budgets terminate the SDK run. If the SDK returns valid structured
partial research output, the executor writes that Markdown as a partial-findings
artifact with an `Open questions` note describing the cutoff; otherwise the
agent task fails and keeps its normal retry/terminal-failure semantics.

### 9.6 Output

Two-phase artifact write (plan §13.5, §18.2). The executor emits:

- A Markdown research artifact under `s3://.../generated/research/<taskId>.md`.
- A JSON sidecar with structured findings + `evidence[]`.
- A redacted JSONL tool trace (`security/redaction.ts`, plan §23.5).
- A `compose_session_sources` row with `kind='generated_research'`, `source_origin.task_id`, and the artifact URI.
- A `compose_agent_tasks.output_json` row.
- `task.completed` event on the session event stream.

The research worker never mutates Working Context directly. Its output flows through Distillation → Context Merger (plan §18.1, §18.3).

## 10. Conversion worker service

Status: Phase 3 target for the service split; the conversion pipeline exists today inside the shared ECS service.

### 10.1 Responsibilities

Runs (plan §12.5, §17.1):

- `ComposeConversionWorker.drain` loop (`src/spec-factory/compose-conversion.ts:303`).
- MarkItDown sidecar calls for document conversion.
- `ffmpeg` audio extraction (via the sidecar, `sidecar/markitdown/app.py extract_audio_segments`).
- Voxtral audio transcription over Bedrock (`src/spec-factory/compose-voxtral.ts`).
- Source state updates (`awaiting_upload | pending | converting | converted | failed | unsupported`, plan §17.3).
- Best-effort `source.conversion.*` durable events around source state updates.
- Optional source-distillation enqueue after successful conversion when `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=true`; the converted source row, `source_distillation` task insert, and durable `task.queued` event are committed in one repository transaction when the DB-backed repository is in use. Repositories without the atomic method retain the legacy best-effort fallback for tests and alternate implementations.

### 10.2 Why markitdown is co-located

The sidecar is co-located with the conversion worker in the same ECS task because:

- Only the conversion worker calls it.
- Loopback (`http://localhost:8080`) avoids exposing the sidecar to any other service or the VPC. No security group, no ALB, no service discovery.
- The sidecar's memory cap is set with `memory` (hard) rather than `memoryReservation` (soft) on the conversion service's task definition, mirroring today's setup at `terraform/spec-factory-ecs.tf:329-334`. Overrunning triggers an OOM on the sidecar only; the essential `spec-factory` container survives, the in-flight conversion fails, and the row is retried under a fresh lease (`isTransientConversionError`, `src/spec-factory/compose-conversion.ts:68`).

### 10.3 Audio pipeline and the Bedrock 25 MB limit

Voxtral audio transcription is called via Bedrock `InvokeModel` with the audio embedded as base64 in the JSON request body. `InvokeModel` has a synchronous request payload ceiling of **25 MB**. Because audio segments are 16 kHz mono 16-bit PCM WAV, the raw-to-base64 blow-up is `raw × 4/3`:

| Segment seconds | Raw bytes (16 kHz mono s16le) | Base64 bytes           |
| --------------- | ----------------------------- | ---------------------- |
| 240             | 7.68 MB                       | ~10.24 MB              |
| 300             | 9.60 MB                       | ~12.80 MB              |
| 590             | 18.88 MB                      | ~25.17 MB (over limit) |
| 600             | 19.20 MB                      | ~25.60 MB (over limit) |

`COMPOSE_AUDIO_SEGMENT_SECONDS` (`terraform/spec-factory-ecs.tf:288`) controls the segment length for both the spec-factory app and the sidecar. Keep it at or below 300s for headroom. Related tuning knobs:

| Env var                                 | Terraform var                           | Purpose                                                                       |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `COMPOSE_AUDIO_SEGMENT_SECONDS`         | `compose_audio_segment_seconds`         | Segment length.                                                               |
| `COMPOSE_AUDIO_MP3_BITRATE`             | `compose_audio_mp3_bitrate`             | MP3 encoding bitrate for supported formats.                                   |
| `COMPOSE_AUDIO_MAX_SECONDS`             | `compose_audio_max_seconds`             | Reject media above this duration.                                             |
| `COMPOSE_AUDIO_MAX_BYTES`               | `compose_audio_max_bytes`               | Reject media above this byte size.                                            |
| `COMPOSE_VOXTRAL_MODEL_ID`              | `compose_voxtral_model_id`              | Bedrock model ID (currently `mistral.voxtral-small-24b-2507` in `us-east-2`). |
| `COMPOSE_TRANSCRIBE_SEGMENT_TIMEOUT_MS` | `compose_transcribe_segment_timeout_ms` | Per-segment InvokeModel timeout.                                              |

The audio-format enum accepts `wav` and `mp3` only (verified against Bedrock). Do not send other formats.

### 10.4 Lease and retry semantics

`ComposeConversionWorker` claims rows with `claimNextPendingSource({ leaseMs })` (`compose-conversion.ts:308`). Errors classified as transient by `isTransientConversionError` (`compose-conversion.ts:68`) return the row to the queue for retry with backoff `retryBackoffMs` (up to `DEFAULT_MAX_CONVERSION_ATTEMPTS`, `compose-conversion.ts:42`). Non-transient errors mark the source `failed` or `unsupported` and stay there until an operator reconverts (`POST /sessions/:sessionId/sources/:sourceId/reconvert`, `compose-routes.ts`).

## 11. Worker lifecycle

Status: v4 lifecycle code-ready; environment deployment pending.

Every split worker follows the same outer lifecycle: validate its role contract, record a durable heartbeat, consume only its queue/capabilities, renew leases or visibility while working, and fence every terminal write.

### 11.1 Startup checks

Before entering the claim loop, the worker asserts (plan §12):

1. Database/RDS Proxy reachability and the expected migration schema.
2. Task-local workspace paths for roles that materialize scratch; legacy-disabled paths reject EFS roots.
3. Sidecar reachability for `conversion-worker`.
4. Queue URL and capability coverage for the selected role.
5. Bedrock/model configuration for roles that invoke models.
6. When legacy runtime is disabled: primary queue dispatch, strict durable events, Valkey, immutable S3, accepted repair/certification, retention/budgets, digest pins, and the complete split-role topology.

Startup fails hard if any check fails. There is no partial-boot with degraded capabilities.

### 11.2 Worker identity and heartbeat

Every worker registers identity fields (plan §12.6):

```text
worker_id       # UUID minted at boot
mode            # SPEC_FACTORY_MODE value
task_arn        # ECS task ARN or hostname for local
started_at
heartbeat_at
capabilities    # capability names this worker will claim
```

Heartbeat cadence: 15 seconds by default, configurable with `SPEC_FACTORY_WORKER_HEARTBEAT_MS`. Worker inventory writes `spec_factory_worker_heartbeats`; task runtime heartbeats update `compose_agent_runtime_runs`. Missed lease heartbeats mark claims expired so stale work is recovered by other workers on the next tick.

### 11.3 Claim loop

Each mode's claim loop is uniform (plan §11.3 for turn jobs, §14 for agent tasks):

```text
loop:
  row = tx claim( queue_set, capability_set, lease_ms )
  if row is null: sleep(pollInterval); continue
  attach workspace if capability requires it
  run executor with lease heartbeat
  on success: write output row + events + capability-specific side effects
  on failure: classify (transient/permanent), update attempts, release or mark dead
  detach workspace
```

Lease heartbeats extend the row's `lease_expires_at` while the executor is running. If the executor process crashes, the lease expires naturally.

### 11.4 Graceful shutdown

On `SIGTERM` (ECS deregistration):

1. Stop accepting new claims immediately.
2. Send the in-flight executor a cancellation signal (plan §11.6 semantics: cooperative first, hard-kill on drain timeout).
3. Update the row to release the lease so another replica can pick it up.
4. Publish a `turn.cancelling`, `turn.cancelled`, or `task.cancelled` event.
5. Flush structured logs and metrics.
6. Exit with code 0 once the last in-flight row is released.

ECS is configured to allow up to 30 s of shutdown time (`deregistration_delay` at `terraform/spec-factory-ecs.tf:138`). Workers must respect this budget and never hold a lease past shutdown.

### 11.5 Drain semantics for cutover

The Phase 2 `off | shadow | drain | on` flag controls whether legacy in-process turns are still processed:

- `off` — legacy path serves responses; HTTP idempotency rows are still written, but durable workers do not process them.
- `shadow` — durable rows written but legacy path serves the response (dark-launch, no cutover).
- `drain` — durable path serves new turns, legacy in-flight allowed to finish; cutover waits for `legacy_inflight == 0`.
- `on` — durable path only.

Workers must not process durable rows in `off`, must not serve responses in `shadow`, and must serve in `drain`/`on`. See [`architecture.md`](./architecture.md) for the full state machine.

## 12. LLM Gateway is a library, not a service

Status: Phase 8 partial plus v4 Work Order C. `LlmGateway` is live in-process.
Purposes listed in `SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES` call Bedrock
Converse directly with native JSON-schema output; unlisted purposes retain the
Claude Agent SDK transport for controlled rollback. Tool-enabled research stays
on the SDK executor.

Plan §15.7 is unambiguous: **the LLM Gateway starts as an in-process TypeScript module, not an HTTP microservice.** A separate service is added only if all four of the following become true simultaneously:

1. Multi-language clients need Bedrock access.
2. Org-wide model governance requires a central control point.
3. Centralized key custody is needed.
4. An independent LLM operations team owns Bedrock policy.

None of those apply. Spec Factory is Node-only. Bedrock keys come from the ECS task role. Model governance lives in the Gateway config. Adding a network hop between every agent and Bedrock adds latency, operational dependency, and a new failure domain for zero benefit.

Anti-pattern callout: "Let's put the LLM Gateway behind an ALB so every agent hits the same rate limiter." **No.** Rate limiting, budget enforcement, retries, structured output parsing, model routing, and usage audit (`spec_factory_llm_calls`) all live in the shared library. Each worker process imports it. Every gateway call is in-process; state is the shared MySQL audit table and MySQL-backed budget queries.

Where the library runs:

| Caller             | Runtime mode    | Gateway usage                                                                                             |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------- |
| Chat Coordinator   | turn-worker     | Direct calls for decision + response synthesis.                                                           |
| Distillation Agent | context-worker  | Direct calls to produce context patches.                                                                  |
| Critic Agent       | context-worker  | Direct calls to review context or artifacts.                                                              |
| Context Merger     | context-worker  | Optional LLM assist during merge.                                                                         |
| Handoff Builder    | context-worker  | Writes deterministic immutable handoff artifacts and may use the Gateway for bounded narrative synthesis. |
| Research Executor  | research-worker | Uses Claude Agent SDK, not the Gateway. Research is agent-loop territory (plan §14.5).                    |

The Legacy Compose Chat adapter continues to call the Claude Agent SDK directly during migration (plan §22). Once turns migrate to the Coordinator, direct-LLM traffic shifts to the Gateway.

## 13. Scaling axes

Status: v4 code ready; environment rollout and certification pending.

| Service                   | Bottleneck                                                                                      | Scaling metric                                   | Notes                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SPEC-FACTORY-API`        | SSE connection count; acceptance latency                                                        | ALB requests, CPU/memory, connection capacity    | Scales horizontally after durable events/tokens and Valkey certification.                                                                  |
| `SPEC-FACTORY-TURN`       | Turn queue age, provider concurrency                                                            | SQS age/depth plus queue/run/provider histograms | Session-level exclusion preserves order; replicas raise cross-session concurrency.                                                         |
| `SPEC-FACTORY-CONTEXT`    | Distillation/merge/handoff task age                                                             | Context SQS age/depth and Bedrock latency        | Independent from interactive turns.                                                                                                        |
| `SPEC-FACTORY-RESEARCH`   | Queue depth on `research` queue                                                                 | Custom metric                                    | Each research task holds a lease for up to `maxRuntimeSeconds`; scale on tail latency. Local scratch storage caps per-replica concurrency. |
| `SPEC-FACTORY-CONVERSION` | Queue depth on `compose_session_sources` where `conversion_status IN ('pending', 'converting')` | Custom metric                                    | Voxtral Bedrock throughput is the ceiling for audio-heavy workloads.                                                                       |
| `SPEC-FACTORY-DRAFT`      | Draft stage queue age; Jira/OneShot quotas                                                      | Draft SQS age/depth and stage latency            | Retries resume from immutable successful stage outputs.                                                                                    |
| `SPEC-FACTORY-RELAY`      | Oldest unpublished outbox/event lag                                                             | Outbox age/depth and event relay latency         | Run at least two for HA after primary cutover.                                                                                             |
| `SPEC-FACTORY-RETENTION`  | Maintenance duration/backlog                                                                    | Repair/retention/GC counts and age               | Fixed count is normally sufficient; work is bounded and idempotent.                                                                        |

The single-replica alarm is rollback-only and applies to the pre-v4 all-local
topology. Disable it at the certified API cutover. Keep per-role health,
queue-age, DLQ/quarantine, outbox, latency, and cost alarms throughout rollout.

## 14. Cross-references

- [README](./README.md) — glossary, doc index, top-level overview.
- [Architecture](./architecture.md) — durable state model, event flow, service boundaries, cutover flag state machine.
- [Data model](./data-model.md) — `compose_turn_jobs`, `compose_agent_tasks`, `compose_turn_outputs`, `compose_session_events`, capability schemas.
- [Operations](./operations.md) — deployment, scaling, capacity, cutover playbooks.
- Plan §12 (Runtime Split), §13 (Workspace Manager), §14 (Capability Registry), §15 (LLM Gateway), §16 (Framework Decision), §23 (Research Worker), §31 (Security and Isolation).
- Code anchors: `Dockerfile.spec-factory:1`, `Dockerfile.compose-markitdown:1`, `terraform/spec-factory-ecs.tf:204-503`, `src/spec-factory/main.ts:1-19`, `src/spec-factory/compose-service.ts:2336` (`runTurn`), `src/spec-factory/compose-service.ts:3648` (`enqueueTurn`), `src/spec-factory/compose-conversion.ts:220` (`ComposeConversionWorker`), `src/spec-factory/compose-sse.ts:98` (`ComposeSseHub`), `src/spec-factory/session/session-guard.ts:11`.
