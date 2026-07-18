# Implementing a New Agent

This file covers the code changes required to add a new agent family before you onboard its infrastructure.

## First decision: what kind of agent are you adding?

Choose the implementation pattern before writing code.

### Pattern A: Claude SDK-first

Use this when the main problem is reasoning over code, logs, config, or documents.

Best examples:

- `DARCI`
- `SCRIBE`
- `PRISM`
- `HERMES`
- `SENTRY`
- `SRLOG`

### Pattern B: hybrid

Use this when the agent must gather or transform external data before reasoning.

Best examples:

- `BEACON`
- `VERITAS`

### Pattern C: deterministic service flow

Use this when the agent mostly calls APIs, parses files, and posts structured results.

Best examples:

- `BCAT-PLANNER`
- `BCAT-EXECUTOR`

Do not force every new agent into the Claude SDK pattern if its job is mainly deterministic orchestration.

## Step 1: choose names carefully

Use one naming sheet before creating files.

Example:

| Concept | Example value |
| --- | --- |
| `agent_key` | `my-agent` |
| `agent_name` | `MY-AGENT` |
| worker file | `MyAgentWorker.ts` |
| worker class | `MyAgentWorker` |
| agent folder | `src/agents/my-agent/` |
| agent class | `MyAgent` |
| internal Claude SDK key | `myagent` |
| logical task type | `my_agent_task` |

Recommended rule:

- keep `agent_key` lowercase kebab-case
- keep `agent_name` equal to the uppercase runtime identity
- keep the worker module stem PascalCase

## Step 1.5: decide whether Terraform needs to change

For many new agents, the answer is no.

If the new worker only needs:

- standard worker runtime env vars
- standard DB/JIRA access
- standard EFS access
- standard ECS resource knobs (`cpu`, `memory`, `desired_count`)

then you usually do not need a new Terraform resource block at all.

You will:

- implement the agent in code
- onboard it through the workflow-managed catalog
- push the first image
- activate it

You should only edit Terraform when the new agent needs something structurally different, such as:

- new env vars injected into the ECS task definition
- new secret injection
- extra IAM permissions
- new security-group/network reachability
- a new ALB/service surface
- a richer per-worker Terraform schema

## Step 2: add the domain agent implementation

If you are using a Claude SDK-backed pattern, create:

```text
src/agents/my-agent/MyAgent.ts
src/agents/my-agent/index.ts
```

### Minimal Claude SDK-backed agent shape

```ts
import {
  runAgent,
  getAgentPrompt,
  registerRepoFromPath,
} from '../../claude-sdk/index.js';

export class MyAgent {
  constructor(private readonly repositoryPath: string) {}

  async run(taskPrompt: string, additionalContext?: string) {
    const repoId = registerRepoFromPath(this.repositoryPath);

    return runAgent({
      taskId: `myagent-${Date.now()}`,
      taskPrompt,
      repoIds: [repoId],
      agentType: 'myagent',
      systemAppend: getAgentPrompt('myagent'),
      additionalContext,
    });
  }
}
```

This is only the minimal shape. Real agents usually add:

- progress hooks
- output shaping
- structured result typing
- repo workspace detection
- timeout controls

## Step 3: add the worker implementation

Create:

```text
src/orchestrator/workers/MyAgentWorker.ts
```

### Minimal worker shape

```ts
import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { MyAgent } from '../../agents/my-agent/index.js';
import type { EventEmitter } from 'events';

export class MyAgentWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer = false) {
    super({
      agentName: 'MY-AGENT',
      repositoryPath,
      pollingIntervalMs: 10000,
      batchSize: 1,
      enableStatusServer,
    });
  }

  protected async process(
    jiraNumber: string,
    taskId: number,
    taskDescription: string,
    additionalContext: string,
    repositoryPath: string,
    eventEmitter?: EventEmitter,
  ): Promise<ProcessResult> {
    const agent = new MyAgent(repositoryPath);
    const result = await agent.run(taskDescription, additionalContext);

    if (!result.success) {
      return {
        success: false,
        output: '',
        error: result.error || 'Unknown error',
      };
    }

    return {
      success: true,
      output: String(result.output),
      metrics: {
        totalTokens: result.metrics.tokensUsed,
        iterations: result.metrics.toolCalls,
        cost: result.metrics.costUsd,
        durationMs: result.metrics.durationMs,
      },
    };
  }
}
```

