# OneShot Phase 0 Design: Contracts and Control Model

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`  
**Phase**: 0 of 7

## Summary

Phase 0 freezes the contracts that every later phase depends on:

- ticket labels and control inputs
- queue names and payloads
- state transitions
- artifact keys and versioning
- secret and environment variable names
- branch naming and PR conventions
- retry and reconciliation anchors

No runtime code ships in Phase 0. The output is contract certainty.

## Deliverables

```
docs/superpowers/specs/2026-04-12-oneshot-phase0-contracts.md
```

## 1. Jira labels and control inputs

### Required label

- `PFOS`

Meaning:

- ticket is eligible for the OneShot flow
- orchestrator must route it only to `QUALIFIER`

### Control labels

- `PFOS-FORCE-APPROVE`
- `PFOS-REPLAN`

Meaning:

- `PFOS-FORCE-APPROVE`: human override for an `escalated` run
- `PFOS-REPLAN`: human-triggered restart for a `replan_required` run

### Label rules

- `PFOS` is the routing label and must remain present for all OneShot tickets.
- `PFOS-FORCE-APPROVE` is only honored when an active run exists in `escalated`.
- `PFOS-REPLAN` is only honored when an active run exists in `replan_required`.
- stale control labels are harmless because `QUALIFIER` also checks run state before acting.
- if Jira API permissions make label cleanup easy, `QUALIFIER` may remove control labels after successful consumption, but v1 must not require that for correctness.

## 2. Queue and DLQ contract

### Queues

- `oneshot-planning.fifo`
- `oneshot-review.fifo`
- `oneshot-implementation.fifo`

### DLQs

- `oneshot-planning-dlq.fifo`
- `oneshot-review-dlq.fifo`
- `oneshot-implementation-dlq.fifo`

### Queue properties

- `FifoQueue = true`
- `ContentBasedDeduplication = false`
- `maxReceiveCount = 3`

### Visibility timeout defaults

- planning: 20 minutes
- review: 15 minutes
- implementation: 90 minutes

### Message identity rules

- `messageGroupId = run_id`
- dedupe key = `<run_id>:<stage>:<version>`

### Queue environment variables

- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`

## 3. Secret and environment contract

### Shared environment variables

- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX=oneshot`
- `ONESHOT_MAX_REVIEW_LOOPS=3`
- `ONESHOT_MAX_TOTAL_TOKENS=2000000`
- `ONESHOT_RECONCILE_STALE_MINUTES=10`

### GitHub secrets

- `GITHUB_REPO_TOKEN`
  - read-only token used for repo hydration and normal pull/fetch operations
- `GITHUB_WRITE_TOKEN`
  - write-capable token used only by `IMPLEMENTER` for branch push and draft PR creation

Recommendation:

- keep the existing shared repo token read-only
- introduce `GITHUB_WRITE_TOKEN` as a separate secret for the write boundary

### OpenAI secret

- `OPENAI_API_KEY`

Recommended secret name in AWS Secrets Manager:

- `specter/prod/openai-reviewer-api-key`

### Token boundary

- `QUALIFIER`: no GitHub write token
- `PLANNER`: no GitHub write token
- `REVIEWER`: no GitHub write token
- `IMPLEMENTER`: read token + write token

## 4. Queue payload contract

All queues use the same minimal envelope:

```json
{
  "run_id": 42,
  "stage": "planning",
  "version": 1,
  "expected_state": "queued_for_planning",
  "revision": false,
  "emitted_at": "2026-04-12T18:15:00.000Z"
}
```

### Field meanings

- `run_id`: primary key of `oneshot_runs`
- `stage`: `planning | review | implementation`
- `version`: artifact version the consumer is expected to create or read
- `expected_state`: optimistic concurrency guard for claim/update
- `revision`: only meaningful on planning messages
- `emitted_at`: traceability only

## 5. State machine contract

### Allowed states

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

### Transition matrix

| From | To | Owner | Notes |
|------|----|-------|-------|
| none | `queued_for_planning` | `QUALIFIER` | fresh qualified run |
| `queued_for_planning` | `planning` | `PLANNER` | atomic claim |
| `planning` | `queued_for_review` | `PLANNER` | plan artifact written |
| `queued_for_review` | `reviewing` | `REVIEWER` | atomic claim |
| `reviewing` | `queued_for_implementation` | `REVIEWER` | approved plan |
| `reviewing` | `queued_for_planning` | `REVIEWER` | needs changes, loops remain |
| `reviewing` | `escalated` | `REVIEWER` | needs changes, loops exhausted |
| `reviewing` | `blocked` | `REVIEWER` | blocked verdict |
| `escalated` | `queued_for_implementation` | `QUALIFIER` | `PFOS-FORCE-APPROVE` path |
| `replan_required` | `queued_for_planning` | `QUALIFIER` | `PFOS-REPLAN` path |
| `queued_for_implementation` | `implementing` | `IMPLEMENTER` | atomic claim |
| `implementing` | `replan_required` | `IMPLEMENTER` | branch drift |
| `implementing` | `pr_open` | `IMPLEMENTER` | draft PR created |
| `pr_open` | `completed` | notification poster | final Jira comment posted |
| any active state | `failed` | stage owner | unrecoverable failure |

### State ownership rules

- only one service owns each transition
- no consumer should skip intermediate state changes
- `queued_for_*` states exist for reconciliation and recovery, not user-facing meaning

## 6. Artifact and key contract

### Prefix layout

Use run-scoped keys, not just Jira-scoped keys:

```text
oneshot/
  <jira-key>/
    run-<run-id>/
      qualification/v1/qualification.json
      plans/v1/plan.json
      reviews/v1-r1/review.json
      plans/v2/plan.json
      reviews/v2-r2/review.json
      implementation/v1/implementation.json
