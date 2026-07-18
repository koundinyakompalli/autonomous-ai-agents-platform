# API Reference

This is the current public surface exported from `src/index.ts` plus the main runtime entrypoints used by the services.

## Package exports

### Agent classes

- `DARCIAgent`
- `SCRIBEAgent`
- `PRISMAgent`
- `HERMESAgent`
- `SENTRYAgent`
- `BEACONAgent`
- `BCATplannerAgent`
- `BCATExecutorAgent`
- `VERITASAgent`

### Claude SDK helpers

- `runAgent`
- `createAgentRunner`
- `registerRepoFromPath`
- `registerCustomerWorkspace`
- `initReposFromEfs`
- `getAgentPrompt`
- `AGENT_PROMPTS`

### Config helpers

- `TOOL_SETS`
- `getToolSet`
- `getOutputSchema`
- `getBedrockEnv`
- `registerRepo`
- `getRepoPath`
- `getRegisteredRepos`

### Hooks

- `buildHooks`
- `makeProgressHook`
- `makeAuditLogHook`
- `makeDenyWritesOutsideRepos`
- `makeDenyDangerousCommands`
- `makeReadOnlyHook`
- `makeRateLimitHook`
- `makeTimeoutHook`

### Utilities

- `createLogger`
- `VERSION`

## `runAgent(options)`

Primary shared execution helper.

Important options:

- `taskId`
- `taskPrompt`
- `repoIds`
- `agentType`
- `systemAppend`
- `additionalContext`
- `permissionLevel`
- `allowedTools`
- `outputSchema`
- `timeoutMs`
- `maxCallsPerMinute`
- `maxTurns`
- `maxBudgetUsd`
- `readOnly`
- `allowWrite`

Returns:

- `success`
- `output`
- `structuredOutput`
- `error`
- `sessionId`
- `metrics`

## `createAgentRunner(agentType, baseConfig?)`

Returns a function:

```ts
(taskPrompt: string, repoIds: string[], options?: Partial<AgentRunnerOptions>) => Promise<AgentResult>
```

Useful when you want a reusable runner for a specific agent family.

## Repo registration helpers

### `registerRepo(id, path)`

Adds an absolute repo root to the in-memory registry.

### `getRepoPath(repoId)`

Resolves a registered repo ID to an absolute path.

### `registerRepoFromPath(repoPath)`

Registers a raw path and returns the generated repo ID.

### `registerCustomerWorkspace(workspacePath)`

Registers a workspace and returns:

- `workspaceId`
- `repoIds`

### `initReposFromEfs(basePath?)`

Scans an EFS repo base path and registers repositories.

## Agent method surface

### DARCI

- `analyze(defectDescription, additionalContext?)`
- `quickTriage(defectDescription)`

### SCRIBE

- `explain(question, additionalContext?)`
- `explainEndpoint(endpoint, method?)`
- `explainFunction(functionName, filePath?)`
- `explainClass(className)`

### PRISM

- `plan(taskDescription, additionalContext?)`
- `refineRequirements(requirements)`
- `breakdown(task)`
- `analyzeImpact(changeDescription)`
- `planMigration(from, to, context?)`

### HERMES

- `findConfig(query, additionalContext?)`
- `findEnvVar(varName)`
- `listConfigs(moduleName)`
- `explainFeatureFlag(flagName)`
- `findDatabaseConfig()`
- `findAPIConfig()`
- `findSystemVariable(code)`
- `findSLAConfig(slaName?)`

### SENTRY

- `review(jiraText, modelName?)`
- `quickSafetyCheck(sql)`
- `validateAgainstModel(sql, modelName)`

### BEACON

- `validate(generatedSql, fileInfo, moanaContext, jiraTicketKey)`

### BCAT

- `BCATplannerAgent.plan(jiraNumber, additionalContext?)`
- `BCATExecutorAgent.execute(jiraNumber, additionalContext?)`

### VERITAS

- `analyze(jiraKey, additionalContext?)`

## Service entrypoints

### Orchestrator

```text
src/orchestrator/index.ts
```

Starts JIRA polling and result posting plus a simple `/health` server.

### Worker

```text
src/worker-main.ts
```

Preferred worker runtime with embedded status API.

### Harvey

```text
src/harvey-main.ts
```

Starts the Teams bot HTTP service and result delivery loop.
