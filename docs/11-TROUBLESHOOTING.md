# Troubleshooting

## Orchestrator fails on startup

Check:

- `JIRA_BASE_URL`
- `JIRA_USERNAME`
- `JIRA_TOKEN`
- `DB_*` values

The orchestrator validates JIRA configuration at startup and will exit early if those values are missing.

## Worker starts but never exposes `/status`

Cause:

- you started the legacy worker entrypoint instead of `worker-main`

Fix:

```bash
WORKER_TYPE=DARCI npm run worker
```

## Worker cannot find repositories

Check:

- `REPOSITORY_PATH`
- EFS mount availability
- actual path is `/mnt/efs/specter-repo/repositories` in the current deployment model

## Task is stuck in `assigned`

Check:

- matching worker is running
- `agents.name` matches the worker's configured `agentName`
- no other worker already claimed it

Useful query:

```sql
SELECT * FROM v_agent_workload;
```

## Task fails before result upload

Check:

- `tasks.error_message`
- S3 permissions
- Claude/Bedrock credentials
- JIRA credentials for agent-specific flows like VERITAS or BCAT

## Harvey does not deliver results

Check:

- `chat_sessions.status`
- linked `task_management.status`
- Teams conversation reference presence
- `RESULT_POLL_INTERVAL`

## JIRA result posting never happens

Check:

- `task_management.source` is `jira`
- row reached `completed`
- posting retries are not being released back repeatedly

## No tests run

Current reality:

```bash
npm test -- --run
```

may report no test files. Build and manual flow verification are still necessary until a real automated suite exists for the touched area.

## Build works locally but ECS task fails

Check for environment mismatch:

- secret injection missing in ECS task definition
- EFS mount path differs from local assumptions
- container launched with the wrong entrypoint or `WORKER_TYPE`

## Legacy doc mismatch

If you see references to Phoenix or MCP in old filenames, cross-check the current runtime docs:

- `02-ARCHITECTURE.md`
- `04-PHOENIX-CONFIGURATION.md`
- `06-MCP-INTEGRATION.md`

Those files now explain the current model and the historical naming.
