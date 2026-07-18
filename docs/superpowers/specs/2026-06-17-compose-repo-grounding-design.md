# Compose Repo Grounding — Design

**Date:** 2026-06-17
**Status:** Approved (design) — pending implementation plan
**Author:** Spec Factory hardening initiative

## Problem

In Spec Factory **Compose** (the chat-driven clarification surface), when an operator
selects code repositories and clicks **Analyze Sources**, the clarification agent does
**not** receive the code. `renderRepositoryContext` (in `compose-service.ts`) writes only a
metadata stub into `repositories.md`:

```
- core-app
  - Repository ID: 42
  - Default branch: main
  - URL: <git url>
  - Description: <one line>
```

The agent runs `permissionLevel: "read_only"`, `allowWrite: false`, with
`repoIds: [workspaceRepoId]` pointing only at the session markdown workspace — it has no
checked-out code. As a result it asks clarifying questions it should be able to answer from
the code, e.g.:

> "Does a core-app 'Submit Appeals' web service/API already exist to create a Medical Appeal
> case and route it into the workflow, or must it be built/extended? What is its contract?"

The repo was named but never read. This contrasts with OneShot/DARCI, whose agents inspect
the real code.

## Goal

Give the Compose clarification agent live, read-only access to the relevant code — both
operator-**selected** repos and repos **auto-identified** from the sources — using the same
cached-clone machinery OneShot uses, augmented with OneShot's **enhanced repo-analyzer**
(pre-scan + route cards). Surface what the agent found back to the operator. Do this without
regressing the chat-turn latency work from PR #316.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Trigger | **Selected repos + auto-identify.** Explicit selection always wins; auto-identify only augments. |
| Read model | **Live grep/Read** (OneShot/DARCI-style), not a static digest. |
| When attached | **Analyze + every chat turn.** |
| Guardrails | Strictly read-only · reuse cached clone (no per-turn fresh clone) · graceful degradation on clone failure · mirror OneShot's (more advanced) repo investigation. |
| Grounding engine | **Reuse OneShot's repo-analyzer** (`repo-scanner`, `repo-route-cards`, repo-identify) — "Approach A now, Planner-style confidence scoring later". |
| Surfacing | **Surface findings** — per-repo "Repo evidence" in the Preview panel; pending questions may cite real paths. |
| Shared module | Promote the provider-agnostic analyzers into a shared home and have **both** OneShot and Spec Factory consume them; also enhance Spec Factory's draft/qualify `repo-context.ts` with the same scan/route-card layer. |

## Non-goals (this iteration)

- Porting OneShot **Planner-grounding** candidate-file confidence scoring (`planner-grounding.ts`).
  Left as a clean seam for a follow-up (the "B-scoring later" decision).
- Writing to / modifying any repo. Clarification is read-only, always.
- Multi-replica concerns (Compose remains single-replica; unchanged here).

## Existing machinery this reuses

- `SpecFactoryRepoWorkspaceManager.prepareMasterWorkspace` (`repo-workspace.ts`) — cached,
  freshness-TTL'd master clone keyed by `SPEC_FACTORY_REPO_CACHE_BASE` (shares OneShot's repo
  cache), returns a `repoId` via `registerRepoFromPath`. Attaching repos every turn is
  normally a **cache hit**, not a clone.
- `runAgent({ repoIds: [...] })` already accepts an array of repo ids, plus
  `toolBudgetGuard` / `toolSprawlGuard` for bounding tool calls — no SDK change needed.
- OneShot's `repo-scanner.ts` (`scanRepo`, `formatScanForPrompt` → "Codebase Intelligence
  (pre-scanned)" block), `repo-route-cards.ts` (`buildRepoRouteCardContext`,
  `getRepoRouteCardMatches`), `repo-metadata.ts` (`getRepoMentionTokens`, slug helpers), and
  `repo-router/` profile matching — provider-agnostic, currently OneShot-only.
- `lookupRepositories()` — already injected into `ComposeService`; maps DB repos to options.
- `SpecFactoryRepoContextManifest` (`repo-context.ts`) — existing manifest shape reused for
  the UI surface.

## Architecture

### New shared module: `src/repo-intel/`

