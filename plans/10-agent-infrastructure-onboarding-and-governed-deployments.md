# Plan 10: Agent Infrastructure Onboarding and Governed Deployments

## Problem

Adding a new Specter agent is still too manual.

Today the platform has:

- per-agent CI/CD workflows for image build and deploy
- a Terraform root that is partly hardcoded by agent name
- a database `agents` table that can drift from deployed ECS services

What it does not have is a governed onboarding path where a user can submit a new agent configuration, review the infrastructure plan, wait for admin approval, and then apply the change with database registration included.

## Why this matters

New agent onboarding is one of the highest-risk operational changes in the system because it crosses multiple boundaries at once:

- ECR repository creation
- CloudWatch log group creation
- ECS task definition and service creation
- worker runtime configuration
- database registration used by orchestrator and Harvey

Without a single controlled path, every new agent addition risks configuration drift, missed registration, or ad hoc deployment steps that are difficult to audit.

## Goals

- make Terraform workflows manual-only
- require a human review point before any apply
- make admin approval mandatory before apply
- allow a new agent to be added without hand-editing Terraform resources for that agent
- include database registration in the approved deployment path
- keep the Terraform plan side-effect free and reviewable
- keep the Terraform refactor state-safe for existing workers
- ensure first-time agent onboarding does not start broken or unready services

## Non-goals

- generating new agent code automatically
- replacing per-agent image build workflows in phase 1
- allowing workers to self-register at runtime
- auto-applying Terraform on `push`

## Proposed target state

The target operating model is:

1. A developer implements the agent code and whatever image-build path is required.
2. A user manually runs a Terraform plan workflow with the new agent metadata.
3. The workflow renders an ephemeral Terraform variable file for that agent and produces a reviewable plan.
4. A separate manual apply workflow, or an apply stage within the same manual workflow, pauses on a protected GitHub Environment.
5. An admin approves the apply stage.
6. Terraform provisions the new agent infrastructure with `desired_count = 0` by default for first-time onboarding.
7. The workflow invokes a dedicated agent-registration Lambda to upsert the `agents` table entry with `is_active = false`.
8. The workflow verifies the registration result and publishes a summary with the service name, log group, ECR repo, and registration response.
9. A later approved activation run scales the ECS service above zero and flips the DB row to `is_active = true` once the image and runtime wiring are ready.

## Recommended design decisions

### 1. Make the Terraform migration state-safe before changing resource shapes

The current Terraform root already manages live worker infrastructure. Refactoring individually named resources into a unified worker map will otherwise appear to Terraform as destroy-and-recreate operations.

The refactor must therefore include:

- declarative `moved` blocks for all existing worker resources that change address
- replacement of one-off conditional chains, especially the worker log-group mapping in `ecs.tf`
- a validation step where `terraform plan` shows no resource changes for the existing fleet before any new-agent functionality is introduced

Imperative `terraform state mv` commands are not the preferred path here. The migration should live in versioned HCL.

### 2. Refactor Terraform to a data-driven worker map

The current Terraform root cannot support workflow-driven onboarding cleanly because worker resources are still enumerated by name in multiple places.

The first change should be:

- keep the existing agents as `local.default_worker_agents`
- introduce `var.additional_worker_agents`
- drive ECR repositories, log groups, task definitions, ECS services, and outputs from one merged map

That gives the workflow one safe extension point without requiring a Terraform edit every time a new agent is introduced.

### 3. Keep plan side-effect free

Do not perform DB registration during `terraform plan`.

That means:

- do not use Lambda invocation inside plan-producing steps for writes
- do not make plan implicitly mutate the database
- do database registration only after the approved apply completes

This is the main difference between a reviewable plan and an operational side effect disguised as planning.

### 4. Use GitHub Environment protection as the control gate

The cleanest control gate is a protected GitHub Environment such as `specter-terraform-apply`.

That environment should require admin reviewers before the apply job can continue.

This gives:

- an explicit pause after plan
- an approval event in GitHub audit history
- a clear separation between planning and deployment authority

### 5. Use Lambda for database registration

The database registration path should follow the enterprise platform pattern in spirit, but tailored to Specter’s simpler schema.

Recommended behavior:

- deploy a small `agent-registry` Lambda in the Specter VPC
- invoke it after approved apply
- support idempotent `upsert_agent` and `get_agent` operations
- write the columns Specter actually uses: `name`, `description`, `additional_context`, `model`, `task_type`, `jql`, `is_active`
- read shared JIRA service credentials from Secrets Manager so new rows can be populated without exposing tokens in workflow inputs
- fail the pipeline if the upsert succeeds syntactically but the verification read-back does not match the expected row

This keeps database writes inside AWS instead of attempting direct DB access from GitHub runners.

### 6. Separate onboarding from activation

Creating infrastructure for a new agent is not the same thing as safely activating it.

The onboarding workflow should default new agents to:

- `desired_count = 0` in ECS
- `is_active = false` in the `agents` table

That avoids two failure modes:

- ECS crash loops from empty ECR repositories or missing runtime wiring
- orchestrator assignment to an agent that exists in the database but is not actually runnable

Activation should be a later approved change after:

- the initial image exists in ECR
- the runtime entrypoint supports the agent
- the team is ready to accept traffic for the agent

