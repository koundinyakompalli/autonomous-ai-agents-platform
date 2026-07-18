# Investigation Platform — Future Dedicated Service Account Architecture Spec

**Date:** 2026-05-02
**Status:** Future dedicated-service-account design reference; not the current AI governance review path
**Author:** Vasavi Gedela

---

## Current Design Reference

This document preserves the future-state architecture that assumes approved
dedicated read-only service accounts. The current code-aligned Investigation
Cockpit design for the AI governance compliance review is documented in
`docs/superpowers/specs/2026-05-02-investigation-platform-design.md`.

In the current review path, PHI-reaching attended DB diagnostics use
operator-supplied LDAP credentials at runtime, not long-lived shared service
account credentials.

## 1. Overview

This design defines a new production-support investigation platform inside the
existing `cp-autonomous-ai-agents-platform` repo. The platform accepts a Jira
support ticket or operator-triggered run, routes production-style intake through
Lambda and SQS FIFO, gathers evidence through safe capability adapters,
correlates findings across infrastructure, code, data, and host surfaces, and
publishes a redacted investigation summary to the dashboard and Jira.

This is **not** a replacement for DARCI, RIFT, OneShot, or Watchdog. Instead,
it is a brokered investigation layer that reuses the strongest patterns already
in the repo:

- Watchdog-style run attempts, events, evidence, and audit
- Claude SDK read-only analysis for scoped reasoning
- existing repository catalog and local repo inspection
- dashboard/server route and service patterns

The key architectural rule is:

> The investigation control plane orchestrates approved adapters. It does not
> hold broad direct access to every operational surface itself.

---

## 2. Strategic Operating Goal

The long-term goal is for Investigation Cockpit to become the governed default
front door for support investigations across SEN tickets, customer
investigation tickets, production-support tickets, lower-environment defect
analysis, and recurring operational issue patterns.

MERIDIAN and Investigation Cockpit support the transition from a traditional
support model to a modern AI-governed healthcare support operations model. The
platform can modernize support by reducing manual handoffs, improving speed to
evidence and RCA, and helping teams meet contractual SLAs more consistently. It
provides a governed shared investigation cockpit for evidence correlation, RCA
support, MERIDIAN SQL remediation drafts, OneShot code/config remediation PR
handoff, and human approval checkpoints.

The target model is:

- support and customer investigation tickets enter Cockpit first by default,
  with policy exceptions handled by intake routing rules
- the model can expand over time to additional ticket types, support
  workflows, clients, environments, and remediation patterns as governance
  approval, adapter coverage, and operational evidence mature
- Cockpit normalizes Jira context, customer, environment, product version,
  service, time window, known symptoms, and evidence needs
- Cockpit routes evidence collection through approved adapters for AWS/logs,
  code, data diagnostics, host/runtime inspection, historical knowledge,
  MERIDIAN SQL-draft workflows, and human-gated remediation
- Cockpit produces a redacted investigation summary, evidence bundle, likely
  RCA, limitation statement, and recommended next action
- production-impacting actions stay outside autonomous execution and remain
  subject to DBA review, operator approval, code review, change control, and
  release governance

Expected business impact:

- faster speed to first evidence for customer and SEN tickets
- lower repeated triage effort across the traditional support model and DBAs
- fewer manual handoffs between support, DBA, cloud, and operations teams
- more consistent investigation summaries and customer-support updates
- better reuse of prior ticket patterns without duplicating raw PHI/PII
- less recurring manual effort for backend correction tickets by standardizing
  ticket parsing, read-only validation, SQL safeguard packaging, and DBA-review
  handoff
- safer scale because all evidence collection remains brokered, scoped,
  redacted, throttled, and auditable

Current model pain points addressed:

- manual ticket reading, comment review, attachment inspection, log searching,
  code searching, database checks, and cross-team routing are repeated across
  many customer investigation tickets
- recurring backend correction workflows require manual field mapping,
  reference-value lookup, current-value comparison, backup query generation,
  guarded update generation, audit statement preparation, and validation query
  generation
- Cockpit and MERIDIAN convert these repeated steps into a controlled,
  evidence-driven, redacted, auditable workflow while preserving human review
  for production-impacting actions
- BECU-style correction tickets are one representative validated workflow
  within this broader support-investigation and backend-remediation model

This goal does not require broad production authority for an AI agent. Scale is
achieved by making Cockpit the controlled routing and evidence-correlation
layer before human-approved remediation.

---

