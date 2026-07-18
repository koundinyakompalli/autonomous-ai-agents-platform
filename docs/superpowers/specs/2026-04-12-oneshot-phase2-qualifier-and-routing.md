# OneShot Phase 2 Design: PFOS Routing and Qualifier

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`  
**Phase**: 2 of 7

## Summary

Phase 2 makes PFOS real in the existing control plane:

- orchestrator routes PFOS tickets exclusively to `QUALIFIER`
- `QUALIFIER` validates readiness and run-entry conditions
- successful qualification creates a `oneshot_runs` row and publishes planning work
- unsuccessful qualification ends cleanly through the existing `task_management` -> Jira comment path

## Deliverables

```
src/orchestrator/Orchestrator.ts
src/orchestrator/workers/QualifierWorker.ts
src/agents/qualifier/QualifierAgent.ts
src/orchestrator/workers/index.ts
src/orchestrator/workers/runtime.ts
src/oneshot/service.ts
src/oneshot/contracts.ts
src/oneshot/publisher.ts
src/oneshot/repo-resolution.ts
src/oneshot/branch-resolution.ts
src/oneshot/git.ts
src/oneshot/database/*
db/schema.sql
terraform/oneshot.tf
terraform/ecs.tf
terraform/iam.tf
```

## 1. Orchestrator routing changes

### PFOS exclusivity rules

Required behavior in the orchestrator assignment path:

- if Jira labels include `PFOS`, only `QUALIFIER` may be considered
- if Jira labels do not include `PFOS`, `QUALIFIER` must not be considered
- normal workers must never receive `PFOS` tickets even if their JQL would otherwise match

### Active-run short-circuit

Before assigning a PFOS ticket, orchestrator must check `oneshot_runs`:

- if no active run exists -> assign to `QUALIFIER`
- if active run exists in `escalated` and ticket has `PFOS-FORCE-APPROVE` -> assign to `QUALIFIER`
- if active run exists in `replan_required` and ticket has `PFOS-REPLAN` -> assign to `QUALIFIER`
- otherwise -> do not assign a new `task_management` row

This prevents duplicate Qualifier churn while a OneShot run is already active.

## 2. QUALIFIER worker modes

`QUALIFIER` runs as a normal `AgentWorker` subclass, but it has three explicit modes.

### Mode 1: Fresh qualification

Preconditions:

- ticket has `PFOS`
- no active run exists for the Jira key

Output:

- qualification failure comment, or
- new `oneshot_runs` row in `queued_for_planning`

### Mode 2: Force-approve re-entry

Preconditions:

- active run exists in `escalated`
- ticket has `PFOS-FORCE-APPROVE`

Output:

- if base SHA still matches current branch head:
  - run transitions to `queued_for_implementation`
  - implementation message is published
- if base SHA drifted:
  - run transitions to `replan_required`
  - notification row is created

### Mode 3: Replan re-entry

Preconditions:

- active run exists in `replan_required`
- ticket has `PFOS-REPLAN`

Output:

- refresh `base_commit_sha` to current branch head
- reset `review_loop_count = 0`
- leave prior artifacts intact
- transition run to `queued_for_planning`
- publish planning message with next plan version

## 3. Qualification algorithm

Qualification must be hybrid:

- deterministic checks first
- LLM judgment only where ambiguity remains

### Step 1: Resolve repo

Resolution order:

1. explicit repo name, slug, or URL mention in the ticket body/summary/comments
2. exact single-repo result from existing `RepoAnalyzer`
3. otherwise fail qualification

Rules:

- multiple repo matches -> fail
- zero repo matches -> fail
- v1 does not allow multi-repo execution

### Step 2: Resolve branch

Resolution order:

1. explicit branch mention in the ticket
2. `customer_branches.branch` when the repo is a versioned customer repo
3. `code_repositories.default_branch`

Then verify:

- branch exists remotely
- branch head SHA is obtainable

### Step 3: Scope guard

Fail qualification if any of these are true:

- request clearly spans multiple repos
- request implies more than one PR
- request is too ambiguous to produce a bounded plan

### Step 4: Requirements completeness

The LLM should output a strict structure:

- `ready_for_planning: boolean`
- `requirements_summary: string[]`
- `acceptance_criteria_present: boolean`
- `blocking_reasons: string[]`
- `non_blocking_warnings: string[]`

### Step 5: Build the qualification result

Return the contract already frozen in Plan 09 and Phase 0.

## 4. Qualification comments

### Failure comment shape

Required sections:

- Qualification result: `Not ready for OneShot`
- Missing or ambiguous inputs
- Exact blocking reasons
- What the ticket owner must add or clarify

### Success comment shape

Required sections:

- Qualification result: `Ready for OneShot`
- Repo
- Branch
- Base commit SHA
- Warnings or assumptions

The success comment is optional for v1 if the team prefers quieter tickets, but the qualification summary must still be written to the `task_management` result for traceability.

## 5. DB and SQS behavior

### Fresh qualification success

Within one DB transaction:

1. insert `oneshot_runs`
2. insert qualification artifact row
3. set initial values:
   - `state = queued_for_planning`
   - `review_loop_count = 0`
   - `current_plan_version = NULL`

After commit:

4. publish planning message to `oneshot-planning.fifo`

If publish fails:

- leave state in `queued_for_planning`
- let reconciliation recover it later

### Force-approve success

Within one DB transaction:

1. verify active run is still `escalated`
2. verify base SHA still matches current branch head
3. set `state = queued_for_implementation`

After commit:

4. publish implementation message

### Replan success

Within one DB transaction:

1. verify active run is still `replan_required`
2. refresh `base_commit_sha`
3. set `state = queued_for_planning`
4. reset `review_loop_count = 0`

After commit:

5. publish planning message with the next plan version

## 6. Shared service helpers introduced in Phase 2

### `src/oneshot/service.ts`

Facade for:

- active run lookup
- run creation
- queue message emission
- qualification artifact persistence

### `src/oneshot/repo-resolution.ts`

Owns:

- explicit repo extraction
- fallback to `RepoAnalyzer`
- exact-one enforcement

### `src/oneshot/branch-resolution.ts`

Owns:

- explicit branch extraction
- customer-branch fallback
- default-branch fallback

### `src/oneshot/git.ts`

Owns:

- remote branch existence check
- `ls-remote` head SHA lookup

## 7. Agent and runtime integration

### `agents` row

`QUALIFIER` must be seeded as a built-in system agent.

Recommended agent characteristics:

- `name = QUALIFIER`
- `task_type = qualification`
- JQL broad enough to match PFOS issues, but real exclusivity is code-enforced

### Runtime mapping

Add `QualifierWorker` to:

- `src/orchestrator/workers/index.ts`
- `src/orchestrator/workers/runtime.ts`

## 8. Terraform and deployment changes

Phase 2 also adds the queue infrastructure needed by later phases.

### Terraform

Add:

- planning/review/implementation FIFO queues
- matching DLQs
- queue URLs exported as env vars
- `QUALIFIER` worker environment for queue URLs
- orchestrator environment for notification/reconciliation queue URLs if needed later

### IAM

Grant `QUALIFIER` / orchestrator role:

- `sqs:SendMessage` to the three OneShot queues

## 9. Tests

Required tests:

- PFOS exclusivity in orchestrator assignment
- no duplicate `task_management` assignment when active run exists
- fresh qualification success/failure
- exact-one repo resolution
- branch resolution order
- force-approve path
- replan path
- SQS publish failure leaves run recoverable

## 10. Acceptance criteria

- PFOS tickets only route to `QUALIFIER`
- non-PFOS tickets never route to `QUALIFIER`
- qualification failure does not create `oneshot_runs`
- qualification success creates a recoverable `queued_for_planning` run
- `PFOS-FORCE-APPROVE` only works from `escalated`
- `PFOS-REPLAN` only works from `replan_required`
