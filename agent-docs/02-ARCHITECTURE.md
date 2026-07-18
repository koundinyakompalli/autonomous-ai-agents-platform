# Architecture

This file explains how the platform works end to end, with an emphasis on the agent execution path.

## Top-level model

Specter is a durable async workflow system.

The main flow is:

```text
JIRA issue or Teams request
  -> orchestrator or Harvey
  -> MySQL control-plane rows
  -> worker claims task
  -> EFS workspace + S3 task/result objects
  -> result delivery back to JIRA or Teams
```

## Infrastructure control path

There is now a second important end-to-end flow for platform operations:

```text
repo code + Terraform source
  -> GitHub Actions manual workflow
  -> Terraform plan artifact
  -> GitHub Environment approval gate
  -> Terraform apply
  -> post-apply Lambda DB registration/update
  -> PR back to main for catalog persistence
```

This matters because future sessions should not treat live onboarding as a manual AWS-console process.

The intended deployment model for new worker agents is governed and GitHub-driven.

## Runtime surfaces

### 1. Orchestrator

Primary responsibilities:

- poll JIRA using each active agent’s `jql`
- resolve customer and repositories
- build task descriptions
- write `task_management`
- watch for completed work
- post results back to JIRA for JIRA-originated tasks

Important architectural fact:

- the orchestrator is the assignment side
- it is not the execution side

Repository assignment detail:

- both the orchestrator and Harvey call `src/orchestrator/RepoAnalyzer.ts`
- the analyzer decides which `code_repositories.id` values are written into `task_management.related_code`
- current selection is a hybrid model:
  - deterministic ticket-family routing first
  - dynamic candidate repo list from the DB catalog
  - Bedrock analysis for the remaining ambiguous cases
- current hard rules matter operationally:
  - CP tickets do not consider `mp-*` repos
  - MP tickets prefer `mp-*` repos only
  - MP config tickets route directly to `mp-product-client-configs`

This means repo-selection behavior is now partly platform logic, not just model output.

### 2. Workers

Primary responsibilities:

- look up their own `agents` row by `name`
- poll for assigned `task_management` rows for their `agent_id`
- claim tasks atomically
- materialize task context and repositories
- run the agent-specific logic
- write result markdown to S3
- mark work complete

All workers share the same base class:

- `src/orchestrator/AgentWorker.ts`

All workers are resolved through:

- `src/orchestrator/workers/runtime.ts`

Preferred entrypoint:

- `src/worker-main.ts`

### 3. Harvey

Harvey is the Teams intake surface.

Important architectural fact:

- Harvey does not create a parallel execution engine
- Harvey routes into the same `task_management` flow used by JIRA-originated work

That is one of the stronger platform decisions in the repo.

## Control plane

The durable control plane is MySQL.

The important tables are:

### `agents`

Stores:

- identity
- description
- model
- task type
- JQL
- JIRA credentials
- active flag

This table is operationally critical because both orchestration and workers depend on it.

Important detail:

- `AgentWorker.start()` looks up the row by `agents.name`
- if the row is missing, worker startup fails

### `task_management`

Stores:

- JIRA key or reference
- assigned `agent_id`
- customer
- related repositories
- task S3 location
- source (`jira`, `harvey`, `api`)
- lifecycle status

This is the durable handoff between assignment and execution.

### `tasks`

Stores:

- individual execution records
- status
- task description
- result S3 pointer
- error and metrics

This is closer to per-execution history than routing state.

### `chat_sessions`

Stores Harvey session state:

- session identity
- user identity
- message history JSON
- resolved agent/customer/repositories
- task linkage

### `customer_branches`

Maps customers to branches or default branch selection.

### `code_repositories`

Maps repo names to clone locations and repository metadata.

Current intended model:

- clone auth should come from the shared GitHub token secret injected into workers as `GITHUB_REPO_TOKEN`
- `code_repositories` should hold names, URLs, descriptions, and default-branch metadata only
- if a repo row is missing for a new agent, the governed onboarding workflow can now upsert it
- repo naming matters because `RepoAnalyzer` uses repo names and ticket-family rules when selecting `related_code`

## Data plane

The payload plane is split across S3 and EFS.

### S3

Current bucket pattern:

```text
<prefix>-tasks
  tasks/<reference>/<timestamp>.md

<prefix>-results
  results/<agent>/<reference>/<taskId>-<timestamp>.md
```

Task markdown and result markdown live here.

The control-plane tables store the pointers, not the full payloads.

### EFS

Current path assumptions:

```text
/mnt/efs/specter-repo/
  repositories/
    <repo>/
    tasks/
      task-<task_management_id>/
  documents/
```

Important operational fact:

- several workers and helper paths still assume this exact base layout

## Worker infrastructure model

Worker infrastructure is intentionally map-driven now.

The important Terraform model is:

- built-in workers live in `local.default_worker_agents`
- workflow-managed workers live in `var.additional_worker_agents`
- the combined source of truth is `local.all_worker_agents`

That merged map drives:

- `aws_cloudwatch_log_group.workers`
- `aws_ecr_repository.workers`
- `aws_ecr_lifecycle_policy.workers`
- `aws_ecs_task_definition.workers`
- `aws_ecs_service.workers`

This has two practical consequences:

1. For most new agents, you do not add a new top-level Terraform resource block.
2. If you need to change the worker schema, you should extend the shared map model rather than fork the worker infrastructure into one-off resources.

Shared non-secret account inputs are committed in:

- `terraform/shared.auto.tfvars`

