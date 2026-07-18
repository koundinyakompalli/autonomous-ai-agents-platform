# Specter Overview

Specter is a durable work orchestration system for AI-assisted engineering tasks. It is designed around asynchronous handoff, not request/response execution:

- JIRA tickets and Teams messages become durable task records.
- Workers process those tasks independently against shared repositories on EFS.
- Results are written back to S3 and then delivered to either JIRA or Teams.

## What the system does

Specter currently supports:

- automated defect investigation
- code explanation and walkthroughs
- implementation planning
- configuration lookup
- SQL safety review
- MOANA SQL validation
- bulk ticket planning and creation from spreadsheets
- evidence-based RCA generation

## Runtime surfaces

### Orchestrator

The orchestrator is a background service that:

- polls JIRA using agent JQL from the `agents` table
- fetches full ticket context
- resolves customer branch and related repositories
- generates a focused markdown task description
- stores that task description in S3
- creates a `task_management` row for worker pickup
- later posts completed JIRA-originated results back to the issue

### Workers

Each worker is a separate process or ECS service for one agent type. Workers:

- poll MySQL for assigned work
- claim tasks atomically
- create a per-task workspace under the shared EFS tree
- run the agent through the shared Claude Agent SDK runner
- upload result markdown to S3
- update task state for posting or delivery

### Harvey

Harvey is the conversational front door. It runs as a Teams bot and:

- accepts free-form user requests
- resolves likely agent, customer, and repositories
- creates `task_management` rows through the same task pipeline as the orchestrator
- watches for completion and proactively sends results back to the user

## Control plane and data plane

```text
Control plane
  MySQL:
    agents
    customer_branches
    code_repositories
    task_management
    tasks
    chat_sessions

Data plane
  EFS:
    shared repositories and task workspaces

  S3:
    task description markdown
    result markdown
```

This split matters because the expensive payloads are not kept inline in MySQL. The database stores pointers and state; S3 stores the long-form task and result documents.

## Primary tables

| Table | Purpose |
| --- | --- |
| `agents` | active agent definitions, models, JQL, optional agent-specific JIRA creds |
| `customer_branches` | customer-to-branch mapping |
| `code_repositories` | repository metadata used during repo selection and workspace setup |
| `task_management` | durable work assignment and lifecycle state |
| `tasks` | worker execution record, metrics, and result S3 location |
| `chat_sessions` | Harvey conversation state and delivery lifecycle |

## Task lifecycle

### JIRA-originated

1. Orchestrator finds a matching issue.
2. It enriches the issue and stores a generated task description in S3.
3. It inserts `task_management` with status `assigned`.
4. A worker claims the row and creates a `tasks` execution record.
5. The worker runs the agent and uploads the result.
6. `task_management` moves to `completed`.
7. The orchestrator claims the row for posting and comments on the JIRA issue.
8. `task_management` moves to `posted_to_jira`.

### Harvey-originated

1. Harvey resolves intent and creates a task description in S3.
2. It inserts `task_management` with `source='harvey'`.
3. A worker processes it exactly like JIRA work.
4. Harvey's notifier claims the completed session and pushes the result to Teams.
5. The chat session moves through `task_created` -> `delivering` -> `delivered`.

## Storage layout

```text
S3 task bucket
  tasks/<jira-or-reference>/<timestamp>.md

S3 result bucket
  results/<agent>/<jira-or-reference>/<taskId>-<timestamp>.md

EFS repositories
  /mnt/efs/specter-repo/repositories/<repo>
  /mnt/efs/specter-repo/repositories/tasks/task-<task_management_id>
```

## Current tradeoffs

The architecture is strong on async durability and operational separation, but there are still important caveats:

- the orchestrator owns too much synchronous enrichment logic
- some worker code assumes a specific EFS path layout
- the docs historically drifted from the runtime and needed consolidation
- the schema still contains secret-seeding patterns that should not be repeated

That said, the core platform shape is sound: durable DB state, S3 for payload handoff, shared EFS repositories, and stateless-ish workers that can scale horizontally.
