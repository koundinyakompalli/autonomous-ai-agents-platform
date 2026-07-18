# OneShot Runbook

## Purpose

This runbook is the operator source of truth for the current OneShot (`PFOS`) runtime.

Use this document for:

- queue and service ownership
- current state and artifact progression
- workspace and `repo-admin` layout
- run inspection and recovery
- rollout and deployment verification

For the dashboard preview-deploy surface, use:

- [ONESHOT_PREVIEW_RUNBOOK.md](./ONESHOT_PREVIEW_RUNBOOK.md)

Historical phase specs still live under `docs/superpowers/specs/`, but they are design snapshots, not the live runtime contract.

## Current runtime at a glance

Current control-plane flow:

1. `QUALIFIER` (includes deterministic gate scorer)
2. `PLANNER` (includes repo scanner pre-scan and PLAN)
3. `REVIEWER` (Plan Review / Validate, then TRACE and VERIFY before final handoff)
4. `IMPLEMENTER`
5. `CODE_REVIEWER`
6. `TESTER`

The handoff path is `PLAN -> Plan Review / Validate -> TRACE -> VERIFY -> Build`. The reviewer runs TRACE and VERIFY only after Validate approves the plan or the configured validation review budget is exhausted. VERIFY recommendations stay advisory: `REJECTED` and `CONDITIONAL` are stored and surfaced, but they do not independently send the run back to planning.

Provider/runtime split:

- `QUALIFIER`, `PLANNER`, `IMPLEMENTER` use the Claude SDK on Bedrock
- `REVIEWER` and `CODE_REVIEWER` use the OpenAI Responses API with read-only repo tools
- `TESTER` is deterministic and does not call an LLM
- the orchestrator owns Jira notification posting and stale-run reconciliation

Important current behavior:

- successful runs open a draft PR, enter `pr_open`, and emit both `pr_created` and `completed` notifications
- the orchestrator normally advances `pr_open -> completed` after the `completed` notification is posted to Jira
- the enum still contains `needs_revision` and `approved`, but current consumers normally queue the next stage directly instead of persisting those states
- workspace cleanup for terminal runs is handled automatically by the reconciliation loop reaper (see "Workspace cleanup reaper" below)

## Deterministic gate scorer

Before any Claude qualification call, a pure-TypeScript scorer evaluates the ticket across 5 weighted dimensions. The scorer no longer acts as a simple pass/fail gate. It classifies tickets into 3 buckets:

- `hard_fail`: fundamentally underspecified; repo inspection will not help
- `direct_qualify`: strong enough to enter OneShot without repo inspection
- `code_adjudicate`: borderline or leaning-reject; Claude must inspect the checked-out repo before a final rejection

| Dimension | Weight | Full-score criteria |
|---|---:|---|
| Summary Quality | 15% | >= 20 chars and contains an action verb |
| Description Presence | 20% | >= 200 chars of description text |
| Acceptance Criteria | 35% | BDD Given/When/Then lines, "should"/"must" bullets, or an AC header section |
| Scope Clarity | 20% | File paths, CamelCase identifiers, endpoint paths, service names |
| Testability | 10% | Testing keywords or verification instructions |

Current thresholds:

- minimum score: **65/100**
- direct-qualification threshold: **85/100**, plus strong per-dimension checks

Current behavior:

- `hard_fail` is reserved for tickets missing both substantive description and acceptance criteria
- `direct_qualify` skips repo inspection and immediately creates the OneShot run
- `code_adjudicate` sends the ticket to Claude with read-only repo tools
- on the code-adjudication path, a rejection is only accepted if Claude actually used repo tools and returned inspection evidence

When qualification fails, the posted feedback includes a score table and a per-dimension list of missing items so the reporter can fix and re-label.

Source: `src/oneshot/qualification-scorer.ts`

Inspect gate results in logs by searching `QUALIFIER` log output for the score and `gateDisposition`. Hard-fail tickets still do not produce a qualification artifact or an `oneshot_runs` row because the run is never created.

## Repo scanner (codebase intelligence pre-scan)

Before the planner invokes Claude, a structural scan runs on the workspace to detect:

- **Tech stack**: primary language, build tool (Maven/Gradle/npm/yarn/pip), test framework (JUnit/Jest/Vitest/pytest/go test), and frameworks (Spring Boot, React, Express, FastAPI)
- **Project structure**: root files, top-level directories, file count (capped at 5000 walk limit), and top-10 extension breakdown
- **Key files**: build configs, entry points, env templates, routes directories, schema/migration files

The scan result is saved to `{statePath}/planner/repo-scan.json` and formatted into a `## Codebase Intelligence (pre-scanned)` section that is prepended to the planner prompt. This lets Claude skip basic project discovery and focus on ticket-specific exploration.

The scan has a 30-second timeout and degrades gracefully -- a failed scan just means the planner runs without the pre-scan context.

Source: `src/oneshot/repo-scanner.ts`

## Deployment topology

Image ownership:

- `QUALIFIER` runs on the standard worker image
- `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER` share the OneShot image

Repository and workspace layout:

- admin clone root: `/mnt/efs/specter-repo/repo-admin/<repo>`
- legacy shared repo tree: `/mnt/efs/specter-repo/repositories/<repo>`
- OneShot run root: `/mnt/efs/specter-repo/oneshot/<run-id>`
- OneShot git worktree: `/mnt/efs/specter-repo/oneshot/<run-id>/workspace`
- OneShot non-git state: `/mnt/efs/specter-repo/oneshot/<run-id>/state`

Current runtime rules:

- OneShot prefers `ONESHOT_REPO_ADMIN_BASE`
- if `ONESHOT_REPO_ADMIN_BASE` is unset, OneShot falls back to `REPOSITORY_PATH`
- `repo-admin` should contain one canonical git repo root per repository, not branch subfolders
- the per-run `workspace/` directory is reused across stages by `git reset --hard` plus `git clean -ffd`
- stage sidecar files live under `state/<stage>/`, not inside the git worktree

## Prerequisites

Before putting `PFOS` traffic through the system:

- Terraform must be applied with `enable_oneshot = true`
- OneShot queues and DLQs must exist
- `repo-admin` must be mounted at `/mnt/efs/specter-repo/repo-admin` or `ONESHOT_REPO_ADMIN_BASE` must point at the desired admin-clone root
- `QUALIFIER` must be deployed on the worker image
- the shared OneShot image must be deployed for `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER`
- Secrets Manager must contain:
  - `github_repo_token_secret_name`
  - `github_app_credentials_secret_name` (`specter/prod/github-app/oneshot` by default) for GitHub App branch push and PR creation
  - `github_write_token_secret_name` for dashboard workflow dispatch, and for OneShot only if GitHub App credentials are disabled
  - `openai_reviewer_api_key_secret_name`
- Migration 012 must be applied (see "Migration 012" below)

Checked-in Terraform default caveat:

- `terraform/shared.auto.tfvars` currently sets:
  - `oneshot_reviewer_enabled = true`
  - `oneshot_code_reviewer_enabled = true`
  - `oneshot_otel_enabled = false`
  - digest pinning enabled for orchestrator, worker, and OneShot task definitions
- Terraform updates task definitions and service config, but image build/push is still a separate rollout step

## Services, queues, and timeouts

| Role | Entry path | Queue | Visibility timeout | Log group | Provider |
|---|---|---|---:|---|---|
| `QUALIFIER` | worker poller | none | n/a | `/ecs/specter/qualifier-worker` | Claude SDK |
| `PLANNER` | OneShot consumer | `oneshot-planning.fifo` | `1800s` | `/ecs/specter/oneshot-planner` | Claude SDK |
| `REVIEWER` | OneShot consumer | `oneshot-review.fifo` | `900s` | `/ecs/specter/oneshot-reviewer` | OpenAI SDK |
| `IMPLEMENTER` | OneShot consumer | `oneshot-implementation.fifo` | `5400s` | `/ecs/specter/oneshot-implementer` | Claude SDK |
| `CODE_REVIEWER` | OneShot consumer | `oneshot-code-review.fifo` | `3600s` | `/ecs/specter/oneshot-code_reviewer` | OpenAI SDK |
| `TESTER` | OneShot consumer | `oneshot-testing.fifo` | `1800s` | `/ecs/specter/oneshot-tester` | deterministic |

Queue notes:

- every queue has a dedicated FIFO DLQ with `maxReceiveCount = 3` and 14-day retention
- the queue stages are `planning`, `review`, `implementation`, `code_review`, and `testing`
- long-running consumers extend SQS visibility while a stage handler is still active
- CloudWatch alarms fire for DLQ depth, primary queue age, and primary queue depth
- Terraform creates an SNS-backed alarm target for OneShot alarms unless `oneshot_alarm_topic_arn` is set explicitly

## Startup validation and health

Before a OneShot consumer begins polling, startup validation checks:

- required schema objects, including migration 012 columns and `oneshot_run_events`
- artifact bucket reachability
- queue access for the current stage
- `repo-admin` and workspace base paths
- prompt assets for prompt-driven stages
- required retrofit workflow prompt assets and insertion placeholders (`prompts/retrofit-workflow`, `{{retrofitWorkflowSection}}`, and `{{retrofitAdaptationSection}}` where applicable)
- provider environment for the current role

`QUALIFIER` performs a narrower version of the same validation through `worker-main.ts`, because it runs on the shared worker image rather than `src/oneshot/main.ts`.

Health endpoints:

- `GET /health` returns `200` when the consumer loop is alive and not stale; otherwise `503`
- `GET /ready` returns `200` only after startup validation has passed and the consumer is healthy
- OneShot ECS tasks expose these endpoints on `STATUS_PORT` (default `8080`)

## Circuit breakers

Several safety mechanisms prevent runaway processing:

