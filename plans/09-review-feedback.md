# Review Feedback (Round 2 + Decisions): Plan 09 — One-Shotting Feature Delivery Pipeline

**Reviewer**: Claude (Opus 4.6)  
**Date**: 2026-04-12  
**Status**: Round 2 review with owner decisions on all four blocking items  
**Verdict**: All blocking items have decisions. Update the plan with the directives below, then Phase 0 is ready to freeze.

---

## What improved since Round 1

All ten items from the first review were substantively addressed:

| Round 1 Item | Resolution | Quality |
|---|---|---|
| Codex/OpenAI for all agents | Narrowed to REVIEWER only; QUALIFIER/PLANNER/IMPLEMENTER back on Bedrock/Claude | Good compromise |
| 7 tables | Collapsed to 3 (`oneshot_runs`, `oneshot_artifacts`, `oneshot_notifications`) | Adopted exactly as proposed |
| Outbox in v1 | Deferred to Phase 7; reconciliation query added | Clean |
| 5 SQS queues | Reduced to 3; revision through planning queue; no completion queue | Clean |
| `approved_with_review_debt` | Replaced with `escalated` + `PFOS-FORCE-APPROVE` human override | Well-designed |
| 16 states | Trimmed to 14; qualification states removed; `queued_for_*` kept for recovery | Justified |
| Missing revision context | Full contract added with JSON schema and loader description | Complete |
| Missing failure recovery | Per-stage retry sections added; implementer branch logic is concrete | Good |
| Missing cost model | Section added with rough estimates and per-run ceiling concept | Directionally right |
| Missing workspace cleanup | Section added with rules per terminal state, assigned to Phase 6 | Adequate |

The plan is substantially better. The core architecture was already sound; the v1 scope is now well-controlled and the contracts are mostly complete.

---

## Round 2 blocking items — all four now have owner decisions

### 1. REVIEWER needs codebase access — design the integration accordingly

**Decision (owner):** REVIEWER needs read access to the codebase. It must be able to read the plan AND compare it against actual code to verify file references, assess change feasibility, and catch plan/code mismatches.

**What this means for the plan:**

The Codex/OpenAI justification should be rewritten around the real argument: model diversity in the review stage reduces blind spots because the reviewer should not share the same training distribution and failure modes as the planner. Drop "the request explicitly called for" — that is provenance, not a design rationale.

The REVIEWER integration is now significantly more complex than a document-only API call. The plan must add a REVIEWER integration subsection specifying:

- **SDK**: OpenAI SDK or Codex SDK — pick one.
- **Auth**: OpenAI API key in Secrets Manager, injected into the ECS task via environment variable or task role secret.
- **Codebase access pattern**: The REVIEWER consumer runs on ECS with access to EFS. It can read repo files locally. The integration has two viable shapes:
  - **Context injection**: The consumer reads the plan artifact, identifies referenced files, reads them from EFS, and sends the plan + relevant file contents together in one prompt. Simpler, no tool-use loop needed, but context window is the constraint.
  - **Tool-use loop**: The consumer provides read-only tools (file read, grep, glob) to the OpenAI model and lets it explore the codebase interactively while reviewing. More powerful, but requires building a tool-use loop against the OpenAI SDK — a parallel to `runAgent()` but for a different provider.
  - Recommendation for v1: context injection. It is sufficient for plan review (the plan already lists impacted files and proposed changes). Tool-use can be a v2 enhancement if reviews need deeper exploration.
- **Error handling**: Retry with exponential backoff on rate limits and timeouts. Fail the review (not the run) on persistent errors so the operator can re-trigger.
- **Wrapper location**: `src/oneshot/providers/openai-reviewer.ts` — isolated from the Claude SDK layer.

**Action required:** Rewrite the REVIEWER section with the model-diversity justification and the integration design above. Recommend context injection for v1 with tool-use as a v2 option.

---

### 2. QUALIFIER has two explicit modes — document both

**Decision (owner):** Keep force-approve in QUALIFIER. Document both modes explicitly with separate preconditions and postconditions.

**What the plan should add:**

#### QUALIFIER Mode 1: Fresh qualification (normal path)

Preconditions:
- Ticket has `PFOS` label
- No active `oneshot_runs` row exists for this `jira_key`

Behavior:
1. Resolve exactly one repo and branch
2. Capture `base_commit_sha`
3. Assess requirement completeness
4. If qualified: create `oneshot_runs` row (state = `queued_for_planning`), send planning message to SQS
5. If not qualified: complete on `task_management` with failure comment, no `oneshot_runs` row created

Postcondition: Either a new `oneshot_runs` row exists in `queued_for_planning`, or the qualification failure is posted to Jira.