## Step 4: make the worker discoverable

Because the runtime is now convention-based, the important part is file naming.

For `WORKER_TYPE=MY-AGENT`, the loader will try to resolve:

- `src/orchestrator/workers/MyAgentWorker.ts`
- export `MyAgentWorker`

Recommended follow-up, even though not strictly required for dynamic loading:

- export the worker from `src/orchestrator/workers/index.ts`
- export the domain agent from `src/agents/index.ts`

This keeps discoverability and older import patterns intact.

## Step 5: update Claude SDK configuration if the agent uses Claude

If the new agent wraps `runAgent()`, update:

### `src/claude-sdk/config.ts`

- add the new internal key to `AgentType`
- add a branch in `getOutputSchema()`
- add a branch in `getToolSet()`
- optionally add a dedicated schema constant

### `src/claude-sdk/index.ts`

- add the system prompt to `AGENT_PROMPTS`

Important:

- the internal Claude SDK key does not have to match `agent_name`
- it does have to be used consistently inside the SDK config and wrapper

## Step 6: decide whether the agent needs repo access

Not every agent needs the same repo behavior.

### Repo-heavy agents

Examples:

- DARCI
- SCRIBE
- PRISM
- HERMES
- SENTRY
- VERITAS

These should usually use:

- `registerRepoFromPath()`
- `registerCustomerWorkspace()`

### Non-repo or light-repo agents

Examples:

- BCAT
- some external-service-first agents

These may only need:

- JIRA credentials
- attachments
- service-specific env vars

Do not add fake repo requirements if the task does not need them.

## Step 6.5: decide whether automatic repo selection needs to change

This is easy to miss.

If the new agent depends on the orchestrator or Harvey automatically selecting the right repo into `task_management.related_code`, you may also need to update:

- `src/orchestrator/RepoAnalyzer.ts`

Current important behavior:

- CP-family tickets are prevented from selecting `mp-*` repos
- MP-family tickets are restricted to `mp-*` repos when those exist in `code_repositories`
- MP + config wording routes directly to `mp-product-client-configs`
- MP + web/release wording routes directly to `mp-web`

What this means in practice:

- if the agent works entirely from an explicitly named repo inside its own worker code, you may not need a `RepoAnalyzer` change
- if the agent expects the task workspace to already contain a repo, you probably do need a `RepoAnalyzer` change
- if you add a new repo family or a new deterministic repo-selection rule, ship that as part of the same feature PR

## Step 7: decide whether the agent needs new env vars

Examples from current agents:

- `MOANA_BASE_URL`
- `MOANA_USER_ID`
- BCAT field IDs

If a new agent needs new env vars:

- add them to `.env.example`
- document them
- make sure Terraform injects them if the worker will run on ECS

Important decision:

- if every worker needs the variable, add it to the shared worker task-definition environment block in `terraform/ecs.tf`
- if only one agent needs it, do not blindly add a global env var just because it is easy

For a truly worker-specific Terraform input, the current map model may need to be extended. If you do that:

1. extend `variable "additional_worker_agents"` in `terraform/variables.tf`
2. extend `local.all_worker_agents` consumers in `terraform/ecs.tf`
3. extend `.github/scripts/manage-worker-agent-catalog.py` if the new field must be workflow-managed
4. update the onboarding/activation docs and workflow inputs only if operators must provide that value

Do not hide worker-specific infrastructure behavior in scattered hardcoded conditionals unless the repo already uses that pattern for the exact same concern.

## Step 8: local validation before infra onboarding

Before touching workflows, validate the code path locally.

Recommended checks:

```bash
npm run build
python3 .github/scripts/resolve-worker-entry.py --worker-type MY-AGENT
WORKER_TYPE=MY-AGENT npm run worker
```

The local worker run may still fail if the DB row does not exist. That is acceptable for bootstrap validation. The important part is:

- the code builds
- the worker entry resolves
- imports do not fail

## Step 9: optional convenience wiring

These are not strictly required, but usually worth doing:

- add an npm script in `package.json`
- add docs
- add tests if the agent has deterministic helper logic
- add logging with clear lifecycle markers

## Step 10: validate the Terraform impact before deployment

