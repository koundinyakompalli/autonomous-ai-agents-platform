# OneShot Phase 6 Design: Reconciliation, Notifications, and Cleanup

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`  
**Phase**: 6 of 7

## Summary

Phase 6 closes the operational loop:

- reconcile stuck queued runs
- post Jira notifications from the DB queue
- clean up EFS workspaces and orphaned branches
- add observability and runbooks

## Deliverables

```
src/orchestrator/oneshot/reconciler.ts
src/orchestrator/oneshot/notification-poster.ts
src/orchestrator/oneshot/cleanup.ts
src/orchestrator/Orchestrator.ts
docs/ONESHOT_RUNBOOK.md
terraform/oneshot-ecs.tf
terraform/iam.tf
```

## 1. Runtime owner

In v1, orchestrator owns the operations loops:

- `OneShotReconciler`
- `OneShotNotificationPoster`

This keeps the number of new deployed services down.

## 2. Reconciliation loop

### Purpose

Recover from the v1 non-outbox failure mode:

- DB state updated
- SQS publish did not happen

### Interval

- every 2 minutes

### Query

Use `v_oneshot_stuck_runs` or equivalent direct query:

- `state LIKE 'queued_for_%'`
- `updated_at < NOW() - INTERVAL 10 MINUTE`

### Behavior

For each stuck run:

- determine expected queue from state
- re-publish the exact same message envelope
- log the recovery action

Do not:

- create a new run
- change version numbers
- mutate the run state

## 3. Notification poster loop

### Interval

- every 30 seconds

### Claim pattern

Use DB atomic claim:

- `pending -> posting`

### Posting target

- Jira comment on the source ticket

### Success behavior

- mark notification `posted`
- if notification type is `completed`:
  - transition run `pr_open -> completed`

### Failure behavior

- transient Jira/API failure:
  - `posting -> pending`
- persistent failure:
  - `posting -> failed`
  - preserve error text

## 4. Cleanup rules

### EFS workspaces

Cleanup trigger states:

- `completed`
- `blocked`
- `failed`
- `escalated`
- `replan_required`

Rules:

- planner/reviewer temp workspaces are always deleted
- implementer workspace is deleted after PR metadata is captured

### Git branches

Rules:

- if run reaches `completed`, keep the implementation branch because it backs the draft PR
- if run fails before PR creation and branch exists, delete the branch
- if run is `blocked`, `escalated`, or `replan_required` and no PR exists, delete branch if it exists

### Cleanup runtime

Cleanup can run inline at stage completion where safe. Phase 6 adds a periodic cleanup sweep for leftovers.

## 5. Observability

Minimum v1 metrics:

- number of runs by state
- queue depth per OneShot queue
- DLQ depth per OneShot DLQ
- notification post failures
- reconciliation republish count
- branch drift count
- review escalation count
- run failure count

Minimum logs:

- run ID on every log line
- Jira key on every log line
- stage and version on stage logs

## 6. DLQ handling

### Queue redrive

- each queue has a dedicated DLQ
- `maxReceiveCount = 3`

### DLQ response

When a message lands in a DLQ:

- create or update a `run_failed` notification
- mark run `failed` unless a human explicitly wants recovery
- record queue name and message metadata in logs

## 7. Runbook requirements

`docs/ONESHOT_RUNBOOK.md` should include:

- how to identify stuck runs
- how to inspect artifacts
- how to inspect review loops
- how to recover escalated runs
- how to recover replan-required runs
- how to inspect PR metadata
- how to inspect DLQs

## 8. Acceptance criteria

- stuck queued runs can be re-published automatically
- notifications are posted from DB-backed queue state
- success transitions from `pr_open` to `completed`
- failed and stale workspaces are cleaned up
- DLQ events are visible and actionable