| Breaker | Scope | Threshold | Behavior |
|---|---|---|---|
| Agent timeout | Implementer `runAgent` | 80 minutes (`timeoutMs: 80 * 60 * 1000`) | Leaves a 10-minute buffer before the 90-minute SQS visibility timeout expires |
| Run age | Implementer + Code Reviewer consumers | 24 hours from `created_at` | Run is failed with `run_age_exceeded` reason |
| Token budget | All consumers | `ONESHOT_MAX_TOTAL_TOKENS` (default 2,000,000) | Run is failed with `budget_exceeded` notification |
| Review loops | Reviewer | `ONESHOT_MAX_REVIEW_LOOPS` (default 3) | Run is escalated with `review_escalated` disposition |
| Verification loops | Code Reviewer + Tester | `ONESHOT_MAX_VERIFICATION_LOOPS` (default 3) | Run is escalated or failed |
| Stage attempt counters | Planning, Implementation, Code Review | `ONESHOT_MAX_STAGE_ATTEMPTS` (default 5) | Prevents infinite retries per stage |

Stage attempt counters are tracked by `planning_attempt_count`, `implementation_attempt_count`, and `code_review_attempt_count` columns on `oneshot_runs`. DB methods: `incrementStageAttempts(id, stage)` and `checkStageAttemptBudget(id, stage, maxAttempts)`.

## Bash command blocklist

The Claude Agent SDK's `canUseTool` callback checks all Bash and BashOutput commands against a blocklist of 12 dangerous patterns before execution:

- `rm -rf` / `rm -fr`
- `chmod 777`
- `curl | sh` / `wget | bash`
- `git push --force` (note: `--force-with-lease` is not blocked)
- `git reset --hard`
- `mkfs`
- `dd if=`
- `/dev/sd*` block device writes
- `sudo`
- `npm publish`

Blocked commands are denied with a message returned to the agent. Logged at `warn` level with `[BASH_BLOCKED]` prefix in the relevant consumer log group.

Source: `BLOCKED_BASH_PATTERNS` in `src/claude-sdk/index.ts`

## Prompt caching

The Claude Agent SDK unconditionally enables the `context-1m-2025-08-07` beta, which activates prompt caching for multi-turn sessions. Cache metrics (`cacheReadTokens`, `cacheWriteTokens`) are logged at `[SDK_COMPLETE]` level in planner and implementer logs. Non-zero cache-read values indicate the system is benefiting from cached prompt prefixes across turns within a single agent invocation.

## Labels and controls

Required routing label:

- `PFOS`

Control labels:

- `PFOS-FORCE-APPROVE`
- `PFOS-REPLAN`

Behavior:

- `PFOS` routes the Jira issue exclusively to `QUALIFIER`
- `PFOS-FORCE-APPROVE` is honored only when the active run is `escalated`
- `PFOS-REPLAN` is a consumed same-run command. It queues planning for an existing eligible run before PR creation/completion and never creates a fresh duplicate run.

## Key tables

- `oneshot_runs`
- `oneshot_artifacts`
- `oneshot_notifications`
- `oneshot_deployments`
- `oneshot_run_events`

## Key artifact stages

- `qualification`
- `plan`
- `trace`
- `verify`
- `review`
- `implementation`
- `code_review`
- `test_result`

Typical straight-line progression:

1. `qualification`
2. `plan`
3. `trace`
4. `verify`
5. `review`
6. `implementation`
7. `code_review`
8. `test_result`

Revision loops usually repeat:

- `plan` + `trace` + `verify` + `review`
- or `implementation` + `code_review` + `test_result`

## Cross-stage data forwarding

Several schema fields exist specifically to carry context forward across stages, reducing redundant LLM exploration:

### TRACE and VERIFY

The Reviewer consumer writes TRACE artifacts after Validate approves the plan or the validation review budget is exhausted:

- `trace/v{planVersion}/test-cases.json`
- `trace/v{planVersion}/test-cases.csv`

TRACE CSV output uses the canonical 16-column header and RFC 4180 quoting. The CSV is attached to Jira as `test-cases-<JIRA_KEY>.csv` when `ONESHOT_TRACE_POST_TO_JIRA=true` and Jira credentials are present; attachment/comment failures are non-blocking but recorded as run events.

VERIFY writes `verify/v{planVersion}/verify-report.json` with recommendation `APPROVED`, `CONDITIONAL`, or `REJECTED`. `REJECTED` and `CONDITIONAL` do not automatically block Jira posting or handoff to Build; they are carried forward as advisory context for Jira, dashboard artifact inspection, and downstream implementation/testing.

The implementer receives TRACE Section C unit-test specs and reports `implementedTraceTestIds` in the implementation artifact.

### plannerDiscoveries

Optional field in the plan schema, populated by the planner during codebase exploration:

- `buildCommand`, `testCommand`, `testPattern`
- `entryPoints`, `relevantPatterns`, `keyDependencies`

Forwarded to the implementer (injected at the top of the prompt as "skip re-discovery" context). The tester falls back to `plannerDiscoveries.testCommand` when the implementation provides no test commands.

### sessionNotes

Optional field in the implementation schema. The implementer writes a self-summary of key design decisions, non-obvious file relationships, and codebase conventions that constrained the approach.

On revision, the prior session notes are injected into the revision prompt so the next implementer invocation (which may run on a different container) can skip re-discovery.

