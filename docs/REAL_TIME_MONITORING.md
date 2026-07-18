# Real-Time Monitoring

Specter's real-time monitoring surface lives in worker processes started through `worker-main.ts`.

## What you get

- REST endpoints for current task state
- WebSocket subscriptions
- SSE event streaming
- optional webhook fan-out

## Local usage

```bash
WORKER_TYPE=DARCI STATUS_PORT=8080 npm run worker
curl http://localhost:8080/health
curl http://localhost:8080/status
curl -N http://localhost:8080/events
```

## ECS usage

Common pattern:

1. identify the worker task private IP
2. tunnel a local port to the status port
3. query the forwarded endpoint

Example shape:

```bash
ssh -L 8080:<task-private-ip>:8080 <user>@<bastion-host>
curl http://localhost:8080/status
```

## What events look like

Workers broadcast events shaped like:

```json
{
  "taskId": "task-123",
  "event": "agent:progress",
  "data": {
    "taskId": "task-123",
    "message": "Searching repository",
    "toolCalls": 4,
    "elapsed": 12000
  },
  "timestamp": "2026-03-19T12:00:00.000Z"
}
```

## CloudWatch still matters

The status API is excellent for live task state, but CloudWatch remains the source for:

- startup failures
- container crashes
- Terraform/ECS deployment issues
- stack traces and shell-level errors

Use both.