## 3. Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Execution model | Single brokered control plane | Avoid split-brain orchestration and centralize state transitions |
| Capability model | Safe adapters instead of broad autonomous agents | Easier approval, audit, and blast-radius control |
| Dashboard | New routes in existing Specter dashboard | Reuses current auth, nav, and operational UI patterns |
| Intake burst control | Lambda intake + SQS FIFO | Absorbs Jira/Cockpit bursts before any SSM or DB session opens |
| LLM role | Scoped reasoning only | LLM interprets evidence; it does not receive unrestricted infrastructure access |
| DB access | Query-pack adapter in VPN/private-reachable network | Safer than direct arbitrary DB access from the main app |
| Host access | Prefer SSM or controlled inspection adapter | Better than broad SSH user distribution |
| PROD access | Replica/slave only, later phase | Lower initial risk and better DBA approval path |
| Historical knowledge memory | MySQL metadata tables only | Keeps reusable RCA patterns searchable and auditable without duplicating raw PHI-bearing evidence |

---

## 4. System Model

### Control plane

The control plane owns:

- intake after Lambda/SQS queue delivery
- run state
- attempt claiming
- adapter dispatch
- evidence correlation
- audit trail
- Jira summary publishing
- dashboard SSE

The control plane does **not** perform arbitrary DB queries, shell into hosts,
or directly inspect production systems outside approved adapter boundaries.

### Production intake queue

Direct Jira webhooks, Jira-label events, and Cockpit submissions must not create
unbounded investigation runs or database sessions. Production intake uses:

```text
Jira webhook / Cockpit request
        ↓
API Gateway or approved webhook endpoint
        ↓
Lambda intake validator
        ↓
SQS FIFO investigation queue
        ↓
Cockpit / MERIDIAN workers
        ↓
Target-level throttle
        ↓
Approved adapters
```

Lambda responsibilities:

- validate Jira key, trigger label, request source, and operator context
- normalize client, environment, time window, and requested mode
- resolve the approved target when possible
- enqueue a minimal routing payload only
- avoid opening AWS Systems Manager sessions
- avoid opening database connections
- avoid fetching large PHI-bearing attachments

SQS FIFO responsibilities:

- absorb bursts from Jira/Cockpit without scaling operational access directly
- serialize work per database target using `MessageGroupId = clientId:environment:dbTargetId`
- deduplicate repeat webhooks using `MessageDeduplicationId = jiraKey:workflowType:eventId`
- route poison messages to a dead-letter queue for manual review/replay

Workers may open AWS Systems Manager or database sessions only after pulling a
message and passing target-level queue/throttle checks.

### Investigation knowledge memory

Investigation Cockpit stores reusable historical investigation knowledge in the
platform MySQL database, not as unbounded prompt history. The memory tables are
separate from `task_management`; `task_management` remains the workflow queue.

Required tables:

- `investigation_knowledge_cases`: one canonical redacted record per reusable
  historical investigation outcome. It stores Jira key, client/environment,
  product version, module, issue signature hash, redacted issue summary, root
  cause summary, resolution summary, validation summary, and safety label.
- `investigation_knowledge_matches`: one row per match event between a new
  Cockpit run and a prior knowledge case. It stores incoming Jira key, matched
  case id, match source (`rovo`, `mysql_fulltext`, `llm`, or `manual`), score,
  reason, applicability notes, and whether a human accepted the match.

Large evidence artifacts such as generated investigation reports, Code Agent
evidence packs, screenshots/OCR, MERIDIAN SQL drafts, and database diagnostic
summaries are not copied into Cockpit knowledge memory. The memory keeps compact
redacted metadata and links back to Jira keys/Cockpit run IDs. Raw PHI/PII,
screenshots, full Jira comments, and full database rows must not be duplicated
into searchable MySQL memory.

Atlassian Rovo may be used as a historical-pattern front door for Jira and
Confluence content. Rovo matches are imported as candidate match rows in
`investigation_knowledge_matches`; the Cockpit must still validate applicability
against the current client, environment, product version, code branch,
configuration/service values, database evidence, and human review. Prior-ticket
knowledge never authorizes an automatic remediation.

### Safe adapters

Each operational surface is accessed through a brokered adapter:

- `aws_evidence_adapter`
- `code_inspection_adapter`
- `data_diagnostics_adapter`
- `host_inspection_adapter`

Every adapter:

- has a narrow contract
- enforces read-only behavior
- returns structured evidence and findings
- logs metadata needed for audit
- can be approved and deployed independently

---

## 5. Module Structure

### Backend — `src/investigation/`

```
src/investigation/
├── control-plane/
│   ├── InvestigationControlPlane.ts    # Main broker/orchestrator
│   ├── InvestigationRunner.ts          # Stage execution flow
│   ├── ConfidenceScorer.ts             # Cross-adapter scoring
│   └── EscalationPolicy.ts             # Stop / escalate / swarm rules
├── adapters/
│   ├── types.ts                        # Adapter contracts
│   ├── AwsEvidenceAdapter.ts           # Watchdog/MCP-backed evidence adapter
│   ├── CodeInspectionAdapter.ts        # Local repo read-only inspection adapter
│   ├── DataDiagnosticsAdapter.ts       # Query-pack-based DB adapter
│   └── HostInspectionAdapter.ts        # Host inspection adapter (prefer SSM)
├── data/
│   ├── ConnectionRegistry.ts           # Secrets/registry for DB and host targets
│   ├── QueryPackRegistry.ts            # Approved DB diagnostic templates
│   ├── QueryValidator.ts               # Query-pack validation and limits
│   └── PhiGuard.ts                     # Redaction and storage filtering
├── types/
│   └── investigation.ts                # Shared investigation schemas
├── jira/
│   └── InvestigationJiraService.ts     # Standardized redacted Jira comments
└── index.ts
```