### Execution evidence (commitDiff)

After committing, the implementer captures `git diff HEAD~1 HEAD --unified=5` (truncated to 100KB) and stores it in the implementation artifact. The code reviewer consumer materializes it as `commit-diff.v{N}.txt` in the workspace, giving the OpenAI reviewer the actual diff rather than requiring it to reconstruct changes from file listings.

### Checkpoint resumability (previousCompletedSpecIds)

On revision, the implementer consumer loads `completedSpecIds` from the prior implementation artifact. These IDs are injected into the prompt as "DO NOT re-implement these spec IDs". Only incomplete or rejected specs get re-worked, avoiding redundant changes to already-approved code.

### Prior review context

When the reviewer processes a plan that has been through a prior review round, it loads its own previous review artifact and materializes it as `review.previous.json` in the workspace. This lets the OpenAI reviewer verify that its previous feedback was addressed.

## Builder pushback (implementerDisagrees)

If the implementer believes a code review required change is technically incorrect or impossible to implement, it sets `implementerDisagrees: true` with `implementerDisagreementReason` in the implementation output. The code reviewer consumer checks this flag before looping. When set, the run escalates to `escalated` with `final_disposition: 'code_review_escalated'` and a conflict notification is posted to Jira that includes both the implementer's reasoning and the reviewer's required changes.

To resolve: inspect both the latest `code_review` and `implementation` artifacts, then either add `PFOS-FORCE-APPROVE` to proceed or address the conflict manually.

## Progress notifications

When the implementer claims a run, a `progress_update` notification is posted to Jira:

> The implementer is now working on [implementing|revising] the approved plan (implementation v{N}).

This gives the ticket reporter visibility that work has started without waiting for the final result.

## Test command fallback chain

The tester resolves test commands using a priority chain:

1. **Implementation `testCommands`** -- the implementer's explicit test commands
2. **`plan.plannerDiscoveries.testCommand`** -- the planner's discovered test command from codebase exploration
3. **Heuristic detection** -- `resolveTestCommands()` inspects `package.json` scripts, `pom.xml`, or `build.gradle` to infer test commands

If all sources fail, the tester infers pass/fail from exit code and logs a parser note.

## Partial WIP PR on code review escalation

When the code reviewer exhausts the verification budget (max loops reached) without approval, it creates a `[WIP][PFOS]` draft PR before escalating the run. The PR body includes the required changes from the last review. The PR URL is stored in `current_pr_url` on `oneshot_runs`.

This means human reviewers can see the actual code diff in GitHub instead of manually checking out the branch. Successful runs typically pass through `pr_open` and then settle in `completed`, and escalated runs may also have a WIP draft PR in `current_pr_url`.

## Key run states

Common runtime states:

- `queued_for_planning`
- `planning`
- `queued_for_review`
- `reviewing`
- `queued_for_implementation`
- `implementing`
- `queued_for_code_review`
- `code_reviewing`
- `queued_for_testing`
- `testing`
- `escalated`
- `blocked`
- `replan_required`
- `pr_open`
- `failed`

Less common or reserved states:

- `completed`
- `needs_revision`
- `approved`

Operational interpretation:

- `pr_open` is the transient success state immediately after draft PR creation
- `completed` is the normal successful terminal state after the Jira notification poster confirms success
- `replan_required` means branch drift blocked reuse of the original base SHA
- `escalated` means a review or code-review loop exhausted the allowed retries, or the implementer disagreed with the code reviewer
- `blocked` means a reviewer or code reviewer returned a hard block

## RunEvent audit trail

The `oneshot_run_events` table (migration 012) records every state transition and claim across all OneShot consumers as a fire-and-forget event. Events are emitted in `.catch(() => undefined)` blocks so they never fail the main processing path.

Event types include: `run_created`, `state_transition`, `token_usage_added`, `artifact_stored`, `trace_generated`, `verify_completed`, `trace_jira_attachment_failed`, `trace_jira_attachment_skipped`, `trace_jira_comment_failed`, `trace_jira_post_completed`, `notification_created`, `run_claimed`, `reconciliation_republished`

Columns: `id`, `oneshot_run_id`, `event_type`, `from_state`, `to_state`, `stage`, `metadata_json`, `occurred_at`

Query to trace the full lifecycle of a run:

```sql
SELECT
  id,
  event_type,
  from_state,
  to_state,
  stage,
  metadata_json,
  occurred_at
FROM oneshot_run_events
WHERE oneshot_run_id = <RUN_ID>
ORDER BY occurred_at ASC;
```

Source: `src/oneshot/database/events.ts`, migration `db/migrations/012_oneshot_run_events_and_attempt_counts.sql`

## Per-stage cost tracking

Each artifact's `metadata_json` includes `stage_tokens_used`, `stage_cost_usd`, and `stage_duration_ms`. Planner artifacts also include `model_cost_usage` when planner metrics are available, so operators can see Opus main-planner cost separately from Haiku scout/workplan cost while existing dashboards continue to read the aggregate `stage_cost_usd`.