Secrets must remain in AWS Secrets Manager, not in Terraform variable files.

## Worker lifecycle in detail

The actual worker lifecycle is mostly defined in `src/orchestrator/AgentWorker.ts`.

The rough flow is:

1. worker starts
2. worker connects to DB
3. worker resolves its own `agents` row by `name`
4. worker polls for assigned rows in `task_management`
5. worker claims a row and marks it in progress
6. worker downloads task description markdown from S3
7. worker sets up repositories and task workspaces on EFS
8. worker builds additional context
9. worker creates a `tasks` row
10. worker calls its subclass-specific `process()` method
11. worker writes result markdown to S3
12. worker updates DB state

Important repository-selection nuance:

- workers do not decide the repo set first; they consume whatever the control plane already put into `task_management.related_code`
- if an agent relies on a specific repo being present in the task workspace, the selection logic in `RepoAnalyzer` matters just as much as the worker code

The subclass contract is:

- implement `process(jiraNumber, taskId, taskDescription, additionalContext, repositoryPath, eventEmitter?)`
- return a `ProcessResult`

## Worker runtime loading

The worker entrypoint used to hardcode a switch statement.

It now uses:

- `src/orchestrator/workers/runtime.ts`

Resolution behavior:

- normalize `WORKER_TYPE`
- try built-in module hints first
- then try convention-based names
- import the worker module dynamically

For new agents, the convention path matters:

- `WORKER_TYPE=MY-AGENT`
- file `src/orchestrator/workers/MyAgentWorker.ts`
- export `MyAgentWorker` or default

The workflows validate the same convention through:

- `.github/scripts/resolve-worker-entry.py`

If runtime loading and workflow validation drift apart, onboarding and activation can appear to succeed while runtime still fails, or vice versa.

## Claude SDK execution layer

Claude SDK-backed agents are thin wrappers around the shared execution layer.

The shared layer provides:

- repo registry and path registration
- tool permission selection
- output schema selection
- Bedrock environment wiring
- hook integration for progress and audit

Main files:

- `src/claude-sdk/config.ts`
- `src/claude-sdk/index.ts`

Typical wrapper behavior:

1. register repo or workspace
2. build prompt and context
3. call `runAgent()`
4. shape the output into agent-specific markdown or structured result

## Agent implementation categories

There is no single “one true” agent implementation pattern.

### Pure Claude SDK agents

Best when the task is reasoning-heavy and mostly code- or text-centric.

Examples:

- `DARCI`
- `SCRIBE`
- `PRISM`
- `HERMES`
- `SENTRY`
- `SRLOG`

### Hybrid agents

Best when evidence or artifacts must be collected first.

Examples:

- `BEACON`: MOANA SQL generation first, Claude validation second
- `VERITAS`: JIRA evidence collection first, Claude RCA synthesis second

### Deterministic service agents

Best when the work is mostly API orchestration and transformation.

## Deployment workflow architecture

The important manual workflows are:

- `Ops / Terraform / Agent Onboard`
- `Ops / Terraform / Agent Activate`
- `Ops / Terraform / Plan Or Apply`
- `Ops / ECS / Force New Deployment`
- `Build / Worker / Manual Push`

Their architectural roles are different:

### Agent onboard

Creates infra for a new workflow-managed worker and registers the DB row as inactive.

Key safety properties:

- manual trigger only
- plan/apply split
- approval gate through `specter-terraform-apply`
- saved plan artifact applied, not a fresh re-plan
- ECS desired count stays at `0`
- DB row stays inactive

### Agent activate

Raises ECS desired count and flips the DB row active.

Extra safety checks:

- worker module must resolve
- ECR image must already exist
- onboarding catalog PR must already be merged

### Terraform sync up

This is the generic repo-to-state reconciliation path.

Use it when:

- Terraform changed outside the dedicated onboarding/activation path
- operators need a reviewed plan without local AWS credentials

### Force new deployment

This is not Terraform. It is an ECS rollout operation for an already-existing service.

Use it when:

- `latest` image changed
- task definition still points to `latest`
- you want ECS to replace running tasks without changing Terraform

Examples:

- `BCAT-PLANNER`
- `BCAT-EXECUTOR`

## Monitoring and status APIs

`src/worker-main.ts` embeds the status server.

Current endpoints include:

- `/health`
- `/status`
- `/status/:taskId`
- `/history`
- `/metrics`
- `/events` for SSE
- WebSocket support

This is one reason `worker-main.ts` is the preferred runtime path.

## Infrastructure architecture for workers

Terraform provisions workers using a data-driven map.

Important files:

- `terraform/main.tf`
- `terraform/ecs.tf`
- `terraform/outputs.tf`
- `terraform/additional-worker-agents.auto.tfvars.json`

Built-in workers come from:

- `local.default_worker_agents`

Workflow-managed new workers come from:

- `var.additional_worker_agents`

The merged map drives:

- CloudWatch log groups
- ECR repositories
- ECS task definitions
- ECS services

## Governed onboarding architecture

New worker infrastructure is intentionally not applied directly by ad hoc Terraform shell usage in the target model.

Instead:

1. onboarding workflow updates the worker catalog artifact
2. Terraform plan runs
3. GitHub Environment approval gates apply
4. apply runs from the reviewed plan artifact
5. Lambda registers the `agents` row as inactive
6. workflow opens a PR to persist the catalog file to `main`
7. later activation scales ECS and flips the DB row active

This separation prevents two classes of failure:

- infra exists but code/image is not ready
- DB row is active before the service can actually run
