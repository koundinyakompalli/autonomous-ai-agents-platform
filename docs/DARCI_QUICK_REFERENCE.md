# DARCI Quick Reference

## Start locally

```bash
WORKER_TYPE=DARCI STATUS_PORT=8080 npm run worker
```

## Status endpoints

```bash
curl http://localhost:8080/health
curl http://localhost:8080/status
curl http://localhost:8080/metrics
curl -N http://localhost:8080/events
```

## Useful SQL

```sql
SELECT * FROM v_agent_workload;

SELECT tm.jira_number, tm.status, t.status AS task_status, t.error_message
FROM task_management tm
LEFT JOIN tasks t ON t.id = tm.task_id
JOIN agents a ON a.id = tm.agent_id
WHERE a.name = 'DARCI'
ORDER BY tm.updated_at DESC
LIMIT 20;
```

## Expected happy-path states

```text
task_management: assigned -> in_progress -> completed -> posted_to_jira
tasks:           pending  -> in_progress -> completed
```

## First places to look when it breaks

- worker logs
- `tasks.error_message`
- task markdown in S3
- workspace path under `/mnt/efs/specter-repo/repositories/tasks/`
