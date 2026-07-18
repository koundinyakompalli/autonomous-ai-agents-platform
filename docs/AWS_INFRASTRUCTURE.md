# AWS Infrastructure

Specter's AWS deployment is centered on ECS Fargate, ECR, S3, CloudWatch, and an existing shared EFS and RDS environment.

## Main components

### ECS

Terraform provisions:

- one ECS cluster
- one orchestrator service
- worker services for DARCI, SCRIBE, PRISM, HERMES, SENTRY, BEACON, BCAT-PLANNER, BCAT-EXECUTOR, VERITAS
- optional OneShot consumer services for `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, `TESTER`
- one Harvey service

### ECR

Terraform creates:

- `specter/orchestrator`
- `specter/<worker>-worker` for each worker family
- `specter/oneshot` when OneShot is enabled
- `specter/harvey`

### SQS

OneShot uses FIFO queues for inter-stage messaging. Each stage has its own queue.

#### SQS Dead-Letter Queues

Each OneShot FIFO queue has a corresponding DLQ with `maxReceiveCount=3` and 14-day retention. When a consumer fails to process a message 3 times, it is moved to the DLQ instead of blocking the message group.

DLQ naming: `{environment}-oneshot-{stage}-dlq.fifo`

CloudWatch alarms (`{environment}-oneshot-{stage}-dlq-depth`) fire when any message lands in a DLQ. Terraform also creates queue-age and queue-depth alarms for the primary OneShot FIFO queues, and by default wires alarm actions to an SNS topic unless an explicit `oneshot_alarm_topic_arn` is provided.

**Operator action when a DLQ alarm fires:**

1. Inspect the message: `aws sqs receive-message --queue-url {dlq-url} --max-number-of-messages 1`
2. Check the corresponding `oneshot_runs` row for `last_error`
3. Fix the issue, then use the reconciliation endpoint to re-queue

### S3

Current bucket model:

- task bucket: `<prefix>-tasks`
- result bucket: `<prefix>-results`

### Shared infrastructure

Terraform expects to reuse existing:

- VPC
- subnets
- EFS file system
- RDS instance / credentials secret
- task IAM role with Bedrock access

## Container images

Current Dockerfiles:

- `Dockerfile.orchestrator`
- `Dockerfile.worker`
- `Dockerfile.harvey`

`Dockerfile.worker` is shared across worker families and relies on `WORKER_TYPE` at runtime.

## Service-specific notes

### Orchestrator

- mounts the shared EFS volume
- exposes `/health`
- needs JIRA, DB, S3, and Bedrock access

### Workers

- mount the shared EFS volume
- use the shared task and result buckets
- should ideally run through `worker-main.js` for status API support
- `QUALIFIER` now also performs OneShot startup validation from `worker-main.ts`

### OneShot consumers

- mount the shared EFS volume
- use EFS for shared bare-mirror repo caches and Fargate local storage for per-run worktrees under `/var/oneshot/workspaces/<run-id>`
- expose `/health` and `/ready` on `STATUS_PORT` (default `8080`)
- validate DB schema, S3, SQS, repo-admin/workspace paths, prompts, and provider env at startup
- extend SQS visibility while long-running stage handlers are active

### Harvey

- runs behind an ALB
- exposes `/api/messages` and `/health`
- needs Teams bot secrets plus DB, S3, and Bedrock access

### Database — OneShot tables

- `oneshot_runs` — State machine, version pointers, loop counts, token budget, **stage attempt counters**
- `oneshot_artifacts` — S3 pointers for each stage's output, with `metadata_json` containing **per-stage cost/duration metrics**
- `oneshot_notifications` — Jira comment queue (including `progress_update` type)
- `oneshot_run_events` — Audit trail for all state transitions and claims (migration 012)

## Secret handling

Preferred production pattern:

- inject DB credentials from Secrets Manager
- inject JIRA token from Secrets Manager
- inject Teams bot credentials from Secrets Manager

Do not use the credential examples embedded in historical schema seeds as production guidance.