Promote the provider-agnostic OneShot analyzers out of `src/oneshot/` so both subsystems
consume one implementation (mirrors the shared-retry-module pattern from PR #317):

- `repo-scanner.ts` — `scanRepo(workspacePath)` + `formatScanForPrompt(scan)`.
- `repo-route-cards.ts` — curated per-repo navigation hints + matching.
- repo-identify helpers — `getRepoMentionTokens`, slug/profile matching (the pieces of
  `repo-metadata.ts` / `repo-router/` needed to infer a repo from free text).

OneShot keeps importing the same functions from the new home (re-export shim or updated
imports — no behavior change; its existing tests move with the modules and must stay green).

### New unit: `src/spec-factory/compose-repo-grounding.ts` — `ComposeRepoGrounding`

Single responsibility: **resolve → clone/refresh → scan/route-cards/identify → return
`{ codeRepoIds, repositoriesMarkdown, manifest }`.** One public method:

```
groundRepos(input: {
  selectedRepositoryIds: number[];
  sources: Array<{ filename: string; content: string }>;  // for auto-identify
}): Promise<ComposeRepoGroundingResult>
```

Dependencies (all already available near `ComposeService`): `lookupRepositories`,
`prepareMasterWorkspace`, and the `repo-intel` analyzers.

**Resolution (explicit-wins precedence):**
1. Selected repos (from the picker) — always included.
2. Auto-identified — match `getRepoMentionTokens` / profile signals from `sources/*.md`
   against `lookupRepositories()`; add matches not already selected.
3. Dedupe; cap at `COMPOSE_MAX_GROUNDED_REPOS` (default 3), selected repos taking priority
   when truncating.

**Per resolved repo:**
1. `prepareMasterWorkspace` → workspace path + `repoId` (cache hit unless stale).
2. `scanRepo(workspacePath)` → `RepoScanResult`.
3. `buildRepoRouteCardContext` for the repo (if route cards exist for it).
4. Compose `repositories.md` body from `formatScanForPrompt(scan)` + route-card context
   (replacing today's bare metadata stub), and a manifest entry
   `{ repoName, headSha, techStack, inspectedPaths: keyFiles, keyMatches, warnings }`.

**Graceful degradation:** the whole per-repo step is wrapped; on any failure (auth, missing,
clone/scan timeout) it falls back to **today's metadata line** for that repo and records a
`warnings[]` entry (`"core-app: code unavailable, used metadata only (<reason>)"`). The repo
is omitted from `codeRepoIds` (no broken repoId passed to the agent). The turn always proceeds.

### Integration in `compose-service.ts` `runTurn`

Replaces the current `renderRepositoryContext(...)` call. On **both** analyze and chat turns:

1. `const grounding = await this.repoGrounding.groundRepos({ selectedRepositoryIds, sources })`
   (wrapped so a total failure degrades to the legacy metadata path).
2. `workspaceManager.prepare({ ..., repositoryContextMarkdown: grounding.repositoriesMarkdown })`.
3. `chatAgent.run({ ..., codeRepoIds: grounding.codeRepoIds })`.
4. Persist `grounding.manifest` alongside readiness; SSE-publish it.

### `compose-chat-agent.ts`

- Accept `codeRepoIds: string[]`; pass `repoIds: [workspaceRepoId, ...codeRepoIds]` to
  `runAgent`. Keep `permissionLevel: "read_only"`, `allowWrite: false`.
- Prompt update: instruct the agent to treat `repositories.md` as a pre-scanned map and to
  **grep/Read the attached repos as primary evidence** before asking a code-answerable
  question (e.g. confirm whether an API/route exists rather than asking).
- Pass `toolBudgetGuard`/`toolSprawlGuard` bounded by `COMPOSE_REPO_GROUNDING_TOOL_BUDGET`.
- Token-budget note: code is read lazily via tools (not inlined into the prompt), so the
  existing `ComposeChatPromptTooLargeError` prompt guard is unaffected; repo cost is bounded
  by the tool budget, a separate axis.

### Spec Factory draft/qualify enhancement (`repo-context.ts`)

Extend `SpecFactoryRepoContextCollector` to also run `scanRepo` + route-cards (from
`repo-intel`) for its grounded repos, so the **draft/qualify pipeline gets the same
codebase-intelligence upgrade**, not just Compose. Existing snippet collection stays; the
scan/route-card context is added to what the draft generator sees.

## Data flow (per turn)

```
runTurn(analyze|chat)
  └─ ComposeRepoGrounding.groundRepos({ selectedRepositoryIds, sources })
       ├─ resolve repos (selected ∪ auto-identified, dedup, cap≤3, selected wins)
       ├─ per repo: prepareMasterWorkspace (cache hit) → scanRepo → route cards
       │     └─ on failure → metadata-only + warning (repo dropped from codeRepoIds)
       └─ returns { codeRepoIds, repositoriesMarkdown, manifest }
  └─ workspaceManager.prepare(repositoryContextMarkdown = repositoriesMarkdown)
  └─ chatAgent.run(repoIds = [workspaceRepoId, ...codeRepoIds], read-only, tool-budgeted)
       └─ agent reads repositories.md (pre-scan map) + greps/Reads live code
  └─ persist manifest as readiness.repoEvidence + SSE "readiness" event → Preview "Repo evidence"
```

## UI surface (Preview panel)

A new **"Repo evidence"** block under DETAILS, rendered read-only from the manifest:

- `core-app @ a1b2c3d — TypeScript/Express · inspected 7 files · AppealsController.submit() found`
- `provider-portal — ⚠ metadata only (clone failed: auth)` on degradation.

The manifest is carried as a new optional field on the persisted **readiness** payload
(`readiness.repoEvidence`), not as a separate transient SSE event — so it survives reload and
session resume, and rides the existing `type: "readiness"` SSE event the frontend already
consumes. Pending questions may reference real paths the agent read.

## Error handling

- **Per-repo failure** → metadata-only fallback for that repo + `warnings[]`; turn proceeds.
- **Total grounding failure** → legacy `renderRepositoryContext` metadata path; turn proceeds.
- **Clone/scan timeout** → bounded by a dedicated grounding timeout, separate from the chat
  turn timeout, so git/scan slowness can't blow the turn.
- **Feature flag** `COMPOSE_REPO_GROUNDING_ENABLED=false` → exact pre-change behavior.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `COMPOSE_REPO_GROUNDING_ENABLED` | `true` | Master kill-switch; off ⇒ legacy metadata-only behavior. |
| `COMPOSE_MAX_GROUNDED_REPOS` | `3` | Cap on attached repos (selected prioritized). |
| `COMPOSE_REPO_GROUNDING_TOOL_BUDGET` | `40` | Max repo grep/Read tool calls per turn (tune from prod telemetry; high enough for genuine investigation, low enough to bound a monorepo). |
| `COMPOSE_REPO_GROUNDING_TIMEOUT_MS` | `120000` | Clone/scan budget per turn, separate from the chat-turn timeout (cache hit is fast; this covers a cold/stale refresh + scan). |

Wired through `server.ts` + terraform `spec-factory-ecs.tf` + `.env.example`.

## Testing (TDD)

- **`repo-intel`**: existing OneShot scanner/route-card tests move with the modules and stay
  green; add a test proving both OneShot and Spec Factory import the shared implementation.
- **`ComposeRepoGrounding`**: resolution precedence (selected wins; auto-identify augments;
  dedupe; cap truncation prioritizes selected); cache-hit path; **graceful degradation**
  (per-repo failure → metadata + warning, repo dropped, turn proceeds); tool-budget applied.
- **`compose-service.runTurn`**: passes `[workspaceRepoId, ...codeRepoIds]`; persists +
  publishes manifest; flag off ⇒ identical legacy behavior.
- **`compose-chat-agent`**: repoIds array threaded; prompt instructs grep-the-code; read-only
  preserved.
- **Frontend**: Repo-evidence rendering incl. degradation warning; `afterEach(cleanup)` on
  touched suites (matches the known RTL-cleanup gap).
- **`repo-context.ts`**: draft path now emits scan/route-card context (regression + new).

## Extension seam (future, out of scope now)

`ComposeRepoGrounding.groundRepos` is the single interface. Planner-style candidate-file
**confidence scoring** (`planner-grounding`) can later slot in behind it to rank/limit what
the agent reads, without changing `compose-service.ts`, the agent, or the UI. Documented as a
TODO seam; no stub code in this iteration.

## File map

**New**
- `src/repo-intel/repo-scanner.ts`, `repo-route-cards.ts`, repo-identify helpers (promoted, provider-agnostic).
- `src/spec-factory/compose-repo-grounding.ts` (+ test).

**Edit**
- `src/oneshot/*` — import the analyzers from `repo-intel` (no behavior change).
- `src/spec-factory/compose-service.ts` — call grounding in `runTurn`; thread repoIds + manifest.
- `src/spec-factory/compose-chat-agent.ts` — repoIds array + grep-the-code prompt + tool budget.
- `src/spec-factory/compose-types.ts` + `dashboard/src/spec-factory/compose/composeTypes.ts` — `repoEvidence` field on the readiness type (backend + frontend mirror).
- `src/spec-factory/repo-context.ts` — adopt scan/route-cards for the draft/qualify path.
- `dashboard/src/spec-factory/compose/PreviewPanel.tsx` (+ `ComposeWorkspace.tsx`) — Repo-evidence block.
- `terraform/spec-factory-ecs.tf`, `terraform/variables.tf`, `.env.example` — new config vars.
```