### 7. Treat runtime code onboarding and infra onboarding as separate concerns

Even after the Terraform refactor, a brand-new agent still needs runnable application code.

This plan should assume the following already exist before infra onboarding:

- worker implementation in `src/`
- runtime wiring if the worker entrypoint is still name-switched
- Docker build path and image publishing path

The workflow should automate infrastructure and registration, not pretend it can synthesize missing runtime code.

## Work breakdown

### Phase 0. State-safe migration prerequisites

- add `moved` blocks for every existing worker resource whose address changes during the refactor
- replace the current worker log-group conditional chain with direct indexed references
- validate that `terraform plan` for the current fleet shows no destructive changes
- apply the migration only when it is a functional no-op for existing services

### Phase 1. Terraform refactor

- introduce a canonical worker-agent map in Terraform
- replace hardcoded worker lists in `ecs.tf` and `outputs.tf`
- keep current per-agent CPU, memory, and desired-count vars as defaults for existing agents
- accept new agents through `additional_worker_agents`
- expose outputs needed by workflows and post-apply validation
- keep the refactor no-op for already deployed agents

### Phase 2. Agent registration Lambda

- add a small VPC-enabled Lambda package for agent registration
- provision the Lambda, IAM role, networking, and outputs in Terraform
- make the Lambda idempotent with `INSERT ... ON DUPLICATE KEY UPDATE`
- scope the Lambda to the Specter `agents` table contract only
- hydrate shared `jira_username` and `jira_token` from Secrets Manager
- add a verification path that reads back the registered row

### Phase 3. Manual GitHub Actions workflows

Add manual-only workflows modeled after the reference Terraform workflows:

- `terraform-agent-plan.yml`
- `terraform-agent-apply.yml`

Shared workflow inputs should include:

- `agent_key`
- `agent_name`
- `description`
- `task_type`
- `jql`
- `cpu`
- `memory`
- `desired_count`
- optional `additional_context`
- optional `model`
- optional `register_agent`
- optional `activate_agent`

Workflow behavior:

- validate the input contract
- render an ephemeral `.auto.tfvars.json` file for Terraform
- render a registration payload for Lambda invocation
- run Terraform init and plan
- upload plan artifacts and plan summary
- in apply, stop on the protected environment
- after approval, apply the exact reviewed plan artifact rather than rerunning plan
- invoke the registration Lambda if requested
- verify the registered row through a follow-up Lambda read
- fail the workflow if registration or verification fails
- publish a final deployment summary

For first-time onboarding, the workflow should default to:

- `desired_count = 0`
- `activate_agent = false`

Activation can happen in a later approved workflow run once the agent image and runtime support are in place.

### Phase 4. Governance and validation

- configure the apply environment with required reviewers
- require manual workflow dispatch only
- add post-apply validation steps such as:
- `terraform output`
- `aws ecs describe-services`
- Lambda registration response capture
- DB registration read-back verification
- explicit activation criteria for moving from `desired_count = 0` / `is_active = false` to active traffic
- document rollback behavior for failed registration or failed service startup

### Phase 5. Documentation and runbook

- update `terraform/README.md`
- update `docs/DEPLOYMENT_GUIDE.md`
- add a “new agent onboarding” runbook
- document prerequisites, inputs, approval flow, activation flow, and rollback steps

## Acceptance criteria

- no Terraform workflow runs automatically on `push`
- the state-safe refactor can be applied without recreating the current fleet
- a user can produce a new-agent plan without editing Terraform HCL
- an admin approval is required before apply can proceed
- the approved apply can create the ECR repo, log group, task definition, and ECS service for the new agent without starting traffic by default
- the approved apply can upsert the new agent into `agents` as inactive
- the workflow verifies that registration succeeded before completing
- a separate approved activation run can scale the service and mark the agent active
- rerunning the same onboarding request is idempotent

## Risks and open questions

- `src/worker-main.ts` still uses an explicit switch by worker type; fully generic onboarding may require a follow-on change to runtime loading
- the repo still uses one workflow per agent image build; this plan does not eliminate that duplication yet
- decide whether activation should stay in the same apply workflow shape or become a dedicated `terraform-agent-activate.yml` workflow
- decide whether AWS auth should stay on long-lived GitHub secrets or move to OIDC role assumption as part of this effort
- confirm whether DB registration should upsert only the requested new agent or also reconcile all Terraform-managed agents

## Recommended implementation order

1. state-safe migration prerequisites
2. Terraform worker-map refactor
3. registration Lambda
4. manual plan/apply workflows with approval gate
5. runbook and deployment docs
6. optional follow-up on generic image-build onboarding

## Dependencies

- aligns with Plan 02 on configuration/runtime alignment
- aligns with Plan 07 on observability and documentation governance
- should be sequenced after any immediate secret-management cleanup that affects deployment credentials

## Review focus for Claude

Claude should specifically review:

- whether the Terraform map refactor is the right abstraction boundary
- whether post-apply Lambda invocation with verification is the right registration boundary
- whether GitHub Environment approval is sufficient as the control gate
- whether onboarding and activation should be separate approved workflow paths
- whether Specter should keep per-agent image workflows or move toward a generic agent build pipeline in a follow-on plan
