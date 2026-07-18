# Specter Architecture

Specter is built around durable asynchronous coordination. The control plane lives in MySQL, the large payloads live in S3, and repository cache state lives on shared EFS.

## System boundaries

### Orchestrator

Background process that:

- polls JIRA
- resolves customer and repositories
- generates task markdown
- inserts `task_management`
- posts completed JIRA results back

### Workers

One worker type per agent family. Workers:

- poll MySQL for assigned rows
- claim tasks atomically
- stage isolated workspaces from shared repo caches
- run agent logic through the shared Claude SDK wrapper
- upload results to S3

### Harvey

Teams bot that:

- accepts conversational requests
- resolves routing decisions
- inserts work through the same task pipeline
- delivers results back to Teams

### Marketing app

`marketing/` is a separate Next.js application. It is not part of the orchestrator/worker runtime.

## Control plane vs data plane

### Control plane

MySQL tables:

- `agents`
- `customer_branches`
- `code_repositories`
- `task_management`
- `tasks`
- `chat_sessions`

These tables store identity, routing, and lifecycle state.

`code_repositories` should now be treated as repository metadata only. Worker
clone auth is intended to come from the shared GitHub token secret injected into
worker tasks, not from inline DB credentials. The table should also carry the
repository `default_branch` so runtime branch logic is data-driven.

### Data plane

- EFS stores shared repository caches; OneShot keeps checked-out per-run worktrees on local task storage
- S3 stores task markdown and result markdown

This division is deliberate. Long-form prompts and results are too bulky and too mutable to keep inline in the control-plane tables.

## Core data flow

```text
JIRA / Teams
  -> assignment service (orchestrator or Harvey)
  -> task_management row
  -> worker claim
  -> tasks row
  -> S3 result
  -> JIRA comment or Teams delivery
```

## Storage layout

### S3

```text
<prefix>-tasks
  tasks/<reference>/<timestamp>.md

<prefix>-results
  results/<agent>/<reference>/<taskId>-<timestamp>.md
```

### EFS

```text
/mnt/efs/specter-repo/
  repositories/
    <repo>/
    tasks/
      task-<task_management_id>/
  documents/
```

Several worker and agent paths still assume this exact EFS base layout.

For OneShot v2, `ONESHOT_REPO_CACHE_BASE` points to shared bare mirrors on EFS
and `ONESHOT_WORKTREE_BASE` points to per-run local worktrees, typically
`/var/oneshot/workspaces`.

## Agent execution model

The current execution layer is the shared Claude Agent SDK wrapper in `src/claude-sdk`.

Key pieces:

- repo registry and repo resolution
- output schemas per agent
- tool permission sets
- hooks for audit, rate limiting, read-only mode, and write-path enforcement
- Bedrock environment wiring

Agents are thin wrappers around `runAgent()` plus domain-specific result shaping.

## Qualification flow

OneShot tickets pass through a QUALIFIER stage before entering the pipeline. QUALIFIER now uses a hybrid 3-way policy:

- `hard_fail`: the ticket is fundamentally underspecified, so repo inspection is skipped and structured feedback is posted directly to Jira
- `direct_qualify`: the ticket is strong enough on its own to enter OneShot without repo inspection
- `code_adjudicate`: the ticket is borderline or leaning-reject, so Claude must inspect the checked-out repository before a final rejection is accepted

The deterministic scorer still evaluates 5 weighted dimensions with a minimum composite score of 65, but scores are now used to classify the ticket rather than simply fail-fast every sub-65 case. The current direct-qualification threshold is 85 plus strong per-dimension checks. On the code-adjudication path, QUALIFIER requires actual repo-tool usage and explicit inspection evidence before a rejection is accepted.

Tickets that pass the gate proceed to LLM-assisted qualification for deeper analysis.

## Agent safety model

The Claude Agent SDK's `canUseTool` callback enforces a bash command blocklist in addition to the tool permission levels listed below. The blocklist covers 12 patterns including `rm -rf`, `sudo`, `curl | sh`, `wget | sh`, `git push --force`, `chmod 777`, `mkfs`, `dd if=`, `: > /`, `shutdown`, `reboot`, and `kill -9`. Any bash invocation matching a blocklisted pattern is rejected before execution regardless of the agent's tool permission level.

