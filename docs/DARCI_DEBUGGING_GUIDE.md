# DARCI Debugging Guide

DARCI depends on more moving parts than the lighter agents because it often needs git history, richer repo context, and longer execution windows.

## Verify assignment

```sql
SELECT tm.id, tm.jira_number, tm.status, tm.retry_count, tm.error_message
FROM task_management tm
JOIN agents a ON a.id = tm.agent_id
WHERE a.name = 'DARCI'
ORDER BY tm.updated_at DESC
LIMIT 20;
```

## Verify execution record

```sql
SELECT id, status, error_message, result_s3_bucket, result_s3_key, updated_at
FROM tasks
ORDER BY updated_at DESC
LIMIT 20;
```

## Verify worker pathing

DARCI usually fails early if any of these are wrong:

- `REPOSITORY_PATH`
- EFS mount
- branch/worktree setup
- task workspace creation under `/mnt/efs/specter-repo/repositories/tasks/task-<id>`

## Verify worker runtime

Preferred start command:

```bash
WORKER_TYPE=DARCI npm run worker
```

This gives you the status API as well as the worker loop.

## Status API checks

```bash
curl http://localhost:8080/health
curl http://localhost:8080/status
curl http://localhost:8080/metrics
curl -N http://localhost:8080/events
```

Healthy flow usually emits:

- `agent:start`
- repeated `agent:progress`
- optional `agent:tool`
- `agent:complete`

## Common DARCI-specific issues

### Missing git history

Symptoms:

- weak root-cause output
- no introducing commit
- shell/git failures in logs

Check:

- repo is a full clone or valid worktree
- task workspace points to the expected branch content

### Wrong repo selection

Symptoms:

- DARCI searches irrelevant repos
- analysis misses the real defect location

Check:

- `task_management.related_code`
- task markdown stored in the task bucket

### Result uploaded but not posted

Check:

- `task_management.status`
- `retry_count`
- orchestrator logs for JIRA posting failures
