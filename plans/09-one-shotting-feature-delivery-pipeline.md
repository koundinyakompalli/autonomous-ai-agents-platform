# Plan 09: One-Shotting Feature Delivery Pipeline

## Problem

Specter’s current control plane is built around one durable unit of work:

- a JIRA or Harvey-triggered `task_management` row
- one assigned agent
- one worker polling loop
- one result artifact posted back to JIRA or Teams

That model works for today’s specialist agents, but it is too flat for a bounded autonomous delivery loop.

One-Shotting needs a ticket to move through:

- readiness qualification
- spec-driven planning
- structured plan review
- bounded plan revision loops
- implementation
- draft PR creation
- final completion posting back to JIRA

The current `task_management` schema is too flat to represent that lifecycle safely, and the current PRISM worker is the wrong place to bolt on multi-stage review loops.

## Working definition

One-Shotting is a dedicated delivery pipeline for JIRA tickets labeled `PFOS` (Product Factory One Shotting).

It is not a generic extension of the existing PRISM worker. It is a new control plane with:

- one source JIRA ticket
- one qualifying agent run on the existing `task_management` path
- one dedicated repo
- one dedicated branch
- one frozen base commit SHA
- versioned planning, review, and implementation artifacts
- bounded review loops
- one draft PR handoff back to JIRA

## Locked decisions

These are already decided for the design:

- `PFOS` tickets are exclusive to the OneShot flow
- introduce four new logical agents:
  - `QUALIFIER`
  - `PLANNER`
  - `REVIEWER`
  - `IMPLEMENTER`
- only `QUALIFIER` stays on the legacy `task_management` worker model
- `PLANNER`, `REVIEWER`, and `IMPLEMENTER` are queue consumers, not `task_management` pollers
- single-repo only for v1
- introduce a new OneShot schema rather than overloading `task_management`
- use `oneshot_notifications` for final JIRA posting
- if the target branch head moves away from `base_commit_sha`, fail the run back to re-plan
- `IMPLEMENTER` opens draft PRs only
- `REVIEWER` verdicts are:
  - `APPROVED`
  - `NEEDS_CHANGES`
  - `BLOCKED`
- max review loops are configurable, default `3`
- `BLOCKED` never auto-advances

## Updated design choices after review

The original draft has been revised across two review rounds:

- keep only `REVIEWER` on Codex/OpenAI — model diversity in review reduces blind spots; the reviewer should not share the planner's training distribution
- `REVIEWER` uses context injection for v1 (plan + referenced files in one prompt), not a tool-use loop
- keep `QUALIFIER`, `PLANNER`, and `IMPLEMENTER` on the existing Bedrock/Claude stack to avoid unnecessary vendor sprawl in v1
- collapse the original multi-table artifact design into one `oneshot_artifacts` table
- defer the transactional outbox to v2; use `queued_for_*` state reconciliation instead
- reduce the queue set from five to three
- replace automatic advance after max `NEEDS_CHANGES` loops with escalation plus optional human force-approve via `PFOS-FORCE-APPROVE` label
- `QUALIFIER` has explicit fresh, force-approve, and replan re-entry modes
- the worker (not the LLM) creates draft PRs via GitHub REST API using a write-capable GitHub token; repo hydration stays on the normal read token
- artifact retry uses upsert (`INSERT ... ON DUPLICATE KEY UPDATE`) with deterministic S3 keys
- `IMPLEMENTER` uses `patch_proposal` tool permission set — first Specter agent with write-to-repo capability

## Implementation spec set

The end-to-end implementation is now split into phase-level specs:

- [docs/superpowers/specs/2026-04-12-oneshot-phase0-contracts.md](../docs/superpowers/specs/2026-04-12-oneshot-phase0-contracts.md)
- [docs/superpowers/specs/2026-04-12-oneshot-phase1-design.md](../docs/superpowers/specs/2026-04-12-oneshot-phase1-design.md)
- [docs/superpowers/specs/2026-04-12-oneshot-phase2-qualifier-and-routing.md](../docs/superpowers/specs/2026-04-12-oneshot-phase2-qualifier-and-routing.md)
- [docs/superpowers/specs/2026-04-12-oneshot-phase3-planner.md](../docs/superpowers/specs/2026-04-12-oneshot-phase3-planner.md)
- [docs/superpowers/specs/2026-04-12-oneshot-phase4-reviewer.md](../docs/superpowers/specs/2026-04-12-oneshot-phase4-reviewer.md)
- [docs/superpowers/specs/2026-04-12-oneshot-phase5-implementer.md](../docs/superpowers/specs/2026-04-12-oneshot-phase5-implementer.md)
- [docs/superpowers/specs/2026-04-12-oneshot-phase6-operations.md](../docs/superpowers/specs/2026-04-12-oneshot-phase6-operations.md)

