# Claude SDK hardening (v2) — post-main-merge scope

Date: 2026-04-17 (v1) / 2026-04-18 (v2 revision after rebase on main)
Status: Draft for implementation (v2)
Owner: kkompalli

## What changed between v1 and v2

Between the time v1 of this spec was written and the time we started
implementing, three relevant PRs merged to `main`:

- **#58 (`5d9c86f`) — SDK observability + idle watchdog + progressive
  retry.** Adds `includePartialMessages`, `stderr` callback, idle
  watchdog (`idleTimeoutMs` + `toolIdleTimeoutMs`),
  `[SDK_HEARTBEAT]`, `[SDK_STALLED_NO_TOOLS]`,
  `[SDK_STALLED_POST_TOOLS]`, `[SDK_STATUS]`, `[SDK_NOTIFICATION]`,
  `[SDK_TOOL_FAILURE]`, `failureKind` on `AgentResult`, and a
  progressive retry ladder in the planner consumer.
- **#60 (`6bac68a`) — remove Bash from planner `allowedTools`.**
  Narrows the planner's tool surface to `Read/Glob/Grep`.
- **#61 (`1d680fc`) — drop planner output schema on attempt 1.**
  Inverts the schema flag: schema is now opt-in via
  `PlannerAttemptOverrides.useOutputSchema` (default off for attempt
  1). A local Python probe showed schema-off completes in ~216s with
  31 tool calls on the same ticket that hangs with schema on.

These shipped:

- ✅ Section 1 observability (heartbeat, partial messages, stderr
  capture, stall logs) — **better than v1 planned**
- ✅ The `stderr` capture that v1 claimed was unsupported — **v1 was
  wrong; the SDK accepts `sdkOptions.stderr`**
- ✅ Part of what we wanted for Section 5 (hooks are now wired for
  observability)