### Dashboard — existing Specter dashboard

```
dashboard/src/routes/
└── InvestigationPage.tsx               # Runs board + detail workspace

dashboard/server/routes/
└── investigation.ts                    # Backend API routes

dashboard/server/services/
├── investigation.ts                    # Run state, evidence, findings, audit
└── investigationRunner.ts              # Claim/execute/reap adapter-backed runs
```

### Database migrations

```
db/migrations/
├── 022_investigation_runs.sql
├── 023_investigation_run_attempts.sql
├── 024_investigation_evidence.sql
├── 025_investigation_findings.sql
├── 026_investigation_events_and_audit.sql
└── 027_seed_investigation_repositories.sql
```

The schema should stay minimal and Watchdog-like. Do not introduce a second
large control plane unless operational need justifies it.

---

## 6. Operating Model: Traditional Support Model

The platform supports the traditional support model, but it should not be
implemented as a rigid sequential queue hierarchy. Use it as an operating
model:

### Intake and fast triage

- normalize customer, environment, service, and time window
- run known-issue / runbook / symptom classification
- trigger bounded AWS evidence collection
- decide whether code probe, data probe, or both are needed

### Operational investigation

- AWS logs and service health
- safe data diagnostics through approved query packs
- host inspection through controlled adapter
- evidence correlation across runtime, config, and state

### Operations RCA

- deeper operational evidence review
- impacted service, module, queue, job, or configuration mapping
- likely file, method, query, job, or runtime path identification
- escalation to the appropriate technical remediation path when needed

### Incident swarm mode

For high-severity incidents, bypass strict linear progression. Pull in the
needed domain adapter(s) and operational responder(s) early.

---

## 7. Run Lifecycle

```
Jira label or operator trigger
        │
        ▼
Lambda intake validation
        │
        ▼
SQS FIFO queue
        │
        ▼
Worker claim / scope normalization
        │
        ▼
AWS triage adapter
        │
        ├── enough evidence + no deeper signal -> summarize
        ├── code signal -> run code inspection adapter
        ├── data/config signal -> run data diagnostics adapter
        └── host signal -> run host inspection adapter
        │
        ▼
Correlation / confidence scoring
        │
        ├── sufficient confidence -> operator-ready summary
        ├── code/config fix needed -> human gate -> OneShot draft PR request
        ├── data correction needed -> MERIDIAN review-only SQL package
        ├── weak confidence -> deeper code RCA / optional DARCI handoff
        └── low confidence -> human escalation with evidence bundle
        │
        ▼
Dashboard + Jira + audit
```

The core flow is **branching**, not a forced traditional support-tier sequence.
The current POC provides bounded, governed orchestration as the safety
foundation for autonomous investigation. The runner decides adapter sequencing
from scope, confidence scoring, and mandatory gates. Phase 6 evolves this
baseline into planner-driven governed autonomy by adding iterative next-action
selection, working memory, stopping criteria, policy validation, and
adversarial verification before final RCA.

Remediation remains separated by action type:

- code or configuration changes are handed to OneShot only after a Cockpit
  human approval gate; OneShot owns planning, implementation, code review,
  testing, and draft PR creation
- database corrections remain MERIDIAN output only: review-only SQL package,
  no autonomous SQL execution, and DBA review/execution outside Cockpit
- operations, vendor, or runbook remediations remain Jira/operator actions,
  not automated Cockpit changes

---

## 8. Failure Lens Engine

Failure Lens is a Cockpit RCA-assistance layer that sits on top of the evidence
correlation flow. It does not replace the adapters and does not perform
remediation. Its purpose is to force the investigation summary through a small
set of reusable diagnostic angles before the operator or Jira draft accepts a
root-cause hypothesis.

Current POC status:

- the dashboard includes a `Failure Lens` tab for the selected Cockpit run
- the current implementation derives lightweight lens cards from run summary,
  findings, evidence, events, and Jira draft text
- this provides a practical demo and POC validation layer
- production hardening promotes these lenses into a configurable rule registry
  with structured evidence hits, confidence, and governance reporting

Initial lenses:

- **Time Lens**: checks session age, token age, delayed item processing, retry
  spacing, and time-window correlation
- **Volume Lens**: checks batch size, page size, queue depth, backlog pressure,
  and vendor/API capacity signals
