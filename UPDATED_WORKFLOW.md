# Current Task Workflow

This document reflects the current end-to-end task lifecycle in Specter.

## High-level flow

```text
JIRA issue or Teams request
  -> resolve agent/customer/repos
  -> generate task markdown
  -> store task markdown in S3
  -> insert task_management row
  -> worker claims task
  -> worker creates EFS workspace
  -> agent runs through Claude Agent SDK
  -> result markdown uploaded to S3
  -> result delivered to JIRA or Teams
```

## JIRA-originated flow

### 1. Issue discovery

The orchestrator polls JIRA using the active agents' JQL queries from the database.

### 2. Issue enrichment

For each issue, the orchestrator:

- fetches the full JIRA issue
- resolves the customer branch
- chooses relevant repositories
- generates a markdown task description from the issue body, comments, and supported attachments

### 3. Task staging

The generated task document is uploaded to:

```text
<prefix>-tasks/tasks/<jira-number>/<timestamp>.md
```

Then `task_management` is inserted with:

- `status='assigned'`
- `source='jira'`
- `task_s3_bucket`
- `task_s3_key`
- `related_code` as CSV repo IDs

### 4. Worker execution

The matching worker:

- claims the row atomically
- creates a `tasks` row
- downloads the task markdown from S3
- prepares a workspace under `/mnt/efs/specter-repo/repositories/tasks/task-<task_management_id>`
- runs the agent
- uploads the result markdown to the shared results bucket

### 5. Posting

After worker completion:

- `task_management` moves to `completed`
- the orchestrator claims it for posting
- the result is posted back to JIRA
- `task_management` moves to `posted_to_jira`

## Harvey-originated flow

Harvey uses the same worker pipeline with a different delivery path.

### 1. Intake

Harvey accepts a Teams message and resolves:

- target agent
- customer
- repository set
- task description

### 2. Task creation

`TaskCreator` uploads the task markdown and inserts `task_management` with:

- `source='harvey'`
- `jira_number='HARVEY-<chat_session_id>'` unless the user provides an issue key
- `chat_session_id`

### 3. Worker execution

Workers process Harvey tasks exactly like JIRA tasks.

### 4. Teams delivery

`ResultNotifier` watches for:

- `chat_sessions.status='task_created'`
- linked `task_management.status='completed'`

It then downloads the result, proactively sends it back to Teams, and marks the session delivered.

## Database state transitions

### task_management

```text
assigned
  -> in_progress
  -> completed
  -> posting_to_jira
  -> posted_to_jira
```

Failure path:

```text
assigned or in_progress -> failed
completed -> posting_to_jira -> completed   (if posting retry is needed)
```

### tasks

```text
pending -> in_progress -> completed
pending -> in_progress -> failed
```

### chat_sessions

```text
active -> routing -> task_created -> delivering -> delivered
```

Additional states:

- `completed`: session closed with a reusable summary
- `abandoned`: stale or user-reset session

## Current storage layout

```text
Task bucket:
  <prefix>-tasks/tasks/<reference>/<timestamp>.md

Result bucket:
  <prefix>-results/results/<agent>/<reference>/<taskId>-<timestamp>.md
```

## Why S3 is in the loop

The task and result documents can be much larger than the lifecycle metadata stored in MySQL. The current design keeps:

- state and routing metadata in MySQL
- large markdown payloads in S3

This makes retries, audits, and multi-service handoff simpler without forcing oversized text blobs into the control-plane tables.