Supporting docs:

- [docs/superpowers/specs/2026-04-12-oneshot-infrastructure-design.md](../docs/superpowers/specs/2026-04-12-oneshot-infrastructure-design.md)
- [docs/superpowers/specs/2026-04-12-oneshot-prompts-and-schemas.md](../docs/superpowers/specs/2026-04-12-oneshot-prompts-and-schemas.md)
- [docs/ONESHOT_RUNBOOK.md](../docs/ONESHOT_RUNBOOK.md)

## Goals

- make `PFOS` tickets flow through one bounded autonomous delivery loop
- preserve MySQL as the durable source of truth
- use SQS for transport only, not as the system of record
- keep OneShot auditable, replayable, and idempotent
- isolate the new pipeline from the existing `task_management` worker model
- reuse current JIRA, EFS, S3, repo, and comment-posting patterns where practical
- keep human review in the loop via draft PRs and JIRA comments

## Non-goals

- replacing the current PRISM worker
- replacing the current orchestrator JIRA polling model for all agents
- supporting multi-repo feature delivery in v1
- auto-merging PRs
- allowing `BLOCKED` reviews to auto-advance
- building preview environments or a QA stage in the first iteration
- introducing a transactional outbox in v1

## Key architecture decision

### OneShot is a new control plane, not “PRISM plus a queue”

PRISM today is:

- a normal `AgentWorker` subclass
- fed from `task_management`
- planning-only
- restricted to Claude SDK `code_exploration`

OneShot needs:

- a state machine
- stage versioning
- queue-driven handoff
- structured review loops
- explicit implementation branch handling

That means:

- keep the current `PRISM` agent for its existing use cases
- create a new `PLANNER` service that reuses PRISM’s planning ideas, but not its polling model
- create separate queue consumers for `REVIEWER` and `IMPLEMENTER`

## Provider strategy

### v1 provider split

- `QUALIFIER`: Bedrock / Claude
- `PLANNER`: Bedrock / Claude
- `REVIEWER`: Codex / OpenAI
- `IMPLEMENTER`: Bedrock / Claude

### Why only the reviewer uses Codex/OpenAI

Model diversity in the review stage reduces blind spots. The reviewer should not share the same training distribution and failure modes as the planner. Using a different provider for review creates genuine independence — the same reason code review by the author's pair is weaker than review by someone outside the team.

The cross-provider split is intentionally narrow:

- independent review is the strongest place to justify provider diversity
- planning and implementation stay on the existing Bedrock/Claude stack in v1
- this limits new secrets, SDK surface, billing complexity, and operational drift

The plan should not assume a second provider for `IMPLEMENTER` until benchmarks justify it.

### REVIEWER integration design

The REVIEWER needs codebase read access. It must read the plan artifact and compare it against actual code to verify file references, assess change feasibility, and catch plan/code mismatches.

**SDK**: OpenAI SDK (`openai` npm package).

**Auth**: OpenAI API key stored in AWS Secrets Manager, injected into the REVIEWER ECS task via environment variable.

**Codebase access pattern (v1 — context injection)**:

The REVIEWER consumer runs on ECS with access to the EFS repo mount. On each review:

1. Load the plan artifact from S3
2. Parse the plan's list of impacted files and proposed changes
3. Read those files from the EFS workspace
4. Send the plan + relevant file contents together in one prompt to the OpenAI model

This avoids building a tool-use loop against the OpenAI SDK. Context injection is sufficient for plan review because the plan already lists impacted files and proposed changes. The reviewer needs to verify those references, not explore the repo open-endedly.

**v2 option**: If reviews need deeper codebase exploration, build a read-only tool-use loop (file read, grep, glob) against the OpenAI SDK — a parallel to `runAgent()` but for a different provider.

**Error handling**: Retry with exponential backoff on rate limits and timeouts (3 retries, base delay 5s). On persistent failure, fail the review artifact (not the entire run) so the operator can re-trigger via reconciliation.

