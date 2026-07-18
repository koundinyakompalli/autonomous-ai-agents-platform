# OneShot Features

**OneShot version:** 1.21.66 (see `ONESHOT_VERSION` in [`src/oneshot/contracts.ts`](../src/oneshot/contracts.ts); release tag target `oneshot/v1.21.66`)
**Document version:** 1.0
**Updated:** 2026-07-06
**Coverage:** OneShot PRs #31 – #153 plus local repo-confirmation auth, repo identity, validation-dispute, and recognized non-MP repo routing fixes

OneShot is an autonomous AI coding pipeline that takes a Jira ticket through six queue stages — **Qualifier → Planner → Reviewer → Implementer → Code Reviewer → Tester** — and produces a reviewed, tested pull request. The validation handoff now runs **PLAN → Plan Review / Validate → TRACE → VERIFY → Build** so draft plans settle before test-case coverage is generated and checked.

This document is a **feature reference**, not a runbook. For operational procedures (how to deploy, how to debug, how to read logs) see [`ONESHOT_RUNBOOK.md`](./ONESHOT_RUNBOOK.md). For preview-environment deploys see [`ONESHOT_PREVIEW_RUNBOOK.md`](./ONESHOT_PREVIEW_RUNBOOK.md). For local development see [`../local-oneshot/README.md`](../local-oneshot/README.md).

Each feature below lists a short description and the primary file(s) where it lives.

---

## Table of contents

