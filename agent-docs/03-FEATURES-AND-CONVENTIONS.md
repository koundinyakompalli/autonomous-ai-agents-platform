# Features and Conventions

This file captures the implementation conventions that matter when you add a new agent.

## Existing feature set

Specter currently supports:

- JIRA-driven assignment through the orchestrator
- Teams-driven intake through Harvey
- agent-specific worker services on ECS
- shared worker runtime entrypoint with status API
- Claude Agent SDK execution on Bedrock
- shared task and result buckets in S3
- shared repo and task workspaces on EFS
- governed onboarding and activation workflows for additional agents
- post-apply DB registration via Lambda
- OIDC-based AWS auth in GitHub Actions

## Agent capability matrix

| Agent | Main capability | Execution model | Key dependencies |
| --- | --- | --- | --- |
| `DARCI` | defect investigation | Claude SDK `analysis` | git history, repo access |
| `SCRIBE` | code walkthroughs | Claude SDK `code_exploration` | repo access |
| `PRISM` | planning and refinement | Claude SDK `code_exploration` | repo access |
| `HERMES` | config/environment lookup | Claude SDK `read_only` | repo access, Bash read-only exploration |
| `SENTRY` | SQL safety review | Claude SDK `code_exploration` | repo access |
| `BEACON` | SQL generation validation | hybrid | MOANA API, repo access |
| `BCAT-PLANNER` | bulk ticket planning | deterministic | JIRA, Excel attachments |
| `BCAT-EXECUTOR` | bulk ticket execution | deterministic | JIRA, Excel-derived ticket plan |
| `VERITAS` | RCA synthesis | hybrid | JIRA evidence, repo access |
| `SRLOG` | log analysis | Claude SDK `read_only` | log files, read-only shell commands |

## Naming conventions

The codebase now relies on conventions more than manual switch statements.

## Recommended naming pattern for new agents

For a hypothetical new agent, use:

- `agent_key`: `my-agent`
- `agent_name`: `MY-AGENT`
- worker file: `src/orchestrator/workers/MyAgentWorker.ts`
- worker export: `MyAgentWorker`
- agent folder: `src/agents/my-agent/`
- agent class: `MyAgent`
- internal Claude SDK key: `myagent`

This pattern minimizes special-case edits.

## Naming crosswalk

| Name | Format | Why it matters |
| --- | --- | --- |
| `agent_key` | lowercase kebab-case | Terraform and ECR naming |
| `agent_name` | uppercase kebab-case or uppercase word | DB row identity and runtime `WORKER_TYPE` |
| worker module stem | PascalCase | dynamic loader convention |
| internal Claude SDK key | lowercase identifier | `AgentType`, tool set, prompt, schema |

## Conventions that must be preserved

1. `AgentWorkerConfig.agentName` should equal the `agents.name` value.
2. The activation workflow’s `agent_name` input should be the actual runtime worker name, not a friendly display string.
3. If `agent_key` is `my-agent`, Terraform will set:
   - ECR repo: `specter/my-agent-worker`
   - ECS service: `MY-AGENT`
   - log group: `/ecs/specter/my-agent-worker`
   - `WORKER_TYPE`: `MY-AGENT`
4. The worker file should be resolvable by `resolve-worker-entry.py`.

## Claude SDK conventions

For Claude SDK-backed agents, the conventional touch points are:

- `src/claude-sdk/config.ts`
  - add the internal key to `AgentType`
  - add schema logic to `getOutputSchema()`
  - add permission logic to `getToolSet()`
- `src/claude-sdk/index.ts`
  - add a prompt to `AGENT_PROMPTS`

## Current tool-set mapping

Current patterns:

- `analysis`
  - `DARCI`
  - `VERITAS`
- `read_only`
  - `HERMES`
  - `SRLOG`
- `code_exploration`
  - `SCRIBE`
  - `PRISM`
  - `SENTRY`
  - `BEACON`

Do not grant `full_autonomy` by default.

## Output schema conventions

Current behavior:

- many agents return structured JSON shaped by an output schema
- `VERITAS` is a partial exception because it relies on a markdown-style RCA format enforced by prompt
- deterministic BCAT agents do not use the shared schema pattern in the same way

When in doubt:

- define an explicit schema if the result must be machine-consumable
- otherwise keep markdown human-readable and consistent

## Worker implementation conventions

Each worker class should:

- extend `AgentWorker`
- set `agentName`
- pick a sensible polling interval
- construct its domain agent or service logic inside `process()`
- return markdown output suitable for JIRA or Teams delivery
- return metrics where possible

## Agent implementation conventions

Each agent implementation should:

- keep external I/O near the edges
- keep prompt and schema selection centralized
- shape results into stable markdown or structured output
- emit progress when useful
- fail with clear error messages

## Environment and secret conventions

The current env surface comes from a mix of `.env.example`, runtime code, and Terraform.

Frequently used variables:

- DB:
  - `DB_HOST`
  - `DB_PORT`
  - `DB_USER`
  - `DB_PASSWORD`
  - `DB_NAME`
- JIRA:
  - `JIRA_BASE_URL`
  - `JIRA_USERNAME`
  - `JIRA_TOKEN`
- repo storage:
  - `EFS_MOUNT_PATH`
  - `REPOSITORY_PATH`
  - `DOCUMENTS_PATH`
- worker runtime:
  - `WORKER_TYPE`
  - `STATUS_HOST`
  - `STATUS_PORT`
- Claude SDK / Bedrock:
  - `CLAUDE_CODE_USE_BEDROCK`
  - `ANTHROPIC_MODEL`
  - `BEDROCK_MODEL`
- Harvey:
  - `TEAMS_APP_ID`
  - `TEAMS_APP_PASSWORD`
  - `TEAMS_TENANT_ID`

## Special-case conventions by agent family

### BCAT

- not a standard Claude SDK wrapper
- JIRA and Excel first
- extra BCAT field environment variables matter

### BEACON

- depends on MOANA API env vars
- does pre-validation orchestration before Claude validation

### VERITAS

- needs JIRA credentials from the agent row
- gathers evidence before reasoning

## Current source-of-truth files for onboarding

- `terraform/additional-worker-agents.auto.tfvars.json`
  - persistent catalog for non-built-in agents
- `terraform/shared.auto.tfvars`
  - committed shared dev-account non-secret inputs for workflows and local Terraform
- `.github/scripts/manage-worker-agent-catalog.py`
  - catalog mutation helper
- `.github/scripts/resolve-worker-entry.py`
  - worker module validation helper

## Current CI/CD reality

The repo now has both:

- legacy per-agent build/push workflows
- a new generic manual worker image workflow for new agents

Interpret that correctly:

- existing agents still have dedicated CI/CD pipelines
- new agents can be seeded through the generic manual workflow
- the generic manual workflow is not yet a full replacement for all dedicated pipelines

The important manual workflow display names are:

- `Ops / Terraform / Agent Onboard`
- `Ops / Terraform / Agent Activate`
- `Ops / Terraform / Plan Or Apply`
- `Ops / Terraform / OIDC Smoke Test`
- `Ops / ECS / Force New Deployment`
- `Build / Worker / Manual Push`

## Current Terraform input convention

The Terraform input model in this repo is deliberate.

### Committed shared inputs

Use:

- `terraform/shared.auto.tfvars`

for:

- VPC IDs
- subnet IDs
- EFS ID
- reused task-role ARN
- secret names
- shared dev-account resource settings

Do not put secret values in this file.

Repository rule:

- the shared GitHub token secret name belongs here
- the token value itself does not
- `code_repositories` rows should contain GitHub metadata and `default_branch`, not inline credentials

### Local override inputs

Use:

- `terraform/terraform.tfvars`

only for:

- temporary local overrides
- private developer-specific experiments
- values that should not be committed

Workflows must not rely on it.

## Terraform authoring rules for future sessions

If you need to change Terraform for a new agent, follow these rules:

1. Do not add a one-off ECS/ECR/log-group/service resource just because a new worker exists.
2. Prefer the existing shared map model:
   - `local.default_worker_agents`
   - `var.additional_worker_agents`
   - `local.all_worker_agents`
3. For a normal new agent, add infra through the onboarding workflow and catalog file, not by hand-editing built-in worker locals.
4. Only edit `local.default_worker_agents` when you are intentionally changing the built-in fleet that should always exist from source control.
5. If a new worker needs additional per-agent configuration beyond `cpu`, `memory`, and `desired_count`, extend the shared worker schema carefully instead of cloning resources.
6. If you extend the worker schema, update all dependent surfaces:
   - `terraform/variables.tf`
   - `terraform/main.tf`
   - `terraform/ecs.tf`
   - `.github/scripts/manage-worker-agent-catalog.py`
   - relevant workflows
   - docs
7. Keep Terraform plans side-effect free. DB writes must stay post-apply through the registration Lambda.
8. Preserve `terraform/moved.tf` unless you fully understand the live-state migration impact.
9. If you touch the registration Lambda packaging or source hash, keep the hash based on tracked source files and exclude generated bytecode.
10. Keep `.github/scripts/resolve-worker-entry.py` aligned with `src/orchestrator/workers/runtime.ts`.
