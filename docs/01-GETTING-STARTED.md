# Getting Started

This guide gets the current Specter backend running locally.

## Prerequisites

- Node.js 20+
- npm
- MySQL access
- AWS credentials or an environment that can call Bedrock and S3
- access to the shared repository tree if you want workers to do real analysis

## 1. Install and build

```bash
npm install
npm run build
```

## 2. Configure environment

Use the current `.env.example` as the reference:

```bash
cp .env.example .env
```

Fill in at least:

```bash
DB_HOST=
DB_PORT=
DB_USER=
DB_PASSWORD=
DB_NAME=Specter

JIRA_BASE_URL=
JIRA_USERNAME=
JIRA_TOKEN=

AWS_REGION=
S3_BUCKET_PREFIX=

REPOSITORY_PATH=/mnt/efs/specter-repo/repositories
REPO_ADMIN_PATH=/mnt/efs/specter-repo/repo-admin
ONESHOT_REPO_ADMIN_BASE=/mnt/efs/specter-repo/repo-admin
ONESHOT_WORKSPACE_BASE=/mnt/efs/specter-repo/oneshot
DOCUMENTS_PATH=/mnt/efs/specter-repo/documents
```

Notes:

- `REPOSITORY_PATH` is the legacy shared repo tree used by standard workers
- `ONESHOT_REPO_ADMIN_BASE` is the preferred OneShot admin-clone root
- if `ONESHOT_REPO_ADMIN_BASE` is unset, OneShot falls back to `REPOSITORY_PATH`

If you want to run Harvey:

```bash
TEAMS_APP_ID=
TEAMS_APP_PASSWORD=
TEAMS_TENANT_ID=
```

## 3. Apply the schema

```bash
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p < db/schema.sql
```

Important note:

- `db/schema.sql` still contains legacy seed data patterns, including repository credentials. Treat that as historical baggage, not a recommended production practice.

## 4. Start the orchestrator

```bash
npm run orchestrator
```

The orchestrator needs working JIRA credentials or it will fail at startup.

## 5. Start a worker

Use the preferred entrypoint:

```bash
WORKER_TYPE=DARCI npm run worker
```

Other valid worker types:

- `SCRIBE`
- `PRISM`
- `QUALIFIER`
- `HERMES`
- `SENTRY`
- `BEACON`
- `BCAT-PLANNER`
- `BCAT-EXECUTOR`
- `VERITAS`
- `ANVIL`
- `SRLOG`
- `FORGE`
- `NOTARY`

## 5a. Start a OneShot consumer if needed

Use the dedicated OneShot entrypoint with `ONESHOT_ROLE`:

```bash
ONESHOT_ROLE=PLANNER npm run oneshot
ONESHOT_ROLE=REVIEWER npm run oneshot
ONESHOT_ROLE=IMPLEMENTER npm run oneshot
ONESHOT_ROLE=CODE_REVIEWER npm run oneshot
ONESHOT_ROLE=TESTER npm run oneshot
```

Local OneShot runs also require the queue URLs and the normal OneShot env such as:

- `ONESHOT_PLANNING_QUEUE_URL`
- `ONESHOT_REVIEW_QUEUE_URL`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`
- `ONESHOT_CODE_REVIEW_QUEUE_URL`
- `ONESHOT_TESTING_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`

If you want local OpenAI review stages, also set:

- `OPENAI_API_KEY`

## 6. Start Harvey if needed

```bash
npm run harvey
```

Harvey exposes:

- `POST /api/messages`
- `GET /health`

## 6a. Start Investigation Cockpit For An Attended Operator Run

For MERIDIAN/Cockpit governance-review runs, operator credentials are supplied
once per local Cockpit session, not once per Jira ticket. The UI then starts
each investigation from a Jira key only.

Use the attended launcher:

```bash
npm run cockpit:attended
```

The launcher prompts for:

- Jira URL, username, and API token
- trusted operator id/display name for local dashboard headers
- LDAP DB username and password for attended read-only diagnostics
- LDAP SSH username and optional SSH control socket
- optional SSH host/IP and remote DB endpoint overrides
- AWS profile, discovery regions, role hints, target file, and local ports

When explicit host overrides are omitted, a DB-enabled run uses bounded AWS
discovery to resolve the client-scoped login/bastion and replica/database
endpoint. CloudWatch-only runs remain AWS-service scopes and do not open SSH.

The attended launcher enables the bounded Bedrock investigation planner by
default. The AWS profile used for client evidence discovery and the profile
used to invoke Bedrock are configured separately. The Bedrock profile must
have an active SSO session and permission to invoke the configured model.

Starting a ticket performs only bounded Jira routing before the run appears in
the flight queue. GitHub repository discovery, AWS enrichment, and LDAP SSH
preparation run after a worker claims the ticket, so those network probes do
not block the Start action.

Relevant planner settings are:

```bash
INVESTIGATION_LLM_PLANNER_ENABLED=true
INVESTIGATION_LLM_AWS_PROFILE=<bedrock-sso-profile>
INVESTIGATION_LLM_AWS_REGION=us-east-2
INVESTIGATION_LLM_MODEL_ID=us.anthropic.claude-sonnet-4-6
INVESTIGATION_LLM_PLANNER_MAX_CALLS=4
INVESTIGATION_LLM_PLANNER_TIMEOUT_MS=60000
```

`INVESTIGATION_LLM_PLANNER_ENABLED` defaults to `false` when the dashboard API
is started directly. A direct `npm --prefix dashboard run dev:server` launch
must therefore set the variables above explicitly. Prefer
`npm run cockpit:attended` for an operator investigation session.

After a ticket finishes, open **Causal RCA completeness and gap plan** in the
run evidence and check its metadata:

- `planner:llm` means Bedrock produced the bounded probe plan.
- `planner:llm_fallback` means Bedrock was attempted but the deterministic
  fallback handled that iteration; the planning trace contains the reason.
- `planner:deterministic` means the LLM planner was disabled or its configured
  call budget was exhausted.
- `llm:no-tools` is a safety property: the LLM can select only allowlisted probe
  intents and cannot execute shell commands, SQL, AWS actions, or remediation.

Do not treat the **RCA Planner: complete** UI state as proof that Bedrock ran.
That state also covers deterministic causal-completeness evaluation; verify the
`planner:*` metadata above.

Cockpit run state is process-local for the current local-only governance
approval. Do not enable or add dashboard durable run history for governed
MERIDIAN/Cockpit runs unless a separate encrypted-store governance review
approves that design.

For governed PHI use, run only the `release/1.0` branch. Do not run `main` or
any personal/feature branch for PHI-touching work.

Before promoting a change onto `release/1.0`, open a PR against that branch
and include the output of:

```bash
npm run governance:check
npm run governance:diff -- origin/release/1.0 <candidate-ref>
```

After startup, open:

```text
http://127.0.0.1:5174/investigation
```

Then enter only the Jira key for each ticket. Cockpit derives the client,
environment, title, and code-version hints from Jira/configured adapters when
available.

The Flight Queue accepts up to 10 outstanding tickets. The attended launcher
runs two workers by default, so tickets for different client/environment target
keys can investigate concurrently. A PROD target remains limited to one active
run for that same target key; additional tickets for it wait without blocking a
different client target. Override the small local worker pool only when the
operator machine and approved evidence systems can support it:

```bash
INVESTIGATION_WORKER_CONCURRENCY=2 npm run cockpit:attended
```

Changing this value requires restarting the attended session. Current local run
state is process-local and is not retained across that restart.

Security notes:

- LDAP DB credentials are exported only into the local process tree for the
  active attended session.
- The attended LDAP credential is used lazily to open the first approved SSH
  ControlMaster. Later tickets reuse that session socket, so the UI accepts a
  Jira key without prompting for the password again.
- If no SSH host is provided, Cockpit first performs bounded client/environment
  AWS discovery. It resolves a gateway and replica/database endpoint as one
  access topology and gives the same result to data diagnostics and Meridian.
  Direct generation fails closed when that approved topology cannot be proven.
- SSM/dedicated service-account host access is future hosted architecture and
  requires separate review.
- Do not put Jira tokens, LDAP passwords, or ticket-specific secrets in repo
  files, target config, PR comments, or documents.

## 7. Verify the basics

Build verification:

```bash
npm run type-check
npm run build
```

Worker status verification:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/status
```

## Common first-run issues

### Worker starts but finds no work

- check that the `agents` table contains active rows
- confirm the JIRA ticket matches the agent JQL
- confirm the orchestrator inserted a `task_management` row

### Worker fails immediately

- verify `REPOSITORY_PATH` exists
- verify `REPO_ADMIN_PATH` / `ONESHOT_REPO_ADMIN_BASE` exists if you are running OneShot
- verify `DB_*` values are correct
- verify AWS credentials or IAM role allow S3 and Bedrock

### OneShot reviewer or code reviewer fails immediately

- verify `OPENAI_API_KEY`
- verify the queue URLs are present
- verify `ONESHOT_ROLE` is one of `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, `TESTER`

### Harvey fails immediately

- verify Teams bot credentials
- verify MySQL connectivity
- verify `BEDROCK_MODEL_ID` and `AWS_REGION`

## What to read next

- [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)
- [03-AGENT-DEVELOPMENT-GUIDE.md](./03-AGENT-DEVELOPMENT-GUIDE.md)
- [ONESHOT_RUNBOOK.md](./ONESHOT_RUNBOOK.md)
- [STATUS_API.md](./STATUS_API.md)
