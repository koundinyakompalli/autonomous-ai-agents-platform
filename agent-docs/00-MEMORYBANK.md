# Memory Bank

This file captures the facts that should remain true across sessions unless the codebase is deliberately reworked.

## What Specter is

Specter is an asynchronous AI-agent platform for engineering work.

It has three main runtime surfaces:

- `orchestrator`: polls JIRA, decides what to assign, creates durable tasks, and posts results back
- `workers`: poll MySQL for assigned work, prepare repositories on EFS, run agent logic, and upload results to S3
- `harvey`: Microsoft Teams bot that routes free-form requests into the same durable pipeline

The current execution engine is the Claude Agent SDK on Bedrock. Phoenix is legacy terminology only.

## The core platform split

The system is deliberately split into:

- control plane: MySQL tables
- payload plane: S3 task and result markdown
- repository plane: EFS repositories, task workspaces, and worktrees

Do not collapse these boundaries casually. They are the main reason the platform is operable.

## Non-negotiable architectural invariants

These are the facts most likely to matter during implementation:

1. Workers and orchestrator do not talk to each other by RPC.
2. Work is coordinated through `task_management` rows and S3 object pointers.
3. `AgentWorker` is the real worker contract. New worker families should extend it unless they are intentionally introducing a new runtime model.
4. `src/worker-main.ts` is the preferred worker entrypoint because it includes the status server.
5. `src/orchestrator/workers/runtime.ts` is now the worker-resolution source of truth.
6. The `agents` table is the contract used by orchestration and Harvey for agent identity and routing metadata.
7. `agents.name` must match the worker identity used at runtime.
8. New infra onboarding is separate from activation:
   - onboarding: infra exists, ECS desired count stays at `0`, DB row stays inactive
   - activation: desired count is raised and DB row is flipped active
9. The Terraform plan path must remain side-effect free.
10. DB registration is intentionally post-apply via Lambda, not Terraform plan logic.
11. Additional workflow-managed workers are persisted in `terraform/additional-worker-agents.auto.tfvars.json`.
12. Built-in workers still live in Terraform as `local.default_worker_agents`.
13. Developers without direct AWS access are expected to use manual GitHub Actions operator workflows for ECS redeploys and Terraform reconciliation.
14. Workflow ECR targets are no longer hardcoded to one AWS account; they come from GitHub repository configuration through `vars.ECR_REGISTRY`.
15. Shared non-secret Terraform inputs for the shared dev account live in the committed file `terraform/shared.auto.tfvars`.
16. Local `terraform/terraform.tfvars` is optional override-only state; workflows must not depend on it.
17. The shared GitHub Actions AWS role should come from `AWS_ROLE_ARN`, and the known-good dev-account role is `arn:aws:iam::323960442001:role/GitHub-OIDC`.
18. Because Terraform reads the existing EFS file system as a data source, the GitHub OIDC role needs `elasticfilesystem:DescribeFileSystems`.
19. The agent-registry Lambda `source_code_hash` must be derived from tracked files under `terraform/lambda/agent_registry`, not from the generated zip bytes.
20. Generated files such as `__pycache__/` and `*.pyc` must never affect the Lambda source hash, or GitHub plans will show false-positive drift.
21. `resolve-worker-entry.py` must stay behaviorally aligned with `src/orchestrator/workers/runtime.ts`, because workflows validate the same naming convention used at runtime.
22. GitHub workflow names are intentionally grouped by prefix:
    - `Ops / Terraform / ...`
    - `Ops / ECS / ...`
    - `Build / Worker / ...`
    - `Build / Service / ...`
    - `AI / Claude / ...`

## Existing agent inventory

There are currently ten worker families in the codebase.