- **Repeat Lens**: checks repeated failed identifiers, retry loops, poison
  messages, and recurring failure clusters
- **Stage Lens**: separates query, download, process, archive, move,
  mark-as-read, database, and notification stages before naming root cause
- **Scope Lens**: compares affected client, queue, route, folder, account,
  environment, and version against healthy equivalents
- **Change Lens**: compares pre-change and post-change behavior and proposes
  safe validation changes before claiming certainty

For the WellCare/FaxCom validation ticket, these lenses should surface:

- API/file-stage split between image download and archive/move failures
- page-size or batch-pressure risk before the page size was reduced
- repeated failed `uniqueJobId` patterns
- queue-specific impact instead of platform-wide outage
- validation plan based on lower page size, queue drain, repeated 5xx volume,
  and repeated item recurrence

Target production hardening:

- move lens definitions to a YAML or database-backed rule registry
- allow teams to add or tune lens patterns without changing dashboard code
- store lens hits as structured investigation findings/evidence
- include confidence, matched signals, missing checks, and recommended next
  evidence per lens
- keep all lens inputs redacted and metadata-oriented
- treat lens output as a hypothesis aid, not an automatic remediation approval

Failure Lens is not a substitute for Lambda/SQS intake controls, approved
adapters, PHI redaction, read-only database access, or human review. It is a
reasoning and presentation layer over already-approved evidence.

---

## 9. Run Metrics and Cost Accounting

Cockpit should show an explicit operational metrics section for every completed
or escalated investigation run. This is needed for governance, support ROI,
capacity planning, and AI-cost review.

Current POC status:

- adapter contracts already support per-adapter `durationMs` telemetry
- dashboard seed/runtime state tracks lightweight progress timestamps
- the Cockpit run API and UI do **not** yet expose a reliable total elapsed
  duration, queue wait time, adapter-by-adapter duration, token usage, or LLM
  cost summary
- current demo runs should therefore be treated as having **cost not captured**
  unless a specific adapter records model/token usage separately

Required dashboard fields:

- ticket/run start time
- queue wait time
- active investigation duration
- completed/escalated time
- total wall-clock time from intake to Cockpit result
- per-adapter duration for AWS, Code, Data/MERIDIAN, Host/SSM, and Jira posting
- human-review wait time, when applicable
- whether an LLM was used
- model/provider used, when applicable
- input tokens, output tokens, and total tokens, when available
- estimated LLM cost, when available
- deterministic/no-LLM indicator for runs completed without model calls

Cost-accounting rules:

- deterministic adapter work should show `LLM used: No` and `LLM cost: $0.00`
  or `not applicable`
- LLM-backed work should record model id, region/provider, prompt-token count,
  completion-token count, and estimated cost using the approved model price table
- if token usage is unavailable, Cockpit must show `LLM cost: not captured`,
  not an invented estimate
- prompts, raw completions, PHI/PII, secrets, and raw Jira attachment contents
  must not be stored for cost accounting
- cost records should store metadata only: run id, adapter, model id, token
  counts, estimated cost, timestamp, and redaction status

Jira-facing output should include a concise operational footer when enabled:

- investigation duration
- whether LLM was used
- LLM cost status (`$0.00`, estimated amount, or `not captured`)
- no autonomous SQL execution / human review status when MERIDIAN output is present

This metric section is not a production access guardrail by itself. It is a
governance and observability requirement that should be implemented before pilot
or production approval.

---

## 10. Adapter Contracts

### Common adapter rules

All adapters must:

- be read-only in MVP
- accept a structured adapter request
- enforce scope and limits internally
- return structured evidence and findings
- avoid returning or storing raw PHI

### Adapter request shape

```typescript
{
  runId: string;
  jiraKey: string;
  adapter: "aws" | "code" | "data" | "host";
  scope: {
    clientId: string;
    environment: "INT" | "UAT" | "STAGE" | "PROD_REPLICA";
    serviceIds: string[];
    timeWindow?: { startTs: string; endTs: string };
    keywords?: string[];
    repoNames?: string[];
    hostTargets?: string[];
  };
  constraints: {
    timeoutMs: number;
    maxRows?: number;
    maxArtifacts?: number;
    redactionRequired: true;
  };
}
```

### Adapter output shape

```typescript
{
  findings: InvestigationFinding[];
  evidence: InvestigationEvidenceArtifact[];
  telemetry: {
    durationMs: number;
    requestsIssued: number;
    rowsRead?: number;
    artifactsStored?: number;
  };
}
```

---

## 11. AWS Evidence Adapter

The AWS adapter reuses the Watchdog MCP approach. It does not invent a second
CloudWatch control path.

Responsibilities:

- bounded CloudWatch searches
- ECS / deployment / task health evidence
- environment and service-scoped operational signals

Implementation notes:

- wrap the same Watchdog MCP helper patterns used today
- store findings/evidence in investigation tables, not Watchdog tables
- keep the runtime model consistent with current dashboard services

---

## 12. Code Inspection Adapter

The code adapter should use the **existing local repository model**, not a new
general-purpose GitHub content client.

Responsibilities:

- inspect relevant local repositories in read-only mode
- search for file paths, service methods, HQL/SQL strings, flags, configs
- map likely ownership and candidate code paths

Implementation notes:

- use `code_repositories` for repo selection
- inspect local checked-out repos and shared workspace paths
- use Claude SDK `read_only` patterns similar to QUALIFIER/DARCI
- do not rely on `src/oneshot/github.ts` for repository exploration

---

## 13. Data Diagnostics Adapter

This adapter is the most sensitive surface and must stay brokered.

### Core rule

The control plane does not execute arbitrary SQL. It requests **approved query
packs** from the data adapter.

### Query-pack model

Examples:

- transaction status lookup
- feature/config verification
- job state inspection
- integration metadata presence
- restriction/config anomaly scan

Each query pack defines:

- the target environment type
- the allowed tables/views
- required parameters
- fixed SQL or fixed stored procedure call
- row cap
- timeout
- expected redaction behavior

### Execution trace requirement

The data adapter must emit a **safe execution trace** for every diagnostic run.
This is not a raw JDBC debug log. It is an operator-facing stack trace that
shows what the adapter did after connection establishment.

Each trace should capture:

- target resolution from the connection registry
- secret load / credential source metadata without exposing secrets
- connection open / close
- selected query pack id
- query validation result
- executed SQL in **redacted/parameterized form**
- row counts returned
- redaction step
- evidence persistence step

Example trace sequence:

1. resolve target `scan-uat1-mysql`
2. load read-only credential from secret reference
3. open SSL MySQL connection
4. select query pack `auth_status_trace`
5. validate approved SQL against allowlist
6. execute `select case_number, status, status_reason from authorizations where case_number = ? limit 1`
7. read `1` row
8. redact result payload
9. persist evidence artifact
10. close connection

This trace should be visible in the dashboard and available in audit output.
It materially improves operator trust and makes DBA/security review easier.

### Connectivity

Primary model:

- the data adapter runs inside a network that already has VPN/private reachability
  to client databases
- the adapter resolves client/environment targets through a **connection registry**,
  not by building ad hoc connection strings from operator input
- for SCAN-style deployments, expect **EC2-hosted MySQL endpoints over private VPC
  networking**, not only managed RDS endpoints

Fallback model:

- if private/VPN path is impossible initially, lower-env-only access may be
  approved through a more limited route, but this is not the preferred design

### Connection registry

The control plane should never accept arbitrary hostnames, usernames, schemas,
or secret references from a run request. The data adapter must resolve those
from an approved registry keyed by client and environment.

The registry should store:

- client id
- environment and environment id
- engine
- approved private host or internal DNS name
- port and database name
- network path type (`private_vpc` or `vpn`)
- secret reference
- restricted DB username
- access class (`lower_ro` or `prod_replica_ro`)
- allowed query packs
- PHI policy flag
- enabled/disabled state

Example entry:

```typescript
{
  id: "scan-uat1-mysql",
  clientId: "SCAN",
  environment: "UAT",
  envId: "UAT1",
  engine: "mysql",
  host: "10.129.0.6",
  port: 3306,
  databaseName: "scan_uat",
  networkPath: "private_vpc",
  authMode: "username_password",
  secretRef: "secretsmanager://investigation/scan/uat1/mysql/agent_ro",
  dbUser: "agent_scan_ro_uat",
  accessClass: "lower_ro",
  allowedQueryPacks: [
    "case_lookup",
    "auth_status_trace",
    "config_check",
    "job_state_check"
  ],
  phiAccess: false,
  enabled: true
}
```

### Environment policy

- lower environments first
- PROD primary never
- PROD replica/slave only in later phase and only with separate approval

### Queueing and concurrency policy

Database-backed diagnostics must be rate-limited by target, not just by worker
instance. This prevents a burst of Jira labels or Cockpit requests from opening
too many AWS Systems Manager sessions or database connections against the same
environment.

Required controls:

- SQS FIFO queue for database-backed investigation work
- `MessageGroupId = clientId:environment:dbTargetId`
- duplicate-message suppression by Jira key + workflow + event id
- per-target active session limit before opening AWS Systems Manager or DB access
- stricter limit for PROD replica/slave than lower environments
- queue/backpressure state visible in the dashboard
- kill switch to disable a client/environment/target without code deployment
- dead-letter queue for failed messages and replay after review

Recommended starting limits:

- PROD replica/slave: 1 active data diagnostic or MERIDIAN-backed diagnostic per target
- lower environments: 1-2 active diagnostics per target, adjusted with DBA approval
- global worker concurrency: small fixed pool until target-level alarms are proven