**Code location**: `src/oneshot/providers/openai-reviewer.ts` — isolated from the Claude SDK layer. This module owns the OpenAI client setup, prompt construction, context assembly, and response parsing.

## Fit with the current Specter architecture

Reuse directly:

- JIRA polling in `Orchestrator`
- JIRA comment posting patterns already owned by the orchestrator
- MySQL for durable workflow state
- S3 for large artifacts
- EFS workspaces and Git hydration patterns
- repo resolution from `code_repositories`
- customer and branch resolution from `customer_branches`

Do not reuse directly:

- `task_management` as the only lifecycle model
- the assumption that one ticket maps to one agent run
- current PRISM polling as the planner runtime

## Recommended target state

Introduce a dedicated OneShot subsystem with these responsibilities:

1. `QUALIFIER` validates whether a `PFOS` ticket is ready for OneShot.
2. If ready, it creates a `oneshot_runs` record and queues planning work.
3. `PLANNER` writes a versioned implementation plan.
4. `REVIEWER` reviews that plan.
5. The review loop continues until:
   - `APPROVED`
   - `BLOCKED`
   - or max `NEEDS_CHANGES` loops are exhausted and the run is escalated
6. `IMPLEMENTER` implements the latest approved plan against the frozen base SHA.
7. `IMPLEMENTER` opens a draft PR.
8. Completion is written into `oneshot_notifications`.
9. Orchestrator posts the final JIRA comment from `oneshot_notifications`.

## Agent and service model

## `QUALIFIER`

Execution model:

- current `task_management` path
- normal `AgentWorker` subclass
- JIRA-polled by the orchestrator

QUALIFIER operates in explicit modes. Mode selection is the first thing it does, before any LLM invocation.

### Mode selection logic

1. Query `oneshot_runs` for an active run matching the ticket's `jira_key`
2. If no active run exists → **Mode 1** (fresh qualification)
3. If an active run exists in state `escalated` AND ticket has `PFOS-FORCE-APPROVE` label → **Mode 2** (force-approve re-entry)
4. If an active run exists in state `replan_required` AND ticket has `PFOS-REPLAN` label → **Mode 3** (replan re-entry)
5. If an active run exists in any other state → skip (run is already in progress); do not create a new run

### Mode 1: Fresh qualification (normal path)

Preconditions:

- ticket has `PFOS` label
- no active `oneshot_runs` row exists for this `jira_key`

Behavior:

1. Resolve exactly one repo and exactly one branch
2. Capture `base_commit_sha` from the remote branch head
3. Run hybrid deterministic checks first, LLM judgment only where needed for requirement completeness
4. If qualified: create `oneshot_runs` row (state = `queued_for_planning`), send planning message to SQS
5. If not qualified: complete on `task_management` with a failure comment explaining blocking reasons; no `oneshot_runs` row is created

Postcondition: Either a new `oneshot_runs` row exists in `queued_for_planning`, or the qualification failure is posted to Jira.

### Mode 2: Force-approve re-entry (escalation override)

Preconditions:

- ticket has both `PFOS` and `PFOS-FORCE-APPROVE` labels
- an `oneshot_runs` row exists for this `jira_key` in state `escalated`

Behavior:

1. Look up the existing `escalated` run
2. Re-check `base_commit_sha` against the current remote branch head
3. If base has drifted: transition run to `replan_required`, write a Jira notification explaining the drift, stop — do NOT force into implementation on stale code
4. If base is still current: transition run from `escalated` to `approved`, then to `queued_for_implementation`, send implementation message to SQS
5. Complete on `task_management` with a comment noting the force-approve

Postcondition: The existing run is either in `queued_for_implementation` (base still valid) or `replan_required` (base drifted).

### Mode 3: Replan re-entry

Preconditions:

- ticket has both `PFOS` and `PFOS-REPLAN` labels
- an `oneshot_runs` row exists for this `jira_key` in state `replan_required`

Behavior:

1. Look up the existing `replan_required` run
2. Refresh `base_commit_sha` against the current remote branch head
3. Reset review-loop counters for the new planning cycle
4. Transition the run back to `queued_for_planning`
5. Send a planning message to SQS for the next plan version

Postcondition: The existing run is back in `queued_for_planning` against a fresh base SHA.

## `PLANNER`

Execution model:

- SQS consumer
- not a `task_management` worker

Responsibility:

- read the qualified ticket and frozen repo context
- produce a spec-driven implementation plan
- write versioned plan artifacts to S3
- record the plan version in MySQL
- enqueue review

