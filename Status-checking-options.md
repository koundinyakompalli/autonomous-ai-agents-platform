# Worker Status Checking Options

The embedded status API is available only when a worker is started through `src/worker-main.ts` or `dist/worker-main.js`.

## Endpoints

```text
GET /health
GET /status
GET /status/:taskId
GET /history?count=100
GET /metrics
GET /events          # SSE
WS  /                # WebSocket
```

## Local development

Start a worker:

```bash
WORKER_TYPE=DARCI STATUS_PORT=8080 npm run worker
```

Then query it:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/status
curl -N http://localhost:8080/events
```

## ECS access through a bastion or tunnel

1. Find the worker task private IP.
2. Tunnel `localhost:<local-port>` to `<task-private-ip>:<status-port>`.
3. Query the local forwarded port.

Example tunnel pattern:

```bash
ssh -L 8080:<task-private-ip>:8080 <user>@<bastion-host>
curl http://localhost:8080/status
```

## WebSocket usage

Typical client messages:

```json
{ "type": "subscribe_all" }
{ "type": "subscribe", "taskIds": ["task-123"] }
{ "type": "get_status" }
{ "type": "get_history", "count": 20 }
{ "type": "ping" }
```

## Important caveat

Some package scripts still use the older `dist/orchestrator/workers/index.js` entrypoint. That path executes work, but it does not start the embedded status server. If you need `/status`, `/events`, or WebSocket monitoring, use `npm run worker` with `WORKER_TYPE=<agent>`.
