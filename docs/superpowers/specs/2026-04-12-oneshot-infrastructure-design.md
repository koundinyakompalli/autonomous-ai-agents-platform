# OneShot Support Design: Infrastructure and Deployment Model

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`

## Summary

This doc defines the Terraform and runtime infrastructure required for the full OneShot v1 pipeline:

- SQS queues and DLQs
- ECS services and task definitions
- IAM roles and permissions
- secret injection
- environment variables
- deployment order

This doc is intentionally narrower than the phase specs. It answers: what infrastructure needs to exist for those phases to run.

## Deliverables

Recommended Terraform and workflow additions:

```text
terraform/oneshot.tf
terraform/oneshot-ecs.tf
terraform/iam.tf
terraform/variables.tf
terraform/outputs.tf
.github/workflows/oneshot-build-push.yml
```

Implementation can be split across existing Terraform files if preferred, but the resource model below should stay intact.

## 1. Infrastructure model

### OneShot runtime components

The v1 runtime consists of:

- `QUALIFIER`
- `PLANNER`
- `REVIEWER`
- `IMPLEMENTER`
- orchestrator-side `OneShotNotificationPoster`
- orchestrator-side `OneShotReconciler`

### Service split

- `QUALIFIER` uses the existing worker runtime model:
  - normal `task_management` worker
  - normal worker image
  - normal worker ECS service
- `PLANNER`, `REVIEWER`, and `IMPLEMENTER` use a new queue-consumer runtime:
  - dedicated ECS services
  - dedicated task definitions
  - one shared `src/oneshot/main.ts` entrypoint

### No ALBs

None of the OneShot services require an ALB or public ingress.

## 2. SQS queues

### Queues

- `oneshot-planning.fifo`
- `oneshot-review.fifo`
- `oneshot-implementation.fifo`

### DLQs

- `oneshot-planning-dlq.fifo`
- `oneshot-review-dlq.fifo`
- `oneshot-implementation-dlq.fifo`

### Required queue settings

- FIFO queue
- content-based dedupe disabled
- retention period: 4 days
- visibility timeout:
  - planning: 1200s
  - review: 900s
  - implementation: 5400s
- dead-letter redrive:
  - `maxReceiveCount = 3`

### Queue outputs

Terraform outputs should expose:

- planning queue URL
- review queue URL
- implementation queue URL
- all three queue ARNs

## 3. ECS services

### QUALIFIER

Runtime:

- current worker image
- current worker entrypoint

Service model:

- included in the standard worker map
- `WORKER_TYPE=QUALIFIER`
- desired count: `1`

Required env:

- DB env vars
- JIRA env vars if needed by existing worker stack
- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_MAX_REVIEW_LOOPS`
- `ONESHOT_MAX_TOTAL_TOKENS`

Required permissions:

- normal worker permissions
- `sqs:SendMessage` to planning queue

### PLANNER

Runtime:

- OneShot image
- `ONESHOT_ROLE=PLANNER`

Desired count:

- `1`

Required env:

- `ONESHOT_ROLE=PLANNER`
- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX`
- `ONESHOT_MAX_TOTAL_TOKENS`
- DB env vars

Required secrets:

- `GITHUB_REPO_TOKEN`

Required permissions:

- receive/delete/change-visibility on planning queue
- send to review queue
- read/write S3 under the OneShot prefix
- Bedrock invoke permissions
- repo-read secret access

### REVIEWER

Runtime:

- OneShot image
- `ONESHOT_ROLE=REVIEWER`

Desired count:

- `1`

Required env:

- `ONESHOT_ROLE=REVIEWER`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX`
- `ONESHOT_MAX_TOTAL_TOKENS`
- DB env vars

Required secrets:

- `OPENAI_API_KEY`
- `GITHUB_REPO_TOKEN`

Required permissions:

- receive/delete/change-visibility on review queue
- send to planning and implementation queues
- read/write S3 under the OneShot prefix
- secrets access for OpenAI and repo-read token

### IMPLEMENTER

Runtime:

- OneShot image
- `ONESHOT_ROLE=IMPLEMENTER`

Desired count:

- `1`

Required env:

