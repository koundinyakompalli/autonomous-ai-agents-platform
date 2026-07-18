# Terraform Deployment Notes

This directory contains the active AWS infrastructure definition for Specter.

## Quick start

```bash
bash ../.github/scripts/package-agent-registry-lambda.sh
terraform init
terraform plan
terraform apply
```

The packaging step builds `terraform/build/agent-registry-lambda.zip`, which is required by the Terraform Lambda resource.

Shared dev-account infrastructure inputs now live in `terraform/shared.auto.tfvars`
and are loaded automatically by Terraform and the GitHub Actions workflows.
Use `terraform/terraform.tfvars` only for local overrides that should not be committed.

## What this stack manages

- ECS cluster
- orchestrator service
- worker services for all current agent families plus additional workflow-managed agents
- optional OneShot queues and consumer services (`PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, `TESTER`)
- Harvey service and ALB
- ECR repositories
- shared S3 task and result buckets
- CloudWatch log groups
- IAM roles needed by the services
- agent-registry Lambda used by the governed onboarding workflows

## Worker catalog

Additional workflow-managed agents are stored in:

```text
terraform/additional-worker-agents.auto.tfvars.json
```

This file is part of the Terraform source of truth. The governed onboarding and activation workflows apply against an updated artifact copy, then open a pull request after successful apply so `main` can be brought back in sync with the applied catalog.

Existing built-in agents still come from hardcoded defaults in `terraform/main.tf`.

## What this stack expects to already exist

- VPC and subnets
- shared EFS
- database credentials secret
- shared JIRA token secret
- shared GitHub repository token secret named by `github_repo_token_secret_name`
- shared GitHub write token secret named by `github_write_token_secret_name` for dashboard workflow dispatch, and as a OneShot fallback only when GitHub App credentials are disabled
- shared GitHub App credential secret named by `github_app_credentials_secret_name` when OneShot is enabled
- OpenAI reviewer API key secret named by `openai_reviewer_api_key_secret_name` when a OneShot reviewer role uses the OpenAI provider
- existing task role with Bedrock permissions
- ACM certificate for Harvey HTTPS

The GitHub repository token secret should contain the raw token string. Worker
tasks inject it as `GITHUB_REPO_TOKEN` as a read fallback. `code_repositories`
should now be treated as repository metadata, not as the source of truth for
credentials.

The GitHub App credential secret should be a JSON object with `appId`,
`installationId`, and `privateKey`. OneShot uses it to mint short-lived
installation tokens for OneShot checkout/fetch operations, branch pushes, and
pull request mutations. When this secret is configured, all OneShot consumer
tasks and the QUALIFIER worker receive it; implementer, code reviewer, and
tester tasks do not receive `GITHUB_WRITE_TOKEN`. The PAT remains limited to
dashboard workflow dispatch. If `github_app_credentials_secret_name` is
intentionally blank, OneShot falls back to `GITHUB_REPO_TOKEN` for read
operations and `GITHUB_WRITE_TOKEN` for write operations.

## After apply

Use outputs to find:

- ECR repository URLs
- service names
- log group names
- Harvey bot endpoint
- agent-registry Lambda name

```bash
terraform output
```

## Image strategy

- build `Dockerfile.orchestrator` once
- build `Dockerfile.worker` once and tag it into each worker ECR repo
- build `Dockerfile.harvey` once
- build `Dockerfile.oneshot` once and tag it into `specter/oneshot` when OneShot is enabled

`QUALIFIER` stays on the standard worker image and is deployed through the
generic worker image path. `PLANNER`, `REVIEWER`, `IMPLEMENTER`,
`CODE_REVIEWER`, and `TESTER` share the dedicated OneShot image.

Current workspace/runtime note:

- Terraform now injects `ONESHOT_REPO_ADMIN_BASE=/mnt/efs/specter-repo/repo-admin`
- OneShot keeps shared repo caches under `ONESHOT_REPO_CACHE_BASE=/mnt/efs/specter-repo/oneshot/repos`
- OneShot creates per-run checked-out worktrees under `ONESHOT_WORKTREE_BASE=/var/oneshot/workspaces`
- Spec Factory owns a writable repo cache under `SPEC_FACTORY_REPO_CACHE_BASE=/mnt/efs/specter-repo/spec-factory/repo-cache`
- Spec Factory creates per-task checked-out worktrees under `SPEC_FACTORY_WORKTREE_BASE=/var/spec-factory/workspaces`
- new repo caches are bare mirrors named `<repo>.git`; older checked-out caches are left in place for cleanup compatibility
- OneShot ECS tasks now expose `/health` and `/ready` on port `8080`
- the stack can pin orchestrator, worker, and OneShot images by ECR digest instead of deploying mutable tags directly

## Governed agent onboarding

New worker families should not be added by editing Terraform directly against the shared account and applying ad hoc.

Use the manual GitHub Actions workflows instead:

- `.github/workflows/terraform-agent-onboard.yml`
- `.github/workflows/terraform-agent-activate.yml`
- `.github/workflows/agent-worker-build-push.yml`
- `.github/workflows/oneshot-build-push.yml`
- `.github/workflows/ecs-force-new-deployment.yml`
- `.github/workflows/terraform-sync-up.yml`
- `.github/workflows/terraform-oidc-smoke-test.yml`

GitHub workflow configuration also expects:

- repository secret `AWS_ROLE_ARN`
- repository variable `ECR_REGISTRY`
- repository variable `ARTIFACTORY_HOST`
- repository variable `MAVEN_USER`
- GitHub Environment `specter-terraform-apply`

For OneShot Maven support, create `specter/prod/oneshot-maven-password`
directly in AWS Secrets Manager in `us-east-2` as a raw-string password value
before running Terraform. Terraform references that AWS secret by name and
injects it into Maven-capable ECS tasks as `MAVEN_PASSWORD`.
`ARTIFACTORY_HOST` must be host-only, such as `dev.medhokapps.com`, because
repo-local `.m2/settings.xml` files build URLs as
`https://${env.ARTIFACTORY_HOST}/artifactory/...`.

Operating model:

- onboarding creates the ECR repo, log group, task definition, and ECS service with `desired_count = 0`
- onboarding registers the DB row as inactive through the agent-registry Lambda
- onboarding can also upsert a `code_repositories` row, including `default_branch`, when the new agent depends on a repo that is not already cataloged
- onboarding opens a PR to persist the catalog change after successful apply
- worker images for new agents can be pushed through the manual build workflow
- activation is a later approved workflow after the onboarding PR is merged, the image exists in ECR, and the worker module is present
- existing services can be rolled through the manual ECS force-deployment workflow without AWS console access
- general Terraform reconciliation against the tracked repo state can be run through the manual `Plan Or Apply` workflow
- `QUALIFIER` image updates can be pushed through the manual worker build workflow with:
  - `agent_key=qualifier`
  - `worker_type=QUALIFIER`
- `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER` image updates go through `oneshot-build-push.yml`
- OneShot Maven password storage lives directly in AWS Secrets Manager at `specter/prod/oneshot-maven-password`; `ARTIFACTORY_HOST` plus `MAVEN_USER` stay as GitHub variables

They also package the agent-registry Lambda automatically before `terraform plan` and `terraform apply`.

## Spec Factory application releases

The Spec Factory build workflow deploys application-only releases directly to
ECS after publishing all five commit-SHA images. It resolves the images to
immutable digests, clones each service's current task-definition configuration,
replaces only the Spec Factory and optional MarkItDown container images,
registers new revisions, updates the services, and waits for stabilization.
Terraform is therefore not required for each code release.

Terraform remains authoritative for infrastructure and task configuration. Run
a reviewed Terraform plan and apply whenever environment variables, IAM,
desired counts, autoscaling, networking, volumes, sidecars, secrets, or other
task/service settings change. The next image workflow preserves that applied
configuration when it creates an application release revision.

## OneShot enablement order

When you are ready to turn on OneShot:

1. create the Secrets Manager secrets referenced by:
   - `github_app_credentials_secret_name`
   - `github_write_token_secret_name` for dashboard workflow dispatch, and for OneShot only if GitHub App credentials are disabled
   - `openai_reviewer_api_key_secret_name` only when a reviewer role uses OpenAI
   - `specter/prod/oneshot-maven-password` as a raw-string password when OneShot Maven validation needs private Artifactory access
2. set `enable_oneshot = true` and the desired counts in Terraform
3. apply Terraform so queues, ECR, log groups, and ECS services exist
4. push the `QUALIFIER` image through `agent-worker-build-push.yml`
5. push the shared OneShot image through `oneshot-build-push.yml`
6. verify `/mnt/efs/specter-repo/repo-admin` exists and contains the required canonical clones, or intentionally rely on runtime first-use cloning into that path
7. verify ECS services and queue connectivity before using the `PFOS` label in Jira

Current checked-in shared tfvars:

- `oneshot_reviewer_enabled = false`
- `oneshot_code_reviewer_enabled = false`
- both reviewer bypass reasons are set to the temporary Zero Data Retention mitigation message
- `oneshot_otel_enabled = true`
- digest pinning enabled for worker and OneShot services; orchestrator uses the mutable `latest` tag so force-new-deployment pulls the newest image

## Database migration note

If the live database still contains GitLab URLs or inline repository tokens in
`code_repositories`, apply:

```text
db/migrations/002_migrate_code_repositories_to_github_and_secret_manager.sql
db/migrations/003_normalize_code_repositories_schema.sql
db/migrations/004_align_code_repositories_metadata.sql
```

Those migrations update the catalog to GitHub remotes, move repository auth
fully out of MySQL, and add explicit `default_branch` metadata so runtime branch
selection no longer depends only on hardcoded compatibility maps. Migration 004
is a safe metadata reconciliation pass for environments that were already
normalized but still have one or more stale repo URLs or default branches.

## Important caution

Current deployment docs assume explicit EFS path configuration. Do not rely on legacy defaults such as `/mnt/efs/repos`.
