# Specter Orchestrator

The orchestrator is the background control-plane service for JIRA-originated work.

## Responsibilities

- poll JIRA using JQL stored in the `agents` table
- fetch complete issue context for matching tickets
- resolve customer branch and relevant repositories
- generate a task description markdown document from the full issue
- upload the task description to the shared S3 task bucket
- create or reuse a `task_management` row
- monitor completed JIRA-originated tasks
- post results back to JIRA and optionally reassign the ticket

It does not execute agent logic itself.

## Runtime shape

```text
JIRA -> Orchestrator -> MySQL task_management/tasks -> Workers -> S3 results
                                     ^
                                     |
                               Orchestrator posts back
```

## Entrypoint

```bash
npm run orchestrator
```

Compiled entrypoint:

```text
dist/orchestrator/index.js
```

## Health endpoint

The orchestrator starts a simple HTTP health server on `STATUS_HOST:STATUS_PORT` and exposes:

```text
GET /health
```

This is only for container health checks. The richer task status API lives in worker processes, not the orchestrator.

## Required configuration

Minimum required environment for startup:

```bash
DB_HOST=localhost
DB_PORT=13306
DB_USER=your-user
DB_PASSWORD=your-password
DB_NAME=Specter

JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_USERNAME=your-email@example.com
JIRA_TOKEN=your-jira-token

AWS_REGION=us-east-2
S3_BUCKET_PREFIX=specter
```

Important optional settings:

```bash
JIRA_POLLING_INTERVAL_MS=60000
RESULT_CHECK_INTERVAL_MS=30000
AUTO_REASSIGN_TICKETS=false
STATUS_HOST=0.0.0.0
STATUS_PORT=8080
LOG_LEVEL=info
```

## What gets written where

### MySQL

- `task_management`: durable assignment, source, status, retry state, S3 pointer to task markdown
- `tasks`: execution record, result S3 pointer, metrics, error state

### S3

- task descriptions: `<prefix>-tasks/tasks/<jira>/<timestamp>.md`
- result documents: `<prefix>-results/results/<agent>/<jira>/<taskId>-<timestamp>.md`

## Assignment flow

For each matching JIRA issue, the orchestrator:

1. resolves the customer from known custom fields or labels
2. maps customer to a branch through `customer_branches`
3. uses repository analysis to choose relevant repos
4. generates a focused markdown task description from the full issue, comments, and supported attachments
5. uploads the task description to S3
6. inserts `task_management` with status `assigned`

Duplicate protection is enforced by the unique key on `task_management (jira_number, agent_id)`. If the same issue is already assigned to the same agent, the existing row is reused.

## Result posting flow

Only rows with `source='jira'` are eligible for JIRA posting. The orchestrator:

1. reads pending rows from `v_pending_jira_posts`
2. atomically claims the row by switching `completed -> posting_to_jira`
3. downloads the result markdown from S3
4. posts the result comment to the JIRA issue
5. marks the row `posted_to_jira`

If posting fails, the claim is released back to `completed` and `retry_count` is incremented so the next cycle can retry.

## Related tables and views

| Object | Use |
| --- | --- |
| `agents` | active JQL, model, task type, optional agent-specific JIRA creds |
| `customer_branches` | customer -> branch mapping |
| `code_repositories` | repository metadata used by repo analysis and workers |
| `task_management` | assignment lifecycle |
| `tasks` | execution lifecycle |
| `v_active_tasks` | current assignments and execution details |
| `v_agent_workload` | simple operational workload summary |
| `v_pending_jira_posts` | completed JIRA-originated work awaiting posting |

## Local development

1. Build the project:

```bash
npm install
npm run build
```

2. Apply the schema:

```bash
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p < db/schema.sql
```

3. Start the orchestrator:

```bash
npm run orchestrator
```

4. Start at least one worker in another terminal:

```bash
WORKER_TYPE=DARCI npm run worker
```

Without workers, the orchestrator will assign work but nothing will process it.

## Operational cautions

- The current codebase still includes legacy credential fallbacks and seeded repository credentials in `db/schema.sql`. Treat those as technical debt, not deployment guidance.
- The orchestrator performs several enrichment steps inline in one assignment path. Failures in repo analysis, task generation, or S3 upload all block assignment.
- Terraform deploys the orchestrator as a Fargate service and injects secrets from Secrets Manager. That is the preferred production model.