```

### Why run ID is required

- same Jira ticket may be rerun later
- run ID prevents artifact collisions across reruns
- deterministic keys still work for stage retries

### Canonical artifact format

All v1 artifacts should be canonical JSON objects.

Optional human-readable markdown can be embedded in a field like:

- `rendered_markdown`

but the DB row should point to the JSON object as the canonical artifact.

## 7. Revision context contract

When a planner revision is required, the planning consumer receives:

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

This payload is loaded from DB and prior artifacts, not treated as the source of truth itself.

## 8. Branch and PR contract

### Implementation branch naming

Deterministic branch name:

```text
oneshot/<jira-key-lower>-run-<run-id>
```

Examples:

- `oneshot/cpclient-9351-run-42`
- `oneshot/mpdev-1234-run-107`

### PR title format

```text
[PFOS] <JIRA_KEY>: <ticket summary>
```

### PR body sections

- Summary
- Approved plan
- Validation run
- Residual risks
- Artifact links

The worker builds this body deterministically from the plan and implementation artifacts.

## 9. Notification contract

### Notification types used in v1

- `review_blocked`
- `review_escalated`
- `branch_drift`
- `run_failed`
- `budget_exceeded`
- `completed`

### Notification ownership

- stage owners create notification rows
- orchestrator-owned poster loop posts them to Jira
- only the poster loop marks notifications `posted`

### Final success notification

- `completed` is the terminal success notification
- it must include the draft PR URL and implementation summary
- when `completed` is posted successfully, the run moves from `pr_open` to `completed`

## 10. Budget and review loop defaults

- max review loops: `3`
- default token budget: `2,000,000`

Behavior:

- `BLOCKED` always stops
- `NEEDS_CHANGES` past max loops becomes `escalated`
- budget exhaustion becomes `failed` + `budget_exceeded` notification

## 11. Reconciliation contract

Stale queued runs are recoverable through DB-first reconciliation.

### Default rule

If a run is in `queued_for_*` for more than 10 minutes:

- re-publish the expected queue message
- do not create a new run
- do not alter the version number

### Runtime owner

The reconciliation loop belongs to orchestrator in v1.

### Interval

- every 2 minutes

## 12. Freeze checklist

Phase 0 is complete only when these are accepted:

- queue names and DLQ names are final
- secret names are final
- state names are final
- success and failure notifications are final
- branch naming is final
- artifact keys include run ID
- control labels are final
- success path is `pr_open` -> `completed`
