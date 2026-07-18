# MCP Integration

This filename is retained for continuity. The current Specter runtime does not depend on MCP for production execution.

## Current state

Active integrations are direct:

- JIRA via REST calls
- S3 via AWS SDK
- MySQL via `mysql2`
- Teams via Bot Framework
- Bedrock via AWS SDK or Claude Code Bedrock mode
- MOANA via direct HTTP calls in the BEACON worker path

There is no active MCP server/client layer in the current request path for orchestrator, workers, or Harvey.

## Why this matters

Older docs described Specter as if external integrations were exposed as MCP tools. That is not how the current code executes.

## Where integration logic lives now

| Integration | Current location |
| --- | --- |
| JIRA issue polling and posting | `src/orchestrator/` |
| JIRA RCA / BCAT helpers | `src/agents/veritas/`, `src/agents/bcat/` |
| Teams bot | `src/harvey/` |
| S3 task/result storage | `src/orchestrator/storage.ts` |
| Bedrock task generation and repo analysis | `src/orchestrator/TaskDescriptionGenerator.ts`, `src/orchestrator/RepoAnalyzer.ts`, `src/harvey/IntakeAgent.ts` |
| MOANA calls | `src/orchestrator/workers/BEACONWorker.ts` |

## If MCP is reintroduced later

Treat it as a future architecture change, not an existing one. Any new MCP work should be documented as additive and should not overwrite the current direct-integration model unless the runtime is actually migrated.