Recommended backend:

- Bedrock / Claude via a new OneShot planner wrapper
- reuse PRISM planning concepts and schema as the starting point
- do not replace current `PRISM`

## `REVIEWER`

Execution model:

- SQS consumer
- not a `task_management` worker

Responsibility:

- review plan artifacts only
- issue a structured verdict
- write review artifacts to S3
- record the verdict in MySQL
- enqueue revision or implementation

Recommended backend:

- Codex / OpenAI
- default model recommendation: `gpt-5.4` with `xhigh` reasoning

## `IMPLEMENTER`

Execution model:

- SQS consumer
- not a `task_management` worker

Responsibility:

- re-check the branch head against `base_commit_sha`
- stop and request re-plan if drift is detected
- create a working branch
- implement the approved plan
- run checks/tests
- open a draft PR
- write implementation artifacts and PR metadata
- write completion notification

Recommended backend:

- Bedrock / Claude
- use a dedicated implementation wrapper rather than overloading ANVIL or PRISM
- tool permission set: `patch_proposal` (Read, Glob, Grep, Edit, Write, Bash, BashOutput)

Note: the IMPLEMENTER is the first Specter agent with write-to-repo capability in production. All other agents are read-only or analysis-only against the codebase. The trust boundary is that IMPLEMENTER only opens draft PRs — it never merges to the target branch directly.

### PR creation mechanism

PR creation is split between the LLM and the worker:

- **LLM responsibility**: create the implementation branch, edit files, run tests, commit, push to remote.
- **Worker responsibility**: after the LLM loop completes, the worker creates the draft PR via the GitHub REST API (`POST /repos/{owner}/{repo}/pulls` with `draft: true`).

Auth: use a dedicated write-capable GitHub token for branch push and draft PR creation. Repo hydration remains on the normal read token.

PR title and body are constructed deterministically by the worker from the plan artifact (ticket summary, scope, changed files list) — not generated by the LLM. This keeps PR metadata quality consistent and testable.

The worker records the PR URL in:

- `oneshot_artifacts` metadata (`metadata_json.pr_url`)
- `oneshot_runs.current_pr_url`

This separation means:

- PR creation is testable without invoking an LLM
- retry after PR-creation failure does not re-run the entire implementation
- PR metadata quality is consistent and predictable

## `OneShotNotificationPoster`

Execution model:

- orchestrator-owned secondary loop

Responsibility:

- poll `oneshot_notifications`
- post comments to JIRA
- mark notifications posted or failed

This preserves centralized JIRA posting without inventing fake completion `task_management` rows.

## PFOS exclusivity rules

This must be enforced in code, not left only to JQL.

Required orchestrator behavior:

- if a ticket has label `PFOS`, only `QUALIFIER` may be assigned
- if a ticket does not have `PFOS`, `QUALIFIER` must skip it
- non-Qualifier agents must skip `PFOS` tickets even if their JQL would otherwise match

This should be implemented as an explicit guard in the orchestrator assignment path.

## Qualification contract

`QUALIFIER` should return a structured result with:

- `qualified: boolean`
- `repo_id: number | null`
- `branch_name: string | null`
- `base_commit_sha: string | null`
- `requirements_summary: string[]`
- `acceptance_criteria_present: boolean`
- `blocking_reasons: string[]`
- `non_blocking_warnings: string[]`
- `comment_markdown: string`

### Qualification pass criteria

Must pass:

- ticket has label `PFOS`
- exactly one repository is identified
- exactly one branch is identified
- branch exists remotely
- current branch head SHA can be captured
- requirements are clear enough to plan implementation
- ticket scope is bounded to one repo and one PR

Warnings allowed:

- no explicit acceptance criteria
- some assumptions required
- some implementation detail left for planner decomposition

### Qualification failure behavior

If qualification fails:

- `QUALIFIER` completes normally on `task_management`
- orchestrator posts the qualification-failure comment to JIRA
- no `oneshot_runs` row is created
- no SQS message is emitted

### Qualification success behavior

If qualification succeeds:

- `QUALIFIER` writes a qualification summary result
- creates the `oneshot_runs` row
- sends the first planning message to SQS
- completes its own `task_management` run normally

## OneShot database model

v1 should stay deliberately small.

## `oneshot_runs`

One row per PFOS ticket run.

Recommended columns:

