# Operations

This document is the runbook for engineers on-call for Spec Factory or shipping
changes that affect production behavior. It covers the feature-flag surface,
staging rollout order, ECS runtime modes, metrics and alerts, incident triage,
retention and DSR, deploy and rollback procedure, cost governance, and answers
to the runbook questions that come up most often. Scope is intentionally
narrow: what to configure, what to watch, and what to do when something
misbehaves. Architecture background lives in [architecture](./architecture.md);
event/turn/session vocabulary lives in the [glossary](./README.md#glossary).

Time framing: PR `#468` contains the code-ready v4 architecture, but repository
state is not deployment state. Migrations, Terraform, split-service routing,
repair acceptance, certification, and legacy removal remain explicit operator
steps. The canonical design source is the
[v4 scale plan](../superpowers/spec-factory/spec_factory_scale_and_reliability_plan_v4.md).

## V4 release runbook

Run one gate at a time. Stop on any discrepancy; do not “continue and observe”
through a failed durability or fencing check.

### Gate 0: merge and ECR bootstrap

1. Record the reviewed merge SHA.
2. Require root TypeScript build, schema verifier, all Spec Factory tests,
   dashboard typecheck/tests/build, Terraform format/validate, and every
   role-specific Docker build.
3. If `specter/spec-factory-api`, `specter/spec-factory-research`, or
   `specter/spec-factory-conversion` does not exist yet, bootstrap only the
   Terraform-owned ECR resources. Review and apply this narrow plan before any
   service/task-definition plan:

   ```bash
   terraform -chdir=terraform plan \
     -target='aws_ecr_repository.spec_factory_runtime' \
     -target='aws_ecr_lifecycle_policy.spec_factory_runtime' \
     -out=tfplan-ecr-bootstrap
   terraform -chdir=terraform apply tfplan-ecr-bootstrap
   ```

   This target-only apply is a one-time bootstrap. Do not create repositories
   manually because the full plan must retain Terraform ownership.

4. Dispatch `Build / Service / Spec Factory` for the merge SHA. The workflow
   pushes SHA-tagged `api`, `core`, `research`, `conversion`, and
   `compose-markitdown` images, resolves every tag to a digest, registers new
   task-definition revisions from the current production definitions, updates
   all Spec Factory ECS services, and waits for stabilization. A failed rollout
   restores the previous task definitions.
5. Do not deploy `latest`. Terraform final removal checks reject it. The image
   workflow and Terraform both resolve the reviewed SHA to immutable digests.

### Gate 1: database expand

Apply only after backing up and confirming the current tail is `068`:

```text
069_spec_factory_context_v4.sql
070_spec_factory_outbox.sql
071_spec_factory_handoffs.sql
072_spec_factory_draft_workflows.sql
073_spec_factory_repair_and_bounds.sql
074_spec_factory_source_distillation_prompt_v2.sql
075_spec_factory_source_deletion_lifecycle.sql
```

Use the repository's normal migration ledger/process. After each file, verify
the migration was recorded and no statement emitted warnings/errors. Then run:

```bash
npm run check:spec-factory-schema
```

Do not enable producers before all five migrations are present. Migration `070`
installs source-conversion outbox triggers; verify both triggers and the outbox/
receipt tables exist before conversion workers start.

### Gate 2: Terraform plan and apply for configuration changes

Terraform is not required for an application-only release. Plan locally with
the merge SHA and digest pinning enabled when the release also changes
infrastructure or task configuration. Review these groups separately:

- SQS queues, DLQs, quarantine queue, redrive policies, age/depth alarms.
- Valkey, optional Aurora/RDS Proxy, database secret/KMS policy, SG direction.
- The rotating Spec Factory data KMS key, the KMS-encrypted Spec Factory log
  group with at least 365-day retention, and, when Aurora is enabled, its daily
  continuous AWS Backup plan with 365-day retention.
- Four ECR role repositories and digest-resolved task images.
- API plus compatibility/turn/context/research/conversion/draft/relay/retention
  task definitions, services, autoscaling, IAM, secrets, scratch, and sidecars.
- Removal of EFS mounts only when legacy runtime is intentionally disabled.

Apply the reviewed plan without changing application flags to primary in the
same step. Confirm every created service is stable and every queue/DLQ URL is in
the intended task definition.

Before the first v4 image rollout against an existing EFS workspace, verify
`/mnt/efs/specter-repo/spec-factory` and its descendants are writable by
UID/GID `1000:1000` (the image's `node` user). Older images ran as root and
may have left root-owned workspaces. Repair only that subtree with a reviewed
one-off task, require exit code `0`, and verify ownership before redeploying;
do not bypass `COMPOSE_WORKSPACE_VALIDATE_ON_STARTUP` on worker roles.

All Spec Factory task-security-group egress is owned by standalone
`aws_security_group_rule` resources. Do not add inline `egress` blocks to
`aws_security_group.spec_factory_tasks`: mixing both ownership models causes
subsequent plans to remove the standalone RDS/EFS rules.

The current shared `subnet_ids` contract assigns public IPs to Fargate tasks.
That compatibility setting is explicit in both API and worker services; moving
to private subnets requires verified NAT/VPC endpoint coverage and is a separate
network migration. Do not describe the network boundary as privately isolated
until that migration has passed the security certification scenarios.

Valkey and RDS Proxy do not use the Fargate subnet list. Configure
`spec_factory_data_subnet_ids` with private subnets in at least two availability
zones. Terraform reads each subnet and rejects a public, foreign-VPC, or
single-AZ data plane. When the existing DB secret uses a customer-managed KMS
key, set `spec_factory_db_secret_kms_key_arn`; otherwise the proxy can read the
secret metadata but cannot decrypt the credentials. Confirm the proxy target is
`AVAILABLE` before accepting the ECS deployment as healthy.

Keep `spec_factory_rds_direct_fallback_enabled=true` through the proxy canary.
It preserves the old task definition's direct-RDS security-group path so an ECS
circuit-breaker rollback remains functional. After the proxy target, TLS path,
connection pooling, and rollback drill are certified, disable the fallback in a
separate reviewed plan; final legacy removal rejects an enabled fallback.

Keep `spec_factory_artifact_store="efs"` for the infrastructure-only apply.
Move it to `s3` as its own gate after immutable-write/read/restart verification;
legacy removal rejects any value other than `s3`.

### Gate 2a: immutable artifact manifests

Keep EFS mounted and keep `spec_factory_artifact_store="efs"` while the
backfill runs. Configure `SPEC_FACTORY_ARTIFACT_BUCKET` and
`SPEC_FACTORY_ARTIFACT_PREFIX` for the target immutable store, then inventory
and migrate active sessions:

```bash
npm run spec-factory:repair-artifact-manifests -- --batch=100
npm run spec-factory:repair-artifact-manifests -- --apply --batch=100
npm run spec-factory:repair-artifact-manifests -- --batch=100
```

The final dry run must report `candidates: 0` and `failed: 0`. The apply path
verifies every EFS file against the stored byte count and SHA-256 before writing
it to content-addressed S3, verifies existing S3 objects on resume, and commits
the version-2 manifest only after all files are durable. A checksum mismatch is
a failed gate; do not regenerate or silently accept changed bytes.

Run `--include-archived` without `--apply` to inventory archived workspaces.
Archived workspaces must be removed by the retention/DSR path before EFS is
unmounted; the backfill intentionally refuses to mutate archived sessions.
Startup with `SPEC_FACTORY_LEGACY_RUNTIME=disabled` independently rejects any
active non-version-2 manifest or any archived workspace still awaiting cleanup.

After the backfill, canary `spec_factory_artifact_store="s3"` with EFS still
mounted. Verify a worker restart and local-disk deletion can hydrate a complete
workspace from S3, and verify corrupted bytes fail checksum validation. Only
then make S3 primary for every role. EFS removal remains a later, separately
reviewed legacy-removal change.

Treat optional Aurora as a separate data-migration project. The first v4
topology rollout should proxy the existing RDS instance. Do not point tasks at a
new `specfactory` database until the complete baseline schema and data have been
restored there, migrations `069`-`073` have been applied, row counts/checksums
have reconciled, and the failover/restore certification scenarios pass.
Terraform provisions encrypted automated backups and an AWS Backup selection,
but those controls do not replace migration rehearsal or restore certification.

### Gate 3: shadow dispatch

Set queue dispatch to `shadow`, keep legacy-compatible execution available, and
raise split desired counts. Confirm:

- every expected heartbeat role/capability is present and fresh;
- outbox pending/publishing age returns to zero;
- shadow receipts are idempotent and quarantine/DLQs remain empty;
- durable events replay across API replicas with Valkey both available and
  unavailable;
- no role has an unrelated secret, tool, S3 prefix, or network path.

### Gate 4: primary queues

Move one workflow class at a time: turns, context, research, conversion, draft,
then event relay. For each class, compare accepted work to terminal work,
outbox/receipt counts, queue age, fence rejection, retries, cost, and latency.
Do not enable the coordinator research path before durable turn and research
workers are primary and healthy.

### Gate 5: context repair

Run a dry inventory first, then the real bounded backfill and reconciliation:

```bash
npm run spec-factory:repair-context-v4 -- --batch=100
npm run spec-factory:repair-context-v4 -- --apply --batch=100
npm run spec-factory:repair-context-v4 -- --reconcile --batch=100
```

During a large repair, monitor `source_distillation` and `context_merge` task
outputs for `compaction.droppedItemsBySection`. Compaction is expected when a
multi-chunk source would exceed 500 patch operations or a merged section would
exceed 500 projected items. It preserves message-backed/user-authored claims,
balances retained generated items across source provenance, and does not mutate
the original source chunks or ready patches. Treat repeated
`context_patch_too_large` or `context_protected_section_limit_exceeded` as a
failed rollout gate rather than accepting the repair run.

Repeat reconciliation while work remains. Inspect the report, failed/skipped
items, artifact checksums, source coverage, and every active session's latest
clean schema-v4 context. Only then accept the exact run:

```bash
npm run spec-factory:repair-context-v4 -- \
  --accept=<repair-run-id> --note="Reviewed source coverage and clean v4 contexts"
```

### Gate 5a: multi-AZ runtime and scale-out

After Valkey and RDS Proxy are healthy, configure the Spec Factory runtime with
public subnets in at least two ALB-enabled availability zones, set the API and
each critical queue worker to a minimum of two tasks, require durable events,
disable the rollback-only single-replica alarm, and enable autoscaling. Terraform
fails the plan if any prerequisite, minimum, maximum, subnet, or backlog target
is inconsistent.

Worker scale-in requires `SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED=true`. The
primary SQS consumer enables protection through the ECS agent before invoking a
handler, retains it through durable receipt completion, renews it every five
minutes while any concurrent receipt remains active, and releases it after the
last receipt completes. Acquisition fails closed: the handler does not run and
SQS retries the message if protection cannot be established. The 30-minute
expiry remains a safety net if release fails. Terraform rejects worker scale-in
without this guard or when the refresh interval is not shorter than the expiry.
The DB-polling rollback path is not scale-in protected, so horizontal-scaling
gates continue to require primary SQS dispatch.

Verify that API targets and every critical worker have running tasks in at least
two availability zones. Then test Last-Event-ID replay across API replicas,
Valkey interruption/recovery, RDS Proxy target failover, queue scale-out from the
configured floor, worker scale-in after a burst, and ECS rollback to the previous
direct-RDS task definition. During the scale-in test, hold a research or draft
receipt open longer than one cooldown and verify the task remains running until
the receipt is complete; then verify it becomes eligible for termination. The
API and per-role running-task-low alarms must remain `OK` throughout.

### Gate 6: certification and legacy removal

Complete the Work Order T procedure below against the exact release SHA and
environment. Set the emitted certification ID and accepted repair-run ID in
Terraform. Only after a fresh plan passes every removal check may the operator
set `SPEC_FACTORY_LEGACY_RUNTIME=disabled`. Startup independently queries the DB
and fails closed if the accepted repair/context state does not match.

## Work Order T certification

Generate the immutable scenario manifest for the exact release:

```bash
npm run spec-factory:certification:plan -- \
  --release-sha=<merge-sha> \
  --environment=<environment> \
  --manifest=artifacts/spec-factory-certification/manifest.json
```

`--release-sha` must be the complete 40-character Git commit SHA (or a
64-character future hash), not an abbreviated ref. The schema-v2 manifest
contains a content-derived `manifestId`; the evaluator rejects a changed
scenario catalog, release, environment, timestamp, or manifest ID.

The manifest covers functional invariants, 5k/25k SSE, 20/100 turn rates,
mixed load, 24-hour soak, worker/dependency/Aurora chaos, role/redaction/DSR
security, and Aurora/queue/artifact disaster recovery. Automated repository
suites are:

```bash
npm run spec-factory:certification:functional
npm run spec-factory:certification:security
```

The security suite proves repository-level redaction, fencing, and deletion
logic. `security.role-boundaries` and `security.dsr` remain operator scenarios:
assume each deployed task role and prove denied capabilities, then execute a
contained DSR against a seeded session and verify database/S3/audit removal.

Load scenarios use `certification/spec-factory-load.js`. At minimum provide
`SPEC_FACTORY_BASE_URL`, a comma-separated set of isolated certification
session IDs, auth, duration/rate overrides, and the manifest scenario ID:

```bash
k6 run certification/spec-factory-load.js \
  -e SCENARIO=load.turn-design \
  -e SPEC_FACTORY_BASE_URL=https://<host> \
  -e SPEC_FACTORY_SESSION_IDS=<id1,id2,...> \
  -e SPEC_FACTORY_AUTH_TOKEN=<token>
```

Chaos, role-boundary/DSR security, and DR are operator scenarios because they
manipulate live infrastructure. Run them only in the isolated certification
environment. Initialize the evidence bundle from the immutable manifest before
executing scenarios:

```bash
npm run spec-factory:certification:evidence -- init \
  --manifest=artifacts/spec-factory-certification/manifest.json \
  --evidence=artifacts/spec-factory-certification/evidence.json
```

Record every scenario once. Provide a non-empty machine-readable result plus a
logs or metrics file; `record` calculates and stores each file's SHA-256 and
byte size and refuses an unknown or duplicate scenario:

```bash
npm run spec-factory:certification:evidence -- record \
  --manifest=artifacts/spec-factory-certification/manifest.json \
  --evidence=artifacts/spec-factory-certification/evidence.json \
  --scenario=load.turn-design \
  --status=passed \
  --started-at=2026-07-13T18:00:00.000Z \
  --completed-at=2026-07-13T18:15:00.000Z \
  --artifact=result=artifacts/spec-factory-certification/load-turn-design.json \
  --artifact=metrics=artifacts/spec-factory-certification/load-turn-design-summary.json
```

Use `status=failed` or `status=blocked` when a scenario does not pass; do not
replace or omit the record. Preserve the complete evidence directory as one
immutable object set after evaluation.

Evaluate without editing the manifest or evidence:

```bash
npm run spec-factory:certification:evaluate -- \
  --manifest=artifacts/spec-factory-certification/manifest.json \
  --evidence=artifacts/spec-factory-certification/evidence.json \
  --output=artifacts/spec-factory-certification/evaluation.json
```

The evaluator exits nonzero for changed manifests; duplicate or unknown
scenario evidence; missing, failed, blocked, release/environment mismatched,
timestamp-invalid, unhashed, empty, duplicate, or under-evidenced artifacts;
and missing result/log-or-metrics evidence. Only a full pass emits
`sfv4-<sha256>`. Store the manifest, evidence, evaluation, dashboards, logs,
and DR/chaos reports together; the ID alone is not sufficient evidence.

## Table of Contents

- [1. Feature flag matrix](#1-feature-flag-matrix)
- [2. Staging rollout order](#2-staging-rollout-order)
- [3. Runtime mode configuration](#3-runtime-mode-configuration)
- [4. Metrics catalog](#4-metrics-catalog)
- [5. SLOs and alerts](#5-slos-and-alerts)
- [6. Incident triage playbooks](#6-incident-triage-playbooks)
- [7. Retention and DSR](#7-retention-and-dsr)
- [8. Deploy procedure](#8-deploy-procedure)
- [9. Rollback semantics](#9-rollback-semantics)
- [10. Cost governance](#10-cost-governance)
- [11. Common runbook questions](#11-common-runbook-questions)

---

## 1. Feature flag matrix

Every flag below is read from the ECS task definition environment
(`terraform/spec-factory-ecs.tf:255-296`). Values that are booleans use the
string `"true"` / `"false"` because `tostring(var...)` is how they are emitted.
Enum values are string literals matched case-sensitively in code. Defaults
mirror plan v3 §28 unless the code already ships with a different production
default; where those diverge, the "today" column names the code fallback.

| Flag                                               | Values                                         | Default (today)                                           | Gates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Plan ref                 |
| -------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `SPEC_FACTORY_MODE`                                | See canonical enum in `runtime-and-workers.md` | `all-local`                                               | Selects one of ten process roles: API, compatibility worker, seven dedicated worker roles, or dev-only all-local. Production must use the split roles; legacy disablement rejects `worker` and `all-local`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | v4 §9, Work Orders H/S/U |
| `OTEL_ENABLED`                                     | `true` \| `false`                              | `true` in Terraform                                       | Starts the Spec Factory OpenTelemetry SDK before database/server modules load. `false` leaves no-op providers in place.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | v4 §21, Work Order B     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`               | OTLP/HTTP URL                                  | `http://127.0.0.1:4317`                                   | Sends traces to the task-local CloudWatch Agent sidecar, which forwards them to X-Ray.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | v4 §21, Work Order B     |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`              | OTLP/HTTP URL                                  | `http://127.0.0.1:4318`                                   | Sends application histograms/counters to the task-local CloudWatch Agent sidecar under `Specter/SpecFactory`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | v4 §21, Work Order B     |
| `SPEC_FACTORY_WORKER_ID`                           | string                                         | `spec-factory-<mode>-<HOSTNAME or pid>`                   | Stable identity stored in `spec_factory_worker_heartbeats`; set explicitly only when an operator needs a fixed logical worker id. The default uses container hostname in ECS so multiple Fargate tasks do not collide on PID 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | §12.6                    |
| `SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED`            | `true` \| `false`                              | `false` for `all-local`, implicit `true` for split modes  | Opts the `all-local` process into heartbeat writes. Split modes always write heartbeats.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §12.6                    |
| `SPEC_FACTORY_WORKER_HEARTBEAT_MS`                 | integer ms                                     | `15000`                                                   | Interval for `spec_factory_worker_heartbeats.heartbeat_at` refresh. Writes are soft-failing and never block product paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §12.6                    |
| `DB_SSL`                                           | `true` \| `false`                              | `true` when RDS Proxy is enabled                          | Requests verified TLS from `mysql2`. Terraform enables it whenever the proxy has `require_tls=true`; existing direct-RDS connections retain their current behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | v4 Work Order Q          |
| `SPEC_FACTORY_DURABLE_EVENTS`                      | `true` \| `false`                              | `false`                                                   | The MySQL durable event store is always wired when the standard repository is available. `false` keeps best-effort behavior; `true` requires a durable `compose_session_events.id` before live fanout of the original SSE frame and emits `event_persist_failed` instead if persistence returns no id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §28, §10                 |
| `SPEC_FACTORY_SSE_DURABLE_POLL_MS`                 | integer ms                                     | `1000`                                                    | Recovery interval for cursor-batched reads from `compose_session_events`. Valkey is the low-latency live path; polling closes missed-fanout gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | v4 Work Order Q          |
| `SPEC_FACTORY_WORKFLOW_STATE_RATE_LIMIT_MAX`       | positive integer                               | `120`                                                     | Maximum authenticated workflow-state reads per actor and session in a fixed 60-second window on each API replica. The default permits one-second dashboard polling with headroom while bounding abusive database reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | v4 Work Order R          |
| `SPEC_FACTORY_DURABLE_TURNS`                       | `off` \| `shadow` \| `drain` \| `on`           | `off`                                                     | Durable turn-job cutover. `shadow` writes rows without executing them; `drain` stops accepting new legacy in-memory turns; `on` executes turns from `compose_turn_jobs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §28, §11                 |
| `SPEC_FACTORY_TURN_WORKER_ID`                      | string                                         | `${SPEC_FACTORY_WORKER_ID}:turn`                          | Optional explicit durable turn worker identity. Prefer the default hostname-derived value; do not set the same override on multiple scaled workers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §12.6                    |
| `SPEC_FACTORY_TURN_LEASE_MS`                       | integer ms                                     | `300000`                                                  | Durable turn lease TTL used when claiming turn jobs. Keep greater than expected turn runtime and heartbeat interval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §11                      |
| `SPEC_FACTORY_TURN_LEASE_HEARTBEAT_MS`             | integer ms                                     | half of `SPEC_FACTORY_TURN_LEASE_MS`                      | In-turn lease renewal interval. Empty uses the service default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | §11                      |
| `SPEC_FACTORY_TURN_WORKER_BATCH_SIZE`              | integer rows                                   | `25`                                                      | Maximum queued turn jobs a turn worker claims per drain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §12                      |
| `SPEC_FACTORY_TURN_WORKER_POLL_MS`                 | integer ms                                     | `1000`                                                    | Durable turn worker drain interval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §12                      |
| `SPEC_FACTORY_TURN_LEASE_RECOVERY_LIMIT`           | integer rows                                   | `100`                                                     | Maximum expired durable turn leases recovered per drain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §11                      |
| `SPEC_FACTORY_TURN_CLARIFICATION_EXPIRY_LIMIT`     | integer rows                                   | `100`                                                     | Maximum parked `awaiting_user_input` turns the durable turn worker expires per drain. Expired turns become `abandoned` and emit `turn.clarification_expired`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §21                      |
| `SPEC_FACTORY_AGENT_TASKS`                         | `true` \| `false`                              | `false`                                                   | Enables the Phase 5 `compose_agent_tasks` queue. Off means capability workers do not run. `SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED` is accepted as the newer internal alias and takes precedence when set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §28, §14                 |
| `SPEC_FACTORY_AGENT_TASK_WORKER_ID`                | string                                         | `${SPEC_FACTORY_WORKER_ID}:agent-task`                    | Optional explicit agent-task worker identity. Prefer the default hostname-derived value; do not set the same override on multiple scaled workers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §12.6, §14               |
| `SPEC_FACTORY_AGENT_TASK_WORKER_BATCH_SIZE`        | integer rows                                   | `25`                                                      | Maximum queued agent tasks an agent-task worker claims per drain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §14                      |
| `SPEC_FACTORY_AGENT_TASK_WORKER_POLL_MS`           | integer ms                                     | `1000`                                                    | Agent-task worker drain interval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §14                      |
| `SPEC_FACTORY_AGENT_TASK_LEASE_RECOVERY_LIMIT`     | integer rows                                   | `100`                                                     | Maximum expired agent-task leases recovered per drain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §14                      |
| `SPEC_FACTORY_AGENT_TASK_WORKER_CAPABILITIES`      | CSV capability names                           | derived from enabled flags                                | Optional capability filter for worker processes. Empty lets the service derive source distillation, context merge, research, critic, and handoff capabilities from feature flags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §14                      |
| `SPEC_FACTORY_WORKSPACE_MANAGER`                   | `true` \| `false`                              | `false`                                                   | Enables the Phase 4 workspace substrate gate for split runtime modes. `ComposeWorkspaceManager.attach()` / `detach()` / manifest writing already exist; off keeps production on the direct EFS materialization path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §28, §13                 |
| `SPEC_FACTORY_RESEARCH_EXECUTOR`                   | `none` \| `claude_agent_sdk`                   | `none`                                                    | Executor implementation the research capability dispatches to. `none` fails research tasks fast; `claude_agent_sdk` runs the SDK executor with the workspace hydrated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §28, §23                 |
| `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED`            | `true` \| `false`                              | `false`                                                   | Enables authenticated `POST /sessions/:sessionId/research/code` enqueue. Must be enabled separately from `SPEC_FACTORY_RESEARCH_EXECUTOR` so workers can be staged before user ingress opens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §28, §23                 |
| `SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS`              | CSV Claude SDK tools                           | `Read,Grep,Glob`                                          | Research executor tool surface. `rg`/`ripgrep` are accepted aliases for the safe ripgrep-backed `Grep` tool. `Bash` requires `SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | §23                      |
| `SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS`      | CSV anchored regexes                           | empty                                                     | Optional scoped Bash allowlist for research. Patterns must be fully anchored (`^...$`) and must not contain wildcard `.*` or shell-control metacharacters. Empty means Bash is unavailable even if listed in `SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §23                      |
| `SPEC_FACTORY_RESEARCH_MODEL_ID`                   | model id                                       | falls back to `SPEC_FACTORY_MODEL_ID`                     | Bedrock model override for Claude SDK research executor runs. This is separate from LLM Gateway model routing because research runs through the SDK tool loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §23                      |
| `SPEC_FACTORY_RESEARCH_TIMEOUT_MS`                 | integer ms                                     | `600000`                                                  | Claude SDK research runner timeout. The effective call timeout is also capped by `SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §23                      |
| `SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS`        | integer seconds                                | `600`                                                     | Per-task research executor runtime cap. Startup rejects `SPEC_FACTORY_AGENT_TASK_LEASE_MS < SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS * 1000` so a research run cannot outlive its agent-task lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §23                      |
| `SPEC_FACTORY_RESEARCH_MAX_COST_USD`               | numeric                                        | `3.0`                                                     | Per-task Claude SDK research budget cap used by manual and coordinator research reservations and enforced by the executor. Distinct from the aggregate `SPEC_FACTORY_RESEARCH_COST_CEILING_USD`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §23, §15.8               |
| `SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED`       | `true` \| `false`                              | `false`                                                   | Enqueue `source_distillation` for generated research outputs after the research artifact/source write succeeds. Separate from conversion-source distillation so generated research can be staged independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | §18, §24                 |
| `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION`         | `true` \| `false`                              | `false`                                                   | Enqueue `source_distillation` tasks after converted operator-added sources reach `source.conversion.completed`. Requires agent tasks and context versions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §28, §24                 |
| `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM`     | `true` \| `false`                              | `false`                                                   | Runs `source_distillation` through the LLM Gateway instead of the deterministic extractor. Requires `SPEC_FACTORY_LLM_GATEWAY=true`; off keeps the zero-cost deterministic patch builder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §24, §15                 |
| `SPEC_FACTORY_CONTEXT_DISTILLATION_MAX_COST_USD`   | numeric                                        | unset                                                     | Optional per-call cost cap passed to LLM-assisted source distillation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §24, §15.8               |
| `SPEC_FACTORY_CONTEXT_DISTILLATION_TIMEOUT_MS`     | integer ms                                     | unset                                                     | Optional timeout passed to LLM-assisted source distillation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §24                      |
| `SPEC_FACTORY_ENABLE_CONTEXT_MERGE`                | `true` \| `false`                              | `false`                                                   | Runs Context Merger processor. Two-phase artifact protocol requires flag on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §28, §20                 |
| `SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM`            | `true` \| `false`                              | `false`                                                   | Runs Context Merger semantic synthesis through the LLM Gateway while preserving backend-owned version, source, and patch identity fields. Requires `SPEC_FACTORY_LLM_GATEWAY=true`; off keeps deterministic merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §20, §15                 |
| `SPEC_FACTORY_CONTEXT_MERGE_MAX_COST_USD`          | numeric                                        | unset                                                     | Optional per-call cost cap passed to LLM-assisted context merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §20, §15.8               |
| `SPEC_FACTORY_CONTEXT_MERGE_TIMEOUT_MS`            | integer ms                                     | unset                                                     | Optional timeout passed to LLM-assisted context merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §20                      |
| `SPEC_FACTORY_LLM_GATEWAY`                         | `true` \| `false`                              | `false`                                                   | Route direct LLM calls through the Phase 8 gateway. Off means direct Bedrock/SDK usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §28, §15                 |
| `SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES`         | CSV purpose names                              | unset                                                     | Routes only the listed tool-free Gateway purposes through Bedrock Converse with native JSON-schema output. Unlisted purposes retain the Claude Agent SDK transport as a rollback path. Invalid purpose names fail at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | v4 Work Order C          |
| `SPEC_FACTORY_LLM_PROMPT_LOGGING`                  | `none` \| `redacted` \| `full`                 | `redacted` (target)                                       | Controls what the gateway stores on `spec_factory_llm_calls`. `full` requires `SPEC_FACTORY_LLM_SECURE_DEBUG=true` and is rejected when `NODE_ENV=production`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §28, §15.6               |
| `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE`             | filesystem path                                | unset                                                     | Optional root for redacted/full prompt-response audit artifacts. When unset, the gateway still records usage rows but leaves prompt/response artifact URIs null. DSR hard-delete treats file URIs under this root as covered artifacts and deletes those files before cascading DB rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §15.6, §31.3             |
| `SPEC_FACTORY_LLM_SECURE_DEBUG`                    | `true` \| `false`                              | `false`                                                   | Explicit non-production gate for `SPEC_FACTORY_LLM_PROMPT_LOGGING=full`; never set in production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §30.5                    |
| `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE`              | `static` \| `db`                               | `static`                                                  | Selects the prompt-version registry used before gateway provider calls. `static` keeps the in-code registry; `db` resolves active defaults and validates explicit `purpose@vN` values from `spec_factory_prompt_versions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §15.4                    |
| `SPEC_FACTORY_LLM_MAX_ATTEMPTS`                    | integer                                        | `3`                                                       | Maximum LLM Gateway provider attempts for transient throttling, 429, 5xx, and timeout errors. Terminal audit rows record only the final outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §15.8                    |
| `SPEC_FACTORY_LLM_RETRY_BASE_MS`                   | integer ms                                     | `25`                                                      | Linear backoff base for LLM Gateway transient retries. Set to `0` only in tests or controlled local debugging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §15.8                    |
| `SPEC_FACTORY_LLM_MODEL_ALLOWLIST`                 | CSV model ids                                  | unset                                                     | Optional allowlist for all Gateway model routes. Empty permits the resolved model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §15                      |
| `SPEC_FACTORY_LLM_MODEL_<PURPOSE>`                 | model id                                       | unset                                                     | Purpose-specific Gateway model override. Supported suffixes: `CHAT_COORDINATOR_FAST`, `CHAT_COORDINATOR_STRONG`, `SOURCE_DISTILLATION`, `CONTEXT_MERGE`, `CRITIC_REVIEW`, `HANDOFF_SYNTHESIS`, `CONVERSATION_SUMMARY`. Empty falls back to `SPEC_FACTORY_MODEL_ID`, then `ANTHROPIC_MODEL`, then the code default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §15                      |
| `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS`               | positive integer                               | unset                                                     | Optional global Gateway output-token cap. Purpose-specific overrides use `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_<PURPOSE>` (for example `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_FAST`). The gateway rejects caller requests above the cap before provider execution and passes the effective cap to Bedrock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §15.6                    |
| `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_<PURPOSE>`     | positive integer                               | unset                                                     | Purpose-specific Gateway output-token cap. Supported suffixes match `SPEC_FACTORY_LLM_MODEL_<PURPOSE>`. Empty falls back to the global cap or provider default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | §15.6                    |
| `SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD`        | numeric                                        | unset                                                     | Optional gateway pre-flight ceiling on committed session spend plus the call's `maxCostUsd`; when set, calls without `maxCostUsd` fail closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §28, §15.8               |
| `SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD`   | numeric                                        | unset                                                     | Optional gateway pre-flight ceiling on global UTC-day committed spend plus the call's `maxCostUsd`; uses `spec_factory_llm_calls.created_at`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §28, §15.8               |
| `SPEC_FACTORY_CHAT_COORDINATOR`                    | `true` \| `false`                              | `false`                                                   | Routes selected turns to the Phase 9 Chat Coordinator when `SPEC_FACTORY_LLM_GATEWAY=true`. Coordinator `answer` decisions complete directly; `escalate` writes a policy-denied assistant final. `dispatch_research` enqueues `code_research`, `config_research`, or `devops_research` tasks when `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk`, `SPEC_FACTORY_DURABLE_TURNS=drain \| on`, and session budget gates pass. Durable dispatch parks the turn in `waiting_on_research`, then wakes it after linked tasks become terminal with bounded generated research and task outcomes in context. Durable `ask_clarification` parks the same turn in `awaiting_user_input`; an idempotent user answer requeues it, and the worker expires stale turns. With legacy runtime enabled, unsupported decisions and coordinator failures may fall back to `ComposeChatAgent`; with legacy runtime disabled, they fail closed. | §28, §21                 |
| `SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN`      | integer                                        | `3`                                                       | Coordinator dispatch fan-out ceiling per turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §28                      |
| `SPEC_FACTORY_COORDINATOR_MAX_COST_USD`            | numeric                                        | unset (`0.25` when LLM Gateway cost ceilings are enabled) | Per-call reservation passed to the Chat Coordinator's LLM Gateway call. If unset and either LLM Gateway cost ceiling is configured, the server supplies `0.25` so budget pre-flight remains fail-closed without disabling coordinator routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §28, §15.8               |
| `SPEC_FACTORY_ENABLE_CRITIC`                       | `true` \| `false`                              | `false`                                                   | Enables Phase 11 critic review scheduling when `SPEC_FACTORY_LLM_GATEWAY=true`. Successful, non-deduplicated assistant finals enqueue a non-blocking critic task. Worker executor registration is independent: a worker assigned `critic_review` in `SPEC_FACTORY_AGENT_TASK_WORKER_CAPABILITIES` always registers the executor or fails startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §28, §11-phase           |
| `SPEC_FACTORY_CRITIC_MAX_COST_USD`                 | numeric                                        | unset                                                     | Optional per-call cost cap passed to the Critic executor's LLM Gateway call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §28, §15.8               |
| `SPEC_FACTORY_CRITIC_TIMEOUT_MS`                   | integer ms                                     | unset                                                     | Optional timeout passed to the Critic executor's LLM Gateway call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §28                      |
| `SPEC_FACTORY_HANDOFF_ENRICHED`                    | `true` \| `false`                              | `false`                                                   | Enables Phase 10 bounded `COMPOSE-<sessionId>` source-summary enrichment and persists deterministic `handoff/handoff-v1.md` + `.json` artifacts into the session workspace before creating a Spec Factory evidence snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §28, §25                 |
| `SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED`          | `true` \| `false`                              | `false`                                                   | Routes Compose handoff artifact/evidence/draft generation through a queued `handoff_build` agent task. Off preserves the synchronous handoff path. Worker executor registration is independent: a worker assigned `handoff_build` in `SPEC_FACTORY_AGENT_TASK_WORKER_CAPABILITIES` always registers the executor or fails startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §28, §25                 |
| `SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS`               | `true` \| `false`                              | `false`                                                   | Adds LLM-authored executive summary, implementation brief, evidence map, and open-question fields to queued `handoff_build` Markdown/JSON artifacts. Requires `SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED=true` and `SPEC_FACTORY_LLM_GATEWAY=true`; synchronous handoff remains deterministic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §28, §25                 |
| `SPEC_FACTORY_HANDOFF_SYNTHESIS_MAX_COST_USD`      | numeric                                        | unset                                                     | Optional per-call cost cap passed to the handoff synthesis LLM Gateway call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §28, §15.8               |
| `SPEC_FACTORY_HANDOFF_SYNTHESIS_TIMEOUT_MS`        | integer ms                                     | unset                                                     | Optional timeout passed to the handoff synthesis LLM Gateway call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | §28                      |
| `SPEC_FACTORY_ADMIN_IDS`                           | comma-separated OIDC subs                      | empty                                                     | Actors whose `ActorContext.roles` include `admin` (plan v3 §9.2). Empty means no admin actor exists in the session guard layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | §28, §9.2                |
| `SPEC_FACTORY_RESEARCH_COST_CEILING_USD`           | numeric                                        | unset                                                     | Per-session rolling ceiling used by manual `POST /research/code` and coordinator `dispatch_research` before enqueue. Unset is fail-closed for both paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §28, §15.8               |
| `SPEC_FACTORY_RESEARCH_TASKS_PER_24H`              | integer                                        | unset                                                     | Per-session rolling ceiling on manual/coordinator research task creations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §28                      |
| `SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION` | integer                                        | `3`                                                       | Per-session cap on queued/running manual/coordinator research tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | §28                      |
| `SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD`    | numeric                                        | unset                                                     | Optional global rolling ceiling for research reservations and committed spend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §28, §15.8               |
| `SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS`      | integer                                        | unset                                                     | Optional global cap on queued/running research tasks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | §28                      |
| `SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H`       | integer                                        | unset                                                     | Optional global rolling cap on research task creations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §28                      |

Compose-side knobs that already ship in production but are not "phase flags":

| Env                                              | Purpose                                                                                                                                               | Code                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `SPEC_FACTORY_PORT`                              | Express bind port (default `3012`).                                                                                                                   | `src/spec-factory/main.ts:4`                                                             |
| `SPEC_FACTORY_JIRA_PROJECT_KEY`                  | Jira project key for generated epic/story publication (default `CPDEV`).                                                                              | `terraform/spec-factory-ecs.tf:290`, `src/spec-factory/jira-publisher.ts:81`             |
| `SPEC_FACTORY_JIRA_EPIC_ISSUE_TYPE`              | Jira issue type for generated epics (default `Epic`).                                                                                                 | `terraform/spec-factory-ecs.tf:291`, `src/spec-factory/jira-publisher.ts:82`             |
| `SPEC_FACTORY_JIRA_CHILD_ISSUE_TYPE`             | Jira issue type for generated child work items (default `Story`).                                                                                     | `terraform/spec-factory-ecs.tf:292`, `src/spec-factory/jira-publisher.ts:83`             |
| `SPEC_FACTORY_QUALIFIER_TIMEOUT_MS`              | Claude SDK qualification timeout (default `300000`).                                                                                                  | `terraform/spec-factory-ecs.tf:376`, `src/spec-factory/qualifier.ts:243`                 |
| `SPEC_FACTORY_PROCESSOR_POLL_MS`                 | Louise-board processor poll interval (default `5000`).                                                                                                | `terraform/spec-factory-ecs.tf:295`, `src/spec-factory/service.ts:557`                   |
| `SPEC_FACTORY_DRAFT_TIMEOUT_MS`                  | Claude SDK draft-generation timeout (default `1200000`, 20 minutes).                                                                                  | `terraform/spec-factory-ecs.tf:294`, `src/spec-factory/draft-generator.ts:337`           |
| `COMPOSE_MAX_QUEUED_TURNS`                       | Per-session running+queued turn cap (default `3`).                                                                                                    | `terraform/spec-factory-ecs.tf:378`, `src/spec-factory/compose-service.ts:87`            |
| `COMPOSE_MAX_UPLOAD_BYTES`                       | Presigned-upload cap (default 500 MB, mirrors sidecar).                                                                                               | `terraform/spec-factory-ecs.tf:379`, `src/spec-factory/compose-service.ts:93-94`         |
| `COMPOSE_CHAT_TIMEOUT_MS`                        | Claude SDK timeout for Compose chat turns (default `300000`).                                                                                         | `terraform/spec-factory-ecs.tf:380`, `src/spec-factory/compose-chat-agent.ts:323`        |
| `COMPOSE_CHAT_MAX_PROMPT_TOKENS`                 | Estimated prompt-token cap for Compose chat turns (default `150000`).                                                                                 | `terraform/spec-factory-ecs.tf:381`, `src/spec-factory/compose-chat-agent.ts:56`         |
| `COMPOSE_RETRY_BASE_MS`                          | Backoff base for transient chat-turn retries (default `1000`).                                                                                        | `terraform/spec-factory-ecs.tf:382`, `src/spec-factory/compose-service.ts:103`           |
| `COMPOSE_WORKSPACE_VALIDATE_ON_STARTUP`          | Opts all-local startup into `COMPOSE_WORKSPACE_BASE` validation; split modes validate regardless.                                                     | `terraform/spec-factory-ecs.tf:402`, `src/spec-factory/server.ts:713`                    |
| `COMPOSE_CONVERT_TIMEOUT_MS`                     | Timeout for document conversion sidecar calls (default `300000`).                                                                                     | `terraform/spec-factory-ecs.tf:412`, `src/spec-factory/compose-conversion.ts:24`         |
| `COMPOSE_CONVERSION_LEASE_MS`                    | DB lease TTL for the conversion worker.                                                                                                               | `terraform/spec-factory-ecs.tf:415`, `src/spec-factory/compose-conversion.ts`            |
| `COMPOSE_CONVERSION_POLL_MS`                     | Conversion worker drain poll interval (default `5000`).                                                                                               | `terraform/spec-factory-ecs.tf:416`, `src/spec-factory/server.ts:966`                    |
| `SPEC_FACTORY_AGENT_TASK_LEASE_MS`               | Agent-task worker lease TTL (default `900000`). Must be at least `SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS * 1000` before research executor startup. | `src/spec-factory/compose-agent-task-worker.ts:13`, `src/spec-factory/server.ts:662-672` |
| `COMPOSE_AUDIO_SEGMENT_SECONDS`                  | Voxtral segmentation window; must respect the 25 MB Bedrock `InvokeModel` cap (see auto-memory).                                                      | `terraform/spec-factory-ecs.tf:410`                                                      |
| `COMPOSE_VOXTRAL_MAX_REQUEST_BYTES`              | Voxtral request-body preflight cap (default `8000000`).                                                                                               | `terraform/spec-factory-ecs.tf:411`, `src/spec-factory/compose-voxtral.ts:29`            |
| `COMPOSE_RETENTION_CLEANUP_ENABLED`              | Migration 046 workspace cleanup toggle.                                                                                                               | `terraform/spec-factory-ecs.tf:417`                                                      |
| `COMPOSE_RETENTION_SWEEP_MS`                     | Retention sweep interval after the guarded startup pass (default `21600000`, 6 hours).                                                                | `terraform/spec-factory-ecs.tf:420`, `src/spec-factory/session/retention-policy.ts:71`   |
| `COMPOSE_CLEANUP_LIMIT`                          | Max archived sessions processed per retention sweep (default `50`).                                                                                   | `terraform/spec-factory-ecs.tf:419`, `src/spec-factory/session/retention-policy.ts:65`   |
| `COMPOSE_CLEANUP_DRY_RUN`                        | Dry-run cleanup without deletes.                                                                                                                      | `terraform/spec-factory-ecs.tf:423`                                                      |
| `SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES`        | Source-deletion Undo window (default `10`). The API uses it to set the durable `undo_until` deadline.                                                 | `src/spec-factory/session/retention-policy.ts`                                           |
| `SPEC_FACTORY_SOURCE_DELETE_SWEEP_MS`            | Retention-worker source-deletion purge interval (default `60000`).                                                                                    | `src/spec-factory/server.ts`                                                             |
| `SPEC_FACTORY_SOURCE_DELETE_PURGE_LIMIT`         | Maximum deletion batches claimed per source-deletion sweep (default `50`).                                                                            | `src/spec-factory/compose-source-deletion.ts`                                            |
| `SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS`   | Age threshold for purging stale `spec_factory_worker_heartbeats` rows during the retention sweep (default `7`).                                       | `terraform/spec-factory-ecs.tf:421`, `src/spec-factory/compose-retention.ts`             |
| `SPEC_FACTORY_WORKER_HEARTBEAT_GC_LIMIT`         | Max stale worker-heartbeat rows deleted per retention pass (default `500`).                                                                           | `terraform/spec-factory-ecs.tf:422`, `src/spec-factory/compose-retention.ts`             |
| `COMPOSE_ARTIFACT_TMP_RETENTION_HOURS`           | Age threshold for stale `.tmp` artifact cleanup under `COMPOSE_WORKSPACE_BASE` (default `24`).                                                        | `src/spec-factory/compose-artifact-gc.ts`                                                |
| `COMPOSE_ARTIFACT_GC_LIMIT`                      | Max stale `.tmp` entries deleted per cleanup pass (default `500`).                                                                                    | `src/spec-factory/compose-artifact-gc.ts`                                                |
| `COMPOSE_ARTIFACT_GC_MAX_DEPTH`                  | Max directory depth searched for `.tmp` artifact directories (default `6`).                                                                           | `src/spec-factory/compose-artifact-gc.ts`                                                |
| `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS` | Age threshold for deleting file-backed LLM audit prompt/response artifacts and clearing their DB URIs (default `30`).                                 | `src/spec-factory/llm/llm-audit-retention.ts`                                            |
| `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT`       | Max LLM audit rows cleaned per retention pass (default `500`).                                                                                        | `src/spec-factory/llm/llm-audit-retention.ts`                                            |
| `COMPOSE_S3_REACHABILITY_GC_ENABLED`             | Enables S3 DB-reachability cleanup under `COMPOSE_S3_PREFIX`; disabled by default. Honors `COMPOSE_CLEANUP_DRY_RUN`.                                  | `src/spec-factory/compose-s3-reachability-gc.ts`                                         |
| `COMPOSE_S3_REACHABILITY_GC_LIMIT`               | Max S3 objects inspected per reachability pass (default `1000`).                                                                                      | `src/spec-factory/compose-s3-reachability-gc.ts`                                         |
| `COMPOSE_HARD_DELETE_SESSION_ID`                 | One-shot DSR hard-delete target. When set, `spec-factory:compose-cleanup` runs only the hard-delete path.                                             | `src/spec-factory/compose-cleanup.ts`                                                    |
| `COMPOSE_HARD_DELETE_DRY_RUN`                    | DSR hard-delete dry-run toggle. Defaults to `true`; destructive mode requires `false`.                                                                | `src/spec-factory/compose-cleanup.ts`                                                    |
| `COMPOSE_HARD_DELETE_CONFIRM`                    | Exact destructive confirmation token: `delete-session:<sessionId>`.                                                                                   | `src/spec-factory/compose-hard-delete.ts`                                                |
| `COMPOSE_CHAT_MODEL_ID`                          | Compose chat model override for `ComposeChatAgent`.                                                                                                   | `terraform/spec-factory-ecs.tf:377`                                                      |

Status callout: `SPEC_FACTORY_MODE` is wired in `server.ts` and defaults to
`all-local`. Non-`all-local` modes are still a rollout surface: set
`SPEC_FACTORY_WORKSPACE_MANAGER=true` before enabling them, and use
`SPEC_FACTORY_ALLOW_SPLIT_RUNTIME=true` only as a temporary compatibility
override while migrating existing environments.

---

## 2. Staging rollout order

Ordered per plan v3 §33.2. Each step lists the flag flip and the phase that
enables it. Never advance to the next step until the SLO gates for the
current step are clean for the agreed staging window (default: 24 hours of
production-like traffic, no alerts, plan v3 §30.4).

| #   | Step                              | Flags flipped                                                                                                                                 | Phase                                                                                                                                      | Verification                                                                                                                                      |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Archive enforcement               | (session-guard code path enabled implicitly)                                                                                                  | Phase 0                                                                                                                                    | Archived sessions reject mutation; protected sessions reject expired tokens (plan v3 §9.4).                                                       |
| 2   | Durable events, shadow            | `SPEC_FACTORY_DURABLE_EVENTS=true` with best-effort store                                                                                     | Phase 1                                                                                                                                    | Every SSE frame appears in `compose_session_events` for the last N sessions; `compose.events.publish` failures = 0.                               |
| 3   | DB stream tokens verified         | no new flag; `compose_stream_tokens` is always authoritative                                                                                  | Phase 1                                                                                                                                    | Token minted on replica A validates on replica B through the DB store; TTL and archive revocation are honored.                                    |
| 4   | Durable events, active            | `SPEC_FACTORY_DURABLE_EVENTS=true` (required, not best-effort)                                                                                | Phase 1                                                                                                                                    | Reconnect with `Last-Event-ID=<n>` replays every intervening frame with matching `durableEventType` (`src/spec-factory/compose-sse.ts:65`).       |
| 5   | Durable turns, shadow             | `SPEC_FACTORY_DURABLE_TURNS=shadow`                                                                                                           | Phase 2                                                                                                                                    | `compose_turn_jobs` row written for every legacy turn; `durable_queued` and `durable_running` gauges track legacy queue depth.                    |
| 6   | Durable turns, drain              | `SPEC_FACTORY_DURABLE_TURNS=drain`                                                                                                            | Phase 2                                                                                                                                    | New turns route to durable path; `legacy_inflight` monotonically decreases to `0` across all API replicas.                                        |
| 7   | Durable turns, on                 | `SPEC_FACTORY_DURABLE_TURNS=on`                                                                                                               | Phase 2                                                                                                                                    | Durable workers execute every turn; `legacy_inflight` stays `0`; duplicate final messages = `0`.                                                  |
| 8   | Workspace manager                 | `SPEC_FACTORY_WORKSPACE_MANAGER=true`                                                                                                         | Phase 4                                                                                                                                    | `WorkspaceManager.attach()` succeeds for a session on a fresh worker; manifest reflects committed context version.                                |
| 9   | Runtime split                     | `SPEC_FACTORY_MODE=api` on one service, `worker` on another                                                                                   | Phase 3                                                                                                                                    | Both replicas heartbeat; API replica does not execute turns; worker replica does not serve HTTP. Requires step 8.                                 |
| 10  | Agent tasks                       | `SPEC_FACTORY_AGENT_TASKS=true`                                                                                                               | Phase 5                                                                                                                                    | `compose_agent_tasks` rows are claimed with lease semantics; capability registry dispatches.                                                      |
| 11  | Generated research, manual        | `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk`, `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=true`, `SPEC_FACTORY_RESEARCH_COST_CEILING_USD=<n>` | Phase 6                                                                                                                                    | Manual trigger creates a `generated_research` source; artifact stored under S3 prefix; cost stays under `SPEC_FACTORY_RESEARCH_COST_CEILING_USD`. |
| 12  | Context versions, shadow          | `SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION=true`, `SPEC_FACTORY_ENABLE_CONTEXT_MERGE=true`                                                     | Phase 7                                                                                                                                    | Distillation writes patches; merger writes versions; `compose_sessions.latest_context_version` advances; chat still reads `context.md`.           |
| 13  | LLM Gateway, shadow               | `SPEC_FACTORY_LLM_GATEWAY=true` for distillation/critic only                                                                                  | Phase 8                                                                                                                                    | `spec_factory_llm_calls` audit populated; retries/budgets/rate visible.                                                                           |
| 14  | Chat Coordinator, limited routing | `SPEC_FACTORY_LLM_GATEWAY=true`, `SPEC_FACTORY_CHAT_COORDINATOR=true`; add `SPEC_FACTORY_DURABLE_TURNS=drain                                  | on`, `SPEC_FACTORY_RESEARCH_EXECUTOR=claude_agent_sdk`, and `SPEC_FACTORY_RESEARCH_COST_CEILING_USD=<n>` before enabling research dispatch | Phase 9                                                                                                                                           | Coordinator `answer` and `escalate` decisions persist directly; escalation writes a policy-denied assistant final. `code_research`, `config_research`, and `devops_research` dispatch is durable-only: it parks the turn in `waiting_on_research`, wakes after linked tasks finish, and re-enters the coordinator with bounded generated-research Markdown plus linked task status/error history for synthesis. If durable workers or budget gates are unavailable, the turn falls back to legacy. Durable `ask_clarification` parks in `awaiting_user_input`; a later user answer requeues the same turn, while the durable turn worker expires stale parked turns. Unsupported non-research capabilities and coordinator errors fall back to legacy until their state machines land. |

Production rule (plan v3 §33.3): never enable Chat Coordinator as the sole
chat path before durable turn jobs and generated research have been stable
for the agreed staging window. Stability for Phase 2 specifically means the
gates in §30.4 hold, duplicate final messages are `0`, and `drain` has
demonstrated `legacy_inflight==0` during a rolling deploy.

---

## 3. Runtime mode configuration

Runtime mode is selected by `SPEC_FACTORY_MODE`. The canonical
description of the runtime mode enum and worker responsibilities lives in
[`runtime-and-workers.md`](./runtime-and-workers.md); this section summarizes
the operational surface. All Node roles use the same compiled application, but
Terraform deploys four role-specific image targets so API, core, research, and
conversion tasks receive only their required OS tools.

| Mode                | Runs                                                      | ECS service               |
| ------------------- | --------------------------------------------------------- | ------------------------- |
| `api`               | HTTP API, auth, durable enqueue, SSE replay/live fanout   | `SPEC-FACTORY`            |
| `worker`            | Compatibility processing during migration only            | `SPEC-FACTORY-WORKER`     |
| `turn-worker`       | Ordered durable turns and Chat Coordinator                | `SPEC-FACTORY-TURN`       |
| `context-worker`    | Distillation, merge, critic, and handoff build            | `SPEC-FACTORY-CONTEXT`    |
| `research-worker`   | Tool-enabled code/config/devops research                  | `SPEC-FACTORY-RESEARCH`   |
| `conversion-worker` | Source conversion with task-local MarkItDown sidecar      | `SPEC-FACTORY-CONVERSION` |
| `draft-worker`      | Durable draft, approval, Jira publish, and OneShot stages | `SPEC-FACTORY-DRAFT`      |
| `relay-worker`      | Transactional outbox and canonical event relay            | `SPEC-FACTORY-RELAY`      |
| `retention-worker`  | Retention, repair reconciliation, and artifact GC         | `SPEC-FACTORY-RETENTION`  |
| `all-local`         | All processors for local development                      | Never production          |

Every worker mode writes `worker_id`, `mode`, `hostname`, `process_id`,
`started_at`, `heartbeat_at`, and `capabilities_json` to
`spec_factory_worker_heartbeats` (plan v3 §12.6). On-call joins that inventory
with `compose_turn_jobs.active_worker_id` or `compose_agent_tasks.active_worker_id`
to determine which process owns a stuck lease.

Status: application and Terraform topology are code-ready but unapplied. The
compatibility worker remains available only for staged migration. The
legacy-disabled startup and Terraform checks reject a final configuration that
uses `worker` or `all-local`, lacks role capacity, or has not met the repair,
event, artifact, budget, retention, image, and certification gates.

### 3.1 ECS task definition surface

The API task definition has two containers when
`spec_factory_otel_enabled=true`:

- `spec-factory` — essential, port `3012`, ECR
  `specter/spec-factory-api`, with no repository tooling or EFS dependency in
  the legacy-disabled topology.
- `ecs-cwagent` — non-essential CloudWatch Agent sidecar. It receives OTLP/HTTP
  traces on `4317` and metrics on `4318`; its config comes from
  `/specter/<environment>/spec-factory/cwagent/config` in Parameter Store. A
  configurable 256 MiB hard cap prevents telemetry failure from starving the
  product container.

Health checks: `spec-factory` polls `curl -fsS http://localhost:3012/health`.
The conversion task alone adds `compose-markitdown`, which polls
`http://localhost:8080/health` via Python urllib. ALB listener rule at priority
140 routes `/api/spec-factory` and
`/api/spec-factory/*` to target group on `3012`.

Mode-scoped services use the `core`, `research`, or `conversion` image target,
set `SPEC_FACTORY_MODE` per service, force the v4 workspace/artifact contract,
disable research ingress, and include `compose-markitdown` only for
`conversion-worker`.
(`SPEC_FACTORY_PORT` remains for the health endpoint but is not exposed via
the ALB rule).

---

## 4. Metrics catalog

### 4.0 OpenTelemetry baseline (v4 Work Order B)

All API responses include `x-request-id`. A valid caller-supplied value is
preserved; otherwise the API generates a UUID. Migration `068` persists that
ID on `spec_factory_processing_jobs`, `compose_turn_jobs`,
`compose_agent_tasks`, `compose_session_sources`, `spec_factory_llm_calls`,
`spec_factory_events`, and `compose_session_events`. Workers restore the persisted ID into
`AsyncLocalStorage`, so Pino logs and OpenTelemetry spans include the same
correlation after a replica or process handoff. Do not use IDs as metric
dimensions.

Turn and agent-task queue age starts at the latest transition into `queued`,
not original row creation. Conversion queue age starts when a source becomes
eligible (`updated_at` for pending work, lease expiry for a delayed retry), so
upload time and retry backoff are not reported as worker saturation.

| Metric                                | Type      | Low-cardinality labels                                      |
| ------------------------------------- | --------- | ----------------------------------------------------------- |
| `spec_factory.work.accepted`          | counter   | `work_type`, optional `subtype`                             |
| `spec_factory.work.outcome`           | counter   | `work_type`, optional `subtype`, `outcome`                  |
| `spec_factory.work.queue_age_ms`      | histogram | `work_type`, optional `subtype`                             |
| `spec_factory.work.run_duration_ms`   | histogram | `work_type`, optional `subtype`, `outcome`                  |
| `spec_factory.provider.calls`         | counter   | `purpose`, `provider`, `model`, `outcome`                   |
| `spec_factory.provider.latency_ms`    | histogram | same as provider calls                                      |
| `spec_factory.provider.tokens`        | histogram | provider labels plus `token_type`                           |
| `spec_factory.provider.cost_usd`      | histogram | provider labels                                             |
| `spec_factory.coordinator.routes`     | counter   | `outcome`, `action`, optional bounded `reason`              |
| `spec_factory.coordinator.latency_ms` | histogram | same as coordinator routes                                  |
| `spec_factory.http.requests`          | counter   | normalized `method`, `route`, `status_code`, `status_class` |
| `spec_factory.http.duration_ms`       | histogram | same as HTTP requests                                       |
| `spec_factory.lease.events`           | counter   | `work_type`, optional `subtype`, `event`                    |

Dimensionless `spec_factory.slo.*` streams back production alarms without
coupling them to model names or capability labels:

- `turn_queue_age_ms`, `draft_queue_age_ms`, `provider_latency_ms`, and
  `coordinator_latency_ms` are percentile histograms.
- `coordinator_attempts` and `coordinator_successes` drive the selected-route
  success-rate alarm.
- Terraform dashboard `<environment>-spec-factory` shows p50/p95/p99 queue,
  run, provider, and coordinator latency plus work/coordinator outcomes.

Metric names below are the canonical dot.snake identifiers from plan v3 §30.2.
Emitters should use `session_id`, `turn_job_id`, `agent_task_id`,
`context_version`, `source_id`, `worker_id`, `capability`, `executor_type`,
`status`, `latency_ms`, `attempt_count`, `error_code` as structured log fields
(§30.1) so a metric spike is traceable to a specific turn or task.

### 4.1 Turn queue

| Metric                               | Type                    | Measures                                                                                                                                                                               | When to look                                                                                                                                                                                        |
| ------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.turns.queued`               | counter                 | Turn jobs enqueued (durable path).                                                                                                                                                     | Throughput. Sudden dip means intake stopped; sudden spike alongside stagnant `completed` means workers are stuck.                                                                                   |
| `compose.turns.running`              | counter                 | Turn jobs transitioned to `running`.                                                                                                                                                   | Confirms workers are claiming. If `queued > 0` but this stays flat, no worker is leasing.                                                                                                           |
| `compose.turns.completed`            | counter                 | Turn jobs finalized with an assistant message.                                                                                                                                         | Baseline of successful throughput.                                                                                                                                                                  |
| `compose.turns.failed`               | counter                 | Turn jobs finalized with terminal failure.                                                                                                                                             | Any nonzero delta is a triage signal.                                                                                                                                                               |
| `compose.turns.duplicate_suppressed` | counter                 | Idempotency-key hits that returned prior state, recorded as `turn.duplicate_suppressed` events and surfaced through `/status` as `composeControlPlane.turns.duplicateSuppressedToday`. | Elevated rate above the normal retry baseline is triage (§6.2).                                                                                                                                     |
| `compose.turns.legacy_inflight`      | gauge (per API replica) | Legacy in-memory turns still running.                                                                                                                                                  | The `drain -> on` cutover gate. Must be `0` on every replica before flipping to `on`.                                                                                                               |
| `compose.turns.legacy_queued`        | gauge (per API replica) | Legacy in-memory turns queued behind the running turn.                                                                                                                                 | During `drain`, this should monotonically fall to `0` before `legacy_inflight` reaches `0`.                                                                                                         |
| `compose.turns.durable_queued`       | gauge                   | Durable path queue depth.                                                                                                                                                              | Sustained growth = worker starvation or capability saturation.                                                                                                                                      |
| `compose.turns.durable_running`      | gauge                   | Durable path in-flight turns.                                                                                                                                                          | Should track worker count. Zero with `durable_queued > 0` = same starvation.                                                                                                                        |
| `compose.turns.durable_abandoned`    | counter                 | Turns marked `abandoned` by stale sweep.                                                                                                                                               | Any burst = worker crash or lease reclaim loop; see §6.1.                                                                                                                                           |
| `compose.turns.lease_expired`        | counter                 | Lease-expiry reclaim events (heartbeat renewal returned 0 rows).                                                                                                                       | Repeated lease expiry from the same `worker_id` means the worker is hung; kill and re-lease.                                                                                                        |
| `compose.turns.lease_fence_rejected` | counter                 | Worker-side pre-side-effect fence rejections (§11.3).                                                                                                                                  | Any nonzero value means a stale worker attempted to write after another claimed. Not a data-loss condition (fence rejected the write), but investigate the underlying worker to prevent duplicates. |

### 4.2 Events and streaming

| Metric                          | Measures                                                                                                                                                                                                                           | When to look                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.events.published`      | Events inserted to `compose_session_events`.                                                                                                                                                                                       | Baseline.                                                                                                                                                       |
| `compose.events.replayed`       | Events emitted from replay on SSE reconnect.                                                                                                                                                                                       | Elevated = frequent disconnects. Combine with `compose.streams.disconnected`.                                                                                   |
| `compose.streams.connected`     | SSE connections opened.                                                                                                                                                                                                            |                                                                                                                                                                 |
| `compose.streams.disconnected`  | SSE connections closed.                                                                                                                                                                                                            | If disconnected >> connected, downstream proxies are dropping.                                                                                                  |
| `compose.stream_tokens.created` | UTC-day stream tokens minted, surfaced through `/status` as `composeControlPlane.streamTokens.createdToday` with `latestCreatedAt`.                                                                                                | Confirms protected-session resume is minting DB-backed tokens.                                                                                                  |
| `compose.stream_tokens.revoked` | UTC-day tokens revoked, surfaced through `/status` as `composeControlPlane.streamTokens.revokedToday` with `latestRevokedAt`; active and expired-unrevoked token gauges are paired as `activeTokens` and `expiredUnrevokedTokens`. | Confirms archive flow revoked tokens before commit (plan v3 §9.3). A growing expired-unrevoked gauge means the retention cleaner is not purging token TTL rows. |

### 4.3 Agent tasks

| Metric                                           | Measures                                                                                                                                             | When to look                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.agent_tasks.queued`                     | Rows inserted into `compose_agent_tasks`.                                                                                                            |                                                                                                                                        |
| `compose.agent_tasks.completed`                  | Rows transitioned to `completed`.                                                                                                                    | Backlog = `queued - completed - failed`.                                                                                               |
| `compose.agent_tasks.by_capability`              | Per-capability queue depth and terminal counters surfaced through `/status` as `composeControlPlane.agentTasks.byCapability.<capability>`.           | Use this to separate research saturation from critic, context, or handoff worker saturation.                                           |
| `compose.agent_tasks.lease_fence_rejected`       | Worker-side completion/failure fence rejections, surfaced through `/status` as `agentTasks.leaseFenceRejected`.                                      | Nonzero means a stale worker tried to finish a task after its lease was superseded.                                                    |
| `compose.workers.live` / `compose.workers.stale` | `/status` live/stale worker heartbeat totals from `spec_factory_worker_heartbeats`, grouped by runtime mode in `composeControlPlane.workers.byMode`. | Stale worker count > 0 during split-mode rollout means a process is dead or cannot write heartbeats; check worker logs before scaling. |

### 4.4 Context and research

| Metric                               | Measures                                                                                                                                                                                                                                                                  | When to look                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.context_patches.ready`      | Ready `compose_context_patches` backlog surfaced through `/status` as `composeControlPlane.context.patchesReady`.                                                                                                                                                         | Growth means distillation is producing patches faster than the merger commits versions.                                                              |
| `compose.context_patches.failed`     | Failed context patch builds surfaced through `/status` as `composeControlPlane.context.patchesFailed`.                                                                                                                                                                    | Nonzero means distillation or artifact-write failures; inspect patch error messages and source conversion status.                                    |
| `compose.context_versions.committed` | UTC-day committed `compose_context_versions` surfaced through `/status` as `composeControlPlane.context.versionsCommittedToday`.                                                                                                                                          | Should track distillation throughput. Zero after distillation runs = merger stuck.                                                                   |
| `compose.context_versions.failed`    | UTC-day failed merge attempts surfaced through `/status` as `composeControlPlane.context.versionsFailedToday`.                                                                                                                                                            | Two-phase artifact protocol failures or merge conflicts.                                                                                             |
| `compose.research.runtime_seconds`   | Wall-clock runtime of research executor per task, surfaced through `/status` as `composeControlPlane.research.avgRuntimeSecondsToday`, `.maxRuntimeSecondsToday`, `.runningTasks`, `.completedToday`, `.failedToday`, `.oldestRunningStartedAt`, and `.latestTerminalAt`. | Cost proxy; combine with `compose.llm.cost_usd`. A rising max runtime with flat completions means research workers are hanging or under-provisioned. |

### 4.5 LLM

| Metric                      | Measures                                                                                                                      | When to look                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `compose.llm.tokens.input`  | Prompt tokens submitted via LLM Gateway.                                                                                      |                                                                                                             |
| `compose.llm.tokens.output` | Completion tokens received.                                                                                                   |                                                                                                             |
| `compose.llm.cost_usd`      | Bedrock cost computed from tokens × unit price.                                                                               | Compare against `SPEC_FACTORY_RESEARCH_COST_CEILING_USD` and rolling task caps. Cost anomaly triage (§6.4). |
| `compose.llm.by_purpose`    | UTC-day call/failure/token/cost attribution surfaced through `/status` as `composeControlPlane.llm.byPurposeToday.<purpose>`. | Use this to separate coordinator, critic, handoff, and research spend before changing budget flags.         |

### 4.6 Retention

| Metric                                          | Measures                                                                                                                                                                                    | When to look                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `compose.retention.workspace_cleanup_pending`   | Archived Compose sessions with `archived_at IS NOT NULL` and `workspace_cleaned_at IS NULL`, surfaced through `/status` as `composeControlPlane.retention.pendingWorkspaceCleanup`.         | Growth means the retention cleaner is not keeping up or is disabled.                                                                       |
| `compose.retention.workspace_cleanup_failed`    | Pending archived sessions with a non-empty `workspace_cleanup_error`, surfaced through `/status` as `composeControlPlane.retention.failedWorkspaceCleanup`.                                 | Nonzero means cleanup attempts are failing; check the latest cleanup error timestamp and retention worker logs.                            |
| `compose.retention.llm_audit_artifacts_pending` | LLM audit rows with non-null prompt/response artifact URIs, surfaced through `/status` as `composeControlPlane.retention.pendingLlmAuditArtifacts` plus `.oldestPendingLlmAuditArtifactAt`. | Growth means `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE` retention is disabled, misconfigured, or failing to clear file-backed audit artifacts. |

### 4.7 Events

| Metric                             | Measures                                                                                                                                                                        | When to look                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.events.published`         | UTC-day durable event rows surfaced through `/status` as `composeControlPlane.events.durablePublishedToday` with `latestPublishedAt`.                                           | Should move when Compose sessions are active. A flatline while sessions are changing means publishers or the durable event store are not wired. |
| `compose.events.replayed`          | Per-replica SSE replay deliveries surfaced through `/status` as `composeControlPlane.events.replayedByThisReplica`; live deliveries are paired as `liveDeliveredByThisReplica`. | Use during replay/live bridge validation and multi-replica rollout. Replay count should move on reconnect tests with `Last-Event-ID`.           |
| `compose.streams.connected`        | Per-replica SSE connections opened, surfaced through `/status` as `composeControlPlane.streams.connectedByThisReplica`; active subscribers/sessions are also exposed.           | Use with ALB/proxy rollout and frontend reconnect debugging.                                                                                    |
| `compose.streams.disconnected`     | Per-replica SSE close callbacks, surfaced through `/status` as `composeControlPlane.streams.disconnectedByThisReplica`.                                                         | If disconnected rises much faster than connected during steady traffic, downstream proxies or clients are dropping streams.                     |
| `compose.events.persist_failed`    | UTC-day durable event persistence failures surfaced through `/status` as `composeControlPlane.events.durablePersistFailuresToday`.                                              | Nonzero means an SSE event degraded to the synthesized durable error path; check DB health and event payload size.                              |
| `compose.events.payload_too_large` | UTC-day non-projectable SSE events rejected by the 16 KiB durable payload cap, surfaced through `/status` as `composeControlPlane.events.payloadTooLargeToday`.                 | Message and readiness projections compact automatically. Nonzero means a control publisher still needs artifact spill or a smaller payload.     |

### 4.8 Coordinator

| Metric                                      | Measures                                                                                                                                                                                     | When to look                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.coordinator.decisions`             | UTC-day decision distribution surfaced through `/status` as `composeControlPlane.coordinator.decisionsToday.answer`, `.dispatchResearch`, `.askClarification`, `.escalate`, and `.rejected`. | Rejections > 0 mean budget, fan-out, or policy gates are pushing turns back to legacy/failure paths. Dispatch spikes should correlate with research queue and LLM cost. |
| `compose.turns.outcomes_by_context_version` | UTC-day terminal turn counters surfaced through `/status` as `composeControlPlane.turns.outcomesByContextVersionToday[]`, grouped by `contextVersionUsed`.                                   | A spike in failed or abandoned turns on one context version usually means the coordinator consumed a bad or stale context bundle.                                       |

Status: `/status` now exposes a UTC-day `composeControlPlane.llm` summary
(`callsToday`, `failedToday`, input/output tokens, estimated cost, latest call)
from `spec_factory_llm_calls` plus UTC-day `composeControlPlane.coordinator`
decision counters from `compose_session_events`; it also exposes
`composeControlPlane.retention` archived-workspace cleanup and LLM audit
artifact backlog counters from `compose_sessions` / `spec_factory_llm_calls`,
`composeControlPlane.events` durable event persistence failure counters from
`compose_session_events`, `composeControlPlane.research` runtime counters from
`compose_agent_tasks`, and `composeControlPlane.context` patch/version health
from `compose_context_patches` and
`compose_context_versions`. The v4 OpenTelemetry baseline above is exported by
every API and worker task. Today the compose Express service also logs structured fields via
`createLogger("compose-service")`
(`src/spec-factory/compose-service.ts:81`); durable-turn / agent-task /
gateway counters appear as their phases ship.

---

## 5. SLOs and alerts

Rollout gates required before enabling Phase 2, 6, and 8 outside dev
(plan v3 §30.4):

| SLO                                                    | Threshold                               | Enforced before        |
| ------------------------------------------------------ | --------------------------------------- | ---------------------- |
| Durable turn claim latency p95                         | < 5s for queued chat turns              | Phase 2 `drain -> on`  |
| Duplicate final assistant messages                     | `= 0`                                   | Phase 2 `drain -> on`  |
| Lost durable events in replay audit                    | `= 0`                                   | Phase 1 active         |
| Lease-lost final write attempts that succeeded         | `= 0`                                   | Phase 2 `drain -> on`  |
| Research task abandoned rate                           | `< 1%` outside explicit worker restarts | Phase 6 broad enable   |
| LLM/coordinator budget denials visible in logs/metrics | present                                 | Phase 8/9 broad enable |

Initial alerts (plan v3 §30.4). Each is expressed as the condition and what
on-call is expected to do:

| Alert                                        | Condition                                                                           | Meaning                                                                                                           | First action                                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TurnLeaseExpiredWithoutRetry`               | A running turn's lease expired and no reset/abandon happened within 2 lease windows | Stale sweep is broken or DB clock is off.                                                                         | Triage §6.1: inspect `compose_turn_jobs` for the row; if `attempt_count < max_attempts`, hand-requeue via SQL; if not, mark abandoned.                       |
| `LegacyInflightDrainStuck`                   | `legacy_inflight > 0` during `drain` for longer than the configured drain timeout   | A replica did not observe the flag flip or a hung turn is holding legacy.                                         | Roll the replica; if the same turn keeps holding, archive the session or use the manual cancellation SQL in §11.8.                                           |
| `EventPublishFailure`                        | `compose.events.publish` failures after the DB insert succeeded                     | Live fanout is degraded but the durable log is fine; connected listeners may lag until replay/polling catches up. | Confirm durable rows exist; degrade to poll-on-reconnect only.                                                                                               |
| `DuplicateSuppressedElevated`                | `compose.turns.duplicate_suppressed` above normal retry baseline                    | Client is retrying with the same `Idempotency-Key` or a bad proxy is duplicating.                                 | Check §6.2.                                                                                                                                                  |
| `LlmCostSessionDayCap`                       | `compose.llm.cost_usd` exceeds session/day cap threshold                            | A single session or day is spending beyond budget.                                                                | §6.4; verify coordinator dispatch budget enforcement or gateway budget enforcement for the affected purpose; hit the kill switch if a runaway research loop. |
| `ArtifactGcBacklogGrowth`                    | Artifact GC backlog grows for more than one retention interval                      | Cleanup worker is dead or lease is stuck.                                                                         | Restart worker; check migration 046 workspace cleanup logs.                                                                                                  |
| `<env>-spec-factory-turn-queue-p95-high`     | `spec_factory.slo.turn_queue_age_ms` p95 > 5s for two 5-minute periods              | Interactive workers are saturated or claims are stalled.                                                          | Check turn queue depth, worker heartbeat, DB locks, and Bedrock quota before scaling.                                                                        |
| `<env>-spec-factory-draft-queue-p95-high`    | Draft queue p95 > 15s for two 5-minute periods                                      | Louise/draft workers are not claiming promptly.                                                                   | Check processing-job workers and stale-job repair.                                                                                                           |
| `<env>-spec-factory-coordinator-p95-high`    | Coordinator decision p95 > 10s for two 5-minute periods                             | Coordinator model or gateway is slow.                                                                             | Inspect provider purpose/model latency and throttles.                                                                                                        |
| `<env>-spec-factory-provider-p95-high`       | Provider p95 > 30s for two 5-minute periods                                         | Bedrock latency/quota degradation.                                                                                | Check provider outcome labels and Bedrock account/model quotas.                                                                                              |
| `<env>-spec-factory-coordinator-success-low` | Selected coordinator routes < 99% for two 5-minute periods                          | Fallback/rejection rate is outside the rollout gate.                                                              | Break down `spec_factory.coordinator.routes` by `outcome` and bounded `reason`.                                                                              |

Debug artifact policy (§30.5): store redacted traces only. Never store
unredacted prompts or tool output unless
`SPEC_FACTORY_LLM_PROMPT_LOGGING=full` and
`SPEC_FACTORY_LLM_SECURE_DEBUG=true` are enabled in a non-production, access-
controlled debug environment. The gateway rejects full logging when
`NODE_ENV=production`.

---

## 6. Incident triage playbooks

### 6.1 Turn stuck / `lease_expired` burst

Plan v3 §11.3 defines the claim, heartbeat, and stale-recovery semantics.
A `lease_expired` burst means workers claimed turns, started running, and
either crashed or blocked longer than the lease TTL without renewing.

Symptoms:

- `compose.turns.lease_expired` counter increments continuously.
- `compose.turns.durable_running` gauge shows N running turns but the same
  `turn_job_id`s stay `running` across scrape intervals.
- Users see "turn queued" state that never advances to `assistant.final`.

Triage:

1. Identify the affected `turn_job_id`s:

   ```sql
   SELECT id, session_id, active_worker_id, lease_generation, lease_until,
          attempt_count, started_at, updated_at
   FROM compose_turn_jobs
   WHERE status = 'running'
     AND lease_until < CURRENT_TIMESTAMP(3);
   ```

2. Check `active_worker_id` against the worker heartbeat table.
   A worker that has not heartbeat in 2 lease windows is dead.
3. If the worker is dead, the stale sweep must repair the row and the
   session in the same transaction (plan v3 §11.4). If the sweep is not
   running (its cron/loop is dead), hand-run the reclaim:

   ```sql
   -- Reclaim to queued if attempt budget remains
   UPDATE compose_turn_jobs
   SET status = 'queued',
       active_worker_id = NULL,
       lease_until = NULL,
       updated_at = CURRENT_TIMESTAMP(3)
   WHERE id = ?
     AND status = 'running'
     AND lease_until < CURRENT_TIMESTAMP(3)
     AND attempt_count < max_attempts;
   ```

4. If `attempt_count >= max_attempts`, mark abandoned and clear
   `compose_sessions.active_turn_started_at` when no active durable turn remains
   in the same transaction.
5. If lease expiry recurs on the same worker after redeploy, the worker is
   hung inside Bedrock or SDK code — capture a stack trace and kill.

Status: Phase 2 partial. Durable turn rows, worker claims, lease renewal, stale recovery, and archive-driven cancellation are implemented. In `SPEC_FACTORY_DURABLE_TURNS=drain|on`, `ComposeTurnWorker` owns execution; in `off|shadow`, legacy in-process execution remains the response path for rollout safety.

### 6.2 Duplicate assistant messages

Plan v3 §11.5 makes the final assistant message write idempotent via
`compose_turn_outputs`. In target state, duplicates must be `0`. Any nonzero
observation is a P1 incident.

Symptoms:

- Same `turn_job_id` has two rows in `compose_session_messages` with `role='assistant'`
  and a `turn_job_id` back-reference.
- `compose.turns.lease_fence_rejected` did not increment, but two rows exist.

Triage:

1. Detect the duplicate:

   ```sql
   SELECT turn_job_id, COUNT(*) AS assistants
   FROM compose_session_messages
   WHERE role = 'assistant' AND turn_job_id IS NOT NULL
   GROUP BY turn_job_id
   HAVING COUNT(*) > 1;
   ```

2. Cross-reference `compose_turn_outputs`:

   ```sql
   SELECT * FROM compose_turn_outputs WHERE turn_job_id IN (?);
   ```

   If the unique constraint on `turn_job_id` is missing or the code path did
   not enter the transaction that reads `compose_turn_outputs FOR UPDATE`,
   duplicates are possible.

3. Verify the fence: the worker must reload the job and confirm the same
   `lease_generation` before the final publish. If two workers claimed the
   same job, `lease_fence_rejected` should have incremented on the loser.
   If it did not, the fence code path is missing.
4. Preserve one message and archive the duplicate; do not delete without an
   incident record.
5. File the incident: this is a §11.5 invariant violation.

Status: Phase 2 partial. Durable final writes are fenced through `compose_turn_outputs`, active lease validation, and the archived-session check. Treat any duplicate final after enabling `drain|on` as an incident.

### 6.3 SSE gap on reconnect

Plan v3 §27.2 and §10 require `Last-Event-ID` / `?after=<eventId>` to replay
every missed event. Today the code path is implemented at
`src/spec-factory/compose-routes.ts:746-819` reading via
`listSessionEventsAfter`. The stream route pauses live delivery until the
durable gap is replayed, lowers the subscriber cursor, and dedupes the final
catch-up against `src/spec-factory/compose-sse.ts:389-446`.

A browser opening a session without either cursor is a fresh subscription, not
a replay request. The route captures the session's current durable high-water
mark before opening the stream; JSON reads provide the current state. This
prevents historical terminal errors from reappearing as current alerts. The
route also sends a state-free `cursor` frame at that high-water mark so an idle
EventSource reconnect still supplies `Last-Event-ID`.

Symptoms:

- Client reconnects and skips ahead to a `readiness.updated` frame without
  seeing the preceding `assistant.final`.
- SSE `id:` values on the stream are not monotonically increasing across
  the reconnect.

Triage:

1. Confirm the client sent `Last-Event-ID` and it matches the durable
   `compose_session_events.id` numbering (not a client-local counter).
2. Confirm `SPEC_FACTORY_DURABLE_EVENTS` is on (or the replay code path is
   hitting the DB, not the in-memory buffer). If durable is off, the 20-event
   buffer is the only replay source and events beyond the window are lost.
3. Confirm `durableEventType` mapping is not dropping the type
   (`src/spec-factory/compose-sse.ts:65`). Frames whose type does not map to
   `assistant.final`/`message.created`/`readiness.updated`/`turn.status`/`error`
   are not persisted; that is by design.
4. If the event exists in `compose_session_events` but the replay endpoint
   skipped it, check the `after` parameter is `<eventId>`, not
   `<sequenceNumber>`.

### 6.4 Bedrock cost anomaly

Plan v3 §15 (LLM Gateway) and §15.8 (cost governance) require every direct
LLM call to write to `spec_factory_llm_calls` and to enforce pre-flight
budgets. Cost anomalies show up first as `compose.llm.cost_usd` spike.

Symptoms:

- `LlmCostSessionDayCap` alert firing.
- Bedrock console shows a spike in `InvokeModel` calls from the Spec Factory
  role.

Triage:

1. Identify the sessions:

   ```sql
   SELECT session_id, SUM(estimated_cost_usd) AS session_cost, COUNT(*) AS calls
   FROM spec_factory_llm_calls
   WHERE created_at >= NOW() - INTERVAL 1 HOUR
   GROUP BY session_id
   ORDER BY session_cost DESC
   LIMIT 20;
   ```

2. Identify the purpose (chat coordinator, distillation, research, critic):

   ```sql
   SELECT purpose, COUNT(*) AS calls, SUM(estimated_cost_usd) AS purpose_cost
   FROM spec_factory_llm_calls
   WHERE created_at >= NOW() - INTERVAL 1 HOUR
   GROUP BY purpose
   ORDER BY purpose_cost DESC;
   ```

3. If manual research or coordinator `dispatch_research` is the culprit, verify
   `SPEC_FACTORY_RESEARCH_COST_CEILING_USD` was set and that the enqueue path
   rejected sessions whose committed plus reserved spend exceeded the ceiling.
4. Pull the kill switch: set `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false`
   to stop new manual enqueues, then drop `SPEC_FACTORY_RESEARCH_EXECUTOR=none`
   to fail research tasks fast.
5. If a runaway coordinator loop, drop `SPEC_FACTORY_CHAT_COORDINATOR=false`
   to send every chat turn back to the legacy agent.

Status: Phase 8/9 partial. Direct legacy paths can still call Bedrock without
gateway audit. LLM Gateway callers write `spec_factory_llm_calls`; manual and
coordinator research enqueue checks committed session spend plus queued/running
task reservations before inserting research tasks. Non-gateway paths are still
monitored via AWS Cost Explorer + CloudWatch Bedrock metrics.

### 6.5 Archive not blocking mutation

Plan v3 §9 requires every mutation route to call the guard functions in
`src/spec-factory/session/session-guard.ts:11`. If a mutation succeeds on an
archived session, the route did not call
`assertSessionMutable`/`assertSessionHandoffAllowed`/`assertSessionStreamable`.

Symptoms:

- A user reports adding a source or sending a message to a session marked
  `archived_at IS NOT NULL`.
- Audit shows a new row in `compose_session_sources` or `compose_session_messages`
  after the archive timestamp.

Triage:

1. Confirm archive:

   ```sql
   SELECT id, archived_at, name
   FROM compose_sessions
   WHERE id = ?;
   ```

2. Find the offending mutation entry point in `src/spec-factory/compose-routes.ts`.
3. Verify it calls the appropriate guard from `session/session-guard.ts:11`
   before mutating. If it calls `getSession` directly and only inspects
   `archived_at`, replace with the guard.
4. Add a regression test to `test/spec-factory/session-guard.test.ts` (or the
   relevant route test) proving the route rejects archived state.
5. Stream tokens revoked on archive: confirm `revokeSessionStreamTokens` ran
   before `archived_at` was committed (`compose-service.ts:989`; plan v3 §9.3).

---

## 7. Retention and DSR

Plan v3 §31.6 defines the retention/DSR matrix. Status: archived workspace
cleanup, stale `.tmp` artifact GC, expired stream-token purge, optional S3
DB-reachability cleanup, file-backed LLM audit artifact cleanup, and one-shot
archived-session DSR hard-delete are implemented. Recoverable source deletion
uses a separate one-minute default sweep on the retention worker.

| Table / artifact                             | Retention behavior                                                                                                                                                                                                                                                                                                                     | Hard-delete (DSR) behavior                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose_session_events`                     | Retain with session.                                                                                                                                                                                                                                                                                                                   | Purge on hard delete.                                                                                                                       |
| `compose_session_sources`                    | Retain with session. Generated sources are agent-authored session state.                                                                                                                                                                                                                                                               | Purge on hard delete.                                                                                                                       |
| `compose_source_deletions`                   | Root and derived sources are hidden immediately. Undo is allowed until `undo_until`; afterward source-specific EFS/S3 artifacts and stored source content are purged while audit metadata remains.                                                                                                                                     | Purge before `compose_session_sources` on hard delete.                                                                                      |
| `compose_session_messages`                   | Retain with session transcript.                                                                                                                                                                                                                                                                                                        | Purge on hard delete.                                                                                                                       |
| `compose_stream_tokens`                      | Expire by TTL (default 30 min, `STREAM_TOKEN_TTL_MS`), revoke on archive, purge expired.                                                                                                                                                                                                                                               | Purge on hard delete.                                                                                                                       |
| `compose_turn_jobs`                          | Retain with session audit.                                                                                                                                                                                                                                                                                                             | Purge on hard delete.                                                                                                                       |
| `compose_turn_outputs`                       | Retain with messages.                                                                                                                                                                                                                                                                                                                  | Purge on hard delete.                                                                                                                       |
| `compose_agent_tasks`                        | Retain with session audit.                                                                                                                                                                                                                                                                                                             | Purge on hard delete.                                                                                                                       |
| `compose_agent_runtime_runs`                 | Retain redacted trace links only.                                                                                                                                                                                                                                                                                                      | Purge on hard delete.                                                                                                                       |
| `compose_context_patches`                    | Retain until superseded retention window.                                                                                                                                                                                                                                                                                              | Purge on hard delete.                                                                                                                       |
| `compose_context_versions`                   | Retain committed versions with session.                                                                                                                                                                                                                                                                                                | Purge on hard delete.                                                                                                                       |
| `compose_workspace_manifests`                | Retain latest derived workspace manifest with session; reset when session progress is reset.                                                                                                                                                                                                                                           | Purge on hard delete.                                                                                                                       |
| `spec_factory_llm_calls`                     | Retain redacted usage audit indefinitely. File-backed prompt/response artifacts under `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE` are deleted after `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS` (default 30), then URI columns are cleared. Non-file artifact schemes are left untouched until a matching object-store deleter exists. | Purge on hard delete; file-backed artifacts under `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE` are deleted during the hard-delete artifact phase. |
| `spec_factory_prompt_versions`               | Retain indefinitely as gateway configuration and audit metadata.                                                                                                                                                                                                                                                                       | Do not purge for session DSR; remove only through prompt-governance change control.                                                         |
| `spec_factory_worker_heartbeats`             | Retain short-term process inventory; purge stale rows after `SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS` (default 7) during retention sweeps.                                                                                                                                                                                        | Do not purge for session DSR.                                                                                                               |
| Immutable S3 artifacts                       | Reachability GC runs only when `SPEC_FACTORY_ARTIFACT_STORE=s3`, and only under `<SPEC_FACTORY_ARTIFACT_PREFIX>/workspaces/`. The cleaner refuses the broader product prefix and honors `COMPOSE_CLEANUP_DRY_RUN`.                                                                                                                     | Delete exact referenced artifacts during session DSR.                                                                                       |
| S3 attachments (`COMPOSE_S3_PREFIX=compose`) | Delete by DB reachability + retention policy.                                                                                                                                                                                                                                                                                          | Delete when parent session is hard-deleted.                                                                                                 |
| EFS workspaces (`COMPOSE_WORKSPACE_BASE`)    | Migration 046 workspace cleanup after `COMPOSE_WORKSPACE_RETENTION_DAYS`; stale `.tmp` artifact entries are removed after `COMPOSE_ARTIFACT_TMP_RETENTION_HOURS`.                                                                                                                                                                      | Delete on hard delete.                                                                                                                      |

DSR / hard-delete rules:

- Archive is not deletion. `archived_at` marks a session hidden and immutable;
  the row and its child rows persist.
- DSR erasure cascades through DB rows and artifact URIs
  (plan v3 §31.6). No child row survives a parent-session hard delete.
- The hard-delete implementation refuses non-archived sessions, validates that
  artifact URIs are covered by the session S3 prefix, workspace root, or
  configured `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE`, deletes those roots and
  covered audit artifact files, then re-locks the archived session and
  cascades DB rows in a single transaction.
- A handed-off `spec_factory_sources` row is outside the Compose child-table
  cascade. If a DSR request also covers downstream draft artifacts created from
  that source, run the separate Spec Factory source/draft DSR process.

Source-deletion operations:

- `COMPOSE_CLEANUP_DRY_RUN=true` prevents physical source-deletion purge as
  well as archived-session cleanup. Logical deletion and Undo still work.
- A `purging` row older than 15 minutes is reclaimable. EFS and S3 deletion is
  idempotent, and DB content is scrubbed only after artifact deletion succeeds.
- `failed` rows are retried after a five-minute backoff so one bad artifact
  cannot monopolize a sweep. Inspect retention-worker logs for
  `source deletion sweep` and `source deletion sweep failed`.
- Undo restores only the selected root source. Generated descendants remain
  deleted and are physically purged after the original deadline.

Immutable artifact cleanup safety:

- Keep `COMPOSE_CLEANUP_DRY_RUN=true` until the retention report shows a
  nonzero referenced count for an environment that already uses canonical S3
  artifacts and every orphan sample is confirmed disposable.
- A report that scans `spec-factory/` instead of
  `spec-factory/workspaces/`, or reports zero references while canonical S3
  artifacts exist, is a rollout blocker. Do not enable deletion.

Runbook: hard-delete is a one-shot operator action through the cleanup command.
Dry-run first:

```bash
COMPOSE_HARD_DELETE_SESSION_ID=123 \
COMPOSE_HARD_DELETE_DRY_RUN=true \
npm run spec-factory:compose-cleanup:dev
```

Review `rowCounts`, `artifactUris`, and `uncoveredArtifactUris` in the JSON
output. Destructive execution requires the exact confirmation token:

```bash
COMPOSE_HARD_DELETE_SESSION_ID=123 \
COMPOSE_HARD_DELETE_DRY_RUN=false \
COMPOSE_HARD_DELETE_CONFIRM=delete-session:123 \
npm run spec-factory:compose-cleanup:dev
```

---

## 8. Deploy procedure

The canonical deploy runbook is [`../DEPLOYMENT_GUIDE.md`](../DEPLOYMENT_GUIDE.md).
Spec Factory uses the v4 release gates at the top of this document. Bootstrap
Terraform-owned role repositories before the image workflow and apply
migrations before enabling producers. For application-only releases, the image
workflow clones the current ECS task-definition configuration, replaces only
the application and MarkItDown images with reviewed immutable digests,
registers revisions, updates all Spec Factory services, waits for stability,
and rolls back on failure. Terraform remains authoritative for infrastructure,
environment, IAM, scaling, sidecar, volume, and service-configuration changes;
apply it when any of those surfaces change.

Do not run the image workflow and a Terraform apply against Spec Factory ECS
services concurrently. Both operations register task-definition revisions; the
Terraform apply must finish and stabilize before an application release starts
so the release clones the intended configuration.

To validate a published SHA against every live service without registering task
definitions or updating services, run the release script in read-only mode:

```bash
SPEC_FACTORY_DEPLOY_DRY_RUN=true \
ECR_REGISTRY=<account>.dkr.ecr.us-east-2.amazonaws.com \
.github/scripts/deploy_spec_factory_ecs.sh <full-merge-sha>
```

Every service uses a deployment circuit breaker. Verify ALB health for API,
per-role running-task alarms, queue/DLQ/quarantine age, outbox age, Valkey
delivery, and durable replay after each staged apply. The old exactly-one-task
alarm applies only to rollback compatibility mode and must be disabled after
certified horizontal API cutover. Apply each feature/routing change as a
separate task-definition revision after the previous stage is healthy.

Rolling deploy discipline (plan v3 §33.3): if you are flipping
`SPEC_FACTORY_DURABLE_TURNS` from `drain` to `on`, watch
`compose.turns.legacy_inflight` on every replica for at least one drain
timeout after `drain` is applied. Only when every replica reports `0` may
`on` be applied.

---

## 9. Rollback semantics

Every phase flag with a `off|shadow|drain|on`-shaped enum is designed so any
adjacent step is a valid rollback. Plan v3 §28 documents the state machines.

### 9.1 Durable turns cutover

```
off     -> legacy executes; idempotency/durable rows are still written for HTTP turns
shadow  -> durable rows written but legacy executes
drain   -> stop accepting new legacy turns, wait until legacy_inflight == 0
on      -> durable workers execute turns
```

Rules:

- `off <-> shadow`: safe both directions. `shadow` writes durable rows the
  legacy path does not consume; reverting drops those rows but keeps user
  behavior intact.
- `shadow -> drain`: safe. New turns route to durable path; existing legacy
  turns finish.
- `drain -> shadow`: safe rollback if durable workers are unstable. New
  turns route back to legacy; durable queue drains through the workers
  that are still running.
- `drain -> on`: only after `legacy_inflight == 0` across every replica. If
  a replica has not caught up to the flip, `on` will strand legacy turns.
- `on -> drain`: safe. New turns route through the durable path; workers
  finish claimed turns. Legacy accepts none.
- `on -> off`: unsafe. Do not skip through `shadow`/`drain`. Reverting
  straight to `off` discards durable queue state that the API replicas may
  already have accepted as `queued`.

### 9.2 Optional stream-token cache rollout

```
off   -> MySQL compose_stream_tokens store only
cache -> populate optional Redis/cache index, but verify/fallback through MySQL
```

Rules:

- DB verification is always authoritative. Do not introduce a mode where Redis
  or any other cache is required to validate a protected session token.
- `off <-> cache`: safe. Cache entries can be dropped; the next verification
  falls back to `compose_stream_tokens`.
- Archive/delete revocation always updates `compose_stream_tokens` first. Cache
  invalidation, if present, is a best-effort latency optimization.

### 9.3 General rollback discipline

- Every flag is env-only. A rollback is a task-definition revision change.
- Never revert a shadow / drain flip and immediately re-flip forward.
  Regression tests must pass first.
- Rollbacks that require dropping DB rows (e.g., abandoning a `shadow`
  cohort) go through the DBA path, not on-call.

---

## 10. Cost governance

Plan v3 §15.8 defines the cost enforcement layer. Direct LLM calls are enforced
in the LLM Gateway; manual and coordinator research enqueue paths are enforced
before enqueue by session/global research reservation checks plus queued/running
task caps.

Caps and kill switches:

| Cap                                     | Enforced by                                                                                                                                                                                                                                                                              | Kill switch                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Per-session research ceiling            | `SPEC_FACTORY_RESEARCH_COST_CEILING_USD` checked before manual research and coordinator `dispatch_research` enqueue, using committed `spec_factory_llm_calls` spend, completed `compose_agent_runtime_runs.estimated_cost_usd` for research tasks, and queued/running task reservations. | Set the env to a small value or `0` to reject further research enqueue for that session.                                                 |
| Per-session in-flight research cap      | `SPEC_FACTORY_RESEARCH_INFLIGHT_TASKS_PER_SESSION` checked before enqueueing manual/coordinator research.                                                                                                                                                                                | Drop to a small number or `0`.                                                                                                           |
| Per-session rolling research task count | `SPEC_FACTORY_RESEARCH_TASKS_PER_24H` checked before enqueueing manual/coordinator research.                                                                                                                                                                                             | Drop to a small number or `0`.                                                                                                           |
| Global research caps                    | `SPEC_FACTORY_RESEARCH_GLOBAL_COST_CEILING_USD`, `SPEC_FACTORY_RESEARCH_GLOBAL_INFLIGHT_TASKS`, and `SPEC_FACTORY_RESEARCH_GLOBAL_TASKS_PER_24H` checked before enqueueing manual/coordinator research when set.                                                                         | Set any cap to `0` to stop new research globally.                                                                                        |
| LLM Gateway spend caps                  | `SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD` and `SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD` checked before provider calls when set.                                                                                                                                                 | Set either cap to a small value or `0` to deny future matching Gateway calls that provide `maxCostUsd`.                                  |
| Per-call max tokens                     | Gateway pre-flight model-allowlist + max-output-token check (plan v3 §15.6).                                                                                                                                                                                                             | Set `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS` or a purpose-specific `SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_<PURPOSE>` to a small positive value. |

Kill switches for a runaway system:

1. `SPEC_FACTORY_CHAT_COORDINATOR=false` — routes every chat turn back to
   the legacy `ComposeChatAgent`.
2. `SPEC_FACTORY_RESEARCH_INGRESS_ENABLED=false` — stops authenticated manual
   code-research enqueue requests while workers drain existing tasks.
3. `SPEC_FACTORY_RESEARCH_EXECUTOR=none` — research tasks fail fast without
   calling Bedrock.
4. `SPEC_FACTORY_ENABLE_CRITIC=false` — stops new critic review scheduling
   and critic executor invocations.
5. `SPEC_FACTORY_DURABLE_TURNS=drain` — if the durable path is generating
   duplicate calls, drop back to `drain` while investigating.

Logging: `SPEC_FACTORY_LLM_PROMPT_LOGGING=full` is only permitted with
`SPEC_FACTORY_LLM_SECURE_DEBUG=true` in a non-production, access-controlled
debug environment. The gateway rejects full logging when `NODE_ENV=production`;
production runs at `redacted` (plan v3 §15.6).

---

## 11. Common runbook questions

### 11.1 How do I archive a session by ID?

The archive route revokes stream tokens and rejects further mutations
(plan v3 §9.3). Prefer the HTTP path over manual SQL because the code path
runs `revokeSessionStreamTokens` before the `archived_at` commit
(`src/spec-factory/compose-service.ts:989`) and publishes a durable
`session.archived` event.

```bash
curl -X DELETE \
  -H "x-amzn-oidc-identity: <admin-oidc-sub>" \
  https://<host>/api/spec-factory/sessions/<sessionId>
```

If HTTP is unavailable (e.g., ECS service down and you need to prevent a
resurrecting worker from producing new output), do the same in SQL. This
must run in a single transaction so a running worker cannot append an
assistant message after tokens are revoked but before archive commits.

```sql
BEGIN;
DELETE FROM compose_stream_tokens WHERE session_id = ?;
UPDATE compose_sessions
SET archived_at = CURRENT_TIMESTAMP(3),
    updated_at = CURRENT_TIMESTAMP(3)
WHERE id = ?
  AND archived_at IS NULL;
-- compose_session_events is written by ComposeSseHub when eventStore is wired;
-- the archive-session flow relies on that path for durable session.archived replay.
COMMIT;
```

Verify:

```sql
SELECT id, archived_at, name FROM compose_sessions WHERE id = ?;
SELECT COUNT(*) FROM compose_stream_tokens WHERE session_id = ?;
```

### 11.2 How do I re-run conversion for a failed source?

Prefer the HTTP endpoints. The conversion worker
(`src/spec-factory/compose-conversion.ts:303-316`) reads work off the DB
lease queue, so requeue is a status flip, not a queue push.

Single source:

```bash
curl -X POST \
  -H "x-amzn-oidc-identity: <oidc-sub>" \
  https://<host>/api/spec-factory/sessions/<sessionId>/sources/<sourceId>/reconvert
```

All failed sources for a session:

```bash
curl -X POST \
  -H "x-amzn-oidc-identity: <oidc-sub>" \
  https://<host>/api/spec-factory/sessions/<sessionId>/sources/reconvert-failed
```

If HTTP is unavailable, requeue via SQL. The conversion worker treats
`pending` as the intake status and picks up any row whose lease has expired.
Do not touch `converting` rows unless you have confirmed the leaseholder is
dead.

```sql
UPDATE compose_session_sources
SET conversion_status = 'pending',
    error_message = NULL,
    conversion_lease_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP(3)
WHERE id = ?
  AND conversion_status IN ('failed', 'unsupported');
```

Diagnose why the source failed before requeueing:

```sql
SELECT id, kind, conversion_status, error_message, updated_at
FROM compose_session_sources
WHERE session_id = ?
ORDER BY updated_at DESC;
```

`isTransientConversionError` (`src/spec-factory/compose-conversion.ts:68`)
classifies retryable Bedrock/markitdown/ffmpeg failures. If the error is
non-transient (e.g., unsupported format), requeueing loops forever; convert
the source manually or delete it.

### 11.3 How do I inspect a session's context version history?

Status: Phase 7 concern. Today `context.md` in the workspace is the closest
analog — inspect it via EFS. The queries below become correct once
`compose_context_versions` and `compose_sessions.latest_context_version`
land.

Today (Phase 0 through Phase 6):

```bash
# On a host with EFS mounted, or via `ecs execute-command` into the running task:
cat /mnt/efs/specter-repo/spec-factory/compose/<sessionId>/context.md
cat /mnt/efs/specter-repo/spec-factory/compose/<sessionId>/chat.md
ls  /mnt/efs/specter-repo/spec-factory/compose/<sessionId>/sources/
```

Target (Phase 7):

```sql
-- Which version is currently canonical?
SELECT id, latest_context_version, updated_at
FROM compose_sessions
WHERE id = ?;

-- Version history, newest first:
SELECT id, session_id, version, artifact_uri, checksum, committed_at, notes
FROM compose_context_versions
WHERE session_id = ?
ORDER BY version DESC;

-- Patches that fed each version:
SELECT id, session_id, patch_kind, source_ref, committed_version, created_at
FROM compose_context_patches
WHERE session_id = ?
ORDER BY created_at DESC;
```

Inspect the artifact bytes referenced by `artifact_uri` (S3 or EFS path).
Never modify a committed version — the two-phase merge protocol
(plan v3 §20) requires immutability so the checksum on
`compose_sessions.latest_context_version` remains authoritative.

### 11.4 How do I list every session that has a stuck turn?

Once durable turns land:

```sql
SELECT
  s.id                            AS session_id,
  s.name                          AS session_name,
  j.id                            AS turn_job_id,
  j.turn_kind,
  j.status,
  j.active_worker_id,
  j.lease_generation,
  j.lease_until,
  j.attempt_count,
  j.started_at,
  j.updated_at
FROM compose_turn_jobs j
JOIN compose_sessions   s ON s.id = j.session_id
WHERE j.status IN ('queued', 'running')
  AND (
    (j.status = 'running' AND j.lease_until < CURRENT_TIMESTAMP(3))
    OR (j.status = 'queued' AND j.created_at < NOW() - INTERVAL 10 MINUTE)
  )
ORDER BY j.updated_at ASC;
```

### 11.5 How do I revoke every stream token for a session without archiving?

If a user's stream token was leaked but the session should stay live:

```sql
DELETE FROM compose_stream_tokens WHERE session_id = ?;
```

The client will get a `401` on next reconnect and must re-authenticate to
mint a fresh token via `POST /sessions/:sessionId/resume`.

### 11.6 How do I see which repos a session is grounded against?

Repo grounding is selected per analyze turn; it is not stored as a column on
`compose_sessions`. For durable analyze turns, inspect the most recent
`turn.queued` event payload:

```sql
SELECT
  e.id AS event_id,
  e.created_at,
  JSON_EXTRACT(e.payload_json, '$.repositoryIds') AS repository_ids
FROM compose_session_events e
WHERE e.session_id = ?
  AND e.event_type = 'turn.queued'
  AND JSON_UNQUOTE(JSON_EXTRACT(e.payload_json, '$.turnKind')) = 'analyze'
ORDER BY e.id DESC
LIMIT 5;
```

For a running or just-finished turn, the materialized workspace also contains
`repositories.md` under the session workspace root.

Grounding execution is controlled by `COMPOSE_REPO_GROUNDING_ENABLED`,
`COMPOSE_MAX_GROUNDED_REPOS`, `COMPOSE_REPO_GROUNDING_TOOL_BUDGET`,
`COMPOSE_REPO_GROUNDING_TIMEOUT_MS`
(`terraform/spec-factory-ecs.tf:284-287`).

### 11.7 How do I force a fresh workspace materialization for a session?

If a workspace is corrupt or a source's converted Markdown is stale, the
workspace manager (Phase 4) will support explicit `detach + attach`. Today,
the workspace is materialized on every turn by `ComposeWorkspaceManager.prepare`
(`src/spec-factory/compose-workspace.ts:230`), which rewrites `chat.md`,
`context.md`, `repositories.md`, `sources/*.md`, and the bundled
`mhk-organizational-context.md` reference. To force a rebuild:

1. Delete the on-disk workspace directory:

   ```bash
   rm -rf /mnt/efs/specter-repo/spec-factory/compose/<sessionId>
   ```

2. Send any new turn or trigger analyze. `prepare` will recreate the tree
   from the DB source of truth.

Do not delete `sources/*.md` files in isolation — they are re-derived from
`compose_session_sources.markdown_content` on the next materialization.

### 11.8 How do I disable a runaway session without archiving it?

Two options:

1. Revoke stream tokens (§11.5) and pause queue admission by dropping
   `COMPOSE_MAX_QUEUED_TURNS=0`. This rejects new turns with `429 queue_full`
   without archiving.
2. If durable turns are on and you need to stop work without archiving, call
   `POST /compose/sessions/:sessionId/turns/:turnJobId/cancel`. It cancels the
   durable turn and linked queued/running agent tasks, clears worker leases, and
   records durable `turn.cancelling` / `turn.cancelled` / `task.cancelled`
   events. Archiving a session performs the same cancellation automatically
   before setting `archived_at`.

   If the API is unavailable, use this manual fallback:

   ```sql
   UPDATE compose_turn_jobs
   SET status = 'cancelled',
       cancellation_requested_at = CURRENT_TIMESTAMP(3),
       active_worker_id = NULL,
       lease_until = NULL,
       completed_at = CURRENT_TIMESTAMP(3),
       updated_at = CURRENT_TIMESTAMP(3)
   WHERE session_id = ?
     AND id = ?
     AND status IN ('queued', 'running', 'waiting_on_research',
                    'awaiting_user_input', 'synthesizing');
   ```

   Workers observe the cancelled status/lease fence between major steps and
   before final output.

### 11.9 How do I update the standard MHK organizational context?

The runtime never reads a developer Desktop path. The canonical, versioned
asset is
`src/spec-factory/context/mhk-organizational-context.md` and is copied to
`dist/spec-factory/context/` by `npm run build`.

1. Replace the canonical Markdown with the reviewed organizational snapshot.
   Preserve the evidence labels, evidence precedence, and safety contract.
2. Update `MHK_ORGANIZATIONAL_CONTEXT_VERSION` in
   `src/spec-factory/organizational-context.ts` to match the new evidence
   snapshot.
3. Register a new `chat_coordinator@vN` entry in the static prompt registry and
   add the corresponding ordered DB migration. Do not mutate an existing prompt
   version in place.
4. Run the organizational-context, coordinator, legacy chat, workspace, and
   prompt-registry tests, then run `npm run build`.
5. Verify the source and `dist` copies have identical SHA-256 checksums. Apply
   the prompt-registry migration before deploying when
   `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=db`.

The coordinator always gets the operating baseline plus bounded relevant
sections. The complete document is materialized only as a workspace reference;
do not inject the entire document into every LLM call.

---

Related documents:

- [architecture](./architecture.md) — service topology, containers, ALB, EFS, ECR.
- [glossary](./README.md#glossary) — session, turn, source, working context, capability, runtime mode.
- [`../superpowers/spec-factory/spec_factory_transformation_plan_v3.md`](../superpowers/spec-factory/spec_factory_transformation_plan_v3.md)
  — canonical target design (plan v3).
- [`../DEPLOYMENT_GUIDE.md`](../DEPLOYMENT_GUIDE.md) — repo-wide deploy runbook.
