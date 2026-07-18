# Local OneShot Cluster

This folder contains the local Podman + Moto deployment for the Specter OneShot
runtime. Use it when you need to test OneShot changes locally instead of pushing
to AWS ECS for every iteration.

The cluster mirrors the production shape closely enough for local development:

- MySQL with the `Specter` database
- Moto for local AWS S3 and SQS
- Dashboard
- Orchestrator
- QUALIFIER worker
- OneShot stage consumers: planner, reviewer, implementer, code reviewer, tester

## Files

- `docker-compose.yml` - Podman Compose stack definition.
- `setup.sh` - Initializes MySQL schema, Moto S3 bucket, and Moto SQS queues.
- `env.local.example` - Template for local secrets and port overrides.
- `../scripts/local-oneshot-cluster.sh` - Main command for agents to use.

## Prerequisites

Install and verify:

- Podman with `podman compose`
- Node.js 20+
- npm
- AWS CLI

The setup script uses the host AWS CLI to create Moto resources via
`--endpoint-url`. The runtime containers use Moto internally at `http://moto:5000`.

Confirm Podman works:

```bash
podman info
podman compose version
```

Confirm project dependencies are installed:

```bash
npm ci
npm --prefix dashboard ci
```

## Environment

Create `.env.local` in the repo root. Start from:

```bash
cp local-oneshot/env.local.example .env.local
```

Required for real OneShot work:

```bash
GITHUB_REPO_TOKEN=...
GITHUB_WRITE_TOKEN=...
OPENAI_API_KEY=...
```

Required because the orchestrator is part of the default local cluster:

```bash
JIRA_BASE_URL=...
JIRA_USERNAME=...
JIRA_TOKEN=...
```

If you only want infra or consumers without orchestrator, use `--no-orchestrator`.

Set this when Artifactory is unavailable and Maven proof should be skipped as
unverified instead of failing the run:

```bash
ONESHOT_MAVEN_BUILDS_ENABLED=false
```

Required only when `ONESHOT_MAVEN_BUILDS_ENABLED=true` for full-delivery MedHOK
Maven smoke runs such as CPDEV-21980:

```bash
ARTIFACTORY_HOST=dev.medhokapps.com
MAVEN_USER=...
MAVEN_PASSWORD=...
```

`ARTIFACTORY_HOST` must be host-only. Do not include `https://`,
`/artifactory`, or any path. Repo-local `.m2/settings.xml` builds URLs as
`https://${env.ARTIFACTORY_HOST}/artifactory/...`, and the smoke harness fails
fast if that would expand to `https:///artifactory/...`.

To print a secret-safe Maven preflight report:

```bash
node scripts/run-cpdev-local-smoke.mjs --diagnose-maven-env
```

The script also tries `aws configure export-credentials --format env` so
Bedrock-backed stages can use your current AWS session. Moto itself uses local
test credentials.

## AWS Credentials

There are two separate AWS credential paths in local mode.

### Bedrock Credentials

Planner, implementer, QUALIFIER, and any Claude/Bedrock-backed path need real
AWS credentials. Use your normal local AWS profile/session for these calls.

Before starting the cluster, make sure your AWS profile can call Bedrock:

```bash
aws sts get-caller-identity
```

If your org uses SSO or temporary credentials, refresh them first:

```bash
aws sso login --profile <profile>
export AWS_PROFILE=<profile>
```

Then start the cluster. The script attempts:

```bash
aws configure export-credentials --format env
```

and passes the resulting `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and
`AWS_SESSION_TOKEN` into the local containers. Those credentials are for real
Bedrock calls only.

### Moto Credentials

Moto does not need real AWS credentials. Local S3 and SQS calls use fake
credentials:

```bash
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_DEFAULT_REGION=us-east-2
```

The compose stack points local S3 and SQS SDK calls at Moto with service-specific
endpoint variables:

```bash
AWS_ENDPOINT_URL_S3=http://moto:5000
AWS_ENDPOINT_URL_SQS=http://moto:5000
```

Do not set the generic `AWS_ENDPOINT_URL` for the local cluster. Bedrock-backed
components need real AWS endpoints, while only S3 and SQS should use Moto.

The setup verification commands use host-side Moto:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-2 \
  aws --endpoint-url http://127.0.0.1:5002 sqs list-queues
```

Do not use real AWS endpoints for local S3/SQS queue setup. Real credentials are
only for Bedrock-backed agent execution.

## Start The Cluster

Full local cluster:

```bash
scripts/local-oneshot-cluster.sh up --build
```

Start without orchestrator:

```bash
scripts/local-oneshot-cluster.sh up --build --no-orchestrator
```

Start only MySQL and Moto:

```bash
scripts/local-oneshot-cluster.sh up --no-consumers --no-dashboard
```

Show status:

```bash
scripts/local-oneshot-cluster.sh ps
```

Tail logs:

```bash
scripts/local-oneshot-cluster.sh logs
```

Stop containers:

```bash
scripts/local-oneshot-cluster.sh down
```

Reset local volumes and workspaces:

```bash
scripts/local-oneshot-cluster.sh reset
```

Use `reset` when schema changes need a clean `Specter` database. Normal `up`
keeps the MySQL volume and skips reapplying `db/schema.sql` when the OneShot
schema is already present.

## Containers And Ports

Default cluster containers:

| Container | Purpose | Host Port |
| --- | --- | --- |
| `specter-oneshot-mysql` | MySQL 8.4, database `Specter` | `3307 -> 3306` |
| `specter-oneshot-moto` | Moto S3/SQS | `5002 -> 5000` |
| `specter-oneshot-dashboard` | Dashboard | `3001 -> 3001` |
| `specter-oneshot-orchestrator` | Jira/dashboard request orchestrator | `18085 -> 8080` |
| `specter-oneshot-qualifier` | `WORKER_TYPE=QUALIFIER` | `18086 -> 8080` |
| `specter-oneshot-planner` | `ONESHOT_ROLE=PLANNER` | `18080 -> 8080` |
| `specter-oneshot-reviewer` | `ONESHOT_ROLE=REVIEWER` | `18081 -> 8080` |
| `specter-oneshot-implementer` | `ONESHOT_ROLE=IMPLEMENTER` | `18082 -> 8080` |
| `specter-oneshot-code-reviewer` | `ONESHOT_ROLE=CODE_REVIEWER` | `18083 -> 8080` |
| `specter-oneshot-tester` | `ONESHOT_ROLE=TESTER` | `18084 -> 8080` |

Dashboard:

```bash
open http://localhost:3001/oneshot
```

Health endpoints:

```bash
curl http://localhost:18080/ready  # planner
curl http://localhost:18081/ready  # reviewer
curl http://localhost:18082/ready  # implementer
curl http://localhost:18083/ready  # code reviewer
curl http://localhost:18084/ready  # tester
curl http://localhost:18085/health # orchestrator
curl http://localhost:18086/health # qualifier
```

## Database

The MySQL container creates and uses database `Specter`.

`setup.sh` applies:

```bash
db/schema.sql
```

That schema contains the base Specter tables and the OneShot tables, including:

- `agents`
- `tasks`
- `task_management`
- `customer_branches`
- `code_repositories`
- `oneshot_run_groups`
- `oneshot_runs`
- `oneshot_artifacts`
- `oneshot_notifications`
- `oneshot_run_events`
- `oneshot_deployments`
- `oneshot_dashboard_run_requests`

Connect from the host:

```bash
mysql -h 127.0.0.1 -P 3307 -uroot -pspecter_local Specter
```

Or through Podman:

```bash
podman exec -it specter-oneshot-mysql mysql -uroot -pspecter_local Specter
```

Quick table check:

```bash
podman exec specter-oneshot-mysql \
  mysql -uroot -pspecter_local -Nse \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='Specter' ORDER BY table_name"
```

## Moto Resources

Moto is available on the host at:

```bash
http://localhost:5002/moto-api/
```

Inside containers it is:

```bash
http://moto:5000
```

The setup creates:

- S3 buckets: `specter-local-results`, `specter-local-tasks`
- FIFO queues:
  - `oneshot-planning.fifo`
  - `oneshot-review.fifo`
  - `oneshot-implementation.fifo`
  - `oneshot-code-review.fifo`
  - `oneshot-testing.fifo`
- Matching DLQs for each queue

List queues:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-2 \
  aws --endpoint-url http://127.0.0.1:5002 sqs list-queues
```

List buckets:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-2 \
  aws --endpoint-url http://127.0.0.1:5002 s3 ls
```

## Local Data Directories

The compose stack bind-mounts:

- `local-oneshot/data/repo-admin`
- `local-oneshot/data/repositories`
- `local-oneshot/data/workspaces`

These are ignored by git. Put local repository/admin clones there when testing
flows that require repository inspection or workspace creation.

Container paths:

- Repo admin base: `/mnt/efs/specter-repo/repo-admin`
- Repository base: `/mnt/efs/specter-repo/repositories`
- OneShot workspace base: `/mnt/efs/specter-repo/oneshot`

## Common Workflows

Rebuild after TypeScript or dashboard changes:

```bash
scripts/local-oneshot-cluster.sh up --build
```

Restart one service:

```bash
podman compose -f local-oneshot/docker-compose.yml restart planner
```

Tail one service:

```bash
podman logs -f specter-oneshot-planner
```

Reinitialize Moto resources without rebuilding:

```bash
scripts/local-oneshot-cluster.sh setup
```

Clean database and Moto state:

```bash
scripts/local-oneshot-cluster.sh reset
scripts/local-oneshot-cluster.sh up --build
```

## Troubleshooting

`orchestrator requires JIRA_BASE_URL, JIRA_USERNAME, and JIRA_TOKEN`

Set those values in `.env.local`, or start with:

```bash
scripts/local-oneshot-cluster.sh up --no-orchestrator
```

`Consumers may fail validation until these are exported`

Set these in `.env.local`:

```bash
GITHUB_REPO_TOKEN=...
GITHUB_WRITE_TOKEN=...
OPENAI_API_KEY=...
```

Consumer fails on repo-admin path

Ensure this directory exists. The setup script creates it automatically, but a
reset or manual cleanup can remove it:

```bash
mkdir -p local-oneshot/data/repo-admin local-oneshot/data/repositories local-oneshot/data/workspaces
```

Schema change does not appear

The MySQL volume is persistent. Reset the stack:

```bash
scripts/local-oneshot-cluster.sh reset
scripts/local-oneshot-cluster.sh up --build
```

Port collision

Override ports in `.env.local`, for example:

```bash
ONESHOT_LOCAL_MYSQL_PORT=3317
ONESHOT_MOTO_PORT=5012
ONESHOT_DASHBOARD_PORT=3011
```

Moto queue or bucket missing

Run setup again:

```bash
scripts/local-oneshot-cluster.sh setup
```

Then verify with the AWS CLI commands in the Moto section.

## Notes For Agents

- Prefer `scripts/local-oneshot-cluster.sh` over direct compose commands for
  normal setup because it builds TypeScript, starts infra first, and initializes
  DB/S3/SQS before app containers validate runtime dependencies.
- Do not commit `.env.local` or anything under `local-oneshot/data/`.
- If adding new queues, update both `docker-compose.yml` environment variables
  and `setup.sh` resource creation.
- If adding new persistent tables, update `db/schema.sql`; use `reset` locally
  to rebuild the database from scratch.