- ⚠️ Planner tool surface narrowed (#60) — **conflicts with v1's
  "expand exploration profile to include Bash" plan.** The team has
  decided explore agents should stay narrow.

These did NOT ship:

- ❌ Real `tools` availability cap (still only `allowedTools`)
- ❌ `permissionLevel` precedence over `agentType` (still agentType wins)
- ❌ Profile collapse to 2 profiles (v1 plan now partially rejected by #60)
- ❌ Bash denylist replacing the allowlist (dead `isAllowedBashCommand`
  + `ANVIL_ALLOWED_COMMANDS` still live alongside a partial
  `isBashCommandBlocked`)
- ❌ `hooks.ts` dead-code cleanup (`makeDenyWritesOutsideRepos` etc.
  still imported but unused; `sdkOptions.hooks` is now hard-coded
  inline in `index.ts` and bypasses `buildHooks` entirely)
- ❌ Repo ID collision fix (still basename-only, globals, no deregister)
- ❌ Session-log jsonl tailer (and no longer needed — stall logs + idle
  watchdog cover the same diagnostic surface)

## Revised motivation

v1 was framed around a 12-minute no-tool-call timeout pattern. That
root cause has been identified (`outputFormat: json_schema` triggers a
Bedrock thinking-stream stall on long prompts) and mitigated by #58
(idle watchdog kicks in at 90s by default, much faster than the
12-min wall timeout) and #61 (schema off by default for planner
attempt 1). The acute incident on CPDEV-20908 is now recoverable via
the retry ladder.

What remains is a family of correctness bugs that are not acute but
still real:

1. The SDK does not actually cap which built-in tools the model can
   invoke. Today the model could theoretically try to call `Task`,
   `WebFetch`, `NotebookEdit`, etc. on any agent, and only our
   `canUseTool` advisory allowlist (which is a *permit-list*, not a
   *deny-list*) rescues us.
2. `permissionLevel` is dead when `agentType` is set, so callers
   silently get the wrong tool surface.
3. The bash policy is split between an allowlist that lets through
   mutating git commands and relative-path redirection, and a
   denylist that covers some of the same patterns — two policies,
   neither complete.
4. `hooks.ts` has ~200 lines of dead code (`makeDenyWritesOutsideRepos`,
   `makeDenyDangerousCommands`, `makeReadOnlyHook`,
   `makeRateLimitHook`, `makeTimeoutHook`, `makeWebhookHook`,
   `makeProgressHook`, `buildHooks`) that is imported but never
   affects runtime — `index.ts` hard-codes the hooks it actually uses.
5. Repo IDs collide: `registerRepoFromPath('/oneshot/1/workspace')` and
   `registerRepoFromPath('/oneshot/2/workspace')` both return
   `workspace` and overwrite each other in the global registry.

None of these are blocking prod today. All of them will bite us
eventually, and fixing them is cheap now that main's observability
lets us verify behavior.

## Guiding principle (unchanged)

**Containers are the sandbox. The SDK is an autonomy layer, not a
second sandbox.** Agents run in isolated ECS tasks with scoped IAM and
EFS mounts — we do not need the SDK to double-lock the container.
Block only things that would escape the container or spend unbounded
money.

`maxBudgetUsd` is the cost cap. A short Bash denylist is the
lateral-movement cap. Everything else is open.

## What v2 drops from v1

- **Profile collapse to `readonly`/`autonomous`.** #60 went the
  opposite direction by narrowing the planner's tools to
  `Read/Glob/Grep`. We keep the legacy 5-profile map and fix the
  precedence bug rather than force a model the team has already
  rejected for at least one agent.
- **Session-log jsonl tailer.** Main's stall diagnostics
  (`[SDK_STALLED_NO_TOOLS]` / `[SDK_STALLED_POST_TOOLS]`) plus
  `[SDK_HEARTBEAT]` with `thinkingDeltas`/`textDeltas` give us
  ground-truth visibility into the subprocess already. Tailer is a
  ~200-line addition for marginal extra signal.
- **`buildHooks` rewrite.** Main's `index.ts` now hard-codes the
  observability hooks inline. `hooks.ts` is effectively unused.
  Instead of rewriting it, we delete it.
- **QUALIFIER null-mode fix.** Already handled by PR #53's
  `Orchestrator.ts:396-407` guard; no change needed.
- **`[SDK_COMPLETE]` counter bug.** Already correct on main.
- **`settingSources: []`.** Not set on main but also not the source of
  any observed bug; defer unless we find a case where global CLAUDE.md
  leaks into a run.

## Scope

### Section 1 — Real `tools` availability cap

**Problem:** `sdkOptions.allowedTools` is the SDK's auto-approve list,
not the availability cap. Per `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:492-526`,
the actual restriction comes from `sdkOptions.tools`. Main sets
`allowedTools` but never sets `tools`, so the model sees every
built-in tool.

**Target:** `src/claude-sdk/index.ts`

**Changes:**
- Set `sdkOptions.tools = resolvedToolSet` alongside `allowedTools`
  (same value for both).
- Add an explicit default-deny branch at the top of `canUseTool`: if
  `toolName` is not in `resolvedToolSet`, log `[TOOL_OUT_OF_SET]` and
  return `{ behavior: 'deny' }`. Today the canUseTool returns
  `behavior: 'allow'` at the end of the function for anything that
  doesn't match an explicit deny rule — that's a default-allow.

### Section 2 — Precedence fix: `permissionLevel` beats `agentType`

**Problem:** `src/claude-sdk/index.ts:244-251` resolves tools as:

```
allowedTools ?? (agentType ? getToolSet(agentType) : permissionLevel ? getToolSetForPermission(permissionLevel) : fallback)
```

`agentType` shadows `permissionLevel`. Callers in HERMES, DARCI,
VERITAS explicitly request `permissionLevel: 'code_exploration'` or
`'read_only'`, expecting downscoping — but they always get the
agentType's default tool set instead.

**Target:** `src/claude-sdk/index.ts`, `src/claude-sdk/config.ts`

**Changes:**
- Add `resolveToolSet(args: { allowedTools?, permissionLevel?, agentType? })`
  in `config.ts` with precedence:
  1. explicit `allowedTools` override
  2. `permissionLevel` (any of the existing 5 profiles)
  3. `agentType` default (keep existing `getToolSet` for this)
  4. fallback: `code_exploration` (current default)
- Replace the resolution block in `index.ts` with a single call to
  `resolveToolSet`.
- Log `policySource` (`'explicit'` | `'permission_level'` |
  `'agent_default'` | `'fallback'`) alongside `resolvedTools` in the
  existing `[TOOLS_SELECT]` log line.
- Keep the existing 5 profiles (`code_exploration`, `read_only`,
  `analysis`, `patch_proposal`, `full_autonomy`). No profile collapse.

### Section 3 — Bash policy cleanup (dedup, not rewrite)

**Problem:** `src/claude-sdk/index.ts` has three coexisting policies:
- `isAllowedBashCommand` — allowlist, blocks a handful of `git`
  subcommands and requires base command ∈ `SAFE_READ_ONLY_COMMANDS`
- `isAllowedANVILBashCommand` — superset allowlist with 15+ extra
  commands
- `isBashCommandBlocked` — denylist matching ~12 dangerous regexes

The first two run as a primary permission gate; the third runs as a
secondary "safety net" in `canUseTool`. The allowlist has known
false-positives (blocks `git commit`, `rm node_modules`) that the team
has accepted by widening the ANVIL list case-by-case.

**Target:** `src/claude-sdk/index.ts`

**Changes:**
- Keep `isBashCommandBlocked` — it is the real denylist. Extend it
  with the dangerous patterns the allowlist was catching that the
  denylist currently misses (enumerated in Task 3 of the plan).
- Delete `isAllowedBashCommand`, `isAllowedANVILBashCommand`,
  `SAFE_READ_ONLY_COMMANDS`, `ANVIL_ALLOWED_COMMANDS`.
- In `canUseTool`, the primary allowlist branch becomes a single call
  to `isBashCommandBlocked`. Agent-specific branching
  (`options.agentType === 'anvil'`) goes away.

**Non-goals:** we are not rewriting the bash policy to the
container-trust model from v1. We are merging two policies into one
and keeping the patterns the team has already validated.

### Section 4 — Delete `hooks.ts` dead code

**Problem:** `src/claude-sdk/hooks.ts` exports
`makeDenyWritesOutsideRepos`, `makeDenyDangerousCommands`,
`makeReadOnlyHook`, `makeRateLimitHook`, `makeTimeoutHook`,
`makeWebhookHook`, `makeProgressHook`, `makeAuditLogHook`,
`buildHooks`. Of these, `buildHooks` is imported by
`src/claude-sdk/index.ts:38` but never called — main's PR #58
hard-coded observability hooks inline and bypassed `buildHooks`.

**Target:** `src/claude-sdk/hooks.ts`, `src/claude-sdk/index.ts`

**Changes:**
- Delete all `make*Hook` factories.
- Delete `buildHooks`, `HooksConfig`, `ProgressUpdate`.
- Keep `HookInput`, `HookOutput`, `HookCallback`, `AuditLogEvent` type
  exports — they are still referenced by `index.ts` and by the
  inline hooks.
- Remove the unused import in `index.ts`.

Follow-up (not this PR): if we want audit logging back, add a
`makeAuditHook` helper and wire it into the inline
`sdkOptions.hooks.PreToolUse` array. Not scoped here because no
caller asks for it today.

### Section 5 — Repo ID collision fix

**Problem:** `src/claude-sdk/config.ts:30-45` exposes `REPO_REGISTRY`
as a global `Record<string, string>`, and
`registerRepoFromPath(absPath)` returns `basename(absPath)` as the
ID. Two OneShot runs with the same workspace basename
(`/oneshot/1/workspace` + `/oneshot/2/workspace`) both register as
`workspace` and overwrite each other.

**Target:** `src/claude-sdk/config.ts`, `src/claude-sdk/index.ts`,
`src/oneshot/workspaces.ts`, `src/oneshot/providers/claude-planner.ts`,
`src/oneshot/providers/claude-implementer.ts`

**Changes:**
- New signature:
  `registerRepoFromPath(absPath: string, explicitId?: string): string`
- When `explicitId` is supplied, use it verbatim.
- Otherwise, return `${basename(absPath)}_${sha256(absPath).slice(0,8)}`.
- Add `deregisterRepo(id: string): void`.
- OneShot providers (`claude-planner.ts`, `claude-implementer.ts`)
  supply `oneshot-run-${jiraKey}-planner` and
  `oneshot-run-${jiraKey}-implementer` as explicit IDs.
- OneShot workspace cleanup (`src/oneshot/workspaces.ts`) calls
  `deregisterRepo` for both IDs when cleaning a run.
- Legacy non-OneShot callers keep their current call shape; the hash
  suffix prevents basename collisions for them too without requiring
  changes.

### Section 6 — CPDEV-20908 recovery runbook

**Target:** manual SQL + requeue CLI (not code).

This is unchanged from v1 but less urgent now that the retry ladder
exists. If the run is still in a failed state after the code changes
deploy, run:

```sql
UPDATE oneshot_runs
   SET state = 'queued_for_planning',
       planning_attempt_count = 0,
       last_error = NULL,
       updated_at = NOW()
 WHERE id = 2;
```

and re-enqueue the message. If the run is already recovered (likely,
given the retry ladder + schema-off default), skip this section.

## Success criteria

1. `sdkOptions.tools` is set to the resolved tool set on every
   `query()` call; the SDK enforces the cap server-side.
2. Callers that pass `permissionLevel` actually get that profile even
   when `agentType` is also set.
3. A new `[TOOLS_SELECT]` log field `policySource` explains why each
   run got the tools it did, so contract mismatches are debuggable
   from logs alone.
4. `canUseTool` default-denies any tool outside the resolved set,
   logged as `[TOOL_OUT_OF_SET]`.
5. Bash policy is a single denylist; `git commit`,
   `rm -rf node_modules`, `echo hi > local.txt`, `npm install`,
   `mvn test`, `git checkout -b feature/x` all pass; `sudo`,
   `rm -rf /`, `curl | sh`, `git push --force` still blocked.
6. `hooks.ts` exports only type definitions that are still in use;
   all dead factory functions are removed.
7. Two concurrent OneShot runs register distinct repo IDs; neither
   overwrites the other.
8. `registerRepoFromPath` accepts an optional explicit ID; OneShot
   providers pass it.

## Tests

In `src/claude-sdk/config.test.ts` (new file):
- Precedence: explicit allowedTools > permissionLevel > agentType > fallback.
- Repo ID: same basename, different paths → different IDs.
- Repo ID: explicit ID wins.
- `deregisterRepo` removes the entry; `getRepoPath` throws after.

In `src/claude-sdk/index.test.ts` (extend existing):
- Mocked `query()` call receives `sdkOptions.tools` equal to the
  resolved set.
- `canUseTool` returns `{behavior: 'deny'}` for a tool outside the
  resolved set.

In `src/claude-sdk/bash-policy.test.ts` (new file):
- Blocks `sudo`, `ssh`, `rm -rf /`, `curl | sh`, `git push --force`.
- Allows `git log`, `git commit -m 'x'`, `git checkout -b foo`,
  `rm -rf node_modules`, `npm install`, `mvn test`,
  `echo hi > local.txt`.

## Rollout

1. Land PR on a feature branch; merge to `main`.
2. Deploy to prod (existing `terraform apply` + ECS deploy flow; no
   infra changes, no migrations).
3. Verify `[TOOLS_SELECT]` log on next planner/implementer/hermes
   run shows `policySource` and a minimized resolved tool set.
4. If CPDEV-20908 is still failed post-deploy, run the SQL reset
   from Section 6.

## Risks and rollback

- **Risk:** setting `sdkOptions.tools` narrower than what the model
  has trained to expect could surface new deny events on legitimate
  work. **Mitigation:** we resolve to the same set we already put in
  `allowedTools`, so behavior should be identical — the change is
  purely about *enforcement location* (server-side vs.
  `canUseTool`-side).
- **Risk:** flipping precedence to `permissionLevel > agentType`
  changes resolved tools for any agent that was implicitly relying on
  the bug (passing `permissionLevel` they didn't intend to honor).
  **Mitigation:** call-site audit in Task 6 of the plan enumerates
  the 3 agents (HERMES, DARCI, VERITAS) that pass both; their
  `permissionLevel` values match their desired surface, so this is
  the correct behavior.
- **Risk:** removing `isAllowedBashCommand` and friends breaks ANVIL,
  which today exercises the ANVIL-specific allowlist.
  **Mitigation:** the denylist is strictly more permissive than any
  of our allowlists — any command ANVIL runs today is not in the
  denylist and would have been allowed. Run ANVIL's integration
  tests on the feature branch before merge.
- **Risk:** deleting `buildHooks` breaks a caller we missed.
  **Mitigation:** `grep buildHooks` across the repo before deletion;
  TypeScript compilation catches any remaining reference.
- **Rollback:** revert the PR. No DB migrations, no new infra, no
  breaking wire format changes for existing callers.

## Review questions answered (carried from v1)

1. **`tools` vs `allowedTools`:** confirmed from
   `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:492-526`.
   `allowedTools` is auto-approve only; `tools` is the real
   availability cap. We set both to the same value.
2. **Precedence model:** explicit `allowedTools` > `permissionLevel` >
   `agentType`. `agentType` is identity (prompt + schema) only.
3. **Bash policy:** keep the current denylist, extend it, and retire
   the parallel allowlist. Not a full container-trust rewrite.
4. **`readOnly` option:** unchanged — remains a `permissionLevel`
   value (`read_only`), not a flag.
5. **Repo ID strategy:** caller-supplied when provided, otherwise
   basename + 8-char path hash. OneShot supplies
   `oneshot-run-${jiraKey}-${stage}`.
6. **Tool profiling:** keep best-effort, unchanged.