## Tool policy model

Current tool sets:

- `code_exploration`: `Read`, `Glob`, `Grep`
- `read_only`: `Read`, `Glob`, `Grep`, `Bash`, `BashOutput`
- `analysis`: `Read`, `Glob`, `Grep`, `Bash`, `BashOutput`, `Task`, `TodoWrite`
- `patch_proposal`
- `full_autonomy`

Current agent mapping:

| Agent type | Default tool set |
| --- | --- |
| `darci` | `analysis` |
| `scribe` | `code_exploration` |
| `prism` | `code_exploration` |
| `hermes` | `read_only` |
| `sentry` | `code_exploration` |
| `beacon` | `code_exploration` |
| `veritas` | `analysis` |
| `custom` | `code_exploration` |

## OneShot session memory model

OneShot stages run as stateless container invocations. All cross-invocation context flows through S3 artifacts. No in-process state persists between container invocations.

Context transfer paths:

- **Planner to Implementer**: The plan artifact includes `plannerDiscoveries` — build/test commands, code patterns, entry points, and dependency observations the planner found during exploration. The implementer loads these as grounding context so it does not re-discover what the planner already mapped.
- **Implementer to Implementer (revision)**: The implementation artifact includes `sessionNotes` — design decisions, file relationships, and conventions the implementer established. On revision loops, these notes are loaded so the implementer maintains continuity with its prior reasoning.
- **Implementer to Code Reviewer**: The implementation artifact includes `commitDiff`, giving the reviewer the exact changeset to evaluate without re-deriving it.
- **Reviewer to Reviewer (revision)**: The prior review is loaded from S3 and materialized as `review.previous.json`, allowing the reviewer to compare the current state against its earlier feedback.

## Circuit breakers

The system enforces multi-layer circuit breaking to bound cost and prevent runaway execution:

- **Token budget**: `total_tokens_used < max_total_tokens` is checked before each stage begins. If the budget is exhausted, the run transitions to a terminal state.
- **Agent timeout**: An 80-minute `timeoutMs` on the implementer prevents Claude from entering unbounded tool loops within a single invocation.
- **Run age**: Runs older than 24 hours are abandoned by the reconciliation sweep regardless of current state.
- **Stage attempt counters**: Each stage tracks its attempt count in `oneshot_runs`. The maximum is configurable via `ONESHOT_MAX_STAGE_ATTEMPTS` (default 5). Exceeding the limit transitions the run to a terminal failure state.

## Status and monitoring

The preferred worker entrypoint is `src/worker-main.ts`. It adds:

- `GET /health`
- `GET /status`
- `GET /status/:taskId`
- `GET /history`
- `GET /metrics`
- `GET /events` for SSE
- WebSocket subscriptions

The orchestrator only exposes `/health`.

### OneShot observability

The `oneshot_run_events` table provides a queryable per-run timeline of all state transitions, stage claims, and error events. Each row records `event_type`, `from_state`, `to_state`, `stage`, and an optional `metadata_json` payload with timestamps at millisecond precision.

Artifact `metadata_json` on `oneshot_artifacts` carries per-stage cost and duration metrics (input/output tokens, cache hits, wall-clock seconds), enabling cost attribution and performance analysis without log scraping.

## Important implementation realities

- Orchestrator and workers do not use direct RPC.
- `task_management.related_code` is currently a CSV string of repo IDs.
- Harvey work is prevented from being posted back to JIRA by `source='harvey'`.
- Some legacy docs and scripts still mention Phoenix or MCP; those are historical, not active runtime dependencies.

## Why the architecture is workable

The design scales because it separates concerns cleanly:

- MySQL handles idempotency and claims
- S3 handles payload transfer
- EFS handles large shared repo state
- workers stay horizontally scalable
- Harvey and the orchestrator feed the same execution backbone