`stage_tokens_used` remains input + output tokens only. The nested `tokens_used` object carries cache read/write token counters when the provider reports them, and `model_cost_usage` carries the per-model dollar split plus whether each row is exact or estimated.

```sql
SELECT
  stage,
  version,
  metadata_json->'$.stage_tokens_used' AS tokens,
  metadata_json->'$.tokens_used' AS token_breakdown,
  metadata_json->'$.stage_cost_usd' AS cost_usd,
  metadata_json->'$.model_cost_usage' AS model_cost_usage,
  metadata_json->'$.stage_duration_ms' AS duration_ms,
  provider,
  model
FROM oneshot_artifacts
WHERE oneshot_run_id = <RUN_ID>
ORDER BY created_at ASC;
```

To get total cost across all stages for a run:

```sql
SELECT
  oneshot_run_id,
  SUM(CAST(metadata_json->'$.stage_cost_usd' AS DECIMAL(10,4))) AS total_cost_usd,
  SUM(CAST(metadata_json->'$.stage_tokens_used' AS UNSIGNED)) AS total_tokens,
  SUM(CAST(metadata_json->'$.stage_duration_ms' AS UNSIGNED)) AS total_duration_ms
FROM oneshot_artifacts
WHERE oneshot_run_id = <RUN_ID>;
```

## Safe JSON parsing

All 5 consumers wrap `JSON.parse` calls in try/catch blocks with descriptive error messages that include the S3 key, byte count, and first 100 characters of the corrupt content. If you see `Corrupted artifact JSON at` in logs, the artifact body in S3 is malformed -- inspect it directly with `aws s3 cp` to diagnose.

## Check recent runs

```sql
SELECT
  id,
  jira_key,
  state,
  current_plan_version,
  current_review_version,
  current_implementation_version,
  current_code_review_version,
  current_test_version,
  current_pr_url,
  final_disposition,
  last_error,
  planning_attempt_count,
  implementation_attempt_count,
  code_review_attempt_count,
  updated_at
FROM oneshot_runs
ORDER BY updated_at DESC
LIMIT 50;
```

## Check stale queued or in-flight runs

The orchestrator reconciliation loop republishes both queued and in-flight stage messages when runs go stale.

```sql
SELECT
  id,
  jira_key,
  state,
  current_plan_version,
  current_review_version,
  current_implementation_version,
  current_code_review_version,
  current_test_version,
  updated_at
FROM oneshot_runs
WHERE state IN (
  'queued_for_planning',
  'planning',
  'queued_for_review',
  'reviewing',
  'queued_for_implementation',
  'implementing',
  'queued_for_code_review',
  'code_reviewing',
  'queued_for_testing',
  'testing'
)
  AND updated_at < NOW() - INTERVAL 10 MINUTE
ORDER BY updated_at ASC;
```

## Inspect artifacts for a run

```sql
SELECT
  id,
  oneshot_run_id,
  stage,
  version,
  status,
  provider,
  model,
  s3_bucket,
  s3_key,
  metadata_json->'$.stage_tokens_used' AS stage_tokens,
  metadata_json->'$.tokens_used' AS token_breakdown,
  metadata_json->'$.stage_cost_usd' AS stage_cost,
  metadata_json->'$.model_cost_usage' AS model_cost_usage,
  metadata_json->'$.stage_duration_ms' AS stage_duration_ms,
  created_at,
  completed_at
FROM oneshot_artifacts
WHERE oneshot_run_id = <RUN_ID>
ORDER BY created_at ASC;
```

## Inspect pending notifications

```sql
SELECT
  id,
  oneshot_run_id,
  jira_key,
  notification_type,
  status,
  error,
  created_at,
  posted_at
FROM oneshot_notifications
ORDER BY created_at DESC;
```

Current notification types you should expect in practice:

- `review_escalated`
- `review_blocked`
- `code_review_escalated`
- `code_review_blocked`
- `branch_drift`
- `test_failed`
- `pr_created`
- `completed`
- `run_failed`
- `budget_exceeded`
- `progress_update`

## Inspect preview deployment rows

Use the separate preview runbook for the full workflow, but this is the core query:

```sql
SELECT
  id,
  oneshot_run_id,
  slot_name,
  branch_name,
  commit_sha,
  status,
  image_uri,
  task_definition_arn,
  preview_url,
  workflow_run_id,
  workflow_url,
  error,
  created_at,
  updated_at
FROM oneshot_deployments
ORDER BY created_at DESC;
```

## Escalated runs

Escalated means:

- `REVIEWER` or `CODE_REVIEWER` returned `NEEDS_CHANGES` and the allowed loop budget was exhausted
- the implementer disagreed with the code reviewer's required changes (`implementerDisagrees` flag)
- the pipeline stopped intentionally for human review

Recommended operator flow:

1. inspect the latest `review` or `code_review` artifact
2. if the escalation is due to `implementerDisagrees`, also inspect the latest `implementation` artifact for `implementerDisagreementReason`
3. decide whether the findings should be addressed in-ticket
4. if you want to override, add `PFOS-FORCE-APPROVE`
5. verify the next queued state:
   - `queued_for_implementation`, or
   - `queued_for_testing` if force-approve advanced a later-stage run
