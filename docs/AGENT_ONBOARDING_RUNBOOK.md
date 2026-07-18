# Agent Onboarding Runbook

This runbook covers the governed workflow for adding a new Specter worker family.

## Why this flow exists

Adding a new agent touches:

- Terraform-managed ECR, log group, task definition, and ECS service resources
- the `agents` table used by the orchestrator and workers
- the shared worker runtime and Docker image pipeline

The onboarding flow keeps those changes reviewable and gated:

- plan is manual
- apply is manual
- admin approval is required before apply
- new agents start inactive

## Workflows

- `.github/workflows/terraform-agent-onboard.yml`
- `.github/workflows/terraform-agent-activate.yml`
- `.github/workflows/agent-worker-build-push.yml`
- `.github/workflows/ecs-force-new-deployment.yml`
- `.github/workflows/terraform-sync-up.yml`
- `.github/workflows/terraform-oidc-smoke-test.yml`

All four workflows are `workflow_dispatch` only.

## Source of truth

Additional workflow-managed workers are persisted in:

```text
terraform/additional-worker-agents.auto.tfvars.json
```

The workflows apply against an updated artifact copy, then open a pull request after successful apply so the tracked file can be merged back to `main`.

## Prerequisites

Before onboarding:

- worker code exists in `src/`
- the worker module exists under `src/orchestrator/workers`
- the worker image will be pushed through `.github/workflows/agent-worker-build-push.yml` or an equivalent approved path
- repository secret `AWS_ROLE_ARN` exists
- repository variable `ECR_REGISTRY` exists
- the shared JIRA token secret, DB secret, and shared GitHub repository token secret already exist in AWS
- the protected GitHub Environment `specter-terraform-apply` is configured with required reviewers
- the protected GitHub Environment `specter-aws-operations` is configured with required reviewers

If the agent needs a repository that is not already present in `code_repositories`:

- decide the `repo_name` you want in the catalog
- have the GitHub clone URL ready
- know the repository default branch (`main`, `master`, or another branch name)
- supply those optional onboarding inputs so the workflow can upsert the metadata row

Before activation:

- at least one image exists in `specter/<agent-key>-worker`
- a matching worker module resolves from the requested `WORKER_TYPE`
- the onboarding catalog PR has already been merged to `main`

## Onboarding flow

Run `terraform-agent-onboard.yml` with:

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

What happens:

1. The workflow updates `terraform/additional-worker-agents.auto.tfvars.json` with `desired_count = 0`.
2. Terraform plan runs against that exact catalog state.
3. The workflow pauses on the protected environment.
4. After approval, Terraform applies the saved plan.
5. The workflow invokes the `agent-registry` Lambda to upsert the `agents` row with `is_active = false`.
6. If repository inputs were supplied, the workflow also upserts the matching `code_repositories` row.
7. The workflow verifies the agent row exists and remains inactive.
8. If repository inputs were supplied, the workflow verifies the repository row.
9. The workflow opens a pull request that persists the worker catalog change back to `main`.

Result:

- infra exists
- the agent is visible in the database
- optional repository metadata row exists in `code_repositories`
- no ECS tasks are started yet
- the orchestrator cannot assign work to it yet
- a catalog PR must be merged before activation or future Terraform runs from `main`

## Activation flow

Run `terraform-agent-activate.yml` with:

- `agent_key`
- `agent_name`
- `desired_count`

What happens:

1. The workflow updates the tracked worker catalog to the new desired count.
2. It verifies the worker module resolves in the current repo.
3. It verifies the worker ECR repository contains at least one image.
4. Terraform plan runs and pauses for approval.
5. After approval, Terraform applies the saved plan.
6. The workflow invokes the `agent-registry` Lambda to mark the DB row active.
7. The workflow verifies the row is now active.
8. The workflow opens a pull request that persists the updated desired count back to `main`.

## Rollback

If onboarding apply fails:

- fix the Terraform issue
- rerun the onboarding workflow with the same inputs

If onboarding apply succeeds but DB registration fails:

- rerun the onboarding workflow
- confirm the Lambda can read DB and JIRA secrets
- verify the `agent-registry` Lambda networking path to RDS

If repository registration fails:

- rerun the onboarding workflow with the same repository inputs
- verify the supplied URL is a GitHub HTTPS clone URL ending in `.git`
- verify the Lambda can still reach the Specter database

If activation fails the image check:

- push at least one image to `specter/<agent-key>-worker` through `.github/workflows/agent-worker-build-push.yml`
- rerun activation

If activation fails the runtime check:

- add or fix the worker module under `src/orchestrator/workers`
- rerun activation

If activation apply succeeds but DB activation fails:

- rerun activation
- verify the row exists through the Lambda `get_agent` path

## Operational notes

- keep onboarding and activation as separate approvals
- do not hand-edit `terraform/additional-worker-agents.auto.tfvars.json` in production unless you intend to change Terraform source of truth directly
- do not mark a new agent active before its runtime and image are ready
- `code_repositories` should now contain repository metadata only; worker clone auth comes from the shared `GITHUB_REPO_TOKEN` secret
- `code_repositories.default_branch` is the source of truth for repo base-branch behavior during onboarding and runtime
- merge the onboarding PR before running activation
- merge the activation PR after the service is successfully active so `main` stays aligned with live Terraform state
- use `ecs-force-new-deployment.yml` when a running service needs to pick up a freshly-pushed `latest` image and the operator does not have AWS access
- use `terraform-sync-up.yml` (`Ops / Terraform / Plan Or Apply`) for general repo-state Terraform reconciliation outside the dedicated onboarding and activation flows
