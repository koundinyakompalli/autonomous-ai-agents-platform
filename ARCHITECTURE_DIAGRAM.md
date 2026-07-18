# Specter Architecture Diagrams

## 1. End-to-end runtime

```text
                        +----------------------+
                        |        JIRA          |
                        +----------+-----------+
                                   |
                                   | poll by JQL
                                   v
+----------------------+   +-------+--------+    +----------------------+
| Microsoft Teams      |   |  Orchestrator  |    |      Harvey          |
| users talk to Harvey +---> (background)   |<---+  Teams bot service   |
+----------+-----------+   +-------+--------+    +----------+-----------+
           |                           |                      |
           | proactive delivery        | create assignments   | create assignments
           |                           v                      v
           |                 +---------+----------------------+
           |                 |           MySQL                |
           |                 | agents / customer_branches     |
           |                 | code_repositories              |
           |                 | task_management / tasks        |
           |                 | chat_sessions                  |
           |                 +---------+----------------------+
           |                           |
           |                           | workers poll and claim
           |                           v
           |                +----------+-----------+
           |                |    Agent workers     |
           |                | DARCI / SCRIBE /     |
           |                | PRISM / HERMES /     |
           |                | SENTRY / BEACON /    |
           |                | BCAT / VERITAS       |
           |                +----+------------+----+
           |                     |            |
           |                     |            |
           v                     v            v
  +--------+---------+   +-------+----+   +--+-----------------+
  | Teams delivery   |   | Shared EFS |   | Shared S3 buckets  |
  | via ResultNotifier|  | repos/tasks|   | tasks + results    |
  +------------------+   +------------+   +--------------------+
```

## 2. JIRA task assignment flow

```text
JIRA issue
  -> Orchestrator fetches full issue
  -> resolve customer branch
  -> analyze relevant repositories
  -> generate markdown task description
  -> upload to <prefix>-tasks
  -> insert task_management(status='assigned')
```

State change sequence:

```text
assigned -> in_progress -> completed -> posting_to_jira -> posted_to_jira
```

If posting fails, the orchestrator releases the claim back to `completed` and increments retry count.

## 3. Harvey task flow

```text
Teams message
  -> Harvey IntakeAgent resolves agent/customer/repos
  -> TaskCreator uploads task markdown
  -> task_management(source='harvey', status='assigned')
  -> worker processes task
  -> ResultNotifier reads result from S3
  -> proactive Teams delivery
```

Chat session states:

```text
active -> routing -> task_created -> delivering -> delivered
```

Sessions can also move to `completed` or `abandoned` depending on follow-up and cleanup flow.

## 4. Worker internals

```text
task_management row claimed
        |
        v
create tasks row
        |
        v
download task markdown from S3
        |
        v
prepare workspace on EFS
  /mnt/efs/specter-repo/repositories/tasks/task-<id>
        |
        v
register repo IDs / workspace with Claude SDK runner
        |
        v
run agent with hooks + output schema
        |
        v
upload markdown result to <prefix>-results
        |
        v
update tasks + task_management
```

## 5. Monitoring surface

Only workers started through `src/worker-main.ts` expose the embedded status server:

```text
GET /health
GET /status
GET /status/:taskId
GET /history
GET /metrics
GET /events      (SSE)
WS  /            (WebSocket)
```

The orchestrator exposes a separate lightweight health endpoint only.

## 6. Important design boundaries

- Orchestrator and workers coordinate through MySQL and S3, not RPC.
- Workers share repository state through EFS and create isolated per-task workspaces.
- Claude Agent SDK execution is centralized in `src/claude-sdk`.
- Harvey is not a special-case executor; it feeds the same task pipeline as JIRA.