6. if a WIP PR was created on escalation, check `current_pr_url` to review the actual diff in GitHub

Query:

```sql
SELECT
  id,
  jira_key,
  state,
  review_loop_count,
  verification_loop_count,
  planning_attempt_count,
  implementation_attempt_count,
  code_review_attempt_count,
  final_disposition,
  current_pr_url,
  last_error,
  updated_at
FROM oneshot_runs
WHERE state = 'escalated'
ORDER BY updated_at DESC;
```

## Replan-required runs

`replan_required` means the target branch head moved and the run can no longer safely continue from the planned base SHA.

Recommended operator flow:

1. inspect the current branch head
2. confirm the ticket should still proceed
3. add `PFOS-REPLAN`
4. verify `QUALIFIER` queued the same run for planning against the new head SHA
5. verify `PFOS-REPLAN` was removed from Jira while `PFOS` remains

Query:

```sql
SELECT
  id,
  jira_key,
  branch_name,
  base_commit_sha,
  final_disposition,
  updated_at
FROM oneshot_runs
WHERE state = 'replan_required'
ORDER BY updated_at DESC;
```

## Blocked runs

Blocked means a reviewer returned a hard block rather than a revision request, or a strict implementation guard exhausted its automatic recovery path.

Recommended operator flow:

1. inspect the latest `review` or `code_review` artifact
2. inspect the latest notification body posted to Jira
3. decide whether to:
   - leave the run blocked
   - update the Jira ticket and replan the same run with `PFOS-REPLAN`

`PFOS-REPLAN` on blocked or failed runs no longer re-enters fresh qualification. If the run has no PR and is not completed, QUALIFIER resolves the current target branch head, resets the same run for planning, consumes the label, and records a `control_replan_requested` event. If Jira label cleanup fails, later QUALIFIER passes no-op on the consumed command instead of bumping plan version repeatedly.

Plan-contract violations are a special case. The implementer still rejects any diff that changes files outside the approved `fileChangeContract`, but future violations automatically return the same run to `queued_for_planning` with reason `plan_contract_violation_auto_replan` while budget remains. The planner receives the violating files and must either add them to the next plan contract with evidence or explicitly reject them and constrain the implementer.

If the auto-replan budget is exhausted, the run remains `blocked` with reason `plan_contract_violation_replan_exhausted`. Existing blocked runs whose latest implementation transition is `plan_contract_violation` or `plan_contract_violation_replan_exhausted` can be recovered once with:

```bash
npm run oneshot:recover-plan-contract-violation -- \
  --dashboard-id run-546 \
  --operator-id "$USER" \
  --operator-name "Operator Name" \
  --reason "Recover plan-contract violation"
```

After recovery, verify the timeline shows `blocked -> queued_for_planning` with reason `manual_plan_contract_violation_recovery`, then a planning claim for the same run ID. Do not restart implementation directly; that preserves the stale plan contract and can loop.

Retrofit proof failures are retrofit-only. Inspect the latest `qualification`, `plan`, `review`, `implementation`, and `code_review` artifacts plus run events before choosing recovery. Current failure reasons:

- `retrofit_source_lookup_failed`, `source_pr_lookup_failed`, `source_commit_lookup_failed`, or `source_branch_lookup_failed` -- GitHub/API/source PR/commit/branch lookup failed; retry or recover as platform infrastructure and do not add `PFOS-NOT-QUALIFIED`
- `target_branch_lookup_failed` -- GitHub/API target branch lookup failed; retry or recover as platform infrastructure and do not render this as missing source evidence
- `source_pr_not_found` or `source_commit_not_found` -- all deterministic source discovery completed but no source PR/commit evidence was found; this is a semantic qualification failure and may add `PFOS-NOT-QUALIFIED`
- `retrofit_contract_missing`, `retrofit_contract_missing_mapping`, or `retrofit_contract_weak_adaptation_evidence` -- the plan did not map selected source commits to target or adaptation files with `fileChangeContract` evidence; replan the same run
- `retrofit_patch_proof_missing` or `retrofit_patch_incomplete` -- implementation could not prove every selected source SHA; use same-run proof repair or replanning, not fresh qualification
- `retrofit_revision_proof_regressed` -- a Build revision invalidated prior accepted source proof; recover or replan the same run with the prior implementation proof visible

Source PR URLs are preferred for retrofits. QUALIFIER looks for source evidence in this order: explicit source PR links in the retrofit ticket, prior OneShot runs for the source Jira with an open/current PR, GitHub PR links on the source Jira, merged GitHub PR search for the source Jira, then Jira-key commit grep plus commit-to-PR expansion. If a source PR is found, OneShot must select all PR commits in order, including commits whose subjects do not contain the Jira key. `subject_grep_only` evidence is a fallback only when no PR is discoverable, and it should be treated as weaker evidence in review. Regular tickets do not use the retrofit execution contract, source commit resolver, patch-first lane, or retrofit proof gates.

Query:

