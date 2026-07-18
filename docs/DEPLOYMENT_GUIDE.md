# Deployment Guide

This guide reflects the current Docker and Terraform layout in the repo.

For new worker families, the preferred deployment path is now the governed GitHub Actions onboarding flow, not ad hoc Terraform applies from a local shell.

## What gets deployed

- orchestrator service
- worker services for all current agent families
- optional OneShot services (`PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, `TESTER`)
- Harvey behind an ALB
- shared S3 task/result buckets
- ECR repositories for orchestrator, each worker family, Harvey, and optional OneShot services

## Prerequisites

- Docker available locally
- Terraform available locally
- AWS credentials for the target account
- required Secrets Manager secrets already created
- an ACM certificate ARN for Harvey HTTPS

## 1. Build the application

```bash
npm install
npm run build
```

## 2. Build container images

```bash
docker build -f Dockerfile.orchestrator -t specter/orchestrator:latest .
docker build -f Dockerfile.worker -t specter/worker:latest .
docker build -f Dockerfile.harvey -t specter/harvey:latest .
docker build -f Dockerfile.oneshot -t specter/oneshot:latest .
```

The worker image is shared. Terraform still creates a separate ECR repository per worker family, so the same built image is tagged into multiple repos.
The OneShot image is shared by `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER`. `QUALIFIER` stays on the standard worker image.

Current prod-oriented rollout note:

- Terraform can resolve the configured image tag to an immutable ECR digest for orchestrator, worker, and OneShot services
- the checked-in shared tfvars enable digest pinning, so `terraform plan/apply` captures the exact pushed image revision

## 3. Initialize and apply Terraform

```bash
bash .github/scripts/package-agent-registry-lambda.sh
cd terraform
terraform init
terraform plan
terraform apply
```

Important:

- `harvey_certificate_arn` must be set
- the deployment expects Secrets Manager entries for DB credentials, JIRA token, the shared GitHub repository token, and Harvey Teams credentials
- when OneShot is enabled, it also expects Secrets Manager entries for the GitHub write token and OpenAI reviewer API key
- the stack now also creates an `agent-registry` Lambda used by the governed onboarding workflows
- local Terraform runs now require the Lambda package step shown above
- shared dev-account Terraform values come from `terraform/shared.auto.tfvars`
- `terraform/terraform.tfvars` is now only for local overrides that should not be committed
- current task definitions inject `ONESHOT_REPO_ADMIN_BASE=/mnt/efs/specter-repo/repo-admin` for OneShot repo hydration and worktree creation
- OneShot ECS services now expose `/health` and `/ready` on port `8080` and use ECS deployment circuit breakers
- OneShot Terraform also creates queue-age and queue-depth alarms in addition to DLQ alarms

## 3a. Governed agent onboarding

Use the manual workflows for new worker families:

- `.github/workflows/terraform-agent-onboard.yml`
- `.github/workflows/terraform-agent-activate.yml`
- `.github/workflows/agent-worker-build-push.yml`
- `.github/workflows/oneshot-build-push.yml`
- `.github/workflows/ecs-force-new-deployment.yml`
- `.github/workflows/terraform-sync-up.yml`
- `.github/workflows/terraform-oidc-smoke-test.yml`

GitHub-side prerequisites for the workflow path:

- repository secret `AWS_ROLE_ARN`
- repository variable `ECR_REGISTRY`
- repository variable `ARTIFACTORY_HOST`
- repository variable `MAVEN_USER`
- protected environment `specter-terraform-apply`

For OneShot Maven support, create `specter/prod/oneshot-maven-password`
directly in AWS Secrets Manager in `us-east-2` as a raw-string password value
before running Terraform. Terraform references that AWS secret by name and
injects it into Maven-capable ECS tasks as `MAVEN_PASSWORD`.
`ARTIFACTORY_HOST` must be host-only, such as `dev.medhokapps.com`, because
repo-local `.m2/settings.xml` files build URLs as
`https://${env.ARTIFACTORY_HOST}/artifactory/...`.

Expected control flow:

1. Run the onboarding workflow manually with the new agent metadata.
   - if the agent depends on a repo that is not already in `code_repositories`, also supply `repository_name`, `repository_url`, optional `repository_description`, and the correct `repository_default_branch`
2. Review the Terraform plan generated in that workflow.
3. Wait for admin approval on the protected `specter-terraform-apply` environment.
4. Let the workflow apply the saved plan, register the agent in MySQL as inactive, optionally upsert the repository catalog row, and open a catalog PR.
5. Merge the onboarding catalog PR.
6. Push the first worker image through `agent-worker-build-push.yml` and confirm the worker module exists.
7. Run the activation workflow to scale the ECS service above zero, flip the DB row to active, and open an activation catalog PR.
8. Merge the activation catalog PR.

Important safeguards:

- onboarding defaults new agents to `desired_count = 0`
- onboarding writes `is_active = false` in the `agents` table
- worker clone auth now comes from the shared `GITHUB_REPO_TOKEN` secret rather than `code_repositories.token`
- `code_repositories.default_branch` now drives base-branch behavior for repo setup and git analysis prompts
- activation verifies both worker-module resolution and at least one ECR image before apply
- both workflows are manual-only and stop on an approval gate before apply
- `ecs-force-new-deployment.yml` gives developers a controlled way to roll a specific ECS service without direct AWS access
- `terraform-sync-up.yml` gives developers a controlled way to run a repo-wide Terraform plan/apply flow without direct AWS access
- `oneshot-build-push.yml` builds and rolls the shared OneShot image for `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER`
- OneShot Maven password storage lives directly in AWS Secrets Manager at `specter/prod/oneshot-maven-password`; use targeted Terraform with `aws_iam_role_policy.ecs_execution_secrets`, `aws_ecs_task_definition.oneshot`, and `aws_ecs_service.oneshot` so OneShot tasks pick up the runtime Maven env wiring

Source of truth for workflow-managed agents:

```text
terraform/additional-worker-agents.auto.tfvars.json
```

If the live DB still carries GitLab URLs or inline repo credentials, apply:

```text
db/migrations/002_migrate_code_repositories_to_github_and_secret_manager.sql
db/migrations/003_normalize_code_repositories_schema.sql
db/migrations/004_align_code_repositories_metadata.sql
```

### Migration 012 — OneShot Run Events and Attempt Counters

Run before deploying the updated OneShot container images:

```sql
ALTER TABLE oneshot_runs
  ADD COLUMN planning_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN implementation_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN code_review_attempt_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS oneshot_run_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  oneshot_run_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  from_state VARCHAR(64) DEFAULT NULL,
  to_state VARCHAR(64) DEFAULT NULL,
  stage VARCHAR(64) DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_run_events_run_id (oneshot_run_id),
  INDEX idx_run_events_occurred_at (occurred_at),
  CONSTRAINT fk_run_events_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Safe to run on a live DB: `ALTER TABLE` adds `NOT NULL DEFAULT 0` columns (instant in MySQL 8), `CREATE TABLE IF NOT EXISTS` is idempotent.

## 3b. OneShot environment variables

The following variables apply to OneShot services. Set them in Secrets Manager or task definition environment blocks as appropriate.

| Variable | Default | Description |
|---|---|---|
| `ONESHOT_MAX_STAGE_ATTEMPTS` | `5` | Max per-stage attempts before circuit-breaking |
| `ONESHOT_PROMPT_SOURCE` | `local` | Prompt source (`local` or `s3`) |
| `STATUS_PORT` | `8080` | OneShot health/readiness HTTP port |

## 4. Push images to ECR

Get repository URLs from Terraform outputs:

```bash
terraform output
```

Then log in to ECR and push:

```bash
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "<account>.dkr.ecr.$AWS_REGION.amazonaws.com"
```

Tag and push orchestrator:

```bash
docker tag specter/orchestrator:latest <orchestrator-ecr-url>:latest
docker push <orchestrator-ecr-url>:latest
```

Tag and push the shared worker image to each worker repo you use:

```bash
docker tag specter/worker:latest <darci-ecr-url>:latest
docker push <darci-ecr-url>:latest
```

Repeat for `scribe`, `prism`, `hermes`, `sentry`, `beacon`, `bcat-planner`, `bcat-executor`, and `veritas`.

Tag and push the shared OneShot image if OneShot is enabled:

```bash
docker tag specter/oneshot:latest <oneshot-ecr-url>:latest
docker push <oneshot-ecr-url>:latest
```

Tag and push Harvey:

```bash
docker tag specter/harvey:latest <harvey-ecr-url>:latest
docker push <harvey-ecr-url>:latest
```

## 5. Roll services

Preferred operator path for developers without AWS access:

- run `.github/workflows/ecs-force-new-deployment.yml`
- provide `service_name`
- provide a short `reason`
- wait for approval on `specter-aws-operations`

Service naming rules:

- worker services are uppercase versions of `agent_key`
- examples:
  - `darci` -> `DARCI`
  - `bcat-planner` -> `BCAT-PLANNER`
  - `my-agent` -> `MY-AGENT`
- non-worker services are:
  - `ORCHESTRATOR`
  - `HARVEY`
  - `DASHBOARD`
  - `PLANNER`
  - `REVIEWER`
  - `IMPLEMENTER`

Direct AWS CLI equivalent:

```bash
aws ecs update-service --cluster specter-cluster --service ORCHESTRATOR --force-new-deployment --region "$AWS_REGION"
```

Repeat for the relevant worker services and Harvey, or use the operator workflow instead.

If OneShot is enabled:

- deploy `QUALIFIER` through the worker image path
- deploy `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER` through `oneshot-build-push.yml`
- or force-roll the ECS services `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER` through `ecs-force-new-deployment.yml`

## 5a. Terraform plan or apply

Preferred operator path for developers without AWS access:

- run `.github/workflows/terraform-sync-up.yml` (`Ops / Terraform / Plan Or Apply`)
- use `plan-only` to review pending changes
- use `apply-approved-plan` only when you want the reviewed plan applied after approval on `specter-terraform-apply`

This workflow:

- packages the agent-registry Lambda
- runs `terraform init`
- runs `terraform plan`
- uploads a human-readable plan artifact
- optionally applies the saved plan artifact after approval

Use it for general Terraform reconciliation when the repo state changed and a developer needs an auditable plan/apply path without local AWS credentials.

## 6. Verify

Check logs:

```bash
aws logs tail /ecs/specter/orchestrator --follow --region "$AWS_REGION"
aws logs tail /ecs/specter/darci-worker --follow --region "$AWS_REGION"
aws logs tail /ecs/specter/harvey --follow --region "$AWS_REGION"
```

Check service health:

- orchestrator `/health`
- Harvey `/health`
- worker `/health` and `/status` if started through `worker-main`
- OneShot `/health` and `/ready`

## 6a. Verify OneShot enhancements

After deploying the updated OneShot images and running migration 012:

- **Prompt caching**: check logs for `cacheReadTokens > 0` in `[SDK_COMPLETE]` log lines. If all values are 0, verify that the model supports prompt caching and the system prompt exceeds the minimum cacheable length.
- **DLQ alarms**: confirm CloudWatch alarms exist:
  ```bash
  aws cloudwatch describe-alarms --alarm-name-prefix oneshot-*-dlq --region "$AWS_REGION"
  ```
- **Queue backlog alarms**: confirm primary queue age/depth alarms exist:
  ```bash
  aws cloudwatch describe-alarms --alarm-name-prefix "${ENVIRONMENT}-oneshot-" --region "$AWS_REGION"
  ```
- **New columns**: verify the `ALTER TABLE` applied:
  ```sql
  DESCRIBE oneshot_runs;
  -- should include planning_attempt_count, implementation_attempt_count, code_review_attempt_count
  ```
- **Events table**: verify the table exists and is empty:
  ```sql
  SELECT COUNT(*) FROM oneshot_run_events;
  -- should return 0 initially
  ```
- **Startup validation**: confirm each OneShot service logs `OneShot consumer runtime validation completed` during boot, and `QUALIFIER` logs `Qualifier runtime validation completed`
- **Success-path normalization**: after a healthy run, confirm the run reaches `completed` after the draft PR is created rather than staying indefinitely in `pr_open`

## Deployment cautions

- do not rely on legacy path defaults like `/mnt/efs/repos`; set `REPOSITORY_PATH` explicitly
- ensure the worker task definitions point to the current EFS path layout
- ensure `/mnt/efs/specter-repo/repo-admin` exists and contains canonical repo roots for the repos OneShot will touch
- ensure all required worker ECR repos receive an image tag before forcing deployment
- do not activate a newly onboarded agent until its image exists in ECR, the worker module exists, and the onboarding catalog PR is merged
- do not enable `PFOS` traffic until `QUALIFIER`, `PLANNER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER` are all deployed and their queues exist
- if you expect the full review path, also verify `ONESHOT_REVIEWER_ENABLED=true` and `ONESHOT_CODE_REVIEWER_ENABLED=true`