#### QUALIFIER Mode 2: Force-approve re-entry (escalation override)

Preconditions:
- Ticket has both `PFOS` and `PFOS-FORCE-APPROVE` labels
- An `oneshot_runs` row exists for this `jira_key` in state `escalated`

Behavior:
1. Look up the existing `escalated` run
2. Re-check `base_commit_sha` against current remote branch head
3. If base has drifted: transition run to `replan_required`, notify Jira, stop (do NOT force into implementation on stale code)
4. If base is still current: transition run from `escalated` to `approved`, then to `queued_for_implementation`, send implementation message to SQS
5. Complete on `task_management` with a comment noting the force-approve

Postcondition: The existing run is either in `queued_for_implementation` (base still valid) or `replan_required` (base drifted).

#### Mode selection logic

The QUALIFIER should determine mode at the top of its `process()` method:
1. Query `oneshot_runs` for an active run matching `jira_key`
2. If no active run exists → Mode 1
3. If an active run exists in state `escalated` AND ticket has `PFOS-FORCE-APPROVE` label → Mode 2
4. If an active run exists in any other state → skip (run is already in progress), complete with informational comment

This branching must be the first thing QUALIFIER does, before any LLM invocation.

**Action required:** Add the two-mode contract to the QUALIFIER section with the preconditions, behaviors, and postconditions above.

---

### 3. Worker creates the draft PR via GitHub REST API

**Decision (owner):** The worker (not the LLM) creates the draft PR. The existing `GITHUB_REPO_TOKEN` already has write scope.

**What the plan should add to the IMPLEMENTER section:**

PR creation mechanism:
- The LLM's job is: create the implementation branch, edit files, run tests, commit, push.
- After the LLM loop completes, the IMPLEMENTER worker code creates the draft PR via the GitHub REST API (`POST /repos/{owner}/{repo}/pulls` with `draft: true`).
- Auth: the existing shared `GITHUB_REPO_TOKEN` (already has write scope).
- PR title and body are constructed deterministically by the worker from the plan artifact (ticket summary, scope, changed files list) — not generated by the LLM.
- The worker records the PR URL in the `oneshot_artifacts` metadata (`metadata_json.pr_url`) and on `oneshot_runs.current_pr_url`.

This separation means:
- PR creation is testable without invoking an LLM
- Retry after PR-creation failure does not re-run the entire implementation
- PR metadata quality is consistent and predictable

**Action required:** Add a "PR creation" subsection to the IMPLEMENTER section with the above.

---

### 4. Artifact retry uses upsert

**Decision (owner):** Upsert (`INSERT ... ON DUPLICATE KEY UPDATE`).

**What the plan should change:**

In both the planner and reviewer failure recovery sections, replace "overwrite it or replace its DB row atomically" with:

> On retry, if an artifact row already exists for `(oneshot_run_id, stage, version)`, upsert it using `INSERT ... ON DUPLICATE KEY UPDATE`. The S3 key is deterministic (`oneshot/<jira-key>/<stage>/v<version>/`), so S3 content is overwritten at the same key. This produces a single atomic operation per retry.

Apply the same semantic to the implementer recovery section.

**Action required:** Update all three failure recovery subsections to specify upsert explicitly.

---

## Round 2 feedback — resolve before Phase 1 implementation begins

These items are not blocking the contract freeze but will create problems during implementation if deferred further.

### 5. Add SQS dead-letter queue and redrive policy

**Where**: SQS design section

The plan specifies three FIFO queues but says nothing about what happens when a consumer repeatedly fails to process a message. Without a redrive policy:

- FIFO queues will keep retrying the message, blocking the message group (`messageGroupId = run_id`) until `maxReceiveCount` is hit
- Default SQS behavior varies; the plan should be explicit

**Recommendation:**
- Set `maxReceiveCount = 3` per queue
- Create one DLQ per queue (e.g., `oneshot-planning-dlq.fifo`)
- Add DLQ depth monitoring to Phase 6 scope
- Operator runbook: when a message lands in DLQ, inspect the `oneshot_runs` row, fix the issue, use reconciliation to re-queue

This is a few lines of Terraform. Add it to the SQS design section now so it is not forgotten during Phase 1 infrastructure setup.

**Action required:** Add DLQ and redrive policy to the SQS design section. Add DLQ monitoring to Phase 6 scope.

---

### 6. Specify the reconciliation runtime

**Where**: "Why there is no v1 outbox" section and service boundaries

The plan defines `src/oneshot/reconciliation.ts` and shows the SQL query, but does not specify who runs it or when:

- Cron job? (simplest but requires a scheduler)
- Orchestrator secondary loop? (consistent with the notification poster pattern — the orchestrator already gains a `OneShotNotificationPoster` loop)
- Manual operator command? (lowest risk but depends on humans noticing)