- `id`
- `jira_key`
- `source_task_management_id`
- `customer_id`
- `repo_id`
- `branch_name`
- `base_commit_sha`
- `state`
- `max_review_loops`
- `review_loop_count`
- `current_plan_version`
- `current_review_version`
- `current_implementation_version`
- `current_pr_url`
- `final_disposition`
- `last_error`
- `created_at`
- `updated_at`

Recommended constraints:

- unique active run per `jira_key`
- foreign keys to:
  - `task_management`
  - `customer_branches`
  - `code_repositories`

## `oneshot_artifacts`

One row per stage execution artifact.

Recommended columns:

- `id`
- `oneshot_run_id`
- `stage`
- `version`
- `status`
- `s3_bucket`
- `s3_key`
- `provider`
- `model`
- `metadata_json`
- `started_at`
- `completed_at`
- `created_at`

Recommended stages:

- `qualification`
- `plan`
- `review`
- `implementation`

`metadata_json` stores stage-specific fields, for example:

- plan:
  - `summary`
  - `requirements`
  - `acceptance_criteria`
- review:
  - `decision`
  - `blocking_findings`
  - `required_changes`
  - `non_blocking_suggestions`
- implementation:
  - `implementation_branch`
  - `pr_url`
  - `changed_files`
  - `test_results`

## `oneshot_notifications`

Notification queue owned by the database.

Recommended columns:

- `id`
- `oneshot_run_id`
- `jira_key`
- `notification_type`
- `body_markdown`
- `status`
- `error`
- `created_at`
- `posted_at`

## Why there is no v1 outbox

The transactional outbox pattern is correct in theory, but too much infrastructure for v1.

v1 behavior should be:

1. update DB state
2. send SQS message
3. if SQS send fails, leave the run in a recoverable `queued_for_*` state
4. use reconciliation to find stuck queued runs and re-publish

Recommended reconciliation query:

```sql
SELECT id, state
FROM oneshot_runs
WHERE state LIKE 'queued_for_%'
  AND updated_at < NOW() - INTERVAL 10 MINUTE;
```

`oneshot_outbox` can be added in v2 if operational volume justifies it.

## SQS design

Recommended queues:

- `oneshot-planning.fifo`
- `oneshot-review.fifo`
- `oneshot-implementation.fifo`

### Queue routing

- fresh planning and revision planning both go to `oneshot-planning.fifo`
- review always goes to `oneshot-review.fifo`
- implementation always goes to `oneshot-implementation.fifo`

There is no separate feedback queue in v1. A revision is just another planning run with revision context.

There is no completion queue in v1. Completion writes a notification row, and the poster polls `oneshot_notifications`.

### Message payload

Recommended queue message payload:

- `run_id`
- `stage`
- `version`
- `expected_state`
- `revision`
- `emitted_at`

FIFO semantics:

- `messageGroupId = run_id`
- dedupe key derived from `(run_id, stage, version)`

Messages should be minimal. The database remains the source of truth.

## Artifact model

Use existing shared S3 buckets with a dedicated prefix such as:

```text
oneshot/
  <jira-key>/
    run-<run-id>/
      qualification/v1/
      plans/v1/
      plans/v2/
      reviews/v1-r1/
      reviews/v2-r2/
      implementation/v1/
```

Run ID must be part of the S3 prefix so the same Jira ticket can be rerun later without artifact collisions.

### Planner artifact contract

The plan artifact should include:

- ticket summary
- repo and branch
- base commit SHA
- scope
- assumptions
- requirements
- acceptance criteria
- impacted files
- proposed changes
- implementation steps
- test strategy
- risks

### Reviewer artifact contract

The review artifact should include:

- `decision`
- `blocking_findings`
- `required_changes`
- `non_blocking_suggestions`
- `confidence`
- `coverage_assessment`

### Revision context contract

When `REVIEWER` returns `NEEDS_CHANGES`, the next planning run must receive:

```json
{
  "run_id": 42,
  "revision_round": 2,
  "max_rounds": 3,
  "prior_plan_s3_key": "oneshot/PROJ-123/run-42/plans/v1/plan.json",
  "review_s3_key": "oneshot/PROJ-123/run-42/reviews/v1-r1/review.json",
  "required_changes": ["...", "..."],
  "blocking_findings": ["...", "..."]
}
```

The planner consumer should load:

- the original ticket context
- the previous plan
- the previous review
- the explicit revision payload

and then produce the next plan version.