Required monitoring:

- queue depth and oldest-message age
- in-flight message count
- dead-letter queue count
- active AWS Systems Manager sessions by target
- active database sessions by target
- throttle/backpressure count
- worker timeout/failure count

---

## 14. Host Inspection Adapter

Preferred implementation:

- AWS Systems Manager or equivalent controlled remote execution model

Responsibilities:

- inspect folders, JARs, scripts, config files, process/service status
- return structured host evidence only

Avoid:

- broad SSH user access as the default design

If SSH is unavoidable, keep it:

- read-only
- lower-environment first
- command allowlisted
- audited

---

## 15. Data Protection and PHI Controls

This platform must enforce multi-layer data controls:

1. approved query packs only
2. allowlisted schemas/tables/views
3. explicit selected columns where possible
4. mandatory row limits
5. statement timeout
6. output redaction before storage
7. no raw PHI in prompts, logs, or persisted evidence

Persist only:

- redacted evidence
- counts
- statuses
- metadata
- investigation summaries

Do not persist raw patient/member data in investigation artifacts.

---

## 16. Security Model

Use separate least-privilege principals, not one broad agent user.

| Surface | Principal | Scope |
|---|---|---|
| Data adapter lower env | `agent_data_ro_lower` | read-only approved query packs |
| Data adapter prod replica | `agent_data_ro_prod_replica` | read-only approved query packs, later phase |
| AWS evidence adapter | `investigation_aws_reader` | CloudWatch/S3/ECS read |
| Host adapter | `investigation_host_ro` | controlled inspection only |
| Control plane | app/service identity | run state, audit, dashboard APIs |

This separation is essential for DBA/security approval and blast-radius control.

### Restricted service-account guidance

Use dedicated read-only service accounts aligned to the approval boundary.
Avoid a single shared DB login across all clients and environments.

Preferred model:

- `agent_data_ro_lower`
- `agent_data_ro_prod_replica`

Stronger isolation model when DBA/security requires it:

- `agent_scan_ro_uat`
- `agent_scan_ro_training`
- `agent_scan_ro_stage`
- `agent_scan_ro_prod_replica`

Every service account should be:

- `SELECT` only
- denied write and DDL permissions
- limited to approved schemas, views, or stored procedures
- denied raw PHI-heavy tables whenever possible
- rotated through a secret manager, never embedded in app config

### Read-only profile verification

Before Cockpit or MERIDIAN uses a database profile for validation, the runtime
should verify that the active principal is read-only. Verification should be
performed once on activation and again when secrets rotate.

Required checks:

- inspect grants for the current database user
- fail closed if `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`,
  `TRUNCATE`, `GRANT`, `SUPER`, or equivalent write/admin permissions are present
- verify the profile points to an approved target from the connection registry
- verify the target environment and access class match the run request
- record a redacted audit event showing profile id, target id, read-only status,
  and verification timestamp
- never log the username/password or secret value

MERIDIAN should not run validation queries until this verification passes.

---

## 17. Dashboard

The Investigation dashboard should behave like an operational workspace:

- run board on the left
- detail workspace on the right
- tabs for Overview, Timeline, Findings, Evidence, Jira, Audit, Approvals
- live SSE updates
- analyzer status strip

The dashboard should surface:

- whether data access was used
- whether scope was lower-env or prod-replica
- whether approved query packs were used
- whether output was redacted
- queue position / waiting-for-capacity state
- target id, active session count, and throttle/backpressure status when data diagnostics are requested
- total ticket/run duration and per-adapter duration
- whether LLM was used and whether cost was `$0.00`, estimated, or not captured

This is as important for operator trust as the findings themselves.

---

## 18. MVP Scope

### In MVP

- Intake / scope normalization
- AWS evidence adapter
- Code inspection adapter
- Data diagnostics adapter with approved query packs only
- lower environments only for DB access
- dashboard run board and detail workspace
- Jira summary posting
- human-gated OneShot draft PR request for code/config remediation
- audit trail and SSE timeline
- basic run metrics visibility where available

### Explicitly out of MVP

- arbitrary AI-generated SQL
- automatic mitigation execution
- direct Cockpit code edits or PR creation outside OneShot
- PROD primary database access
- broad SSH-style host access by default
- unrestricted shell execution

---

## 19. Implementation Phases

### Phase 1 — Control plane and dashboard

- `investigation_runs`, attempts, events, findings, evidence, audit
- dashboard route and basic run detail workspace
- brokered control-plane skeleton
- demo Failure Lens tab using run-derived heuristics
- placeholder run metrics panel showing unavailable/not-captured values honestly

### Phase 1A — production intake queue

POC implementation:

- SQS-compatible message contract for Cockpit investigation runs
- in-process worker loop that processes queued Cockpit run messages
- platform MySQL target-slot throttle table for active target leases
- environment caps: PROD or PROD replica/slave target starts at one active run,
  lower environments start at two active runs per target