| Agent | Worker file | Agent implementation | Pattern | Notes |
| --- | --- | --- | --- | --- |
| `DARCI` | `src/orchestrator/workers/DARCIWorker.ts` | `src/agents/darci/` | Claude SDK analysis agent | root-cause and git investigation |
| `SCRIBE` | `src/orchestrator/workers/SCRIBEWorker.ts` | `src/agents/scribe/` | Claude SDK code-explanation agent | read/search heavy |
| `PRISM` | `src/orchestrator/workers/PRISMWorker.ts` | `src/agents/prism/` | Claude SDK planning agent | implementation planning |
| `HERMES` | `src/orchestrator/workers/HERMESWorker.ts` | `src/agents/hermes/` | Claude SDK read-only agent | config and environment lookup |
| `SENTRY` | `src/orchestrator/workers/SENTRYWorker.ts` | `src/agents/sentry/` | Claude SDK review agent | SQL safety review |
| `BEACON` | `src/orchestrator/workers/BEACONWorker.ts` | `src/agents/beacon/` | hybrid | MOANA SQL generation plus Claude validation |
| `BCAT-PLANNER` | `src/orchestrator/workers/BCATplannerWorker.ts` | `src/agents/bcat/BCATplannerAgent.ts` | deterministic service agent | JIRA + Excel, no Claude SDK runner path |
| `BCAT-EXECUTOR` | `src/orchestrator/workers/BCATExecutorWorker.ts` | `src/agents/bcat/BCATExecutorAgent.ts` | deterministic service agent | JIRA bulk execution flow |
| `VERITAS` | `src/orchestrator/workers/VERITASWorker.ts` | `src/agents/veritas/` | hybrid | JIRA evidence collection plus Claude RCA generation |
| `SRLOG` | `src/orchestrator/workers/SRLOGWorker.ts` | `src/agents/srlog/` | Claude SDK read-only agent | log analysis |

## Agent pattern families

Do not assume every agent follows the same structure.

There are three real patterns in the codebase:

### 1. Claude SDK-first agents

Examples:

- `DARCI`
- `SCRIBE`
- `PRISM`
- `HERMES`
- `SENTRY`
- `SRLOG`

Typical shape:

- worker extends `AgentWorker`
- worker creates domain agent
- domain agent wraps `runAgent()`
- `src/claude-sdk/config.ts` defines tool set and output schema
- `src/claude-sdk/index.ts` defines the system prompt

### 2. Hybrid agents

Examples:

- `BEACON`
- `VERITAS`

Typical shape:

- worker performs non-Claude pre-processing
- worker or agent gathers external evidence
- Claude SDK is used for the reasoning-heavy part
- extra credentials or external APIs are involved

### 3. Deterministic service agents

Examples:

- `BCAT-PLANNER`
- `BCAT-EXECUTOR`

Typical shape:

- worker still extends `AgentWorker`
- the “agent” class mostly orchestrates JIRA, Excel, or service logic
- Claude SDK hooks may not be involved at all

## Naming facts that must line up

There are several different names for the same conceptual agent. Mixing them up causes broken onboarding.

| Concept | Example | Used in |
| --- | --- | --- |
| `agent_key` | `my-agent` | Terraform map key, ECR repo name, workflow input |
| `agent_name` | `MY-AGENT` | `agents.name`, ECS `WORKER_TYPE`, worker identity |
| worker module file | `MyAgentWorker.ts` | runtime loader and activation validation |
| worker class export | `MyAgentWorker` | runtime loader |
| agent folder | `src/agents/my-agent/` | implementation organization |
| internal Claude SDK agent type | `myagent` | `AgentType`, prompt/tool/schema mapping |
| logical task type | `implementation_planning` | `agents.task_type` and Harvey/orchestrator metadata |

The most important invariant is:

- `agents.name`
- the worker class `agentName`
- the ECS `WORKER_TYPE`
- the activation workflow’s `agent_name`

must all describe the same runtime identity.

## Runtime loader rules

`src/orchestrator/workers/runtime.ts` is now responsible for resolving workers.

For new custom agents, the important rule is:

- `WORKER_TYPE=MY-AGENT` should resolve to `src/orchestrator/workers/MyAgentWorker.ts`
- the module should export `MyAgentWorker` or a default constructor

If you follow that convention, you do not need to add a new switch case to `src/worker-main.ts`.

## Claude SDK memory

For Claude SDK-backed agents, the main places to update are:

- `src/claude-sdk/config.ts`
  - `AgentType`
  - `getOutputSchema()`
  - `getToolSet()`
- `src/claude-sdk/index.ts`
  - `AGENT_PROMPTS`
  - `getAgentPrompt()`

If a new agent does not call `runAgent()`, those files may not need to change.

## Important source files

These are the first files a fresh session should inspect when implementing or debugging an agent:

- `src/orchestrator/AgentWorker.ts`
  - base lifecycle, DB lookup, workspace setup, S3/result handling
- `src/orchestrator/workers/runtime.ts`
  - worker loading conventions
- `src/worker-main.ts`
  - preferred runtime entrypoint with status server
- `src/orchestrator/workers/*.ts`
  - current worker implementations
- `src/agents/*`
  - domain-specific agent logic
- `src/claude-sdk/config.ts`
  - tool sets, schemas, agent types
- `src/claude-sdk/index.ts`
  - prompts and runner
- `db/schema.sql`
  - core table contracts and legacy seed state
- `terraform/main.tf`
  - default worker map and shared locals
- `terraform/shared.auto.tfvars`
  - committed shared dev-account Terraform inputs used by both workflows and local runs
- `terraform/ecs.tf`
  - ECS, ECR, log group, service naming
- `terraform/agent-registry-lambda.tf`
  - post-apply registration Lambda
- `.github/workflows/terraform-agent-onboard.yml`
  - onboarding workflow
- `.github/workflows/terraform-agent-activate.yml`
  - activation workflow
- `.github/workflows/agent-worker-build-push.yml`
  - manual generic worker image push
- `.github/workflows/ecs-force-new-deployment.yml`
  - manual targeted ECS rollout with approval
- `.github/workflows/terraform-sync-up.yml`
  - manual repo-wide Terraform reconcile with optional approved apply

## Persistent gotchas

These are easy to forget and worth carrying forward:

1. `db/schema.sql` does not seed every worker that exists in code or Terraform.
2. Several package scripts still point to `dist/orchestrator/workers/index.js` instead of `dist/worker-main.js`.
3. Repository clone auth is supposed to come from the shared GitHub secret in Secrets Manager, not `code_repositories.token`.
4. `task_management.related_code` is still a CSV string, not a normalized join table.
5. `BEACON` requires MOANA-related environment variables.
6. `BCAT` agents require JIRA access and Excel attachment handling, not just repo access.
7. The generic manual image workflow seeds a worker image, but it is not a complete ongoing CI/CD replacement.
8. The Terraform worker map supports new agent infra, but code onboarding is still manual.
9. Force-deploying an ECS service is a separate operational action from Terraform activation or image push.
10. If a plan shows only `aws_lambda_function.agent_registry`, the likely issue is Lambda source-hash drift, not a broad infrastructure change.
11. A previous false-positive Lambda drift was caused by local `__pycache__` bytecode leaking into the source-hash calculation.
12. `terraform/shared.auto.tfvars` exists because this repo targets one shared AWS account. Do not move secret values into it.
13. `code_repositories` is now intended to be metadata-only, and onboarding can optionally upsert a missing repo row.
14. `RepoAnalyzer` is no longer purely LLM-driven. It now applies deterministic ticket-family routing before the Bedrock path:
    - MP ticket families (`MPDEV`, `MPSUP`, `MPCLIENT`, or referenced `MP*-123` keys) are restricted to MP repos.
    - CP ticket families are prevented from selecting `mp-*` repos.
    - MP + config-style wording routes directly to `mp-product-client-configs`.
15. If a new agent depends on automatic repo assignment and its repo family is not already covered, update `src/orchestrator/RepoAnalyzer.ts` as part of the feature, not as a later cleanup.

## What not to trust blindly

- old Phoenix or MCP terminology
- the schema seed list as a complete representation of deployed agents
- legacy diagrams in `agent-docs/*.png`
- older package scripts as proof of the preferred runtime path
- assumptions that a new agent can be onboarded with no code changes
- a Terraform plan from an older commit that predates the shared-input or Lambda hash-stability fixes
