# OneShot Phase 4 Design: Reviewer Service

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`  
**Phase**: 4 of 7

## Summary

Phase 4 implements the independent review stage:

- consume review work from SQS
- load the approved plan candidate plus referenced code
- return `APPROVED | NEEDS_CHANGES | BLOCKED`
- either requeue planning, escalate, block, or enqueue implementation

## Deliverables

```
src/oneshot/consumers/reviewer.ts
src/oneshot/providers/openai-reviewer.ts
src/oneshot/review-context.ts
src/oneshot/schema/review.ts
terraform/oneshot-ecs.tf
terraform/iam.tf
```

## 1. ECS service contract

Add a dedicated ECS service:

- service name: `REVIEWER`
- desired count: `1` in v1

Required environment:

- `ONESHOT_ROLE=REVIEWER`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX`
- `OPENAI_API_KEY`
- `GITHUB_REPO_TOKEN`
- DB env vars

Required mounts:

- existing EFS repo volume

Required IAM:

- SQS receive/delete/change-visibility on review queue
- SQS send on planning and implementation queues
- S3 read/write for OneShot artifact paths
- Secrets Manager read for `OPENAI_API_KEY` and repo token

## 2. Review context assembly

The reviewer does not use tool-calling in v1. It uses context injection.

### Inputs

- canonical `plan.json`
- current repo snapshot at `base_commit_sha`
- contents of impacted files
- existence check results for impacted files

### File loading rules

- load files listed in `impactedFiles`
- cap at:
  - 20 files
  - 150 KB total content
- if more files exist:
  - include the first N deterministically
  - add truncation notice in review context
- if a referenced file does not exist:
  - include that fact in the review context

### Review-context helper

`src/oneshot/review-context.ts` owns:

- impacted-file loading
- truncation
- context serialization

## 3. Reviewer provider integration

Use OpenAI SDK directly:

- module: `src/oneshot/providers/openai-reviewer.ts`

Responsibilities:

- client initialization
- prompt assembly
- JSON-schema response parsing
- retry/backoff

Recommended model:

- `gpt-5.4`
- reasoning effort: `xhigh`

## 4. Canonical review artifact

Canonical key:

```text
oneshot/<jira-key>/run-<run-id>/reviews/v<plan-version>-r<review-round>/review.json
```

Canonical JSON shape:

```json
{
  "decision": "NEEDS_CHANGES",
  "blockingFindings": ["..."],
  "requiredChanges": ["..."],
  "nonBlockingSuggestions": ["..."],
  "confidence": "high",
  "coverageAssessment": "..."
}
```

Validation rules:

- `decision` must be one of the three allowed verdicts
- `requiredChanges` must be non-empty when `decision = NEEDS_CHANGES`
- `blockingFindings` should be non-empty when `decision = BLOCKED`

## 5. Reviewer consumer flow

1. receive message
2. load run and current plan artifact
3. claim `queued_for_review -> reviewing`
4. check budget before invocation
5. build review context from plan + code
6. invoke OpenAI reviewer
7. write review artifact to S3
8. upsert `oneshot_artifacts(stage='review', version=N)`
9. branch on verdict:
   - `APPROVED`
   - `NEEDS_CHANGES`
   - `BLOCKED`

## 6. Verdict behavior

### APPROVED

Within one DB transaction:

- set `current_review_version = N`
- set `state = queued_for_implementation`

After commit:

- publish implementation message

### NEEDS_CHANGES with loops remaining

Within one DB transaction:

- increment `review_loop_count`
- set `current_review_version = N`
- set `state = queued_for_planning`

After commit:

- publish planning message with `revision = true`

### NEEDS_CHANGES with loops exhausted

Within one DB transaction:

- set `current_review_version = N`
- set `state = escalated`
- set `final_disposition = review_escalated`

After commit:

- create `review_escalated` notification

### BLOCKED

Within one DB transaction:

- set `current_review_version = N`
- set `state = blocked`
- set `final_disposition = review_blocked`

After commit:

- create `review_blocked` notification

## 7. Failure behavior

### Transient OpenAI failure

- retry up to 3 times
- exponential backoff with base 5 seconds

### Persistent reviewer failure

- set run `state = failed`
- set `last_error`
- create `run_failed` notification

### Budget exhaustion

- set run `state = failed`
- create `budget_exceeded` notification

## 8. Tests

Required tests:

- review context truncation
- verdict schema parsing
- approval path to implementation queue
- revision path to planning queue
- escalation path after max loops
- blocked path
- run_failed path on provider failure

## 9. Acceptance criteria

- reviewer never edits code
- reviewer only works from `queued_for_review`
- `BLOCKED` never advances
- exhausted `NEEDS_CHANGES` loops always become `escalated`
- implementation is only queued from an approved review
