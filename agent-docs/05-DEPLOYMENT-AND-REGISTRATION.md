# Deployment and Registration

This file explains how a new agent moves from code to live infrastructure, and how future sessions should think about Terraform changes in this repo.

## The end-to-end phases

Adding a new agent is not one step. It is four separate phases:

1. write the code
2. onboard the infrastructure
3. push the first worker image
4. activate the agent

Day-2 operations happen after that and use different workflows.

## Important terminology

### Onboarding

Onboarding means:

- create ECR repo
- create CloudWatch log group
- create ECS task definition
- create ECS service
- keep ECS desired count at `0`
- register the DB row as inactive

### Activation

Activation means:

- raise ECS desired count
- mark the DB row active
- allow the orchestrator to start assigning work

### Plan or apply

Plan or apply means:

- run Terraform against the current repo state
- produce a reviewed plan
- optionally apply the approved saved plan

It is the generic Terraform reconcile path, not the dedicated agent-onboarding path.

## Core source-of-truth files

- `terraform/main.tf`
- `terraform/variables.tf`
- `terraform/ecs.tf`
- `terraform/shared.auto.tfvars`
- `terraform/additional-worker-agents.auto.tfvars.json`
- `terraform/moved.tf`
- `terraform/agent-registry-lambda.tf`
- `terraform/lambda/agent_registry/index.py`
- `.github/workflows/terraform-agent-onboard.yml`
- `.github/workflows/terraform-agent-activate.yml`
- `.github/workflows/terraform-sync-up.yml`
- `.github/workflows/agent-worker-build-push.yml`
- `.github/workflows/ecs-force-new-deployment.yml`
- `.github/scripts/manage-worker-agent-catalog.py`
- `.github/scripts/resolve-worker-entry.py`

## Current workflow display names

The main manual workflows are:

- `Ops / Terraform / Agent Onboard`
- `Ops / Terraform / Agent Activate`
- `Ops / Terraform / Plan Or Apply`
- `Ops / Terraform / OIDC Smoke Test`
- `Ops / ECS / Force New Deployment`
- `Build / Worker / Manual Push`

These are the names future sessions should look for in the GitHub Actions UI.

## Step 0: live prerequisites

Before using the workflows in GitHub, these preconditions must be satisfied:

1. The implementation commit is pushed to the target branch.
2. `terraform/shared.auto.tfvars` exists on that branch.
3. GitHub repo secret `AWS_ROLE_ARN` points to the shared dev-account OIDC role:
   - `arn:aws:iam::323960442001:role/GitHub-OIDC`
4. The OIDC role has the AWS permissions required by the workflows, including:
   - ECS
   - ECR
   - Lambda
   - Terraform state S3/DynamoDB
   - Secrets Manager read
   - CloudWatch read/write as needed
   - `elasticfilesystem:DescribeFileSystems`
5. GitHub repo variable `ECR_REGISTRY` is configured as:
   - `323960442001.dkr.ecr.us-east-2.amazonaws.com`
6. GitHub Environment `specter-terraform-apply` exists.
7. `specter-terraform-apply` has required reviewers.
8. GitHub Environment `specter-aws-operations` exists.
9. `specter-aws-operations` has required reviewers.
10. Secrets Manager contains:
    - DB credentials secret
    - shared JIRA token secret
    - shared GitHub repository token secret
    - Harvey Teams secret if you run repo-wide Terraform that evaluates Harvey resources

Important rule:

- do not rely on a local `terraform/terraform.tfvars` for workflow success

The workflows are designed to run from committed source plus AWS/GitHub config, not from a developer laptop.

## How to write Terraform correctly for new agents

This is the most important section for future sessions.

### The normal case: no new Terraform resource block

For a standard new worker, do not start by adding new top-level resources.

The worker infrastructure is already modeled generically through:

- `local.default_worker_agents`
- `var.additional_worker_agents`
- `local.all_worker_agents`

That merged map already drives:

- worker log groups
- worker ECR repos
- worker task definitions
- worker ECS services

For a typical new agent, the correct path is:

1. add code
2. onboard through the workflow-managed catalog
3. push the first image
4. activate

### Built-in workers versus workflow-managed workers

Use the correct bucket:

- `local.default_worker_agents`
  - only for built-in workers that are part of the core fleet from source control
- `terraform/additional-worker-agents.auto.tfvars.json`
  - for new workflow-managed workers added through onboarding

Do not add a one-off new worker to `local.default_worker_agents` unless you are intentionally changing the built-in fleet.

### Current schema for workflow-managed workers