- dashboard status fields for `queued`, `waiting_for_target`, `running`,
  `completed`, `failed`, target key, throttle reason, queued time, started time,
  and completed time
- bounded throttle table design: one row per target slot, not one row per run

Production hardening follow-up:

- API Gateway/webhook endpoint for Jira and Cockpit submissions
- Lambda intake validator
- managed AWS SQS FIFO queue with per-target message groups
- dead-letter queue and replay procedure
- distributed worker deployment with target-level throttle checks
- dashboard queue/backpressure indicators including oldest message age and DLQ
  status
- queue wait duration and target-throttle duration

Required implementation checklist:

- `[POC]` add an SQS-compatible message contract for Cockpit run requests
- `[POC]` set `MessageGroupId = clientId:environment:dbTargetId` style target
  grouping through the run `targetKey`
- `[POC]` set `MessageDeduplicationId = jiraKey:workflowType:eventId` style
  metadata on the queued message contract
- `[POC]` add a Cockpit worker loop that processes queued messages and updates
  Cockpit run state
- `[POC]` add a central target-throttle check before AWS Systems Manager or
  read-only database work starts
- `[POC]` enforce target limits by environment, with PROD set to one active
  run per target and lower environments set to two
- `[POC]` surface minimal queue/backpressure state in the dashboard, including
  queue depth, active workers, target key, and throttle reason
- `[POC]` add audit events for queued, target-capacity wait, target claimed,
  completed, and failed states
- `[Follow-up]` add a Lambda intake validator in front of Cockpit/MERIDIAN
  operational runs
- `[Follow-up]` route Jira webhook and Cockpit run requests through managed AWS
  SQS FIFO instead of the in-process POC queue
- `[Follow-up]` add a dead-letter queue and replay procedure for failed intake
  messages
- `[Follow-up]` add read-only profile/grant verification before MERIDIAN
  validation runs
- `[Follow-up]` harden MERIDIAN packaged backend controls before pilot or
  production use: backend token auth, runtime-only DB activation, disabled raw
  query/profile storage, redacted Jira SQL preview, and approved target
  registry validation
- `[Follow-up]` add alarms, IAM hardening, Terraform, queue oldest-message age,
  DLQ count, and replay audit events

Acceptance criteria:

- `[POC]` a burst of multiple tickets for the same client/environment/database
  creates queued messages and target-capacity waits instead of simultaneous
  SSM/database sessions beyond the configured cap
- `[POC]` the worker refuses to open SSM/database access when the target
  active-session limit is reached
- `[POC]` dashboard users can see that a run is waiting because of target
  capacity
- `[Follow-up]` two managed SQS messages with the same deduplication id do not
  create duplicate active runs
- `[Follow-up]` failed messages can be inspected and replayed from the
  dead-letter flow
- `[Follow-up]` MERIDIAN refuses validation if the configured DB profile is not
  verified as read-only
- `[Follow-up]` packaged MERIDIAN backend endpoints cannot be used without the
  worker token, and Jira attachments do not contain raw PHI/PII SQL literals

### Phase 2 — AWS and code adapters

- Watchdog/MCP-backed AWS evidence adapter
- local repo code inspection adapter
- correlation and confidence scoring
- structured Failure Lens hits from AWS/code evidence where available
- per-adapter duration telemetry surfaced in the run metrics panel

### Phase 3 — data diagnostics

- query-pack registry
- connection registry
- validator and PHI guard
- lower-environment pilot only
- configurable Failure Lens rule registry using redacted evidence metadata
- LLM token/cost accounting where any adapter uses an approved model

### Phase 4 — host inspection

- SSM or controlled host inspection adapter
- lower-environment pilot

### Phase 5 — prod-replica expansion

- separate DBA/security approval
- separate principal
- load, rate-limit, and audit review
- SQS/worker alarms and target-level throttles proven in lower environments first

### Phase 6 — governed autonomous investigation loop

This phase upgrades Cockpit from the current governed orchestration baseline
into planner-driven autonomous investigation.

Current POC capability baseline:

- Cockpit already provides governed, bounded orchestration as the safety
  foundation for autonomous investigation.
- Cockpit runs approved adapters, correlates findings, presents Failure Lens
  hypotheses, and keeps remediation behind human approval.
- The current runner decides adapter sequencing from scope, confidence scoring,
  and mandatory gates.
- Phase 6 adds planner-driven next-action selection across multiple reasoning
  iterations.

Required autonomous architecture:

```text
Jira / Cockpit run
        ↓
Bounded scope + target registries
        ↓
Investigation state
        ↓
LLM planner proposes typed PlannerAction
        ↓
PolicyEngine validates action and parameters
        ↓
Approved adapter executes read-only bounded action
        ↓
Evidence appended to working memory
        ↓
StoppingCriteria checks confidence, budget, time, and progress
        ↓
AdversarialVerifier tries to refute leading hypothesis
        ↓
Redacted RCA / escalation / human-gated remediation
```