### Implementer artifact contract

The implementation artifact should include:

- implementation branch
- PR URL
- changed files
- test commands run
- test results
- deviations from plan
- residual risks

## State machine

Recommended `oneshot_runs.state` values for v1:

- `queued_for_planning`
- `planning`
- `queued_for_review`
- `reviewing`
- `needs_revision`
- `approved`
- `escalated`
- `blocked`
- `queued_for_implementation`
- `implementing`
- `replan_required`
- `pr_open`
- `completed`
- `failed`

### State notes

- `queued_for_*` states exist primarily for recovery and reconciliation
- qualification failure does not create a `oneshot_runs` row, so there are no qualification states in OneShot
- `escalated` replaces the earlier `approved_with_review_debt` idea

## Review loop behavior

### Normal review loop

1. `PLANNER` writes `plan vN`
2. `REVIEWER` evaluates it
3. If decision is:
   - `APPROVED` -> move to implementation
   - `NEEDS_CHANGES` and loops remain -> queue another planning run with revision context
   - `NEEDS_CHANGES` and loops exhausted -> set `escalated`, notify Jira, stop
   - `BLOCKED` -> set `blocked`, notify Jira, stop

### Human override after escalation

The reviewed v1 design does not auto-continue after max loops.

Instead:

- set `state = 'escalated'`
- post a JIRA comment summarizing unresolved review feedback

To override, a human adds the `PFOS-FORCE-APPROVE` label to the ticket. When the orchestrator next assigns the ticket to QUALIFIER, QUALIFIER enters Mode 2 (force-approve re-entry), which re-checks `base_commit_sha` and transitions the run to `queued_for_implementation` or `replan_required`.

This preserves human control without pretending the reviewer actually approved the plan.

## Branch drift behavior

Before implementation:

1. `IMPLEMENTER` checks the current remote head SHA for `branch_name`
2. It compares that SHA to `base_commit_sha`
3. If they differ:
   - do not implement
   - set run state to `replan_required`
   - write a JIRA notification
   - stop

This protects against planning on one code state and implementing on another.

## Failure recovery semantics

## Planner retry behavior

Planner runs are stateless.

On retry:

- re-read the ticket, repo, and revision context
- regenerate the plan from scratch
- if an artifact already exists for `(run_id, stage='plan', version=N)`:
  - upsert it using `INSERT ... ON DUPLICATE KEY UPDATE`
  - the S3 key is deterministic (`oneshot/<jira-key>/run-<run-id>/plans/v<N>/`), so S3 content is overwritten at the same key

## Reviewer retry behavior

Reviewer runs are stateless.

On retry:

- re-read the plan artifact
- regenerate the review from scratch
- if an artifact already exists for `(run_id, stage='review', version=N)`:
  - upsert it using `INSERT ... ON DUPLICATE KEY UPDATE`
  - the S3 key is deterministic (`oneshot/<jira-key>/run-<run-id>/reviews/v<N>/`), so S3 content is overwritten at the same key

## Implementer retry behavior

Implementer runs are stateful and need explicit retry behavior.

Recommended v1 behavior:

- implementation branch name is deterministic, e.g.:
  - `oneshot/<jira-key-lower>-run-<run-id>`
- on retry:
  - if no remote branch exists, start normally
  - if a remote branch exists and there is no PR recorded, delete the branch and restart from `base_commit_sha`
  - if a PR already exists, set state to `pr_open`, attach the PR metadata, and stop rather than creating a second PR
- if an artifact already exists for `(run_id, stage='implementation', version=N)`:
  - upsert it using `INSERT ... ON DUPLICATE KEY UPDATE`
  - the S3 key is deterministic (`oneshot/<jira-key>/run-<run-id>/implementation/v<N>/`), so S3 content is overwritten at the same key

This is simpler and safer than trying to resume partial code-edit state.

## Cost model

One OneShot run can invoke:

- `QUALIFIER`: 1
- `PLANNER`: 1 to 3
- `REVIEWER`: 1 to 3
- `IMPLEMENTER`: 1

So a normal run is roughly 3 to 8 model invocations.

### Rough expected cost band

At current architecture assumptions:

- low-complexity run: low single-digit dollars
- larger run with multiple review loops: potentially low teens of dollars

The exact number will depend on:

- repo context size
- plan length
- review loop count
- implementation token volume

### Required v1 guardrail

Add a per-run token and/or cost ceiling.

Recommended behavior:

- maintain cumulative token usage on `oneshot_runs`
- if the run exceeds configured budget:
  - stop the run
  - set state to `blocked`
  - write notification to JIRA

Budget exhaustion should behave like a hard safety stop, not an automatic retry loop.

## Workspace and branch cleanup

OneShot will create:

- EFS working directories for each run
- implementation branches
- possibly orphaned branches if a run fails mid-implementation

Minimum v1 cleanup rules:

- on `completed`:
  - clean up EFS workspace
  - keep the implementation branch because it backs the PR
- on `failed`, `blocked`, or `escalated`:
  - clean up EFS workspace
  - if implementation branch exists and no PR exists, delete the branch
- on `replan_required`:
  - clean up temporary implementation workspace
  - keep no implementation branch unless one was intentionally created

Cleanup should be explicit in rollout scope, not left as an afterthought.

## Notification model

`oneshot_notifications` should be used for:

- review blocked
- review escalated
- branch drift / re-plan required
- run failed
- budget exceeded
- final completion summary with draft PR URL

The orchestrator should gain a second posting loop that:

- polls queued OneShot notifications
- posts them to JIRA
- marks them posted or failed

## Service boundaries

Recommended code structure:

- `src/oneshot/types.ts`
- `src/oneshot/database/`
- `src/oneshot/config.ts`
- `src/oneshot/service.ts`
- `src/oneshot/main.ts`
- `src/oneshot/workspaces.ts`
- `src/oneshot/github.ts`
- `src/oneshot/consumers/planner.ts`
- `src/oneshot/consumers/reviewer.ts`
- `src/oneshot/consumers/implementer.ts`
- `src/orchestrator/oneshot/reconciler.ts`
- `src/orchestrator/oneshot/notification-poster.ts`
- `src/orchestrator/workers/QualifierWorker.ts`

Important boundary:

- do not make `PLANNER`, `REVIEWER`, or `IMPLEMENTER` extend the current `AgentWorker`
- only `QUALIFIER` stays on the legacy worker base

## Rollout phases

### Phase 0. Contracts and state model

- freeze the OneShot state model
- freeze queue contracts
- freeze artifact contracts
- freeze revision context contract
- freeze review-loop semantics

### Phase 1. Schema and state services

- add `oneshot_runs`
- add `oneshot_artifacts`
- add `oneshot_notifications`
- add DB access layer and transition helpers
- add schema docs and migrations

### Phase 2. PFOS routing and Qualifier

- add PFOS exclusivity to orchestrator assignment
- implement `QUALIFIER` as a normal `task_management` worker
- add qualification result comments
- create `oneshot_runs` and send planning message on success

### Phase 3. Planner service

- create `PLANNER` queue consumer
- reuse PRISM planning patterns where practical
- write versioned plan artifacts
- enqueue review

### Phase 4. Reviewer service

- create `REVIEWER` queue consumer
- implement strict verdict schema
- wire bounded review loops
- support escalation after max `NEEDS_CHANGES`
- enforce `BLOCKED` stop behavior

### Phase 5. Implementer service

- create `IMPLEMENTER` queue consumer
- enforce branch drift checks
- create implementation branches
- open draft PRs
- write notifications

### Phase 6. Reconciliation, notifications, and cleanup

- add queued-state reconciliation for missed SQS publishes
- add orchestrator notification poster loop
- add workspace and branch cleanup
- document runbook and failure recovery

### Phase 7. Optional v2 hardening

- transactional outbox
- richer stage event history
- preview environments
- QA stage
- provider benchmarking for `IMPLEMENTER`

## Acceptance criteria

- `PFOS` tickets never route to normal non-OneShot agents
- `QUALIFIER` is the only OneShot stage that uses `task_management`
- OneShot run state is queryable entirely from MySQL
- queue dispatch can be recovered from `queued_for_*` reconciliation
- planning, review, and implementation artifacts are versioned in S3
- review loops are capped and auditable
- `BLOCKED` never auto-advances
- branch drift causes re-plan rather than silent implementation
- `IMPLEMENTER` opens a draft PR only
- final JIRA posting works through `oneshot_notifications`

## Open items for Phase 1

These are now frozen by the phase-level specs:

1. SQS dead-letter queues with `maxReceiveCount = 3`
2. orchestrator-owned reconciliation loop
3. default budget ceiling of `2,000,000` tokens per run

Remaining follow-up work is implementation, not design.