The current `additional_worker_agents` shape is:

```json
{
  "additional_worker_agents": {
    "my-agent": {
      "cpu": "512",
      "memory": "1024",
      "desired_count": 0
    }
  }
}
```

The onboarding and activation workflows, plus `manage-worker-agent-catalog.py`, currently understand exactly that shape.

### When Terraform really does need to change

Edit Terraform only if the new agent needs something structurally different, such as:

- new ECS environment variables
- extra secret injection
- extra IAM permissions
- extra network reachability
- new ALB/service infrastructure
- a richer per-worker schema than `cpu`, `memory`, and `desired_count`

When you do need a schema change, update all dependent surfaces together:

1. `terraform/variables.tf`
2. `terraform/main.tf`
3. `terraform/ecs.tf`
4. `.github/scripts/manage-worker-agent-catalog.py` if workflows must write the new field
5. relevant workflow inputs and summaries
6. docs

Do not fork the worker ECS resources into one-off copies unless the repo truly needs a new runtime model.

### Shared inputs versus secrets

Use:

- `terraform/shared.auto.tfvars`

for:

- shared account IDs
- VPC/EFS/subnet IDs
- secret names
- shared non-secret settings

Use Secrets Manager for secret values.

Do not put secret values in:

- `shared.auto.tfvars`
- `terraform.tfvars.example`
- workflow inputs

### Lambda packaging and hash behavior

The registration Lambda has two important implementation constraints:

1. Packaging still produces a zip under `terraform/build/agent-registry-lambda.zip`.
2. Terraform update detection is based on tracked source files under `terraform/lambda/agent_registry`, not on the generated zip bytes.

That hash path intentionally excludes:

- `__pycache__/`
- `*.pyc`

If you break that behavior, GitHub `plan-only` runs can show false-positive Lambda drift.

### State migration discipline

`terraform/moved.tf` is part of the live-state contract.

Do not remove or casually rewrite moved blocks unless you fully understand:

- current resource addresses in state
- target resource addresses
- the blast radius of destroy/recreate behavior

## Step 1: onboarding workflow

Workflow:

- `.github/workflows/terraform-agent-onboard.yml`

Inputs:

- `agent_key`
- `agent_name`
- `description`
- `task_type`
- `jql`
- `cpu`
- `memory`
- optional `model`
- optional `additional_context`
- optional `repository_name`
- optional `repository_url`
- optional `repository_description`
- optional `repository_default_branch`

What it does:

1. updates the tracked worker catalog artifact with `desired_count = 0`
2. packages the agent-registry Lambda
3. runs `terraform init`
4. runs `terraform plan`
5. uploads the saved plan artifact
6. pauses on the `specter-terraform-apply` environment
7. after approval, applies the reviewed plan artifact
8. invokes the Lambda with `upsert_agent`
9. if repository inputs were supplied, invokes the Lambda with `upsert_repository`
10. verifies the row with `get_agent`
11. if repository inputs were supplied, verifies the repository row with `get_repository`
12. opens a PR to persist `terraform/additional-worker-agents.auto.tfvars.json`

Why the PR exists:

- the workflow applies from an artifact copy first
- the PR is what brings `main` back into sync with the applied catalog

## Onboarding output expectations

After a successful onboarding run, these should be true:

- ECR repository exists
- ECS service exists
- ECS desired count is `0`
- `agents` row exists
- `agents.is_active = false`
- optional `code_repositories` row exists when repository inputs were provided
- catalog PR exists and must be merged

## Step 2: merge the onboarding PR

This is not optional.

If the onboarding PR is not merged:

- future Terraform runs from `main` will not contain the new worker in source control
- activation will fail because the catalog helper expects the key to already exist

The catalog helper intentionally errors with guidance to merge the onboarding PR first.

## Step 3: push the first image

Workflow:

- `.github/workflows/agent-worker-build-push.yml`

Inputs:

- `agent_key`
- `worker_type`

Recommended values:

- `agent_key = my-agent`
- `worker_type = MY-AGENT`

What it does:

1. validates the worker file can be resolved with `resolve-worker-entry.py`
2. runs `npm ci`
3. runs `npm run build`
4. assumes AWS role through OIDC
5. checks the ECR repository exists
6. builds `Dockerfile.worker`
7. tags and pushes:
   - `sha`
   - `latest`

Important limitation:

- this workflow only pushes the image
- it does not force an ECS rollout for already running services

For a newly onboarded agent at desired count `0`, that is fine. Activation will start the first task after the image exists.

## Step 4: activation workflow

Workflow:

- `.github/workflows/terraform-agent-activate.yml`

