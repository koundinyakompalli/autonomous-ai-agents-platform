# Agent Development Guide

This guide covers the current way to add or modify agents in Specter.

## The pattern

An agent feature usually has four pieces:

1. an agent wrapper in `src/agents/`
2. an output schema and tool policy in `src/claude-sdk/`
3. a worker implementation in `src/orchestrator/workers/`
4. operational registration in exports, package scripts, Terraform, and the `agents` table

## When you only need a custom wrapper

If you do not need a new first-class `AgentType`, you can build a custom wrapper around `runAgent()` with explicit `allowedTools` and `outputSchema`.

Example:

```ts
import {
  runAgent,
  registerRepoFromPath,
  TOOL_SETS,
} from '../../claude-sdk/index.js';

export class SecurityScanAgent {
  private repoId: string;

  constructor(repositoryPath: string) {
    this.repoId = registerRepoFromPath(repositoryPath);
  }

  async scan(taskPrompt: string) {
    return runAgent({
      taskId: `security-${Date.now()}`,
      taskPrompt,
      repoIds: [this.repoId],
      allowedTools: TOOL_SETS.code_exploration,
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          findings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['summary'],
      },
      readOnly: true,
    });
  }
}
```

## When you want a first-class agent type

If the new agent should be part of the shared platform, update:

- `src/claude-sdk/config.ts`
  - extend `AgentType`
  - add an output schema if needed
  - map the new agent to a tool set in `getToolSet()`
- `src/claude-sdk/index.ts`
  - add the system prompt to `AGENT_PROMPTS`
  - expose it through `getAgentPrompt()`
- `src/agents/`
  - add the wrapper class
- `src/orchestrator/workers/`
  - add a worker class
- `src/agents/index.ts`
  - export the new agent
- `src/worker-main.ts`
  - add the worker type switch case
- `package.json`
  - add convenience scripts if desired
- `db/schema.sql` or DB seed process
  - add the `agents` row if the orchestrator should route JIRA tickets to it
- `terraform/`
  - add ECR, task definition, log group, service, and desired-count variables if it needs a dedicated ECS service

## Worker implementation pattern

Workers extend `AgentWorker` and only implement agent-specific processing.

Skeleton:

```ts
import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import type { EventEmitter } from 'events';

export class SECURITYWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer = false) {
    super({
      agentName: 'SECURITY',
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
    // Create your agent, run it, and return markdown + metrics.
    return {
      success: true,
      output: `# SECURITY Review for ${jiraNumber}\n\n...`,
    };
  }
}
```

## Repo handling rules

- Prefer repo IDs over raw paths once a workspace has been registered.
- If you accept a raw path, use `registerRepoFromPath()` or `registerCustomerWorkspace()`.
- Keep write access constrained to task workspaces or explicit repo roots.

## Tool policy guidance

Choose the smallest tool set that can do the job:

- `code_exploration` for pure read/search work
- `read_only` when safe shell exploration is required
- `analysis` when git history or sub-task delegation is important
- `patch_proposal` only when the agent truly needs to write files

Do not default to write-capable tool sets.

## Output guidance

- return markdown that can be posted directly to JIRA or Teams
- add structured output only when downstream code actually uses it
- keep schemas narrow and stable

## JIRA-routing checklist

If the orchestrator should auto-route tickets to the new agent:

1. add an `agents` row with `name`, `task_type`, `model`, and `jql`
2. ensure the worker uses the same agent name as the DB row
3. deploy at least one worker instance for that agent

## Testing checklist

- run `npm run type-check`
- run `npm run build`
- if you added tests, run `npm test -- --run`
- create one manual task and verify:
  - `task_management` row created
  - worker claims it
  - result lands in S3
  - result reaches the destination system

## Common mistakes

- adding an agent wrapper without adding the worker
- adding a worker without matching the DB `agents.name`
- forgetting that some helper scripts still use the legacy worker entrypoint
- over-scoping tool permissions
- documenting a new agent without updating Terraform and operational docs
