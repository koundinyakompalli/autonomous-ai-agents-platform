# Specter

Specter is an async AI-agent platform for engineering work. It has three primary runtime surfaces:

- `orchestrator`: polls JIRA, enriches tickets, creates durable work items, and posts results back.
- `workers`: claim tasks from MySQL, prepare repository context from shared cache plus isolated workspaces, run specialized agents through the Claude Agent SDK on Bedrock, and upload results to S3.
- `harvey`: a Microsoft Teams bot that routes free-form requests into the same task pipeline and delivers results back to chat.

The codebase also contains a separate marketing site in `marketing/`.

## Governance First

Reviewers evaluating MERIDIAN or Investigation Cockpit for AI governance should
start with [AI_GOVERNANCE_COMPLIANCE.md](./AI_GOVERNANCE_COMPLIANCE.md). It
maps the safeguards, policies, runtime boundaries, and code evidence that make
MERIDIAN and Investigation Cockpit suitable for governed healthcare support
review.

## Current Architecture

```text
JIRA issues or Teams requests
            |
            v
   +-------------------+
   |  Orchestrator /   |
   |     Harvey        |
   +-------------------+
            |
            v
   +-------------------+
   | MySQL task state  |
   |  task_management  |
   |      tasks        |
   |   chat_sessions   |
   +-------------------+
            |
            v
   +-------------------+
   |   Agent workers   |
   | DARCI / SCRIBE /  |
   | PRISM / HERMES /  |
   | SENTRY / BEACON / |
   | BCAT / VERITAS    |
   +-------------------+
      |            |
      v            v
  repo cache    S3 tasks/results
```

Important implementation details:

- The orchestrator and workers do not talk to each other directly. Coordination is through MySQL state and S3 object pointers.
- Task descriptions are generated from enriched source context and stored in the shared task bucket as markdown.
- All worker result artifacts are stored in a single shared result bucket, partitioned by key prefix, not by per-agent buckets.
- Harvey uses the same `task_management` flow as JIRA-originated work instead of a separate execution path.

## Agents

| Agent | Purpose |
| --- | --- |
| `DARCI` | Defect analysis and root-cause investigation |
| `SCRIBE` | Code explanation and endpoint behavior walkthroughs |
| `PRISM` | Implementation planning and requirement refinement |
| `HERMES` | Configuration and environment lookup |
| `SENTRY` | SQL safety review against application models |
| `BEACON` | MOANA SQL validation against HBM models |
| `BCAT-PLANNER` | Bulk ticket planning from Excel attachments |
| `BCAT-EXECUTOR` | Bulk ticket creation and linking |
| `VERITAS` | Evidence-driven RCA synthesis from JIRA and repos |

## Repository Layout

```text
.
├── src/
│   ├── agents/              # Agent wrappers and domain logic
│   ├── claude-sdk/          # Shared Claude Agent SDK runner, schemas, hooks
│   ├── orchestrator/        # JIRA polling, assignment, workers, status server
│   ├── harvey/              # Teams bot, intake, sessions, result delivery
│   ├── worker-main.ts       # Preferred worker entrypoint with status API
│   ├── harvey-main.ts       # Harvey service entrypoint
│   └── index.ts             # Package exports
├── db/schema.sql            # MySQL schema and seed data
├── agent-docs/              # Deep session handoff docs for future agent work
├── plans/                   # Recommended enhancement roadmap and initiative plans
├── terraform/               # AWS ECS/ECR/S3/IAM/ALB infrastructure
├── teams/                   # Teams app manifest and packaging assets
├── marketing/               # Separate Next.js marketing site
└── docs/                    # Detailed architecture and operations docs
```

## Prerequisites

- Node.js 20+
- npm
- MySQL reachable locally or through a tunnel
- AWS credentials or IAM role with Bedrock and S3 access
- Access to the shared repository cache for worker execution
- JIRA credentials for orchestrator and JIRA-backed agents

## Quick Start

1. Install dependencies and build:

```bash
npm install
npm run build
```

2. Copy `.env.example` to `.env` and fill in real values.

3. Apply the schema:

```bash
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p < db/schema.sql
```

4. Start the orchestrator:

```bash
npm run orchestrator
```

### Investigation Cockpit Local Startup

For the operator LDAP SSH startup flow, including the required AWS SSO refresh
for CloudWatch/S3 evidence collection, see
`docs/MERIDIAN_INVESTIGATION_COCKPIT_ARCHITECTURE.md#local-operator-startup`.

5. Start one or more workers:

```bash
WORKER_TYPE=DARCI npm run worker
WORKER_TYPE=SCRIBE npm run worker
```

6. Start Harvey when you want Teams intake enabled:

```bash
npm run harvey
```

## Environment

`.env.example` is the current reference for local configuration. The most important variables are:

- Database: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- JIRA: `JIRA_BASE_URL`, `JIRA_USERNAME`, `JIRA_TOKEN`
- AWS / Bedrock: `AWS_REGION`, `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`
- S3: `S3_BUCKET_PREFIX`
- Repo storage: `REPOSITORY_PATH`, `DOCUMENTS_PATH`
- Worker status server: `WORKER_TYPE`, `STATUS_PORT`, `STATUS_HOST`
- Harvey: `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`, `HARVEY_PORT`, `HARVEY_HOST`

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript |
| `npm run type-check` | Run TypeScript without emitting files |
| `npm run orchestrator` | Start the JIRA polling service |
| `npm run worker` | Start the preferred worker entrypoint (`WORKER_TYPE` required) |
| `npm run harvey` | Start the Teams bot service |
| `npm test -- --run` | Run Vitest if tests exist |

Notes:

- `worker-main.ts` is the preferred runtime because it includes the status server.
- Some package scripts still point at the older `dist/orchestrator/workers/index.js` entrypoint. That path works for task execution, but it does not expose the embedded status API.

## Storage and Paths

Current shared path and object layout:

```text
EFS
└── /mnt/efs/specter-repo/
    ├── repositories/
    │   ├── <repo>/
    │   └── tasks/
    │       └── task-<task_management_id>/
    └── documents/

S3
├── <prefix>-tasks
│   └── tasks/<jira-or-reference>/<timestamp>.md
└── <prefix>-results
    └── results/<agent>/<jira-or-reference>/<taskId>-<timestamp>.md
```

## Documentation Map

- [docs/00-INDEX.md](docs/00-INDEX.md): docs index
- [docs/01-GETTING-STARTED.md](docs/01-GETTING-STARTED.md): local setup
- [docs/02-ARCHITECTURE.md](docs/02-ARCHITECTURE.md): runtime architecture
- [ORCHESTRATOR_README.md](ORCHESTRATOR_README.md): orchestrator-specific behavior
- [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md): build and deploy flow
- [docs/AGENT_ONBOARDING_RUNBOOK.md](docs/AGENT_ONBOARDING_RUNBOOK.md): governed onboarding and activation flow for new worker families
- [docs/STATUS_API.md](docs/STATUS_API.md): worker monitoring API
- [teams/README.md](teams/README.md): Teams packaging and Harvey deployment
- [plans/README.md](plans/README.md): recommended enhancement roadmap
- [agent-docs/README.md](agent-docs/README.md): deep agent-session memory bank and end-to-end agent implementation/deployment guide

## Operational Notes

- The project builds successfully with `npm run build`.
- The root Vitest command currently reports no test files if you run `npm test -- --run`.
- The schema and code still contain legacy seeded credential patterns. Do not copy those patterns into new environments; use Secrets Manager or secure environment injection instead.
