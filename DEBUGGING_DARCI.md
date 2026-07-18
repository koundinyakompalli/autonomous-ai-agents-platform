# Debugging DARCI

DARCI is the deepest investigative agent in the system. When it misbehaves, the failure is usually in one of four places:

- task assignment never happened
- the worker could not claim or prepare the workspace
- Claude SDK execution failed
- result upload or JIRA posting failed after analysis completed

## Quick checks

### 1. Confirm the task exists

```sql
SELECT tm.id, tm.jira_number, tm.status, tm.retry_count, a.name AS agent_name
FROM task_management tm
JOIN agents a ON a.id = tm.agent_id
WHERE a.name = 'DARCI'
ORDER BY tm.updated_at DESC
LIMIT 20;
```

### 2. Confirm the execution row exists

```sql
SELECT id, status, result_s3_bucket, result_s3_key, error_message, updated_at
FROM tasks
ORDER BY updated_at DESC
LIMIT 20;
```

### 3. Confirm the worker is using the status-enabled entrypoint

```bash
WORKER_TYPE=DARCI npm run worker
```

If DARCI was started via `dist/orchestrator/workers/index.js`, you will not get the embedded status API.

## Signals to watch

Healthy execution generally looks like:

- `task_management`: `assigned -> in_progress -> completed`
- worker logs: task claimed, workspace prepared, agent run started
- status API: `agent:start`, repeated `agent:progress`, then `agent:complete`
- `tasks.result_s3_key` is populated

## Common failure modes

### Task stuck in `assigned`

Possible causes:

- DARCI worker is not running
- agent row in `agents` table is misconfigured
- worker cannot claim the row because another container already owns it

Check:

- DARCI worker logs
- `SELECT * FROM v_agent_workload;`

### Task moves to `failed` quickly

Possible causes:

- missing JIRA credentials
- missing or invalid repository path
- workspace creation or symlink setup failed on EFS
- Bedrock or Claude SDK startup error

Check:

- `tasks.error_message`
- worker stderr / CloudWatch logs
- EFS path exists at `/mnt/efs/specter-repo/repositories`

### DARCI runs but produces weak output

Possible causes:

- wrong branch or repository selection
- task description generation omitted critical context
- repo workspace is missing git history

Check:

- `task_s3_key` content in the task bucket
- chosen `related_code`
- workspace contents under `/mnt/efs/specter-repo/repositories/tasks/task-<id>`

### Result never reaches JIRA

Possible causes:

- task completed but posting failed
- JIRA comment API failure
- result row was released back to `completed` for retry

Check:

```sql
SELECT jira_number, status, retry_count, error_message, jira_posted_at
FROM task_management
WHERE jira_number = '<ISSUE-KEY>';
```

## Useful endpoints

When using `worker-main.ts`:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/status
curl http://localhost:8080/metrics
curl -N http://localhost:8080/events
```

## Practical debugging order

1. Verify the JIRA issue was assigned to DARCI.
2. Verify a DARCI worker is alive and claiming work.
3. Verify the task markdown exists in S3.
4. Verify the EFS workspace exists and contains the expected repos.
5. Inspect worker logs and the status API.
6. Inspect `tasks.error_message` and posting retry state if the analysis finished.