The LLM may only select from a typed action space. It must not construct raw
commands, raw SQL, arbitrary AWS calls, arbitrary filesystem access, or
unapproved infrastructure actions.

Recommended code shape:

```text
src/investigation/
  control-plane/
    InvestigationPlanner.ts       # LLM-driven bounded planner loop
    PolicyEngine.ts               # validates planned actions vs registries
    InvestigationState.ts         # typed working memory and evidence refs
    StoppingCriteria.ts           # confidence/cost/time/no-progress caps
    AdversarialVerifier.ts        # refutation pass before final RCA
    InvestigationRunner.ts        # extended to drive planner mode
  types/
    PlannerAction.ts              # typed action space over existing adapters
    Hypothesis.ts                 # hypothesis, support, contradiction model
```

Initial `PlannerAction` set:

- `aws.queryLogs`
- `code.searchSymbol`
- `data.runQueryPack`
- `host.searchFile`

Each action must be parameterized only by approved registries, target ids,
query-pack ids, repo ids, log group ids, host target ids, redacted keywords, and
bounded time windows.

Required working memory:

```typescript
interface InvestigationState {
  hypotheses: Hypothesis[];
  leadingHypothesisId: string | null;
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
  openQuestions: string[];
  ruledOutHypotheses: string[];
  actionHistory: PlannerActionAudit[];
}
```

Required stopping criteria:

- leading hypothesis support score is at or above the configured confidence
  threshold
- iteration cap is reached
- per-run token or cost cap is reached
- wall-clock time cap is reached
- no-progress detector sees no new evidence for the configured number of
  iterations
- action-class budget is exhausted, such as maximum DB query packs or log
  queries per run

If confidence remains below threshold when a cap is hit, Cockpit must mark the
run as human triage needed and include structured output showing what was
attempted, what was ruled out, and what evidence is still missing.

Required policy boundary:

- `PolicyEngine` must be the only path from planner output to adapter
  execution.
- Validate action type against the allowed `PlannerAction` enum.
- Validate target ids against approved target registries.
- Validate query-pack ids against the query-pack registry.
- Validate repo and branch identifiers against approved code registries.
- Validate host targets and file roots against host registries.
- Validate log groups, regions, and time windows against AWS evidence config.
- Enforce per-action class budgets before execution.
- Log the proposed action and parameters before execution.
- Log result metadata after execution.
- Fail closed when any registry or policy check is missing.

The action log must be replayable and tamper-evident enough for governance
review. The POC can use append-only database rows plus run id and action
sequence. Pilot or production should evaluate signed hashes over action log
entries.

Required adversarial verification:

- before declaring an RCA done, a separate verifier pass must try to refute the
  leading hypothesis with the same bounded adapter set
- verifier checks healthy comparable cases, unaffected queues, alternate error
  stages, missing deploy/config correlation, and contradictory data evidence
- if substantive contradiction is found, confidence is reduced and the planner
  loop resumes
- if no contradiction is found within budget, verifier outcome is included in
  the final RCA

Required canary and shadow mode:

- planner suggestions run in shadow mode first while current bounded Cockpit
  orchestration still executes
- planner path is compared against known-ticket outcomes and current Cockpit RCA
- metrics include precision, recall, time-to-evidence, adapter calls saved,
  missed evidence, cost, and human override rate
- opt-in autonomous mode requires an approved flag such as `COCKPIT_AUTO`
- default-on use requires governance-approved metrics on representative tickets

Implementation order:

1. Define `PlannerAction` and `Hypothesis` types over the existing adapters.
2. Build `PolicyEngine` and make it the only execution path for planned
   actions.
3. Add `InvestigationState` persistence and action audit records.
4. Add a minimal planner in shadow mode with fixed iteration, time, cost, and
   no-progress caps.
5. Add dashboard visibility for planner suggestions, rejected actions, budgets,
   and stopping reasons.
6. Add `AdversarialVerifier` and lower confidence on substantive refutation.
7. Add opt-in `COCKPIT_AUTO` execution after shadow metrics are accepted.

This phase must preserve the existing non-execution boundaries: no autonomous
SQL execution, no arbitrary shell, no unrestricted database query, no automatic
PR merge, no deployment, and no operational action without human approval.

---

## 20. Final Position

This architecture is strong for production support **only if** it stays brokered:

- one control plane
- Lambda + SQS FIFO intake before operational access
- safe adapters
- approved query packs
- separate least-privilege identities
- private/VPN-first database reachability
- redaction-first evidence handling
- target-level queueing and throttling for SSM/database access

That model supports the traditional support model, minimizes unnecessary
technical escalation, and is materially more approvable than a broad
direct-access agent design.
