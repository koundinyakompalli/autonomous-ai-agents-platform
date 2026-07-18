# OneShot Phase 3 Design: Planner Service

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`  
**Phase**: 3 of 7

## Summary

Phase 3 implements the queue-driven planner:

- consume planning work from SQS
- hydrate a read-only workspace at the frozen base SHA
- produce a canonical plan artifact
- persist it to S3 and MySQL
- enqueue review

## Deliverables

```
src/oneshot/config.ts
src/oneshot/main.ts
src/oneshot/consumer-base.ts
src/oneshot/workspaces.ts
src/oneshot/consumers/planner.ts
src/oneshot/providers/claude-planner.ts
src/claude-sdk/config.ts
src/claude-sdk/index.ts
terraform/oneshot-ecs.tf
terraform/iam.tf
```

## 1. Runtime shape

Use one shared OneShot entrypoint:

```text
src/oneshot/main.ts
```

Dispatch by:

- `ONESHOT_ROLE=PLANNER`
- `ONESHOT_ROLE=REVIEWER`
- `ONESHOT_ROLE=IMPLEMENTER`

Phase 3 only implements the PLANNER role.

## 2. ECS service contract

Add a dedicated ECS service:

- service name: `PLANNER`
- desired count: `1` in v1

Required environment:

- `ONESHOT_ROLE=PLANNER`
- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX`
- `ONESHOT_MAX_TOTAL_TOKENS`
- DB env vars
- `GITHUB_REPO_TOKEN`

Required mounts:

- existing EFS repo volume

Required IAM:

- `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on planning queue
- `sqs:SendMessage` on review queue
- S3 read/write for OneShot artifact paths
- Secrets Manager read for repo token if injected via ECS secret
- Bedrock access already used by existing Claude agents

## 3. Workspace behavior

The planner must plan against the exact frozen code state.

### Workspace helper

Introduce shared helper:

- `src/oneshot/workspaces.ts`

Planner behavior:

1. hydrate shared repo root if needed
2. create stage workspace under:
   - `/mnt/efs/specter-repo/oneshot/<run-id>/planner`
3. create checkout from `base_commit_sha`
4. expose workspace path to the Claude planner wrapper

Planner workspaces are read-only by convention:

- no git push
- no branch creation
- no code edits persisted back to the repo

## 4. Planner provider integration

Planner uses Bedrock / Claude.

Recommended integration:

- add `agentType = 'oneshot_planner'`
- tool permission set: read/search only

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- optionally `Bash` only for read-only inspection commands if needed

Do not give planner write capability in v1.

## 5. Planner input contract

Planner consumes:

- Jira ticket summary/description
- qualification summary
- repo name and URL
- branch name
- base commit SHA
- workspace path
- revision context if `revision = true`

### Revision planning

If the message has `revision = true`, planner must also load:

- prior plan artifact
- prior review artifact
- explicit `required_changes`
- explicit `blocking_findings`

## 6. Canonical plan artifact

Canonical key:

```text
oneshot/<jira-key>/run-<run-id>/plans/v<version>/plan.json
```

Canonical JSON shape:

```json
{
  "jiraKey": "PROJ-123",
  "repoName": "core-app",
  "branchName": "3.18",
  "baseCommitSha": "abc123...",
  "summary": "Short plan summary",
  "scope": ["..."],
  "assumptions": ["..."],
  "requirements": ["..."],
  "acceptanceCriteria": ["..."],
  "impactedFiles": ["path/a.ts", "path/b.ts"],
  "proposedChanges": ["..."],
  "implementationSteps": ["..."],
  "testStrategy": ["..."],
  "risks": ["..."],
  "renderedMarkdown": "..."
}
```

Rules:

- `impactedFiles` is required
- `implementationSteps` is required
- `renderedMarkdown` is present for human readability, but JSON is canonical

## 7. Planner consumer flow

1. receive message
2. load `oneshot_runs`
3. claim `queued_for_planning -> planning`
4. check budget before invocation
5. hydrate workspace at `base_commit_sha`
6. compute next plan version
7. call Claude planner
8. write artifact to S3
9. upsert `oneshot_artifacts(stage='plan', version=N)`
10. update run:
   - `current_plan_version = N`
   - `state = queued_for_review`
11. publish review message
12. delete queue message

If review publish fails:

- keep run in `queued_for_review`
- let reconciliation recover it

## 8. Failure behavior

### Transient failure

- leave message unacked or extend visibility
- rely on normal retry up to queue redrive threshold

### Persistent planner failure

After local retries are exhausted:

- set run `state = failed`
- set `last_error`
- create `run_failed` notification
- delete queue message

### Budget exhaustion

- set run `state = failed`
- create `budget_exceeded` notification
- do not enqueue review

## 9. Tests

Required tests:

- claim transition from `queued_for_planning`
- version incrementing on fresh and revision plans
- canonical artifact JSON shape validation
- revision context loading
- review message emission
- budget stop behavior
- failure notification on persistent error

## 10. Acceptance criteria

- planner only works from `queued_for_planning`
- planner artifacts are canonical JSON in S3
- planner never mutates repo state
- planner retries are idempotent
- successful plan creation always leaves the run in `queued_for_review`