Before you tell anyone to run onboarding, answer this explicitly:

### Case A: no Terraform schema change needed

This is the common case.

You only need:

- code changes
- a pushed branch
- the onboarding workflow inputs

### Case B: Terraform schema change needed

This is the less common case.

Make the change carefully:

1. Prefer extending the shared worker model over cloning worker resources.
2. Keep secrets in Secrets Manager, not in `.tfvars`.
3. Keep shared non-secret account values in `terraform/shared.auto.tfvars`.
4. Run local validation:
   - `bash .github/scripts/package-agent-registry-lambda.sh`
   - `cd terraform && terraform init -backend-config=backend.hcl`
   - `terraform plan`
5. If the change touches only new code and workflow-managed catalog entries, the onboarding workflow should be the path that applies it.
6. If the change alters shared infrastructure behavior, use `Ops / Terraform / Plan Or Apply` or a reviewed local Terraform path first so the plan is understood.

## Step 11: know what not to edit for a normal new agent

For a standard new worker, do not start by editing:

- `local.default_worker_agents`
- `terraform/moved.tf`
- separate per-agent ECS resource blocks

Those are the wrong first moves unless you are intentionally changing the built-in fleet or performing a state migration.

## What must be true before infra onboarding

Before the onboarding workflow is worth running, all of these should be true:

1. The worker file exists and resolves.
2. The worker class `agentName` matches the future DB `agents.name`.
3. The code builds successfully.
4. If the agent uses Claude SDK, its prompt/tool/schema config exists.
5. If the agent uses external services, the env and secret requirements are understood.
6. If the agent depends on a repository that is not already in `code_repositories`, have the GitHub clone URL ready for the optional onboarding repository inputs.

## Repository catalog rule

Repository auth is no longer supposed to live in `code_repositories`.

Use the shared GitHub repository token secret for worker clone auth, and treat
`code_repositories` as metadata only:

- `repo_name`
- `repo_url`
- `description`
- provider = GitHub

If the new agent needs a repo that is not already cataloged:

- for a normal single-branch repo, supply the optional repository fields in `Ops / Terraform / Agent Onboard`
- if the repo needs special branch handling beyond the existing hardcoded versioned monorepo map, update the runtime branch logic in `src/orchestrator/database.ts` and `src/orchestrator/AgentWorker.ts` as part of the same PR

## Common mistakes during implementation

### Mistake: mixing `agent_key` and `agent_name`

Bad:

- `agent_key = my-agent`
- `agent_name = My Agent`

Good:

- `agent_key = my-agent`
- `agent_name = MY-AGENT`

### Mistake: using a worker filename the resolver cannot infer

Bad:

- `src/orchestrator/workers/MyCustomRuntime.ts`

Good:

- `src/orchestrator/workers/MyAgentWorker.ts`

### Mistake: adding the worker but forgetting Claude SDK config

If the agent uses `runAgent()`, forgetting `AgentType`, tool set, prompt, or schema updates creates runtime failures or default behavior you probably did not intend.

### Mistake: assuming `task_type` should equal `agent_name`

It can, but it does not have to.

### Mistake: editing Terraform built-ins for what should be a workflow-managed agent

Bad:

- adding `my-agent` directly to `local.default_worker_agents` for a one-off new worker

Better:

- let onboarding persist the new agent through `terraform/additional-worker-agents.auto.tfvars.json`

### Mistake: adding secrets or account-specific values to local code instead of shared Terraform inputs

Bad:

- hardcoding secret values
- assuming a developer's `terraform.tfvars` is the workflow source of truth

Good:

- shared non-secret values in `terraform/shared.auto.tfvars`
- secrets referenced by name through Terraform and resolved from Secrets Manager

Current code treats them differently:

- `agents.name` is the worker identity
- `agents.task_type` is logical routing metadata

## Decision checklist

Before moving on to deployment, answer these questions:

1. Is this a Claude SDK agent, hybrid agent, or deterministic service agent?
2. What is the exact `agent_key`?
3. What is the exact `agent_name`?
4. What worker filename will the runtime resolver use?
5. Does this agent need:
   - repo access
   - JIRA credentials
   - extra service credentials
   - a new output schema
   - a new prompt
6. Does this agent need a dedicated CI workflow later, or is the generic manual image workflow enough for now?