**Recommendation:** Orchestrator secondary loop, same pattern as `OneShotNotificationPoster`. The orchestrator is already deployed and monitored. Adding a reconciliation check every 5 minutes to the same process is operationally trivial. This is also consistent — both the notification poster and the reconciliation loop are "check DB, take action" patterns.

**Action required:** State the runtime for reconciliation (recommended: orchestrator loop). Add it to the service boundaries section.

---

### 7. Specify the IMPLEMENTER tool permission set

**Where**: IMPLEMENTER section

The plan says Bedrock/Claude but does not specify which tool permission set the IMPLEMENTER needs. Looking at `src/claude-sdk/config.ts`:

- `code_exploration` (Read, Glob, Grep) — insufficient, cannot edit files
- `read_only` (+ Bash) — insufficient, cannot edit files
- `analysis` (+ Task, TodoWrite) — insufficient, cannot edit files
- `patch_proposal` (+ Edit, Write) — minimum viable set
- `full_autonomy` — too broad

The IMPLEMENTER needs at minimum `patch_proposal`: Read + Glob + Grep + Edit + Write + Bash + BashOutput. It needs Bash for git operations (create branch, commit, push) and running tests. It needs Edit/Write for code changes.

This is also worth calling out as a trust boundary shift: no current Specter agent writes to repositories in production. Every agent today is read-only or analysis-only against the codebase. The IMPLEMENTER is the first agent with write-to-repo capability. That is an intentional and correct design decision for OneShot, but it should be acknowledged explicitly because it changes the blast radius of a misbehaving agent.

**Action required:** State the tool permission set (`patch_proposal` or a new OneShot-specific set). Add a one-line note acknowledging that this is the first write-to-repo agent and that draft-PR-only is the trust boundary.

---

### 8. Set a concrete default for the per-run cost ceiling

**Where**: Cost model section, line 718

The plan says "add a per-run token and/or cost ceiling" but does not propose a default. For Phase 0 contract freeze, the exact number is less important than having a number that can be tuned:

**Recommendation:**
- Add `max_total_tokens` column to `oneshot_runs` (default: 2,000,000)
- Add `total_tokens_used` column to `oneshot_runs` (updated after each stage)
- Each consumer checks `total_tokens_used < max_total_tokens` before invoking the LLM
- If exceeded: set state to `failed` with `last_error = 'token_budget_exceeded'`, write notification
- The default can be overridden per-agent in the `agents` table or per-run at qualification time

2M tokens is a rough starting point: ~500K per stage x 4 stages in a simple run, with headroom for 2-3 review loops. Adjust after the first few real runs.

**Action required:** Propose a default ceiling value. Specify the columns and check mechanism. This does not need to be perfect — it needs to exist so the first real run does not burn an unbounded budget.

---

## Summary

| # | Item | Status | Decision |
|---|------|--------|----------|
| 1 | Codex integration design | **Decided** | REVIEWER needs codebase read access; use context injection for v1; document model-diversity rationale |
| 2 | Force-approve mechanism | **Decided** | Keep in QUALIFIER; document two explicit modes with preconditions/postconditions |
| 3 | PR creation mechanism | **Decided** | Worker creates draft PR via GitHub REST API; existing token has write scope |
| 4 | Artifact retry semantic | **Decided** | Upsert (`INSERT ... ON DUPLICATE KEY UPDATE`) |
| 5 | SQS DLQ + redrive policy | Should fix | Before Phase 1 infra |
| 6 | Reconciliation runtime | Should fix | Before Phase 6 deploy |
| 7 | IMPLEMENTER tool permission set | Should fix | Before Phase 5 |
| 8 | Concrete cost ceiling default | Should fix | Before Phase 1 schema |

All four blocking items now have owner decisions. Update the plan with the directives above, then Phase 0 is ready to freeze. Items 5-8 should be resolved during the phase they affect.

---

## What is good and should not change

Everything that was good in Round 1 remains good, plus the revisions strengthened several areas:

- **Three-table schema** — clean, queryable, minimal
- **Three FIFO queues with revision through planning queue** — clean routing
- **`escalated` state with human override path** — correct trust model
- **14-state machine with recovery states documented** — justified and implementable
- **Revision context contract** — complete, the PLANNER now has a clear interface for revision runs
- **Per-stage failure recovery** — concrete, especially the implementer branch-exists logic
- **Reconciliation over outbox for v1** — pragmatic and adequate at low volume
- **Workspace/branch cleanup rules** — acknowledged and scoped
- **Phase 7 as documented v2 scope** — clear boundary between v1 and hardening work

The plan is close. Four decisions to make, then Phase 0 is ready to freeze.
