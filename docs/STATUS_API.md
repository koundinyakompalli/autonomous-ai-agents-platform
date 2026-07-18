# Status API

The worker status API is implemented by `src/orchestrator/StatusServer.ts` and is available when workers run through `src/worker-main.ts`.

## REST endpoints

### `GET /health`

Response:

```json
{
  "status": "healthy",
  "timestamp": "2026-03-19T12:00:00.000Z",
  "activeTasks": 1,
  "connectedClients": 0,
  "sseClients": 0
}
```

### `GET /status`

Returns all tracked task statuses:

```json
{
  "count": 1,
  "tasks": {
    "task-123": {
      "taskId": "task-123",
      "jiraNumber": "CPDEV-123",
      "agentName": "DARCI",
      "status": "in_progress",
      "toolCalls": 4,
      "phase": "processing",
      "startTime": "2026-03-19T12:00:00.000Z",
      "lastUpdate": "2026-03-19T12:01:00.000Z",
      "toolsUsed": ["Read", "Grep", "Bash"],
      "metrics": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cost": 0,
        "durationMs": 0
      }
    }
  },
  "timestamp": "2026-03-19T12:01:00.000Z"
}
```

### `GET /status/:taskId`

Returns a single task snapshot or a `404` if the task is not currently tracked.

### `GET /history?count=100`

Returns recent events:

```json
{
  "count": 2,
  "events": [
    {
      "timestamp": "2026-03-19T12:00:00.000Z",
      "event": "agent:start",
      "data": { "taskId": "task-123", "agentType": "DARCI" }
    }
  ],
  "timestamp": "2026-03-19T12:01:00.000Z"
}
```

### `GET /metrics`

Aggregated metrics across currently tracked tasks:

```json
{
  "totalTasks": 3,
  "completedTasks": 1,
  "failedTasks": 0,
  "inProgressTasks": 2,
  "pendingTasks": 0,
  "totalCost": 0.0132,
  "totalDurationMs": 45000,
  "totalToolCalls": 12,
  "averageCostPerTask": 0.0044,
  "averageDurationMs": 15000,
  "connectedClients": 1,
  "sseClients": 1,
  "timestamp": "2026-03-19T12:01:00.000Z"
}
```

### `GET /events`

SSE stream. Initial connection sends:

```json
{
  "timestamp": "2026-03-19T12:00:00.000Z",
  "activeTasks": ["task-123"]
}
```

## WebSocket

Connect to:

```text
ws://<host>:<port>
```

On connect the server sends:

```json
{
  "type": "connected",
  "clientId": "ws-123",
  "timestamp": "2026-03-19T12:00:00.000Z",
  "activeTasks": ["task-123"]
}
```

### Supported client messages

```json
{ "type": "subscribe", "taskIds": ["task-123"] }
{ "type": "subscribe_all" }
{ "type": "get_status", "taskId": "task-123" }
{ "type": "get_status" }
{ "type": "get_history", "count": 20 }
{ "type": "ping" }
```

### Server replies

- `connected`
- `subscribed`
- `status`
- `all_statuses`
- `history`
- `pong`

## Event types

Current built-in worker event bridge types:

- `agent:start`
- `agent:progress`
- `agent:tool`
- `agent:complete`
- `agent:error`

## Webhooks

Optional worker env:

```bash
ENABLE_WEBHOOKS=true
WEBHOOK_URL=https://example.com/hook
WEBHOOK_SECRET=change-me
```

When `WEBHOOK_SECRET` is set, payloads include an `X-Webhook-Signature` HMAC SHA-256 header.

## Important caveat

If you start workers through the older `dist/orchestrator/workers/index.js` path, none of this is available because that entrypoint does not initialize the status server.