- `ONESHOT_ROLE=IMPLEMENTER`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX`
- `ONESHOT_MAX_TOTAL_TOKENS`
- DB env vars

Required secrets:

- `GITHUB_REPO_TOKEN`
- `GITHUB_WRITE_TOKEN`

Required permissions:

- receive/delete/change-visibility on implementation queue
- read/write S3 under the OneShot prefix
- Bedrock invoke permissions
- secrets access for repo-read and repo-write tokens

## 4. Shared image strategy

### Recommended v1

Use one dedicated OneShot image for:

- `PLANNER`
- `REVIEWER`
- `IMPLEMENTER`

This image contains:

- OneShot entrypoint
- shared queue consumer base
- Claude provider integration
- OpenAI reviewer integration
- GitHub API helper code

Keep `QUALIFIER` on the existing worker image.

### Why this split is correct

- `QUALIFIER` belongs to the old worker runtime by design
- the three queue consumers share most of their infrastructure shape
- a single image reduces build sprawl in v1

## 5. Secrets Manager model

Recommended secrets:

- `specter/prod/github-repository-token`
- `specter/prod/github-write-token`
- `specter/prod/openai-reviewer-api-key`

Rules:

- repo-read token is for clone/fetch only
- repo-write token is for branch push and draft PR creation only
- reviewer API key is isolated to the reviewer service

## 6. IAM model

### Execution role

Execution role should continue to own:

- ECS secret injection
- ECR image pull
- CloudWatch log delivery

### Task roles

Create or extend task roles so each service has the least required privilege.

#### QUALIFIER task role

- DB access already implied by app runtime
- send to planning queue
- read repo metadata from DB

#### PLANNER task role

- receive planning queue
- send review queue
- S3 read/write on OneShot prefix
- Bedrock invoke

#### REVIEWER task role

- receive review queue
- send planning queue
- send implementation queue
- S3 read/write on OneShot prefix
- Secrets Manager read for OpenAI and repo token

#### IMPLEMENTER task role

- receive implementation queue
- S3 read/write on OneShot prefix
- Secrets Manager read for repo-read and repo-write tokens
- no queue-send permission required in v1

### S3 scope

Limit OneShot S3 access to:

```text
arn:aws:s3:::<artifact-bucket>/oneshot/*
```

## 7. EFS model

All OneShot services mount the existing shared EFS repo volume.

Required directories:

- `/mnt/efs/specter-repo/repositories`
- `/mnt/efs/specter-repo/oneshot`

OneShot-specific workspace roots:

- planner: `/mnt/efs/specter-repo/oneshot/<run-id>/planner`
- reviewer: `/mnt/efs/specter-repo/oneshot/<run-id>/reviewer`
- implementer: `/mnt/efs/specter-repo/oneshot/<run-id>/implementer`

Reviewer may use a lightweight scratch workspace or direct read-only file access, but v1 should still reserve the reviewer path for debugging consistency.

## 8. Environment variables

### Common OneShot env

- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX=oneshot`
- `ONESHOT_MAX_REVIEW_LOOPS=3`
- `ONESHOT_MAX_TOTAL_TOKENS=2000000`
- `ONESHOT_RECONCILE_STALE_MINUTES=10`

### Queue env

- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`

### Role env

- `ONESHOT_ROLE=PLANNER|REVIEWER|IMPLEMENTER`

## 9. Terraform resource map

Recommended Terraform resources:

- 3 x `aws_sqs_queue`
- 3 x DLQ `aws_sqs_queue`
- 3 x `aws_sqs_queue_redrive_policy`
- 1 x `aws_ecs_task_definition` for OneShot consumers
- 3 x `aws_ecs_service` for PLANNER / REVIEWER / IMPLEMENTER
- updates to worker ECS map for QUALIFIER
- new IAM role policies or task roles
- Secrets Manager references for new secrets

If the repo keeps ECS task definitions split by service family, place:

- queue resources in `terraform/oneshot.tf`
- ECS resources in `terraform/oneshot-ecs.tf`
- IAM updates in `terraform/iam.tf`

## 10. Workflow model

Recommended workflow additions:

- `Build / OneShot / Queue Consumers`
  - build and push the shared OneShot image
  - optionally take a target role input for partial redeploys

Existing workflows already cover:

- Terraform plan/apply
- force new deployment

So OneShot should plug into the current governed deployment model, not create a parallel one.

## 11. Deployment order

### Safe rollout sequence

1. apply queue + IAM + secrets + ECS task definitions
2. deploy QUALIFIER support
3. deploy PLANNER
4. deploy REVIEWER
5. deploy IMPLEMENTER
6. enable PFOS routing in orchestrator
7. run one controlled PFOS test ticket

### Important gating rule

PFOS exclusivity in orchestrator should be enabled only after the required services are deployed and healthy.

## 12. Acceptance criteria

- all required queues and DLQs exist
- all required URLs are injected into the right services
- OpenAI secret is isolated to REVIEWER
- GitHub write token is isolated to IMPLEMENTER
- QUALIFIER uses the legacy worker runtime
- PLANNER / REVIEWER / IMPLEMENTER use the queue-consumer runtime
- OneShot can be deployed through the existing governed workflow model