```sql
SELECT
  id,
  jira_key,
  state,
  final_disposition,
  last_error,
  updated_at
FROM oneshot_runs
WHERE state = 'blocked'
ORDER BY updated_at DESC;
```

## Failed runs

Failure sources typically include:

- malformed provider output after retries
- provider/runtime errors
- implementation produced no changes
- test execution failures that exhausted retries
- queue redrive / repeated consumer failure
- run age exceeded 24 hours
- token budget exhausted
- stage attempt budget exhausted

Recommended inspection flow:

1. inspect `oneshot_runs.last_error`
2. inspect the latest artifact
3. inspect the latest notification
4. inspect the relevant consumer log group
5. inspect the run event trail for the full sequence of state transitions

Query:

```sql
SELECT
  id,
  jira_key,
  state,
  final_disposition,
  last_error,
  planning_attempt_count,
  implementation_attempt_count,
  code_review_attempt_count,
  updated_at
FROM oneshot_runs
WHERE state = 'failed'
ORDER BY updated_at DESC;
```

## Draft PR verification

Most successful runs should expose a draft PR and end in `completed`. Escalated runs may also have a WIP draft PR in `current_pr_url`.

```sql
SELECT
  id,
  jira_key,
  state,
  current_implementation_branch,
  current_implementation_commit_sha,
  current_pr_url,
  updated_at
FROM oneshot_runs
WHERE state IN ('pr_open', 'completed', 'escalated')
  AND current_pr_url IS NOT NULL
ORDER BY updated_at DESC;
```

If `current_pr_url` is null for a `completed` or `pr_open` run:

- inspect the latest `implementation` and `test_result` artifacts
- inspect tester logs
- verify GitHub branch push and PR creation succeeded

## Queue and DLQ checks

Queues:

- `oneshot-planning.fifo`
- `oneshot-review.fifo`
- `oneshot-implementation.fifo`
- `oneshot-code-review.fifo`
- `oneshot-testing.fifo`

DLQs:

- `oneshot-planning-dlq.fifo`
- `oneshot-review-dlq.fifo`
- `oneshot-implementation-dlq.fifo`
- `oneshot-code-review-dlq.fifo`
- `oneshot-testing-dlq.fifo`

DLQ configuration:

- `maxReceiveCount = 3` (message moves to DLQ after 3 failed processing attempts)
- 14-day message retention on all DLQs
- CloudWatch alarms fire when `ApproximateNumberOfMessagesVisible > 0` on any DLQ
- queue age and primary queue depth alarm independently on the main FIFO queues
- Alarm names: `{environment}-oneshot-planning-dlq-depth`, `{environment}-oneshot-review-dlq-depth`, etc.

When a DLQ receives messages:

1. inspect the message body for `run_id`, `stage`, `version`, and `expected_state`
2. inspect the matching `oneshot_runs` row
3. inspect the matching consumer logs
4. inspect the run event trail for the sequence of state transitions leading to the failure
5. decide whether to:
   - leave the run `failed`
   - fix the underlying issue and republish manually

## Workspace and cleanup checks

Expected filesystem paths:

- `/mnt/efs/specter-repo/repo-admin/<repo>`
- `/mnt/efs/specter-repo/oneshot/<run-id>/workspace`
- `/mnt/efs/specter-repo/oneshot/<run-id>/state`
- `/mnt/efs/specter-repo/oneshot/<run-id>/state/<stage>/` (e.g., `state/planner/repo-scan.json`)

Current behavior:

- OneShot reuses the same `workspace/` directory across stages within a run
- before reuse it runs `git reset --hard <target-sha>` and `git clean -ffd`
- stage sidecar files are isolated under `state/<stage>/`
- `state/<current-stage>/` is cleared when that stage reruns

### Workspace cleanup reaper

The orchestrator's reconciliation loop calls `OneShotService.cleanupTerminalWorkspaces(olderThanHours=24, limit=20)` on each pass. This queries terminal runs (`pr_open`, `completed`, `failed`, `blocked`) older than 24 hours and `rm -rf`s their EFS workspace directories under `/mnt/efs/specter-repo/oneshot/<run-id>`. Up to 20 workspaces are cleaned per cycle.

Recommended checks:

- confirm `repo-admin/<repo>/.git` exists and is a real clone
- confirm there are no branch subfolders inside `repo-admin/<repo>`
- check cleanup logs in the orchestrator log group for `OneShot workspace cleanup completed` entries
- if disk pressure is observed, reduce `olderThanHours` or increase `limit`

## Log groups

Primary groups:

- `/ecs/specter/qualifier-worker`
- `/ecs/specter/oneshot-planner`
- `/ecs/specter/oneshot-reviewer`
- `/ecs/specter/oneshot-implementer`
- `/ecs/specter/oneshot-code_reviewer`
- `/ecs/specter/oneshot-tester`
- `/ecs/specter/orchestrator`

The orchestrator log group is where notification posting, stale-run reconciliation, and workspace reaper runs are logged.

Key log patterns to search for:

- `[BASH_BLOCKED]` -- blocked dangerous bash commands (implementer/planner logs)
- `[SDK_COMPLETE]` -- agent completion with token usage and cache metrics
- `Corrupted artifact JSON` -- safe JSON parsing caught a malformed artifact
- `OneShot workspace cleanup completed` -- reaper activity (orchestrator logs)
- `implementerDisagrees` -- builder pushback escalation (code reviewer logs)

## Environment variables reference

| Variable | Default | Description |
|---|---|---|
| `ONESHOT_REPO_ADMIN_BASE` | falls back to `REPOSITORY_PATH` | Admin clone root for OneShot |
| `ONESHOT_WORKSPACE_BASE` | `/mnt/efs/specter-repo/oneshot` | Run workspace root |
| `ONESHOT_MAX_REVIEW_LOOPS` | `3` | Max plan revision loops |
| `ONESHOT_MAX_VERIFICATION_LOOPS` | `3` | Max implementation/test loops |
| `ONESHOT_MAX_TOTAL_TOKENS` | `2000000` | Token budget per run |
| `ONESHOT_MAX_STAGE_ATTEMPTS` | `5` | Max retries per stage before hard fail |
| `ONESHOT_RECONCILE_STALE_MINUTES` | `10` | Minutes before a stale run is republished |
| `ONESHOT_REVIEWER_ENABLED` | `true` | Set to `false` to bypass plan review |
| `ONESHOT_CODE_REVIEWER_ENABLED` | `true` | Set to `false` to bypass code review |
| `ONESHOT_TRACE_ENABLED` | `true` | Generate TRACE test-case artifacts after Plan Review / Validate clears or exhausts |
| `ONESHOT_DOCS_SYNTHESIS_ENABLED` | `false` | Use LLM synthesis for documentation generation instead of the deterministic assembler. Staged rollout: enable per environment via the `oneshot_docs_synthesis_enabled` Terraform variable after validating output quality. When enabled, synthesized docs are structurally validated (required-section citations, no invented citations, no unsupported claims); any failure routes the ticket to `DOCS-BLOCKED` for human review rather than `DOCS-GENERATED` |
| `ONESHOT_TRACE_POST_TO_JIRA` | `true` | Attach/comment TRACE CSV back to Jira when credentials are configured |
| `ONESHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA` | `true` | Attach the reviewed implementation plan to Jira and post a compact handoff comment when implementation is queued |
| `ONESHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS` | `300000` | Repo-cache lease wait for retrofit planning when an extra source branch must be fetched; normal tickets keep the default workspace wait |
| `ONESHOT_VERIFY_ENABLED` | `true` | Review TRACE output after Validate and before Build handoff |
| `ONESHOT_VERIFY_MODE` | `balanced` | VERIFY scoring profile: `balanced`, `strict`, or `lenient` |
| `ONESHOT_ARTIFACT_BUCKET` | `{S3_BUCKET_PREFIX}-results` | S3 bucket for artifacts |
| `ONESHOT_ARTIFACT_PREFIX` | `oneshot` | S3 key prefix for artifacts |
| `ONESHOT_PROMPT_SOURCE` | `local` | `s3` or `local` for prompt templates |
| `ONESHOT_HEALTHCARE_GUARDRAILS` | `false` | Enable healthcare-specific guardrails |
| `STATUS_PORT` | `8080` | HTTP port for OneShot `/health` and `/ready` |

Prompt rollout note: after changing prompt assets, run `scripts/publish-oneshot-prompts.sh` before deploying workers that use `ONESHOT_PROMPT_SOURCE=s3`. The generated manifest must include `prompts/retrofit-workflow`; workers intentionally fail startup if the retrofit workflow fragment or its template insertion points are missing.

## Migration 012

Migration `db/migrations/012_oneshot_run_events_and_attempt_counts.sql` adds:

```sql
ALTER TABLE oneshot_runs
  ADD COLUMN planning_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN implementation_attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN code_review_attempt_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS oneshot_run_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  oneshot_run_id BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  from_state VARCHAR(64) DEFAULT NULL,
  to_state VARCHAR(64) DEFAULT NULL,
  stage VARCHAR(64) DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_run_events_run_id (oneshot_run_id),
  INDEX idx_run_events_occurred_at (occurred_at),
  CONSTRAINT fk_run_events_run
    FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs (id) ON DELETE CASCADE
);
```

This migration must be applied before deploying the image that includes the event trail and stage attempt features. The `ALTER TABLE` is additive and safe to run against a live database.

## Rollout checklist after code changes

Terraform apply updates task definitions and environment variables, but it does not build or push new application images.

For a full OneShot rollout:

1. apply migration 012 if not already applied
2. apply Terraform if env/config changed
3. push the worker image for `QUALIFIER`
4. push the shared OneShot image for `PLANNER`, `REVIEWER`, `IMPLEMENTER`, `CODE_REVIEWER`, and `TESTER`
5. verify ECS service stability
6. verify queue connectivity and log groups before using or reusing the `PFOS` label
7. verify DLQ CloudWatch alarms are active
8. confirm workspace reaper is running by checking orchestrator logs for `OneShot workspace cleanup completed`