1. [Pipeline & Orchestration](#1-pipeline--orchestration)
2. [Qualification](#2-qualification)
3. [Planning & Discovery](#3-planning--discovery)
4. [Review Loop](#4-review-loop)
5. [Implementation](#5-implementation)
6. [Code Review](#6-code-review)
7. [Testing & Verification](#7-testing--verification)
8. [Guardrails & Compliance](#8-guardrails--compliance)
9. [Branch & Git Management](#9-branch--git-management)
10. [Jira & Notifications](#10-jira--notifications)
11. [Cost Tracking & Telemetry](#11-cost-tracking--telemetry)
12. [Dashboard & UI](#12-dashboard--ui)
13. [Preview Deploy](#13-preview-deploy)
14. [Providers & Models](#14-providers--models)
15. [Prompt Management](#15-prompt-management)
16. [Error Handling & Recovery](#16-error-handling--recovery)
17. [Repository Intelligence](#17-repository-intelligence)
18. [Persistence](#18-persistence)
19. [Local Development](#19-local-development)
20. [Infrastructure & Deployment](#20-infrastructure--deployment)
21. [Environment variable quick reference](#21-environment-variable-quick-reference)
22. [Changelog](#22-changelog)
23. [Where to go next](#23-where-to-go-next)

---

## 1. Pipeline & Orchestration

- **Jira polling via JQL** — Orchestrator scans Jira on an interval and enqueues qualifying tickets into the pipeline. *`src/oneshot/service.ts`, `ORCHESTRATOR_README.md`*
- **Six-stage queue pipeline** — Qualifier → Planner → Reviewer → Implementer → Code Reviewer → Tester, each its own consumer with its own queue and artifact version. The Planner produces the plan; the Reviewer performs Plan Review / Validate, then generates TRACE and VERIFY artifacts before Build handoff. *`src/oneshot/main.ts`, `src/oneshot/consumer-base.ts`, `src/oneshot/consumers/planner.ts`, `src/oneshot/consumers/reviewer.ts`, `src/oneshot/trace-verify-runner.ts`*
- **Queue-based dispatch** — SQS FIFO queues per stage with per-queue DLQs for failure isolation. *`src/oneshot/contracts.ts`, `src/oneshot/publisher.ts`*
- **18-state run lifecycle** — Discrete states including `queued_*`, `*ing`, `pr_open`, `completed`, `escalated`, `blocked`, `failed`. *`src/oneshot/types.ts`, `src/oneshot/state-transitions.ts`*
- **Stale-run reconciliation** — Runs stuck in-flight for more than 10 minutes are republished; runs older than 24 hours are terminated. *`src/oneshot/service.ts`*
- **Run groups** — Multi-repo or multi-branch batch runs are correlated under a shared group ID. *`src/oneshot/database/run-groups.ts`*
- **Workspace management** — Shared repo caches stay on EFS while per-run git worktrees are isolated on local task storage. *`src/oneshot/workspaces.ts`*
- **Workspace reaper** — Automatic cleanup of workspaces attached to terminal runs after 24 hours. *`src/oneshot/workspaces.ts`*
- **Workspace v2** — Reworked workspace layout with richer state, stage-partitioned directories, and coordinated termination semantics across consumers and the dashboard. *`db/migrations/018_oneshot_workspace_v2.sql`, `src/oneshot/workspaces.ts`, `dashboard/server/services/oneshotRunTerminations.ts`*
- **Workspace leases** — Database-backed leases prevent two stages from mutating the same workspace simultaneously. *`src/oneshot/database/workspace-leases.ts`, `src/oneshot/workspace-lease-errors.ts`*
- **Stage version + candidate guards** — Every stage handoff validates the upstream artifact version and rejects stale candidates. *`src/oneshot/stage-version-guard.ts`, `src/oneshot/stage-candidate-guard.ts`*
- **Consumer visibility control** — Dynamically tunes SQS message visibility to match long-running stage work. *`src/oneshot/consumer-visibility.ts`*
- **Readiness + health endpoints** — Each consumer exposes `/ready` and `/health` for orchestrator and ECS health checks. *`src/oneshot/health-server.ts`, `src/oneshot/readiness.ts`*

## 2. Qualification

- **Deterministic qualification scorer** — Pure TypeScript scorer evaluating summary quality, description, acceptance criteria, scope clarity, and testability with no LLM call. *`src/oneshot/qualification-scorer.ts`*
- **Claude-adjudicated borderline tickets** — Tickets that score near the threshold are re-examined with repo context before being rejected. *`src/oneshot/qualification-artifact.ts`, `src/oneshot/consumers/*` (qualifier)*
- **Ticket-intent classification** — Infers whether a ticket is a feature, bug, refactor, or retrofit before routing. *`src/oneshot/ticket-intent.ts`*
- **Force-approve label** — `PFOS-FORCE-APPROVE` bypasses qualification rejection for human-sanctioned tickets. *`src/oneshot/contracts.ts`*
- **Force-replan label** — `PFOS-REPLAN` discards the current plan and re-plans the same run against the latest branch head; it is consumed after queueing and never creates a fresh duplicate run. *`src/oneshot/contracts.ts`*
- **No-requeue on not-qualified / terminal runs** — PFOS tickets that fail qualification or reach a terminal state are not automatically re-enqueued on the next orchestrator sweep. *`src/oneshot/service.ts`*

## 3. Planning & Discovery

- **Repo scanner** — Pre-scans the workspace for tech stack, build tool, test framework, root files, and entry points before the planner runs. *`src/oneshot/repo-scanner.ts`*
- **Codebase-intelligence injection** — Scanner output is fed into the planner prompt so the planner skips basic discovery. *`src/oneshot/repo-scanner.ts`, `src/oneshot/prompt-composer.ts`*
- **Plan spec schema** — Structured plan artifact with objectives, acceptance criteria, target files, implementation notes, and validation steps. *`src/oneshot/schema/plan.ts`*
- **Planner discoveries carried forward** — `buildCommand`, `testCommand`, `testPattern`, entry points, and key dependencies are surfaced so downstream stages reuse them. *`src/oneshot/schema/plan.ts`*
- **Explicit repo resolution** — Uses explicit hints in the ticket (e.g. repo label, comment directive) to pick the target repository. *`src/oneshot/explicit-repo-resolution.ts`*
- **Description-based repo resolution** — Falls back to ticket description signals when no explicit hint is present. *`src/oneshot/description-repo-resolution.ts`*
- **Description repo directives** — Authors can embed explicit repo directives directly in the ticket description; the resolver parses and honors them before description-signal inference. *`src/oneshot/description-repo-resolution.ts`*
- **Retrofit repo resolution** — Resolves the target repo when the ticket is a backport / forward-port of an earlier change. *`src/oneshot/retrofit-repo-resolution.ts`*
- **Repository route cards** — Structured metadata that maps tickets to teams and specific repositories. *`src/oneshot/repo-route-cards.ts`, `src/oneshot/repo-router/`*
- **Repo-domain rules** — Declarative rules constrain which repos a given domain of work may touch. *`src/oneshot/repo-domain-rules.ts`*
- **Default-on planner scout pre-check** — Runs a lightweight LLM workplanner to choose focused read-only scout briefs, then executes bounded harness scouts before final planning; `ONESHOT_PLANNER_SCOUT_ENABLED=false` is the kill switch. *`src/oneshot/providers/scout-workplan.ts`, `src/oneshot/providers/planner-scouts.ts`*
- **Planner Skills and native subagents** — Planner-only Claude plugin Skills cover grounding, decomposition, MedHOK domain cues, bounded scouting, plan quality, test-first validation, and root-cause planning; SDK-native read-only scout subagents are enabled by default with independent kill switches, the first native scout action targets `oneshot-grounding-scout`, the planner prompt inlines the Skill checklist, and bundled Skills resolve from the package root before any service CWD fallback. *`src/oneshot/providers/claude-planner.ts`, `oneshot-prompts/plugins/oneshot-planner/`*
- **Scout telemetry** — Planner scouts emit dedicated telemetry events so scout cost and latency can be attributed separately from the main planner pass. *`src/oneshot/providers/planner-scouts.ts`, `src/oneshot/telemetry/`*
- **Planner grounding** — Enforces grounding of plan references in real files in the workspace, including strict ticket-explicit new Java sources and ticket-backed/template-backed new frontend UI/API feature targets. *`src/oneshot/planner-grounding.ts`*
- **Retrofit context detection** — Detects backport/forward-port scenarios and computes source → target branch propagation. *`src/oneshot/retrofit-context.ts`*
- **Retrofit execution contract** — Retrofit runs carry a `retrofit_execution_contract.v1` ledger from qualification evidence through Planner, Validate, Implementer, Code Review, and recovery. The contract records selected source commits, commit-selection method, source files, target/adaptation mappings, per-commit outcomes, and proof snippets; retrofit-only gates reject missing mappings or proof while regular tickets bypass this path entirely. *`src/oneshot/retrofit-execution-contract.ts`, `src/oneshot/retrofit-source-evidence.ts`, `src/oneshot/consumers/reviewer.ts`, `src/oneshot/consumers/implementer.ts`*
- **Retrofit patch-first lane** — Applies source commits oldest-to-newest via `git apply` before any LLM call: already-applied commits complete as no-action, clean patches apply mechanically (`clean_applied`), conflicts invoke the LLM in constrained adaptation-only mode (`adapted`). Post-implementation coverage (`validateRetrofitCoverage`) and file-scope (`validateRetrofitFileScope`) gates block completion as `retrofit_patch_incomplete` when a source commit is unaccounted or out-of-scope files are modified. Per-commit apply status is recorded in commit messages, PR bodies, and Jira comments. Plan-time file-scope enforcement also runs in the reviewer. Non-retrofit behavior is byte-for-byte unchanged. *`src/oneshot/consumers/implementer.ts`, `src/oneshot/consumers/reviewer.ts`*
- **External spec evidence** — Attaches and validates any external specification linked from the ticket as plan grounding. *`src/oneshot/external-spec-evidence.ts`*
- **TRACE test-case generation** — Generates Section A/B/C test cases from Jira acceptance criteria and the validated OneShot plan, renders the canonical 16-column RFC 4180 CSV, stores JSON/CSV artifacts, and posts the CSV plus coverage summary back to Jira when enabled. *`src/oneshot/schema/trace-verify.ts`, `src/oneshot/trace-verify-runner.ts`, `src/oneshot/consumers/reviewer.ts`*
- **VERIFY post-Validate advisory review** — Reviews TRACE output for requirement coverage, guardrail compliance, QA gaps, and anti-fabrication rules after Plan Review / Validate approves or exhausts its review budget. `REJECTED` and `CONDITIONAL` continue as visible advisory context instead of automatically blocking Jira posting or Build handoff. *`src/oneshot/schema/trace-verify.ts`, `src/oneshot/trace-verify-runner.ts`, `src/oneshot/consumers/reviewer.ts`*

## 4. Review Loop

- **Plan review** — Reviewer evaluates planner output for clarity, feasibility, and completeness. *`src/oneshot/consumers/reviewer.ts`*
- **TRACE/VERIFY post-Validate context** — After Plan Review / Validate clears or exhausts, the Reviewer writes TRACE coverage, VERIFY recommendation, conditional risks, and unverified claims for Jira, dashboard inspection, and downstream implementation/testing. *`src/oneshot/consumers/reviewer.ts`, `src/oneshot/trace-verify-runner.ts`, `src/oneshot/schema/trace-verify.ts`*
- **Review loop budget** — `ONESHOT_MAX_REVIEW_LOOPS` (default 3) caps plan-revision cycles. *`src/oneshot/contracts.ts`*
- **Previous-review context materialization** — The prior review artifact is materialized into the current review so the reviewer can verify feedback was addressed. *`src/oneshot/review-context.ts`*
- **OpenAI Responses API with read-only tools** — Reviewer is backed by an OpenAI reviewer provider that has only read access to the repo. *`src/oneshot/providers/openai-reviewer.ts`, `src/oneshot/providers/reviewer-provider.ts`*
- **Claude reviewer option** — A Claude-backed reviewer implementation is also available and selectable per environment. *`src/oneshot/providers/claude-reviewer.ts`*
- **Review schema** — Structured review output (status, blockers, suggestions) enforced by schema validation. *`src/oneshot/schema/review.ts`*
- **Review escalation** — Escalates to a human when the loop budget is exhausted or a hard block is issued. *`src/oneshot/state-transitions.ts`*

## 5. Implementation

- **Claude SDK (Bedrock) autonomous implementer** — Implementer runs Claude via Bedrock with tool access to write files, run git, and execute tests. *`src/oneshot/providers/claude-implementer.ts`, `src/oneshot/consumers/implementer.ts`*
- **Bash command blocklist** — Blocks dangerous patterns (`rm -rf`, `chmod 777`, `curl | sh`, `git push --force`, `sudo`, `npm publish`, …) before Bash invocation. *`src/oneshot/providers/claude-implementer.ts`*
- **Commit diff evidence** — Captures `git diff HEAD~1 HEAD` (truncated to 100 KB) on each implementation commit so the code reviewer sees the exact change. *`src/oneshot/schema/implementation.ts`*
- **Session notes** — Implementer writes a self-summary of design decisions, non-obvious relationships, and repo conventions for the next stage. *`src/oneshot/schema/implementation.ts`*
- **TRACE Section C build context** — Implementer prompts include TRACE Section C unit-test specs and must report `implementedTraceTestIds` in the implementation artifact. VERIFY recommendations remain advisory review context. *`src/oneshot/consumers/implementer.ts`, `src/oneshot/providers/claude-implementer.ts`, `src/oneshot/schema/implementation.ts`*
- **Checkpoint resumability** — On plan revision, previously-approved spec IDs are preserved so already-implemented code is not redone. *`src/oneshot/schema/implementation.ts`*
- **Implementer "disagrees" pushback** — Builder can dispute code-reviewer changes with reasoning, escalating to a human. *`src/oneshot/schema/implementation.ts`*
- **Per-stage attempt tracking** — Retries per stage are counted; the run fails after `ONESHOT_MAX_STAGE_ATTEMPTS` (default 5). *`src/oneshot/contracts.ts`, `src/oneshot/state-transitions.ts`*
- **Per-stage token budget** — `ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION` caps token spend for the implementer. *`src/oneshot/contracts.ts`, `src/oneshot/token-budget.ts`*
- **Prompt caching beta** — `context-1m-2025-08-07` prompt-caching is always on so multi-turn sessions reuse cached prefix tokens. *`src/oneshot/providers/claude-implementer.ts`*
- **Retry classifier** — Categorizes transient vs. permanent failures so only recoverable failures are retried. *`src/oneshot/retry-classifier.ts`*
- **Fork-resume on revision builds** — Revision Build stages fork-resume the prior implementer Claude session (`resumeSessionId`, `forkSessionOnResume`, `CLAUDE_CONFIG_DIR`) so the model keeps its earlier context; emits `implementation_session_resume` events and falls back once to a fresh session if resume fails before work starts. *`src/claude-sdk/index.ts`, `src/oneshot/providers/claude-implementer.ts`*
- **Per-run shared Claude session storage** — Implementer sessions persist under a per-run-scoped shared config directory so revisions can re-attach without cross-run cache collisions. *`src/oneshot/providers/claude-implementer.ts`*
- **SDK idle watchdog** — Aborts stalled planner/implementer SDK streams using a base idle timeout plus a longer `toolIdleTimeoutMs` while a tool call is in flight, resetting on stream events and at tool admission. *`src/claude-sdk/index.ts`*
- **Progressive retry for planner stalls** — Planner stalls are classified (`PlannerStallError` / `ImplementerStallError`) and retried with progressive backoff distinct from normal failure retries. *`src/oneshot/providers/claude-planner.ts`, `src/oneshot/retry-classifier.ts`*
- **Schema-on-retry / drop-schema-on-first-attempt** — Planner runs attempt 1 without a rigid output schema to reduce first-pass refusals, then re-attaches the schema on retry. *`src/oneshot/providers/claude-planner.ts`*
- **Mandatory exploration + system-prompt slot** — Planner enforces a mandatory repo-exploration step and reserves a dedicated system-prompt slot separate from the user message. *`src/oneshot/providers/claude-planner.ts`*
- **Bash removed from planner allowed tools** — Planner has no Bash access; exploration happens through read-only file tools only. *`src/oneshot/providers/claude-planner.ts`*
- **Run-scoped repo IDs** — Claude SDK repo registrations use explicit run-scoped IDs with a path-hash suffix and are deregistered on cleanup so parallel runs don't collide. *`src/claude-sdk/index.ts`*
- **Retrofit patch-first lane** — When a run is a retrofit (backport/forward-port), the implementer mechanically applies source commit patches via `git apply` before any LLM call. Commits that are already patch-equivalent on the target are detected via `git apply --reverse --check` and completed via the existing verification-only path with no LLM invocation. Clean missing patches are applied mechanically (`clean_applied`). Only conflicting patches route to Claude in a constrained adaptation mode (`adapted`) that resolves conflicts from the exact source patch without semantic rediscovery. Commits that cannot be resolved are classified `failed` or `not_attempted` and surfaced as `retrofit_patch_incomplete` blocking findings in review. Source commit SHAs, per-commit apply status, and source/target branch traceability are recorded in the commit message, PR body, and Jira completion comment. *`src/oneshot/consumers/implementer.ts`, `src/oneshot/git.ts`, `src/oneshot/retrofit-source-evidence.ts`, `src/oneshot/providers/claude-implementer.ts`, `src/oneshot/consumers/reviewer.ts`, `src/oneshot/pr-body.ts`, `src/oneshot/jira-comments.ts`*

## 6. Code Review

- **OpenAI Responses API code reviewer** — Reviews the implementation against the approved plan and style guidelines. *`src/oneshot/providers/openai-code-reviewer.ts`, `src/oneshot/consumers/code-reviewer.ts`*
- **Claude code reviewer option** — A Claude-backed code reviewer is also available. *`src/oneshot/providers/claude-code-reviewer.ts`*
- **Verification loop budget** — `ONESHOT_MAX_VERIFICATION_LOOPS` (default 3) caps code-review + test retry cycles. *`src/oneshot/contracts.ts`*
- **Draft WIP PR on escalation** — Creates a `[WIP][PFOS]` draft PR before escalation so humans can inspect the actual diff in GitHub. *`src/oneshot/github.ts`, `src/oneshot/pr-title.ts`, `src/oneshot/pr-body.ts`*
- **Code-review context** — Assembles plan, diff, session notes, and prior review for the code reviewer. *`src/oneshot/code-review-context.ts`*
- **Code-review schema** — Structured output (status, findings, severity) validated by schema. *`src/oneshot/schema/code-review.ts`*
- **Code-review escalation** — Escalates when verification budget is exhausted or a hard block is issued. *`src/oneshot/state-transitions.ts`*
- **Review stage soft-gate / bypass flags** — Configurable bypass flags allow the Reviewer and Code Reviewer stages to be demoted to soft gates (or disabled in production) without redeploying the pipeline. *`src/oneshot/config.ts`, `src/oneshot/consumers/reviewer.ts`, `src/oneshot/consumers/code-reviewer.ts`, `terraform/variables.tf`*
- **Agentic reviewers** — Reviewers run with repo-tool access rather than pure text-in/text-out, so they can open files before scoring the plan or diff. *`src/oneshot/providers/openai-reviewer.ts`, `src/oneshot/providers/openai-code-reviewer.ts`*
- **Validated review-model reporting** — Review artifacts validate and report the exact model used so the dashboard and cost tracker reflect real provider/model, not a config default. *`src/oneshot/model-usage.ts`, `src/oneshot/consumers/reviewer.ts`*

## 7. Testing & Verification

- **Deterministic tester** — No LLM required; parses test output and infers pass/fail from exit code and logs. *`src/oneshot/consumers/tester.ts`*
- **TRACE/VERIFY stays pre-build** — TRACE and VERIFY add post-Validate test-case generation and advisory review without introducing an LLM call into the deterministic TESTER stage. *`src/oneshot/trace-verify-runner.ts`, `src/oneshot/consumers/reviewer.ts`, `src/oneshot/consumers/tester.ts`*
- **Test command fallback chain** — Priority order: implementation commands → planner discoveries → heuristic detection from `package.json`, `pom.xml`, `build.gradle`. *`src/oneshot/test-executor.ts`*
- **Maven lifecycle support** — Full Maven support with Artifactory integration and smoke runs. *`src/oneshot/test-executor.ts`, `src/oneshot/maven-env.ts`*
- **Build-log parsing** — Extracts results from Maven, npm, pytest, go test output. *`src/oneshot/test-executor.ts`*
- **Exit-code + log pass/fail inference** — Combines exit code with log signals for resilient pass/fail detection. *`src/oneshot/test-executor.ts`*
- **Test-result schema** — Structured test outcome persisted as a versioned artifact. *`src/oneshot/schema/test-result.ts`*
- **Failed-build re-implementation** — Test failure triggers another implementation pass within the verification loop budget. *`src/oneshot/consumers/tester.ts`, `src/oneshot/state-transitions.ts`*

## 8. Guardrails & Compliance

- **Plan guardrails** — Stage-specific constraints for the planner (file paths, scope, complexity). *`oneshot-prompts/guardrails/plan-guardrails.md`*
- **Review-plan guardrails** — Constraints for reviewing planner output. *`oneshot-prompts/guardrails/review-plan-guardrails.md`*
- **Code-review guardrails** — Style, testing, and safety constraints for the code reviewer. *`oneshot-prompts/guardrails/review-code-guardrails.md`*
- **Build guardrails** — Maven/npm build-safety and environment-validation rules. *`oneshot-prompts/guardrails/build-guardrails.md`*
- **Healthcare guardrails** — Domain-specific rules covering HIPAA, FHIR R4, PHI protection, consent management, and SMART on FHIR. *`oneshot-prompts/guardrails/healthcare-rules.md`*
- **Healthcare mode toggle** — `ONESHOT_HEALTHCARE_GUARDRAILS=true` conditionally layers healthcare rules into every stage prompt. *`src/oneshot/prompt-composer.ts`, `src/oneshot/runtime-validation.ts`*
- **PHI severity rules** — Nine severity levels (CRITICAL → LOW) for PHI logging, encryption, and audit trails. *`oneshot-prompts/guardrails/healthcare-rules.md`*
- **FHIR field/type validation** — Enforces required fields and data types for FHIR R4 resources. *`oneshot-prompts/guardrails/healthcare-rules.md`*
- **Runtime validation** — Guardrail configuration is validated at consumer startup. *`src/oneshot/runtime-validation.ts`*
- **TRACE/VERIFY guardrails** — TRACE enforces the exact 16-column schema, Section A/B/C structure, synthetic PHI/PII handling, auth preconditions, AC coverage, and negative-path coverage; VERIFY rejects fabricated history, unmeasured coverage percentages, and unverifiable claims. *`src/oneshot/schema/trace-verify.ts`*

## 9. Branch & Git Management

- **Customer-branch resolution** — Maps customer branches to target branches via the `customer_branches` table. *`src/oneshot/branch-resolution.ts`*
- **Branch drift detection** — Detects when the target branch head has moved since planning and blocks reuse of the original base SHA. *`src/oneshot/branch-drift.ts`*
- **Branch hygiene** — Validates branch naming and enforces safe checkout + cleanup sequences. *`src/oneshot/branch-hygiene.ts`*
- **Git worktree per-run isolation** — Each run operates in its own worktree, enabling parallel execution. *`src/oneshot/workspaces.ts`, `src/oneshot/git.ts`*
- **Implementation branch + SHA tracking** — `current_implementation_branch` and `current_implementation_commit_sha` are recorded on every run. *`src/oneshot/types.ts`, `src/oneshot/database/runs.ts`*
- **Draft PR creation** — Creates and updates draft PRs, tracks `current_pr_url`, and stores PR metadata. *`src/oneshot/github.ts`*
- **PR title + body rendering** — Structured PR title and body composition from plan + implementation artifacts. *`src/oneshot/pr-title.ts`, `src/oneshot/pr-body.ts`*
- **Force-replan against new head** — `PFOS-REPLAN` queues same-run planning against the latest branch head and suppresses repeat replans from stale Jira labels. *`src/oneshot/contracts.ts`, `src/oneshot/service.ts`*
- **Candidate SHA hygiene** — Implementation candidate SHAs are validated for freshness and CI-readiness before handoff; stale candidates are rejected. *`src/oneshot/stage-candidate-guard.ts`, `src/oneshot/branch-hygiene.ts`*

## 10. Jira & Notifications

- **Progress-update notification** — Posted when the implementer claims a run so watchers know work has started. *`src/oneshot/database/notifications.ts`, `src/oneshot/jira-comments.ts`*
- **Notification type catalog** — 18 types including `planning_completed`, `pr_created`, `review_escalated`, `budget_exceeded`, `completed`. *`src/oneshot/types.ts`*
- **Jira comment rendering** — Markdown renderers for result comments, escalation reasoning, and drift notices. *`src/oneshot/jira-comments.ts`, `src/oneshot/renderers.ts`*
- **Branch-drift notification** — Dedicated Jira comment when the target branch head has moved. *`src/oneshot/jira-comments.ts`*
- **TRACE Jira notification** — Reviewer attaches `test-cases-<JIRA_KEY>.csv` after Validate when credentials are available and posts `OneShot | TRACE Test Cases Generated` with Section A/B/C counts and AC coverage. Attachment failures are non-blocking and logged as run events. *`src/oneshot/trace-verify-runner.ts`, `src/oneshot/consumers/reviewer.ts`, `src/oneshot/schema/trace-verify.ts`*
- **Escalation comments** — Detailed reasoning attached to review and code-review escalations. *`src/oneshot/jira-comments.ts`*
- **Optional auto-reassign** — `AUTO_REASSIGN_TICKETS` updates the Jira assignee on claim. *`ORCHESTRATOR_README.md`*
- **Run-event audit trail** — Every state transition, claim, and artifact storage event lands in `oneshot_run_events`. *`src/oneshot/database/events.ts`, `src/oneshot/event-emit.ts`*
- **Redesigned Jira comment rendering** — Result, escalation, PR-state, and drift comments use a consolidated renderer with richer status blocks. *`src/oneshot/renderers.ts`, `src/oneshot/jira-comments.ts`*
- **SNS → Teams alert pipeline** — A dedicated Lambda (`specter-teams-notifier`) subscribes to the `prod-oneshot-alerts` SNS topic and posts CloudWatch alarm adaptive cards to a Teams incoming webhook backed by Secrets Manager. *`terraform/lambda/teams_notifier/index.py`*
- **CloudWatch alarm coverage** — ~40 alarms on queue depth, DLQ depth, stage failure rate, and pipeline latency route into the `prod-oneshot-alerts` SNS topic. *`terraform/oneshot-ecs.tf`*

## 11. Cost Tracking & Telemetry

- **Per-stage token/cost/duration** — Each artifact `metadata_json` captures `stage_tokens_used`, `stage_cost_usd`, `stage_duration_ms`. *`src/oneshot/model-usage.ts`, `src/oneshot/database/artifacts.ts`*
- **Total-spend cap** — `ONESHOT_MAX_TOTAL_TOKENS` (default 2M) halts any run that exceeds its budget. *`src/oneshot/contracts.ts`, `src/oneshot/token-budget.ts`*
- **Provider/model usage metrics** — Provider, model, input/output/cache tokens captured per stage; `stage_tokens_used` stays input + output only while nested token metadata carries cache counters. *`src/oneshot/model-usage.ts`*
- **USD pricing integration** — Costs calculated from provider pricing. *`src/oneshot/pricing.ts`*
- **OpenTelemetry traces** — SDK-emitted traces for latency and error analysis. *`src/oneshot/telemetry/`*
- **SDK observability options** — Streaming observability hooks capture retry overrides, stall error propagation, and model provenance on every agentic call. *`src/claude-sdk/index.ts`, `src/oneshot/providers/claude-planner.ts`*
- **Analytics normalization** — Dashboard analytics normalize string metrics, tokens, costs, and durations before aggregation so provider inconsistencies don't skew rollups. *`dashboard/server/services/oneshot.ts`, `dashboard/src/oneshot/formatters.ts`*
- **Planner model-cost attribution** — Planner artifacts preserve aggregate `stage_cost_usd` while adding `model_cost_usage` for exact Opus main-planner cost and separate Haiku scout/workplan cost, with estimated rows called out when native SDK Agent usage is bundled into one mixed-model result. *`src/oneshot/model-cost-usage.ts`, `src/oneshot/consumers/planner.ts`, `src/oneshot/postmortem.ts`*
- **Per-model cost attribution** — Analytics split tokens and cost by model when the provider reports model usage, surfacing model mix per stage. *`src/oneshot/model-usage.ts`, `dashboard/src/oneshot/Costs.tsx`*
- **Bedrock pricing aliases** — Pricing table includes regional and global Bedrock Claude rates, including Sonnet 5 implementer aliases, with dashboard cost-table metadata so new model IDs cost-track correctly. *`src/oneshot/pricing.ts`, `dashboard/server/services/oneshotCosting.ts`*
- **Postmortem artifacts** — Terminal runs generate a summary artifact with failure context. *`src/oneshot/postmortem.ts`*

## 12. Dashboard & UI

The OneShot dashboard lives under `/oneshot` in the platform UI.

- **Overview + RunsView** — Top-level summary and full runs list. *`dashboard/src/oneshot/Overview.tsx`, `dashboard/src/oneshot/RunsView.tsx`*
- **Pipeline diagram** — Visualizes stage progression and bottlenecks. *`dashboard/src/oneshot/PipelineDiagram.tsx`, `dashboard/src/oneshot/MiniPipeline.tsx`*
- **Run detail modal** — Deep-dive inspection of artifacts, logs, tokens, cost breakdown. *`dashboard/src/oneshot/DetailModal.tsx`*
- **Queue board** — Live view of queued and in-flight runs by stage. *`dashboard/src/oneshot/QueueBoard.tsx`*
- **Failures view** — Triage of failed runs with error summaries and recovery options. *`dashboard/src/oneshot/Failures.tsx`*
- **Throughput analytics** — Success rate, stage duration, pipeline efficiency metrics. *`dashboard/src/oneshot/Throughput.tsx`*
- **Costs analytics** — Per-run and aggregated cost trends. *`dashboard/src/oneshot/Costs.tsx`*
- **Agents view** — Deployment and readiness status of OneShot consumers. *`dashboard/src/oneshot/AgentsView.tsx`*
- **Command palette** — Quick actions: retry, replan, force-approve, terminate. *`dashboard/src/oneshot/CommandPalette.tsx`*
- **Stage panel + status pill** — Reusable components for per-stage status display. *`dashboard/src/oneshot/StagePanel.tsx`, `dashboard/src/oneshot/StatusPill.tsx`*
- **Analytics range control** — Unified time-range selector shared by Throughput and Costs. *`dashboard/src/oneshot/AnalyticsRangeControl.tsx`*
- **Run-control APIs** — Client APIs for retry, CI refresh, and new-run submission. *`dashboard/src/oneshot/newRunApi.ts`, `dashboard/src/oneshot/runRetryApi.ts`, `dashboard/src/oneshot/runCiRefreshApi.ts`*
- **Manual restart age guard** — Guards against manually restarting runs that are older than a safe threshold; dashboard elapsed-duration display is recomputed post-restart. *`dashboard/server/routes/oneshotRunRetries.test.ts`, `dashboard/src/oneshot/formatters.ts`*
- **Dashboard ETag polling + modal stability** — Run-list polling uses ETag conditional GETs and the detail modal is stable across polling refreshes. *`dashboard/server/routes/oneshotRunRequests.ts`, `dashboard/src/oneshot/DetailModal.tsx`*
- **Shared-element run detail transition** — Clicking a run card transitions into a shared-element modal with a hero header and error-summarization block. *`dashboard/src/oneshot/DetailModal.tsx`*
- **Liquid-glass visual system** — The OneShot page uses a glass-rail sidebar, an elevation system, and a lucide-icon palette for consistent visual language. *`dashboard/src/oneshot/liquid-glass.css`, `dashboard/src/oneshot/sidebar-shell.css`, `dashboard/src/oneshot/icons.tsx`*
- **Repo router UI** — A dashboard surface for viewing and editing the repo-route cards that drive repository resolution. *`dashboard/src/oneshot/repoRouterApi.ts`, `dashboard/server/routes/repoRouter.ts`*
- **Watchdog investigation dashboard** — A sibling dashboard (Watchdog) investigates production incidents, drafts DARCI-ready scopes, and cross-links into the OneShot view. *`dashboard/server/routes/watchdog.ts`*
- **Run-auth layer** — Dashboard run controls (retry, terminate, deploy) go through a dedicated auth layer. *`dashboard/server/routes/oneshotRunAuth.ts`*
- **Run-termination endpoint** — Operators can terminate in-flight runs with a recorded reason from the dashboard. *`dashboard/server/routes/oneshotRunTerminations.ts`, `dashboard/server/services/oneshotRunTerminations.ts`*

## 13. Preview Deploy

- **Deployments table** — `oneshot_deployments` tracks build/deploy lifecycle per run. *`src/oneshot/types.ts`, `dashboard/server/routes/oneshotDeployments.ts`*
- **GitHub Actions workflow-dispatch** — Triggers a GitHub Actions workflow to build an ECR image and deploy to ECS. *`dashboard/server/routes/oneshotDeployments.ts`, `dashboard/server/routes/oneshotDeployRequests.ts`*
- **Slot-based deploys** — Deploys to named slots (e.g. `core-app-preview`) with approval gates. *`docs/ONESHOT_PREVIEW_RUNBOOK.md`*
- **Deploy state machine** — `requested → awaiting_approval → building → pushing → deploying → active / failed / superseded`. *`src/oneshot/types.ts`*
- **Preview URL generation** — Generates a shareable URL once a preview deploy is active. *`src/oneshot/types.ts`*
- **Workflow callback** — Endpoint receives GitHub Actions callbacks and updates deployment status. *`dashboard/server/routes/oneshotDeployments.ts`*
- **Deploy auth** — Dedicated authentication/authorization layer for deploy endpoints. *`dashboard/server/routes/deployAuth.ts`*
- **Deploy control-plane foundation** — Separate deploy-request endpoint and state machine from run mutation, so deploys can be gated without gating the rest of the dashboard. *`dashboard/server/routes/oneshotDeployRequests.ts`*
- **Manual core-app deploy workflow** — GitHub Actions workflow-dispatch entry for manually deploying core-app images outside the preview slot flow. *`terraform/oneshot-ecs.tf`*
- **Watchdog** — Monitors deploy health and flags stuck or unhealthy deploys. *`dashboard/server/routes/watchdog.ts`*

## 14. Providers & Models

- **Claude via Bedrock (Planner / Implementer / Qualifier)** — All generative stages run Claude through AWS Bedrock. *`src/oneshot/providers/claude-planner.ts`, `src/oneshot/providers/claude-implementer.ts`*
- **OpenAI Responses API (Reviewer / Code Reviewer)** — Both review stages run on OpenAI. *`src/oneshot/providers/openai-reviewer.ts`, `src/oneshot/providers/openai-code-reviewer.ts`*
- **Pluggable reviewer provider** — Reviewer provider is abstracted so Claude or OpenAI can back the reviewer stage. *`src/oneshot/providers/reviewer-provider.ts`*
- **Per-stage model overrides** — `ONESHOT_PLANNER_MODEL_ID`, `ONESHOT_IMPLEMENTER_MODEL_ID`, `ONESHOT_REVIEWER_MODEL_ID`, and peers. *`src/oneshot/contracts.ts`*
- **Per-stage max-output-token limits** — `ONESHOT_PLANNER_MAX_OUTPUT_TOKENS`, etc. *`src/oneshot/contracts.ts`*
- **Per-stage thinking-token budgets** — `ONESHOT_PLANNER_MAX_THINKING_TOKENS`, etc. *`src/oneshot/contracts.ts`*
- **Planner scouts** — Optional LLM-generated scout workplan plus bounded read-only harness scout pass for cheaper context gathering. *`src/oneshot/providers/scout-workplan.ts`, `src/oneshot/providers/planner-scouts.ts`*

## 15. Prompt Management

- **Externalized prompts** — All stage prompts live under `oneshot-prompts/prompts/` as markdown. *`oneshot-prompts/prompts/`*
- **S3 or local prompt loader** — `ONESHOT_PROMPT_SOURCE` selects between S3 (prod) and local filesystem (dev). *`src/oneshot/prompt-loader.ts`*
- **Prompt composer** — Assembles base prompt + stage-specific guardrails + conditional healthcare guardrails. *`src/oneshot/prompt-composer.ts`*
- **Retrofit workflow fragment** — Required `retrofit-workflow` prompt fragment is injected into Planner, Plan Review / Validate, Implementer, and Code Review whenever retrofit context is present so source-commit proof rules stay consistent across stages. Validate and Code Review also receive qualification source evidence when a draft plan is missing its own retrofit evidence. Startup validation fails closed if the fragment or required insertion placeholders are missing. *`oneshot-prompts/prompts/retrofit-workflow.md`, `src/oneshot/retrofit-workflow.ts`, `src/oneshot/runtime-validation.ts`*
- **Stage-specific guardrail composition** — Plan, review-plan, review-code, build, and healthcare guardrails are layered per stage. *`oneshot-prompts/guardrails/`*
- **Prompt-metadata capture** — Guardrail asset list and healthcare flag are stored in each artifact's metadata. *`src/oneshot/prompt-composer.ts`*
- **Prompt types** — Typed interfaces for prompt assembly inputs and outputs. *`src/oneshot/prompt-types.ts`*

## 16. Error Handling & Recovery

- **Safe JSON parsing** — Failures log the S3 key, byte count, and content preview for diagnosis. *`src/oneshot/errors.ts`*
- **Circuit breakers** — 80-min agent timeout, 24-hr run age, token budget, review/verification loop limits, stage attempt limits. *`src/oneshot/contracts.ts`, `src/oneshot/state-transitions.ts`*
- **DLQ management** — `maxReceiveCount=3`, 14-day retention, CloudWatch alarms on DLQ depth. *`src/oneshot/contracts.ts`, `terraform/oneshot-ecs.tf`*
- **Operator run termination** — Runs can be killed with a recorded reason. *`src/oneshot/service.ts`, `dashboard/server/routes/oneshotRunTerminations.ts`*
- **Postmortem artifacts** — Terminal runs emit a summary artifact with failure context. *`src/oneshot/postmortem.ts`*
- **Retry classifier** — Categorizes transient vs permanent failures to avoid pointless retries. *`src/oneshot/retry-classifier.ts`*
- **Plan-contract auto-replan** — Off-contract implementation diffs stay blocked from promotion, but bounded same-run replanning can repair incomplete `fileChangeContract` scope before the run parks. *`src/oneshot/consumers/implementer.ts`, `src/oneshot/consumers/planner.ts`, `src/oneshot/tools/recover-plan-contract-violation.ts`*
- **Stale-run republish** — Runs stuck in-flight for 10+ minutes are republished to their stage queue. *`src/oneshot/service.ts`*

## 17. Repository Intelligence

- **Tech stack detection** — Identifies primary language, build tool (Maven / Gradle / npm / yarn / pip), test framework. *`src/oneshot/repo-scanner.ts`*
- **Project structure analysis** — Root files, top-level directories, file count, top-10 extensions. *`src/oneshot/repo-scanner.ts`*
- **Key file identification** — Detects build configs, entry points, env templates, routes, schema / migrations. *`src/oneshot/repo-scanner.ts`*
- **Cached repo profiles** — Repo metadata is cached for fast lookup during planning. *`src/oneshot/repo-metadata.ts`*
- **Repo router** — Routes tickets to target repositories based on route cards + rules. *`src/oneshot/repo-router/`, `src/oneshot/repo-route-cards.ts`*

## 18. Persistence

- **Runs table** — `oneshot_runs` holds the core run entity (state, versions, PR URL, token usage). *`src/oneshot/database/runs.ts`*
- **Branch-aware active-run uniqueness** — Non-terminal duplicate-run protection is scoped by Jira key, repo, and target branch so multi-branch retrofit fan-out can create same-repo child runs without allowing same-branch duplicates. *`db/migrations/050_oneshot_branch_scoped_active_run_key.sql`, `db/schema.sql`*
- **Run-events table** — `oneshot_run_events` is the audit trail for every transition, claim, and artifact storage. *`src/oneshot/database/events.ts`*
- **Artifacts table** — Stages, versions, S3 pointers, provider/model, cost metadata. *`src/oneshot/database/artifacts.ts`*
- **Notifications table** — Pending / posted Jira notifications with markdown body and error tracking. *`src/oneshot/database/notifications.ts`*
- **Run groups table** — Correlates related runs into groups. *`src/oneshot/database/run-groups.ts`*
- **Workspace leases** — Prevents concurrent mutation of the same workspace. *`src/oneshot/database/workspace-leases.ts`*
- **Workspace state** — Per-stage sidecar files (repo-scan.json, prior reviews, etc.). *`src/oneshot/database/workspace-state.ts`*
- **Candidate versions** — Tracks per-stage candidate artifact versions for guarded handoff. *`src/oneshot/database/candidate-versions.ts`*
- **Workspace artifacts** — Links between workspace state and persisted artifacts. *`src/oneshot/workspace-artifacts.ts`*
- **Run-event sort indexes** — Dedicated DB indexes on `oneshot_run_events` so dashboard event streams and audit queries scan efficiently at scale. *`db/migrations/017_oneshot_run_event_sort_indexes.sql`*
- **Runs `updated_at` order index** — Index on `oneshot_runs` to support the dashboard's recently-updated ordering without full scans. *`db/migrations/019_oneshot_runs_updated_order_index.sql`*

## 19. Local Development

- **Podman-based local cluster** — MySQL + Moto (S3/SQS) + Dashboard + six OneShot consumers. *`local-oneshot/README.md`, `local-oneshot/docker-compose.yml`*
- **Setup script** — `scripts/local-oneshot-cluster.sh` abstracts setup and teardown. *`scripts/local-oneshot-cluster.sh`*
- **Bedrock vs Moto credential isolation** — Separate credential paths for real Bedrock and local fake AWS. *`local-oneshot/README.md`*
- **Orchestrator-optional mode** — Can run without the orchestrator (Jira polling) for focused stage testing. *`local-oneshot/README.md`*
- **Per-consumer health endpoints** — `/ready` and `/health` on every consumer for readiness and liveness. *`src/oneshot/health-server.ts`*
- **E2E harness** — End-to-end fixtures and helpers for local pipeline runs. *`src/oneshot/e2e/`*
- **CPDEV local smoke runner** — `scripts/run-cpdev-local-smoke.mjs` drives an end-to-end local pipeline run against a real CPDEV ticket for validation. *`scripts/run-cpdev-local-smoke.mjs`, `scripts/run-cpdev-local-smoke.test.ts`*
- **Maven smoke preflight** — `scripts/maven-smoke-preflight.mjs` validates Maven + Artifactory wiring before a smoke run attempts a real build. *`scripts/maven-smoke-preflight.mjs`*
- **ECS plan verifier** — `scripts/verify-oneshot-ecs-plan.mjs` dry-runs the Terraform plan and asserts expected OneShot ECS changes before apply. *`scripts/verify-oneshot-ecs-plan.mjs`*
- **Prompt publisher** — `scripts/publish-oneshot-prompts.sh` syncs `oneshot-prompts/` to S3 for the prod prompt loader. *`scripts/publish-oneshot-prompts.sh`*

## 20. Infrastructure & Deployment

- **Terraform ECS services** — Six ECS services (Qualifier worker + five OneShot consumers on a shared image). *`terraform/oneshot-ecs.tf`*
- **Dockerfile.oneshot** — Multi-stage build with Maven, Node, git, Claude Code CLI, and Bedrock env vars. *`Dockerfile.oneshot`*
- **Dedicated CloudWatch log group per role** — Separate log groups simplify log searching by stage. *`docs/ONESHOT_RUNBOOK.md`*
- **Secrets Manager-backed tokens** — GitHub tokens and OpenAI API key stored in AWS Secrets Manager. *`terraform/oneshot-ecs.tf`*
- **ALB front door** — Application Load Balancer fronts the dashboard. *`terraform/oneshot-ecs.tf`*

## 21. Environment variable quick reference

Full list lives in [`ONESHOT_RUNBOOK.md`](./ONESHOT_RUNBOOK.md) — common ones:

| Variable | Purpose |
| --- | --- |
| `ONESHOT_MAX_REVIEW_LOOPS` | Plan-revision cycle cap (default 3) |
| `ONESHOT_MAX_VERIFICATION_LOOPS` | Code-review + test retry cap (default 3) |
| `ONESHOT_MAX_STAGE_ATTEMPTS` | Retries per stage before failing (default 5) |
| `ONESHOT_MAX_TOTAL_TOKENS` | Total-spend token cap per run (default 2M) |
| `ONESHOT_MAX_STAGE_TOKENS_IMPLEMENTATION` | Per-stage token cap for implementer |
| `ONESHOT_TRACE_ENABLED` | Enable post-Validate TRACE test-case generation |
| `ONESHOT_DOCS_SYNTHESIS_ENABLED` | Enable LLM documentation synthesis (staged rollout, default off); synthesized docs are structurally validated and fail to `DOCS-BLOCKED` on any validation or synthesis error |
| `ONESHOT_TRACE_POST_TO_JIRA` | Attach/comment TRACE CSV back to Jira |
| `ONESHOT_IMPLEMENTATION_PLAN_POST_TO_JIRA` | Attach the reviewed plan to Jira and post a compact handoff comment when implementation is queued |
| `ONESHOT_VERIFY_ENABLED` | Enable advisory VERIFY review of TRACE output |
| `ONESHOT_VERIFY_MODE` | VERIFY scoring profile: `balanced`, `strict`, or `lenient` |
| `ONESHOT_HEALTHCARE_GUARDRAILS` | Enable HIPAA / FHIR / PHI guardrails |
| `ONESHOT_PLANNER_SCOUT_ENABLED` | Kill switch for the default-on planner scout workplan and harness scout pass |
| `ONESHOT_PLANNER_SKILLS_ENABLED` | Gate planner Claude plugin Skills (default true) |
| `ONESHOT_PLANNER_SUBAGENTS_ENABLED` | Gate planner SDK-native subagents (default true) |
| `ONESHOT_PLANNER_SUBAGENT_MAX_TURNS` | Max turns for each planner SDK-native subagent (default 16) |
| `ONESHOT_PLANNER_PLUGIN_PATH` | Local planner Claude plugin path |
| `ONESHOT_PLANNER_SCOUT_MODEL_ID` | Planner scout/workplan/subagent model override (default Haiku 4.5 on Bedrock) |
| `ONESHOT_RETROFIT_REPO_CACHE_LEASE_WAIT_MS` | Repo-cache lease wait override for retrofit planning when an additional source branch must be fetched (default 300000ms) |
| `ONESHOT_PROMPT_SOURCE` | `s3` (prod) or local filesystem (dev) |
| `ONESHOT_PLANNER_MODEL_ID` | Planner model override |
| `ONESHOT_IMPLEMENTER_MODEL_ID` | Implementer model override |
| `ONESHOT_REVIEWER_MODEL_ID` | Reviewer model override |
| `ONESHOT_CODE_REVIEWER_MODEL_ID` | Code reviewer model override |
| `ONESHOT_STATISTICS_LLM_MODEL_ID` | Statistics tab LLM model override |
| `ONESHOT_PLANNER_MAX_OUTPUT_TOKENS` | Planner max output tokens |
| `ONESHOT_PLANNER_MAX_THINKING_TOKENS` | Planner extended-thinking budget |
| `AUTO_REASSIGN_TICKETS` | Auto-update Jira assignee on claim |

## 22. Changelog

Each entry is a merged PR from `main`, listed in reverse-chronological order with its exact merge date. `#NN` is the PR number in GitHub.

| Date | PR | Title |
| --- | --- | --- |
| 2026-06-29 | CPDEV-25333 | Wire retrofit patch-first lane (mechanical apply, already-applied no-action, adaptation LLM, coverage/scope gates, per-commit traceability) |
| 2026-06-11 | `local` | Teach QUALIFIER multi-repo decision policy |
| 2026-05-13 | `49100f3` | Fix repo confirmation operator auth |
| 2026-05-13 | #153 | Enable OneShot BI Datamart routing |
| 2026-05-13 | #152 | Raise OneShot planner schema text limits |
| 2026-05-13 | #151 | Rm/oneshot about immersive |
| 2026-05-11 | #150 | Enable OneShot description repo directives |
| 2026-05-11 | #149 | Codex/deterministic retrofit qualification |
| 2026-05-11 | #148 | Codex/fix explicit repo retrofit qualification |
| 2026-05-08 | #147 | CPDEV-21321: Auto-trigger RIFT on Jira label with mandatory context fetch |
| 2026-05-08 | #146 | Codex/costs dashboard cleanup |
| 2026-05-08 | #145 | Clean up OneShot Costs dashboard |
| 2026-05-08 | #144 | Codex/manual restart age guard |
| 2026-05-08 | #143 | Add planner grounding repair |
| 2026-05-07 | #142 | Fix OneShot dashboard run list query |
| 2026-05-07 | #141 | Add OneShot run control APIs |
| 2026-05-07 | #140 | Codex/OneShot workspace v2 readiness |
| 2026-05-06 | #137 | Fix OneShot scout telemetry and event indexes |
| 2026-05-06 | #135 | Poll upstream build every 30s instead of 3s |
| 2026-05-06 | #134 | Delegate core-app build to cp-medhok-monorepo pipeline |
| 2026-05-06 | #133 | Drop Maven cache from manual core-app deploy workflow |
| 2026-05-06 | #132 | Add manual core-app deploy workflow |
| 2026-05-05 | #131 | Fix OneShot model binding and branch hygiene |
| 2026-05-05 | #130 | Codex/candidate SHA hygiene + CI cost |
| 2026-05-04 | #129 | Improve OneShot model and cost visibility |
| 2026-05-04 | #128 | [codex] Fix OneShot Maven test environment parity |
| 2026-05-04 | #127 | Harden OneShot revision flow and planner grounding guidance |
| 2026-05-03 | #126 | Align OneShot reviewer models and budgets |
| 2026-05-03 | #125 | Harden OneShot planner reliability and SDK observability |
| 2026-05-01 | #124 | Codex/fork-resume Build revisions |
| 2026-05-01 | #123 | Enhance Watchdog preview and findings |
| 2026-05-01 | #122 | Improve Watchdog masthead and natural language preview |
| 2026-05-01 | #121 | feat(oneshot): harden autonomous readiness gates |
| 2026-04-30 | #117 | Fix OneShot planner validation recovery |
| 2026-04-30 | #116 | Improve OneShot planner reliability and dashboard fidelity |
| 2026-04-30 | #115 | Restore Watchdog intake for historical sessions |
| 2026-04-30 | #114 | Add Watchdog marketing page |
| 2026-04-30 | #113 | Fix OneShot retry cost accounting |
| 2026-04-30 | #111 | Allow Watchdog without Cognito auth |
| 2026-04-30 | #110 | Add Watchdog investigation dashboard and ECS deployment |
| 2026-04-30 | #109 | Harden qualifier repo routing and stage budgets |
| 2026-04-29 | #108 | Implement RepoRouter qualifier routing |
| 2026-04-28 | #103 | Enable OneShot validate review model reporting |
| 2026-04-28 | #102 | Fix OneShot planner and qualifier evidence handling |
| 2026-04-28 | #101 | Add local OneShot cluster setup |
| 2026-04-28 | #100 | Fix Claude SDK executable resolution for OneShot |
| 2026-04-28 | #99 | Fix OneShot dashboard metric collations |
| 2026-04-28 | #98 | Enable OneShot planner scouts |
| 2026-04-28 | #96 | Fix OneShot planner grounding and budgets |
| 2026-04-27 | #95 | Improve remote OneShot planner grounding |
| 2026-04-27 | #94 | Codex/structured qualifier outcomes |
| 2026-04-24 | #92 | Codex/OneShot planner Opus/Sonnet |
| 2026-04-24 | #89 | Codex/review uncommitted OneShot dashboard |
| 2026-04-24 | #88 | Codex/OneShot dashboard review |
| 2026-04-23 | #80 | Stop requeuing not-qualified PFOS tickets |
| 2026-04-21 | #79 | Tighten stateless OpenAI reviewer follow-ups |
| 2026-04-21 | #78 | Implement stateless OpenAI reviewer continuations |
| 2026-04-21 | #77 | Narrow TF blast radius: scope comment/dashboard env vars to qualifier only |
| 2026-04-21 | #76 | Redesign OneShot Jira comments and dashboard PR state |
| 2026-04-21 | #74 | Fix OneShot tester failures and dashboard cost accuracy |
| 2026-04-20 | #72 | Add OneShot analytics dashboard tabs |
| 2026-04-20 | #71 | feat(oneshot): rework DetailModal hero and failure surface |
| 2026-04-20 | #70 | Harden OneShot tester command resolution |
| 2026-04-20 | #68 | Codex OneShot stale-run termination (follow-up) |
| 2026-04-20 | #66 | Codex OneShot stale-run termination |
| 2026-04-19 | #65 | Upgrade OneShot dashboard backend and UI |
| 2026-04-19 | #64 | fix: audit findings — SDK bookkeeping, credential scoping, dead options, deploy-ready semantics |
| 2026-04-18 | #63 | fix(claude-sdk): real tools cap, precedence, bash dedup, repo IDs, hook cleanup |
| 2026-04-18 | #62 | fix(oneshot): system-prompt slot + mandatory exploration + schema-on retry |
| 2026-04-17 | #61 | fix(oneshot): drop planner output schema on attempt 1 |
| 2026-04-17 | #60 | fix(oneshot): remove Bash from planner allowedTools |
| 2026-04-17 | #59 | fix(dashboard): OneShot bug fixes — modal stability, ETag polling, error summarization |
| 2026-04-17 | #58 | feat(oneshot): SDK observability + idle watchdog + progressive retry for planner stalls |
| 2026-04-17 | #57 | feat(dashboard): OneShot phase 1 visual overhaul |
| 2026-04-17 | #55 | Fix S3 VPC endpoint + route oneshot alerts to Teams channel |
| 2026-04-17 | #54 | Default `bedrock_allow_sonnet_4_6` to true to match live fleet |
| 2026-04-17 | #53 | Harden OneShot pipeline: correctness, safety, cost, observability |
| 2026-04-17 | `e28f30b` | Route oneshot SNS alerts into a Microsoft Teams channel |
| 2026-04-16 | #52 | Fix worker repository path resolution |
| 2026-04-16 | #51 | Fix qualifier startup validation and enable OneShot OTEL |
| 2026-04-16 | #48 | diag(oneshot): log raw planner SDK output on Zod failure |
| 2026-04-16 | #47 | Fix OneShot schema validation aliases |
| 2026-04-16 | #44 | Improve OneShot startup diagnostics |
| 2026-04-16 | #43 | Stabilize OneShot workspaces and agent SDK loops |
| 2026-04-15 | #42 | fix: reuse OneShot workspaces across retries |
| 2026-04-15 | #41 | refactor: simplify OneShot stage contracts |
| 2026-04-15 | #40 | fix: harden OneShot structured output parsing |
| 2026-04-15 | #39 | fix: repair OneShot planner JSON parsing |
| 2026-04-15 | #35 | infra: allow OneShot code review and tester queues |
| 2026-04-15 | #32 | fix: harden OneShot workspace preparation |
| 2026-04-15 | #31 | Add code reviewer and tester stages to OneShot pipeline |

---

## 23. Where to go next

- **Operations** — [`ONESHOT_RUNBOOK.md`](./ONESHOT_RUNBOOK.md)
- **Preview deploys** — [`ONESHOT_PREVIEW_RUNBOOK.md`](./ONESHOT_PREVIEW_RUNBOOK.md)
- **Local setup** — [`../local-oneshot/README.md`](../local-oneshot/README.md)
- **Orchestrator** — [`../ORCHESTRATOR_README.md`](../ORCHESTRATOR_README.md)
- **Platform overview** — [`../SPECTER_OVERVIEW.md`](../SPECTER_OVERVIEW.md)
