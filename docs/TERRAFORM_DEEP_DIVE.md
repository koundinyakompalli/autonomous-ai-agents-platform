# Terraform Deep Dive

The Terraform configuration in `terraform/` is the current infrastructure source of truth for AWS deployment.

## Files

| File | Purpose |
| --- | --- |
| `main.tf` | provider, caller identity, shared locals/data |
| `iam.tf` | execution role, Harvey task role, secret access |
| `s3.tf` | shared task and result buckets |
| `ecs.tf` | cluster, log groups, ECR, orchestrator, worker task definitions and services |
| `harvey-ecs.tf` | Harvey ECR, task definition, ALB, target group, service, security groups |
| `variables.tf` | deployment inputs and desired counts |
| `outputs.tf` | ECR URLs, service names, log groups, ALB DNS, helper commands |

## Current resource model

Terraform creates:

- one ECS cluster
- one orchestrator service
- nine worker services
- one Harvey service
- ECR repositories for orchestrator, each worker family, and Harvey
- two S3 buckets
- CloudWatch log groups
- ALB and target group for Harvey

It reuses:

- existing VPC and subnets
- existing EFS
- existing DB credentials secret
- existing task role with Bedrock access

## Important variables

### Shared

- `aws_region`
- `environment`
- `subnet_ids`
- `existing_efs_id`
- `db_host`
- `db_name`

### Worker counts and sizing

- `darci_desired_count`
- `scribe_desired_count`
- `prism_desired_count`
- `hermes_desired_count`
- `sentry_desired_count`
- `beacon_desired_count`
- `bcat_planner_desired_count`
- `bcat_executor_desired_count`
- `veritas_desired_count`

### Harvey

- `harvey_desired_count`
- `harvey_teams_secret_name`
- `harvey_certificate_arn`
- `harvey_alb_subnet_ids`

### Buckets

- `s3_task_bucket`
- `s3_result_bucket`

## How worker images are modeled

Terraform creates one ECR repo per worker family even though all workers are built from the shared `Dockerfile.worker`. In practice:

- build one worker image locally
- tag it into each worker ECR repo you need
- let task definitions differentiate behavior through `WORKER_TYPE`

## Harvey specifics

Harvey is different from the background workers:

- always-on HTTP service
- public HTTPS endpoint through an ALB
- Bot Framework callback path at `/api/messages`

## Operational advice

- set `REPOSITORY_PATH` and EFS-related env explicitly
- treat Terraform outputs as the authoritative place to fetch ECR URLs and service names
- do not rely on older docs that describe only four worker services or per-agent S3 buckets