Inputs:

- `agent_key`
- `agent_name`
- `desired_count`

What it does:

1. updates the catalog artifact with the new desired count
2. validates worker module resolution with `resolve-worker-entry.py`
3. checks the worker ECR repository contains at least one image
4. packages the registration Lambda
5. runs `terraform plan`
6. pauses for approval
7. applies the saved plan artifact
8. invokes the Lambda with `set_agent_active`
9. verifies the row using `get_agent`
10. opens a PR to persist the desired-count change back to `main`

## Activation output expectations

After successful activation:

- ECS desired count is above zero
- the DB row is active
- the service can begin processing work
- an activation PR exists and should be merged

## Step 5: later operational workflows

These are not part of first-time onboarding, but they matter for day-2 operations.

### Targeted ECS rollout

Workflow:

- `.github/workflows/ecs-force-new-deployment.yml`

Use it when:

- a worker or shared service already exists
- a new `latest` image has been pushed
- you need ECS to start new tasks without changing Terraform
- the developer triggering the action does not have direct AWS access

Inputs:

- `service_name`
- `reason`
- `wait_for_stable`

Service naming rules:

- worker services are the uppercase form of `agent_key`
- `my-agent` becomes `MY-AGENT`
- shared services are `ORCHESTRATOR`, `HARVEY`, and `DASHBOARD`

### Terraform plan or apply

Workflow:

- `.github/workflows/terraform-sync-up.yml`

Displayed in GitHub Actions as:

- `Ops / Terraform / Plan Or Apply`

Use it when:

- Terraform code changed in the repo
- you want a reviewed plan against the current source of truth
- the operator does not have local AWS credentials

Modes:

- `plan-only`
- `apply-approved-plan`

This is the generic reconcile path outside the dedicated onboarding and activation workflows.

## Registration Lambda behavior

The registration Lambda is intentionally small and idempotent.

Supported operations:

- `upsert_agent`
- `get_agent`
- `set_agent_active`
- `upsert_repository`
- `get_repository`

What it writes:

- `name`
- `description`
- `additional_context`
- `model`
- `task_type`
- `jql`
- `jira_token`
- `jira_username`
- `is_active`
- optional repository metadata in `code_repositories`
- repository default branch metadata when a repository row is upserted

Where credentials come from:

- DB credentials from the DB secret
- JIRA token from `jira_token_secret_name`
- JIRA username from Terraform variable `jira_username`
- worker GitHub clone auth from the shared `GITHUB_REPO_TOKEN` secret injected into ECS

Important operational detail:

- Lambda code changes should now be detected from tracked source files, not generated zip bytes

## Reading plans correctly

When reviewing Terraform plans for new-agent work, use these expectations:

### Normal onboarding plan

Expected:

- new worker ECR repo
- new worker log group
- new worker task definition
- new worker ECS service

Not expected:

- DB writes during plan
- activation of the agent

### Normal activation plan

Expected:

- desired-count change for the worker ECS service

Not expected:

- creation of brand-new worker infrastructure if onboarding already succeeded

### Suspicious plan pattern: only `aws_lambda_function.agent_registry`

If the only change is the registration Lambda:

- verify the branch still contains the stable Lambda source-hash logic in `terraform/main.tf`
- verify generated `__pycache__/` and `*.pyc` files are excluded

That symptom usually means hash drift, not a meaningful agent-infra change.

## Local Terraform path

If you need to run Terraform locally:

```bash
bash .github/scripts/package-agent-registry-lambda.sh
cd terraform
terraform init -backend-config=backend.hcl
terraform plan
```

Packaging the Lambda zip first is required because the Terraform Lambda resource references the archive path.

## Rollback guidance

### If onboarding plan is wrong

- do not approve apply
- fix code or catalog inputs
- rerun onboarding

### If onboarding apply succeeds but registration fails

- rerun onboarding
- inspect Lambda logs
- verify VPC, SG, RDS, and secret access

### If the image push fails

- fix code, Docker, or AWS auth
- rerun `agent-worker-build-push.yml`

### If activation fails before apply

- resolve worker file naming mismatch or ECR image absence
- rerun activation

### If activation apply succeeds but DB activation fails

- rerun activation
- inspect Lambda logs and read-back verification

## Live setup tasks still easy to forget

Even after the code is correct, the platform will not be ready until:

1. the code is pushed
2. the environment gates exist
3. reviewers are configured
4. OIDC trust is verified live
5. `ECR_REGISTRY` is configured correctly
6. old static AWS secrets are removed once no workflows depend on them
