# Developer guide

This guide teaches a new engineer how to change Spec Factory safely. The
[v4 plan](../superpowers/spec-factory/spec_factory_scale_and_reliability_plan_v4.md),
[architecture](./architecture.md), and [operations](./operations.md) are the
current contracts. Older single-process/file-line descriptions below remain
useful for navigation but do not override the v4 runtime ownership model.

## V4 validation loop

Before pushing a Spec Factory change, run the same release surfaces as CI:

```bash
npm ci
npm run build
npm run check:spec-factory-schema
npm run test:spec-factory
npm --prefix dashboard ci
npm --prefix dashboard run typecheck
npm --prefix dashboard test
npm --prefix dashboard run build
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
```

Build the role targets when Docker is available:

```bash
docker build --target api -f Dockerfile.spec-factory .
docker build --target core -f Dockerfile.spec-factory .
docker build --target research -f Dockerfile.spec-factory .
docker build --target conversion -f Dockerfile.spec-factory .
docker build -f Dockerfile.compose-markitdown .
```

For Work Order T tooling, generate a candidate manifest with
`npm run spec-factory:certification:plan`, then initialize and record evidence
with `npm run spec-factory:certification:evidence`. Never fabricate environment evidence
or accept a repair run from unit-test output.

## Table of contents

- [Repo layout](#repo-layout)
- [Local dev setup](#local-dev-setup)
- [Testing conventions](#testing-conventions)
- [Adding a new source kind](#adding-a-new-source-kind)
- [Adding a new capability](#adding-a-new-capability-target--phase-5)
- [Adding a new SSE event](#adding-a-new-sse-event)
- [Adding a new migration](#adding-a-new-migration)
- [Guard hygiene](#guard-hygiene)
- [Common pitfalls](#common-pitfalls)
- [Code style](#code-style)
- [PR checklist](#pr-checklist)

## Repo layout

Spec Factory compiles one TypeScript application into role-specific image
targets. Runtime modes decide which API/worker loops boot; MySQL, SQS, S3, and
Valkey provide shared control, dispatch, artifact, and fanout planes.

### Process boundary

| File                             | Purpose                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/spec-factory/main.ts:1`     | Node entrypoint. Reads `SPEC_FACTORY_PORT` (default 3012), calls `initDatabase()`, mounts `buildSpecFactoryApp()`. Invoked by `Dockerfile.spec-factory:33`.                                                                                                                                                                       |
| `src/spec-factory/server.ts:704` | `buildSpecFactoryApp()` composes all singletons: `ComposeRepository`, `ComposeUploads`, `MarkitdownClient`, `ComposeAudioClient`, `ComposeVoxtral`, `ComposeConversionWorker`, `ComposeChatAgent`, `ComposeWorkspaceManager`, `ComposeSseHub`, `ComposeRetentionCleaner`, then `createComposeRouter` + `createSpecFactoryRouter`. |

### Compose intake lane

| File                                           | Role                                                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/spec-factory/compose-service.ts:737`      | `ComposeService` — in-process turn queue (`activeTurns`, `queuedTurns`, `queuedDepth`), retry logic, stream-token mint, handoff wiring, guard wrappers (`requireReadableSession` etc. at lines 4000-4039). |
| `src/spec-factory/compose-service.ts:2336`     | `runTurn` — grounding, workspace prepare, chat agent/coordinator call, readiness publish.                                                                                                                  |
| `src/spec-factory/compose-service.ts:3648`     | `enqueueTurn` — per-session serial chain with `MAX_QUEUED_TURNS_PER_SESSION` backpressure (`compose-service.ts:87`, default 3, overridable via `COMPOSE_MAX_QUEUED_TURNS`).                                |
| `src/spec-factory/compose-routes.ts:289`       | `createComposeRouter` Express factory. Every route resolves an `ActorContext` via `actorFromRequest` and delegates to `ComposeService`.                                                                    |
| `src/spec-factory/compose-routes.ts:746`       | `GET /sessions/:sessionId/stream` — SSE + durable event replay via `Last-Event-ID` / `?after=`.                                                                                                            |
| `src/spec-factory/compose-database.ts:1`       | `ComposeRepository` — MySQL access + row shapes (`SessionRow`, `SourceRow`, `MessageRow`, `SessionEventRow`, `TurnJobRow`, `TurnOutputRow`, `WorkspaceCleanupRow`, `ConversionHealthRow`).                 |
| `src/spec-factory/session/session-guard.ts:11` | `SYSTEM_ACTOR` + `assertSession{Exists,Readable,Mutable,Streamable,HandoffAllowed}` (Phase 0 archive gate).                                                                                                |
| `src/spec-factory/compose-chat-agent.ts:327`   | `ComposeChatAgent.run` — Claude Agent SDK invocation, prompt-size guard, structured envelope parse.                                                                                                        |
| `src/spec-factory/compose-chat-agent.ts:29`    | `ComposeChatPromptTooLargeError` — ~150k-token partial-context guard.                                                                                                                                      |
| `src/spec-factory/compose-conversion.ts:220`   | `ComposeConversionWorker` — lease-based conversion drain, media transcode + Voxtral segmentation.                                                                                                          |
| `src/spec-factory/compose-conversion.ts:68`    | `isTransientConversionError` — retry classifier for Bedrock / MarkItDown / ffmpeg.                                                                                                                         |
| `src/spec-factory/compose-workspace.ts:230`    | `ComposeWorkspaceManager.prepare` — writes `chat.md`, `context.md`, `repositories.md`, `sources/*.md`, `session-manifest.json`, durable manifest metadata, and registers the SDK repo.                     |
| `src/spec-factory/compose-sse.ts:98`           | `ComposeSseHub` — in-process subscribers + 20-event replay buffer + optional durable event store fan-out.                                                                                                  |
| `src/spec-factory/compose-sse.ts:65`           | `durableEventType` mapping (message → `assistant.final` / `message.created`; readiness → `readiness.updated`; status → `turn.status` / `error`).                                                           |

### Support modules (Compose)

| File                             | Role                                                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose-types.ts`               | Zod schemas + inferred types for session, source, message, readiness, turn kind. `ComposeSourceKindSchema` at line 11 is the canonical enum; `ComposeConverterSchema` at line 21; `ComposeConversionStatusSchema` at line 24; `ComposeMessageRoleSchema` at line 36. |
| `compose-uploads.ts`             | Presigned-URL S3 upload minting. Called from the `POST /sessions/:sessionId/uploads` route.                                                                                                                                                                          |
| `compose-markitdown-client.ts`   | HTTP client for the `compose-markitdown` sidecar. Uploads a byte stream and receives Markdown back.                                                                                                                                                                  |
| `compose-audio-client.ts`        | HTTP client for audio extraction on the sidecar (ffmpeg-backed).                                                                                                                                                                                                     |
| `compose-voxtral.ts`             | Bedrock Voxtral InvokeModel wrapper for audio transcription; enforces a per-segment 25MB request-size budget (see `MEMORY.md` note on the Voxtral limit).                                                                                                            |
| `compose-jira-source.ts`         | Fetches Jira issues by key via `JiraClient` and normalizes them to Markdown.                                                                                                                                                                                         |
| `compose-repo-grounding.ts`      | Optional repo-grounding pass that materializes selected repositories into the chat workspace before an SDK call. Gated by `COMPOSE_REPO_GROUNDING_ENABLED`.                                                                                                          |
| `compose-evidence-provider.ts`   | Bridges Compose sources to the legacy `SpecFactoryEvidenceCollector` when a session hands off.                                                                                                                                                                       |
| `compose-retention.ts`           | Retention sweep worker for archived workspaces, S3 prefixes, and expired stream tokens.                                                                                                                                                                              |
| `compose-source-deletion.ts`     | Bounded post-Undo purge worker for source-specific EFS/S3 artifacts and deletion-ledger finalization.                                                                                                                                                                |
| `compose-artifact-gc.ts`         | Bounded stale `.tmp` artifact cleanup under `COMPOSE_WORKSPACE_BASE`; shares `COMPOSE_CLEANUP_DRY_RUN`.                                                                                                                                                              |
| `compose-cleanup.ts`             | One-shot script (`npm run spec-factory:compose-cleanup`) that runs workspace retention plus temp-artifact GC.                                                                                                                                                        |
| `compose-source-intelligence.ts` | Post-conversion metadata extraction (title, summary, kind hints). Persists under `metadata` per migration 052.                                                                                                                                                       |
| `compose-url-policy.ts`          | Confluence host allowlist + URL policy checks. Reads `COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES`.                                                                                                                                                                     |

### Legacy Louise/Jira draft pipeline

These modules stay untouched by Compose changes. They fire when a session hands off (see `ComposeService.handoff` at `compose-service.ts:1319`).

| File                                                                                | Role                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `routes.ts`                                                                         | Legacy REST endpoints and helpers (`actorFromRequest`, `positiveInt`) imported by `compose-routes.ts:6`. |
| `service.ts`, `database.ts`                                                         | `SpecFactoryService` and `SpecFactoryRepository` (draft/qualification pipeline).                         |
| `qualifier.ts`, `draft-generator.ts`, `draft-validator.ts`                          | Qualification and draft generation stages.                                                               |
| `jira-publisher.ts`, `candidate-ingestor.ts`                                        | Louise intake + Jira publishing.                                                                         |
| `oneshot-submitter.ts`, `evidence-collector.ts`, `evidence-workspace.ts`            | Evidence gathering for OneShot handoff.                                                                  |
| `repo-context.ts`, `repo-workspace.ts`, `repo-reference.ts`                         | Repository grounding for the legacy path.                                                                |
| `terraform-config.ts`, `renderers.ts`, `prompt-summary.ts`, `attachment-archive.ts` | Utilities.                                                                                               |

## Local dev setup

**Prerequisites.** Node 26 (the ECS image runs Node 26; the `tsx watch` loop tolerates ≥20), Podman or Docker for the MarkItDown sidecar image, MySQL 8, and AWS credentials with Bedrock InvokeModel + S3 PutObject on the two Spec Factory buckets.

The Compose service depends on MySQL, the MarkItDown sidecar, S3, and Bedrock. There is no `docker-compose.yml` at the repo root that boots Spec Factory end-to-end — the only Podman/Compose stack that ships is `local-oneshot/docker-compose.yml`, which does not cover Spec Factory. Engineers should:

1. **Install deps**: `npm install` at the repo root.
2. **MySQL**: point `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` (see `src/orchestrator/database.ts`) at a reachable dev database. `DB_PASSWORD` is always required; there is no checked-in fallback credential. The team's convention is a local MySQL 8 on port 13306 (`db:schema` script in `package.json` uses that host/port). Run migrations from `db/migrations/` in filename order.
3. **MarkItDown sidecar**: build and run `Dockerfile.compose-markitdown` locally, or set `COMPOSE_MARKITDOWN_URL` to a reachable instance. The default in `server.ts:734-737` is `http://localhost:8080`.
4. **AWS credentials**: export `AWS_REGION` (Bedrock region), plus creds sufficient to call Bedrock InvokeModel and S3 `PutObject` on `SPEC_FACTORY_ARTIFACT_BUCKET` / `SPEC_FACTORY_ATTACHMENT_BUCKET`.
5. **Workspace root**: create a writable directory and export `COMPOSE_WORKSPACE_BASE=/tmp/compose-workspaces` (or similar). The default in production is `/mnt/efs/specter-repo/spec-factory/compose`.
6. **Run**: `npm run spec-factory:dev` — this executes `SPEC_FACTORY_PORT=3012 tsx watch src/spec-factory/main.ts` (see `package.json:39`).

**Status: v4 code-ready; deployment pending.** `SPEC_FACTORY_MODE` is wired in `server.ts` with the ten values documented in [`runtime-and-workers.md`](./runtime-and-workers.md): `api`, compatibility `worker`, dedicated turn/context/research/conversion/draft/relay/retention workers, and dev-only `all-local`. Terraform defines the API plus eight independently scaled worker services. Production state must be verified from Terraform/ECS; the repository does not imply that the split has been applied.

### Required environment variables (today)

Grouped by what breaks if you omit them. Extracted from `src/spec-factory/**/*.ts` (excluding tests). See [operations](./operations.md) for tuning knobs.

| Category      | Vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Notes                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Process       | `SPEC_FACTORY_PORT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Default 3012.                                                                                                                              |
| Database      | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Read by `resolveDatabaseConfig()` in `src/orchestrator/database.ts`; `DB_PASSWORD` is required.                                            |
| Jira (legacy) | `JIRA_BASE_URL`, `JIRA_TOKEN`, `JIRA_EMAIL` (or `JIRA_USERNAME`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `requiredEnv` in `server.ts:186`; consumed during bootstrap at `server.ts:718-722`.                                                        |
| S3            | `SPEC_FACTORY_ARTIFACT_BUCKET`, `SPEC_FACTORY_ATTACHMENT_BUCKET`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Used by uploads and draft archiving.                                                                                                       |
| Bedrock       | `AWS_REGION` (or `BEDROCK_REGION`), `ANTHROPIC_MODEL` / `BEDROCK_MODEL`, `COMPOSE_CHAT_MODEL_ID`, `COMPOSE_VOXTRAL_MODEL_ID`, `SPEC_FACTORY_MODEL_ID`, `SPEC_FACTORY_QUALIFIER_MODEL_ID`                                                                                                                                                                                                                                                                                                                                          | Model routing across chat / qualifier / draft / audio.                                                                                     |
| Sidecar       | `COMPOSE_MARKITDOWN_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Defaults to `http://localhost:8080`.                                                                                                       |
| Workspaces    | `COMPOSE_WORKSPACE_BASE`, `SPEC_FACTORY_WORKSPACE_BASE`, `SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE`, `SPEC_FACTORY_TASK_WORKSPACE_BASE`, `SPEC_FACTORY_WORKTREE_BASE`, `SPEC_FACTORY_REPO_CACHE_BASE`                                                                                                                                                                                                                                                                                                                                 | Any writable path locally; EFS mount in prod.                                                                                              |
| Access        | `SPEC_FACTORY_ADMIN_IDS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Comma-separated actor IDs granted `admin` role (see `session-guard.ts:20`).                                                                |
| Retention     | `COMPOSE_RETENTION_CLEANUP_ENABLED`, `COMPOSE_RETENTION_SWEEP_MS`, `COMPOSE_WORKSPACE_RETENTION_DAYS`, `COMPOSE_CLEANUP_DRY_RUN`, `COMPOSE_CLEANUP_LIMIT`, `SPEC_FACTORY_SOURCE_DELETE_UNDO_MINUTES`, `SPEC_FACTORY_SOURCE_DELETE_SWEEP_MS`, `SPEC_FACTORY_SOURCE_DELETE_PURGE_LIMIT`, `SPEC_FACTORY_WORKER_HEARTBEAT_RETENTION_DAYS`, `SPEC_FACTORY_WORKER_HEARTBEAT_GC_LIMIT`, `COMPOSE_ARTIFACT_TMP_RETENTION_HOURS`, `COMPOSE_ARTIFACT_GC_LIMIT`, `COMPOSE_ARTIFACT_GC_MAX_DEPTH`, `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_RETENTION_DAYS`, `SPEC_FACTORY_LLM_AUDIT_ARTIFACT_GC_LIMIT`, `COMPOSE_S3_REACHABILITY_GC_ENABLED`, `COMPOSE_S3_REACHABILITY_GC_LIMIT` | Turn on source-deletion purge, archived-session retention, stale heartbeat purge, stale `.tmp` artifact GC, LLM audit artifact cleanup, and optional S3 reachability GC. |
| Grounding     | `COMPOSE_REPO_GROUNDING_ENABLED`, `COMPOSE_REPO_GROUNDING_TIMEOUT_MS`, `COMPOSE_REPO_GROUNDING_TOOL_BUDGET`, `COMPOSE_MAX_GROUNDED_REPOS`                                                                                                                                                                                                                                                                                                                                                                                         | Feature-flagged optional grounding.                                                                                                        |
| Conversion    | `COMPOSE_CONVERT_TIMEOUT_MS`, `COMPOSE_EXTRACT_AUDIO_TIMEOUT_MS`, `COMPOSE_TRANSCRIBE_SEGMENT_TIMEOUT_MS`, `COMPOSE_CONVERSION_LEASE_MS`, `COMPOSE_CONVERSION_POLL_MS`, `COMPOSE_VOXTRAL_MAX_REQUEST_BYTES`, `COMPOSE_MAX_UPLOAD_BYTES`                                                                                                                                                                                                                                                                                           | Lease + timeout knobs for `ComposeConversionWorker`.                                                                                       |
| Chat          | `COMPOSE_CHAT_MAX_PROMPT_TOKENS`, `COMPOSE_CHAT_TIMEOUT_MS`, `COMPOSE_MAX_QUEUED_TURNS`                                                                                                                                                                                                                                                                                                                                                                                                                                           | Turn scheduling and prompt-size guard.                                                                                                     |
| Retry         | `COMPOSE_RETRY_BASE_MS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Backoff base for transient chat-turn retries.                                                                                              |
| URL policy    | `COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Confluence host allowlist.                                                                                                                 |

**Valkey is the live event latency layer.** `ValkeySessionEventFanout` uses the Redis protocol for canonical cross-replica publication. MySQL still backs stream tokens, event ordering/replay, leases, and all product state; local development can omit Valkey and rely on cursor-batched durable polling.

### Smoke test the running service

Once `npm run spec-factory:dev` is up on 3012:

```bash
# health
curl -s localhost:3012/health

# create a session (route is under the router's mount prefix inside the app)
curl -s -X POST localhost:3012/sessions \
  -H 'content-type: application/json' \
  -d '{"name":"local-smoke","userName":"you"}'

# subscribe to the SSE stream (durable events + heartbeats)
curl -N localhost:3012/sessions/1/stream
```

The router paths are declared in [`compose-routes.ts:289+`](../../src/spec-factory/compose-routes.ts). When mounted inside the dashboard reverse proxy in production the prefix is `/api/spec-factory`; locally the router is mounted at the root.

## Testing conventions

Spec Factory tests run under Vitest via the repo-root `npm test` script (`package.json:13`). Vitest config sits at `vitest.config.ts`.

### How to run

- All Spec Factory tests: `npm test -- src/spec-factory/`.
- One file: `npm test -- src/spec-factory/session/session-guard.test.ts`.
- Watch loop: `npm test -- --watch src/spec-factory/compose-service.test.ts`.
- Type-check without running: `npm run type-check`.

Follow the patterns already established in the tree:

- **Every module owns a sibling `*.test.ts`.** No exceptions — the tree at `src/spec-factory/*.test.ts` covers ~30 files today. New modules must ship with tests in the same PR.
- **Prefer the compact table-driven form from `session-guard.test.ts:34-54`** when the same assertion applies to several inputs: a `const guards = [...]` tuple + a single `for (const [name, guard] of guards)` loop. It reads better than N separate `it` blocks.
- **Use zod-derived types from `compose-types.ts`** to build fixtures, e.g. `sessionSummary(overrides)` in `session-guard.test.ts:12-32`. Fixtures live inside the test file unless several tests share them.
- **`compose-service.test.ts`** is the reference for integration-style tests against the service. It stubs the repository at the interface level, not with `vi.mock`, so refactors do not silently break coverage.
- **`vi.stubEnv`** for env-var toggles (see `compose-chat-agent.test.ts:118, 151`). Never mutate `process.env` directly.
- **Timers**: `vi.useFakeTimers()` when asserting queue drain / lease expiration. Restore with `vi.useRealTimers()` in an `afterEach`.
- **DB tests**: `compose-database.test.ts` uses a real MySQL pool. Skip the file with `-- --exclude` locally if you have no MySQL, but every PR that touches `compose-database.ts` must run the full suite in CI.
- **HTTP tests**: `compose-routes.test.ts` uses `supertest` against `buildSpecFactoryApp()`. Prefer this shape over hand-rolled Express harnesses.
- **SSE tests**: `compose-sse.test.ts` covers publish → subscribe → replay. When adding a new event, extend the replay assertion so `Last-Event-ID` reconnect delivers the new type.

### What to test

For any new module, mirror the coverage matrix from `session-guard.test.ts`:

1. Happy path (returns expected value).
2. Every branch of every conditional.
3. Every thrown error path (message + type).
4. Env-var overrides via `vi.stubEnv`.
5. Boundary values (empty string, zero, negative, very-large).
6. Guard interactions (see [Guard hygiene](#guard-hygiene)).

## Adding a new source kind

Source kinds are the substrate for grounding. Each kind carries a converter, a route to create it, DB persistence, and a workspace materialization step. The lifecycle for a source is: **create row → converter runs under a lease → converted markdown lands in DB → workspace prepare copies it to `sources/*.md` → chat prompt references it.** The full checklist:

1. **Type**: extend `ComposeSourceKindSchema` at `compose-types.ts:11`. This is a zod enum — add the string literal to the array. TypeScript will surface every switch/exhaustive-check that must handle the new kind.
2. **Migration**: if the new kind carries kind-specific columns (e.g., a URL, an external ID, a channel), add a migration under `db/migrations/`. See [Adding a new migration](#adding-a-new-migration). If it fits inside the existing JSON `metadata` column on `compose_session_sources`, skip the migration.
3. **Repository writes**: add a repository method on `ComposeRepository` (see the upload-source insertion pattern near `compose-database.ts:4623`). Emit a `kind: '<newkind>'` row. Keep row shapes matching the `SourceRow` type.
4. **Route**: add `POST /sessions/:sessionId/<newkind>` in `compose-routes.ts` alongside the existing `/youtube`, `/jira`, `/confluence` handlers. Every handler must:
   - Call `actorFromRequest` (from `routes.ts`).
   - Delegate to a new `ComposeService.add<Newkind>Source` method that calls `requireMutableSession` before any DB write, following the source handlers around `compose-service.ts:1846-1923`.
   - Return the new source summary as JSON.
5. **Conversion**: teach `ComposeConversionWorker` how to convert the new kind. In `compose-conversion.ts:318+`, route the new kind to an existing converter (`markitdown`, `voxtral`) or add a new converter class. Update `ComposeConverterSchema` at `compose-types.ts:21` if you need a new converter enum value.
6. **Workspace materialization**: extend `ComposeWorkspaceManager.prepare` (`compose-workspace.ts:230`) so the converted Markdown lands under `sources/*.md` and is visible to the chat agent. Include kind-specific frontmatter (title, source URL, converted-at timestamp).
7. **Handoff**: if the new kind should feed the draft pipeline, wire it into `ComposeEvidenceProvider` so `SpecFactoryEvidenceCollector` sees it.
8. **Tests**: add cases to `compose-database.test.ts`, `compose-conversion.test.ts`, `compose-routes.test.ts`, and `compose-service.test.ts`. Cover: happy path, malformed payload, archived-session rejection (via the guard), converter timeout.
9. **Docs**: append the new kind to the terminology table in [`README`](./README.md) and to the source lifecycle in [architecture](./architecture.md).

### Worked example: skeleton for a Slack thread source

Illustrative only — do not merge without the tests and evidence-provider wiring above.

```ts
// compose-types.ts
export const ComposeSourceKindSchema = z.enum([
  "file",
  "youtube",
  "chat",
  "note",
  "jira",
  "confluence",
  "slack_thread", // <-- new
]);
```

```ts
// compose-service.ts (excerpt)
async addSlackThreadSource(input: {
  sessionId: number;
  actor: SpecFactoryActor;
  channelId: string;
  threadTs: string;
}) {
  const session = await this.requireMutableSession(input.sessionId); // guard first
  const source = await this.composeRepository.createSlackThreadSource({
    sessionId: session.id,
    channelId: input.channelId,
    threadTs: input.threadTs,
    actor: input.actor,
  });
  await this.composeConversionWorker.enqueue(source.id); // lease-based drain
  return source;
}
```

```ts
// compose-routes.ts (excerpt)
router.post("/sessions/:sessionId/slack", express.json(), async (req, res) => {
  const sessionId = positiveInt(req.params.sessionId, "sessionId");
  const actor = actorFromRequest(req);
  const { channelId, threadTs } = SlackThreadCreateSchema.parse(req.body);
  const source = await composeService.addSlackThreadSource({
    sessionId,
    actor,
    channelId,
    threadTs,
  });
  res.status(201).json(source);
});
```

The guard call at the top of `addSlackThreadSource` is load-bearing. Without it, an archived session can receive new sources — the archive-gate invariant from plan §9.1 fails.

**Status: Phase 6 partial.** `kind = 'generated_research'`, `source_origin`, the research executor, redaction, and artifact writer paths exist behind research flags. New generated-source work must preserve the existing `generated_by_task_id` idempotency fence and the final archive/lease checks in the repository layer.

## Adding a new capability (target — Phase 5+)

**Status: Phase 5 partial.** `compose_agent_tasks`, the worker loop, and executor registries exist. Add new capabilities through the existing registry shape rather than creating a new queue or worker loop. Source distillation and context merge keep deterministic defaults unless their `SPEC_FACTORY_ENABLE_CONTEXT_*_LLM` flag and `SPEC_FACTORY_LLM_GATEWAY=true` are both set; new direct model work should follow that opt-in gateway pattern.

The Phase 5 shape is:

- `compose_agent_tasks` — durable task rows with `capability`, `executor_type`, `input_json`, `lease` fields (plan §8.5).
- `CapabilityRegistry` — maps capability name → executor factory (plan §14.1).
- `ExecutorRegistry` — maps executor type → runtime binding (plan §14.2).
- Task claim/lease loop mirroring `compose_turn_jobs` semantics (plan §11.3).

When adding another capability, follow this shipped Phase 5 shape:

1. **Register the capability**: add `<capability-name>` to the capability enum and provide the executor mapping (plan §14.1).
2. **Executor implementation**: implement the executor class with the `run(input, ctx) -> output` shape defined in plan §14.3.
3. **Task-writer**: add a service method that inserts a `compose_agent_tasks` row with `capability = '<newkind>'`, `input_json = {...}`, and any `depends_on_task_id`. Do not block the caller.
4. **Artifacts**: use the two-phase artifact write protocol from plan §13.5. Never mutate Working Context directly (plan §3.5).
5. **SSE**: emit the canonical `task.queued` / `task.started` / `task.status` / `task.completed` / `task.failed` events through the durable publisher (plan §10.1). See [Adding a new SSE event](#adding-a-new-sse-event).
6. **Tests**: mirror the existing turn-job and agent-task test shape. Cover: claim, timeout, retry, cancellation, idempotent final output, and archive fencing where the executor mutates session state.

Do not introduce a parallel queue for new Spec Factory agent work. Use `compose_agent_tasks` for background capabilities, the turn capability seam for chat/coordination work, and the existing conversion worker for source-format conversion.

## Adding a new SSE event

Every new event must be added to the plan §10.1 vocabulary before code lands, then implemented in three places: publisher, durable event store, replay path.

**Status: v4 event path code-ready.** `ComposeSseHub` writes durable rows, bridges replay to local subscribers, receives canonical events through Valkey, and cursor-batches MySQL recovery reads. Valkey loss increases delivery latency but cannot change the durable order or replay result.

### Rules

- **Event type names are lowercase dot.case.** Never CamelCase. Examples that already ship: `assistant.final`, `message.created`, `readiness.updated`, `turn.status`, `task.started`, `task.completed`, and `error`. New names follow the canonical plan vocabulary — e.g., `task.status`, `context.updated`, `source.conversion.completed`.
- **Payload is JSON.** Keys are camelCase in the payload body. The event `type` is lowercase.dot.case, the payload keys are camelCase — this split is intentional and mirrored across all existing events.
- **Every event is durable.** The `durableEventType` mapping at `compose-sse.ts:65-86` names each event so `ComposeSseEventStore.appendSessionEvent` (`compose-sse.ts:239-287`, `compose-database.ts:1817`) can persist it before live fan-out. When `SPEC_FACTORY_DURABLE_EVENTS=required`, failed durable writes synthesize an `event_persist_failed` error event instead of silently downgrading to live-only delivery.
- **Replay honors `Last-Event-ID` and `?after=`.** `GET /sessions/:sessionId/stream` (`compose-routes.ts:746-819`) calls `listSessionEventsAfter` (`compose-database.ts:1878`) to backfill, subscribes with a paused live cursor, re-reads the durable store for the replay/live gap, lowers the cursor, and performs a final durable catch-up while skipping rows already delivered live. New event types automatically replay once they are in the durable event store — no route change needed.

### Steps

1. **Extend the vocabulary**: append the new event name and payload schema to plan §10.1 in the same PR (or a preceding one).
2. **Extend `ComposeChatEvent`** (or introduce a sibling union type) in `compose-types.ts` with a zod schema and inferred type.
3. **Extend `durableEventType`**: add a case in `compose-sse.ts:65-86` mapping the new discriminant to its wire name.
4. **Publish**: call `ComposeSseHub.publish(sessionId, event)` from the code path that produces the event. The hub handles both durable append and live delivery (`compose-sse.ts:219-287`).
5. **Frontend**: update the SSE consumer (in `dashboard/`) to handle the new type. Ignore unknown types silently — never crash on a type the frontend does not know yet.
6. **Tests**: cover in `compose-sse.test.ts` — publish → durable append → live delivery → replay after reconnect with `Last-Event-ID`.

### Do not

- Do not add per-event SSE routes. Everything flows through `GET /sessions/:sessionId/stream`.
- Do not emit CamelCase event types. `MessageCreated` is wrong; `message.created` is right.
- Do not skip the durable append. Live-only events break replay when a client reconnects.

## Adding a new migration

Spec Factory shares the repo-wide `db/migrations/` directory. Migrations run in filename order via the standard tooling.

### Numbering

- Inspect `db/migrations/` for the highest filename number. Today the highest is `067_compose_workspace_manifests.sql`.
- Pick the **next unused integer**. For migrations that ship on top of `067_compose_workspace_manifests.sql`, use `068_*` etc.
- Name pattern: `<zero-padded-number>_<snake_case_scope>.sql`. Prefix with `compose_` for Compose-owned tables, `spec_factory_` for the legacy pipeline.

### Column and constraint conventions

Follow migration 053 as the reference (`db/migrations/053_compose_session_events_and_stream_tokens.sql:1-38`):

- `TIMESTAMP(3)` for every timestamp column. Millisecond precision is required for lease and event ordering.
- `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` for `created_at`.
- `TIMESTAMP(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` for `updated_at` when a row is mutated in place.
- Named foreign keys: `CONSTRAINT fk_<table>_<referenced>` (e.g., `fk_compose_session_events_session`).
- Named unique keys: `UNIQUE KEY uniq_<table>_<cols>`.
- Named indexes: `INDEX idx_<table>_<cols>`.
- `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci` on every table.
- `JSON` for structured metadata columns. Never `TEXT` for JSON-shaped payloads.

### Backfill

- Include the backfill SQL in the same migration file when a column is added with a `NOT NULL` constraint on an existing table. Do it in three statements: `ALTER TABLE ... ADD COLUMN ... NULL`; `UPDATE ...`; `ALTER TABLE ... MODIFY COLUMN ... NOT NULL`.
- Never rely on application code to backfill during startup — the migration must be self-contained.

### After landing

1. Update `ComposeRepository` (or `SpecFactoryRepository`) row types to reflect the new schema.
2. Update fixtures across `*.test.ts`.
3. Add a note in [architecture](./architecture.md) if the migration introduces a new durable surface.

## Guard hygiene

**Every service method that touches a session must call the appropriate guard before reading or writing state.** No exceptions. Phase 0 archive-gate enforcement lives in `src/spec-factory/session/session-guard.ts:38-82`.

### Guard functions

| Guard                         | Use when                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `assertSessionExists`         | You need to prove the row exists but do not care about status. Rare — prefer a stronger guard.                              |
| `assertSessionReadable`       | Any read path (`GET /sessions/:sessionId`, list messages, list sources). Rejects archived sessions with a 404-shaped error. |
| `assertSessionMutable`        | Any write path (add source, post message, request note). Same policy as readable today; Phase 0 does not enforce owner.     |
| `assertSessionStreamable`     | Every `GET /sessions/:sessionId/stream` connection. Blocks archived-session subscribers.                                    |
| `assertSessionHandoffAllowed` | Only `POST /sessions/:sessionId/handoff`. Enforces the terminal transition contract from plan §9.1.                         |

All four guards throw `Error("Compose session <id> was not found")` when the session is archived (`session-guard.ts:53-57`). This is deliberate — archived sessions must be invisible to non-admins.

### Service wrappers

`ComposeService` wraps the raw guards behind four private methods (`compose-service.ts:4000-4039`) that resolve the session from the repository and hand it to the appropriate `assert*` function with `SYSTEM_ACTOR`:

- `requireReadableSession(sessionId)`
- `requireMutableSession(sessionId)`
- `requireStreamableSession(sessionId)`
- `requireHandoffAllowedSession(sessionId)`

**Call these wrappers, not the raw guards, from every `ComposeService` method.** Existing public methods do this before mutating or returning protected session data; match the pattern in new methods:

```ts
async addNewSource(input: AddNewSourceInput) {
  const session = await this.requireMutableSession(input.sessionId);
  // ...write path...
}
```

### Route-level guards

Route handlers must not skip the service wrapper. If a route touches session state through the repository directly, it bypasses the archive gate. The only route that reads a session without a service call is the archived-session-tolerant admin path (does not exist today) — every other handler in `compose-routes.ts` delegates to a `ComposeService` method that calls a `require*Session` wrapper first.

### Tests

Every new service method needs a test that:

1. Passes for a non-archived session (`sessionSummary({ status: "ready" })` fixture from `session-guard.test.ts:44`).
2. Throws for an archived session (`sessionSummary({ status: "archived" })`).

This is table-driven in `session-guard.test.ts:34-54` — copy the pattern.

## Common pitfalls

- **Do not use `composeRepository.getSession` for pre-read authorization or branch decisions.** Direct reads bypass the archive gate. In `ComposeService`, raw `getSession` calls are allowed only for create/import/post-write refreshes that immediately wrap the row in `requireSession`, or inside the `require*Session` wrappers. Grep before merging: `rg -n "composeRepository\\.getSession" src/spec-factory/compose-service.ts` should show only those refreshes plus the wrapper call sites.
- **Do not append messages outside the durable idempotency contract.** API message/analyze requests create `compose_turn_jobs` with a stable `Idempotency-Key`; final assistant writes are fenced through `compose_turn_outputs`. New turn paths must preserve the same request hash, lease generation, archive check, and single-final invariant.
- **Do not publish CamelCase SSE events.** The `durableEventType` mapping (`compose-sse.ts:65-77`) uses lowercase dot.case. Frontends and replay consumers pattern-match on the lowercase form.
- **Do not put new LLM logic outside the LLM Gateway.** **Status: Phase 8 partial plus v4 Work Order C.** `LlmGateway` owns purpose-scoped direct Bedrock Converse routing, the Agent SDK rollback transport, structured calls, audit rows, prompt-version validation, optional budget pre-flight checks, and DB-backed prompt registry resolution when `SPEC_FACTORY_PROMPT_REGISTRY_SOURCE=db`. Legacy `ComposeChatAgent` and tool-enabled research still call the Claude Agent SDK directly. New tool-free LLM call sites must route through `LlmGateway` with a purpose, explicit prompt version, structured input, structured output, and budget metadata where applicable.
- **Do not bypass the canonical event layer.** MySQL is the durable event source and Valkey provides low-latency cross-replica fanout. New events must use the outbox/canonical vocabulary and preserve replay cursors; direct process-local publication is not an authoritative path.
- **Do not bypass the runtime resolver.** `SPEC_FACTORY_MODE` is centralized in `resolveSpecFactoryRuntime` (`server.ts`). Add or change mode behavior there and update the capability-to-queue map, Terraform service role, heartbeat capabilities, and operations matrix in the same change.
- **Do not add a synthetic COMPOSE source directly from a new handoff site.** Use `ComposeService.handoff` (`compose-service.ts:1319-1746`). It owns the idempotency contract for `COMPOSE-<sessionId>` and coordinates with `SpecFactoryRepository.createComposeSource`.
- **Do not swallow conversion errors.** `isTransientConversionError` (`compose-conversion.ts:68`) classifies retryable failures. New converters must call it before deciding to retry.
- **Do not exceed the ~150k prompt-token guard.** `ComposeChatPromptTooLargeError` (`compose-chat-agent.ts:29`) is thrown when the assembled prompt is too large. The remedy is to trim `context.md` or drop repo grounding — never widen the guard.

## Code style

- **TypeScript strict.** `tsconfig.json` enables strict mode across `src/`. Run `npm run type-check` before pushing.
- **No default exports.** Everything is a named export. This matches the existing tree and keeps rename refactors safe.
- **Imports are `.js`-suffixed relative paths.** Node ESM resolution requires the `.js` extension even in `.ts` source. See any file in `src/spec-factory/` for the pattern (e.g., `compose-service.ts:29-34` importing `./session/session-guard.js`).
- **Absolute vs relative.** The codebase uses relative imports inside `src/spec-factory/` (e.g., `./compose-types.js`) and cross-module relative imports across `src/` (e.g., `../orchestrator/database.js`). Do not introduce path aliases — none exist in `tsconfig.json`.
- **Zod for external I/O.** Every HTTP payload, every DB row shape that leaves the repository, and every SDK envelope parses through a zod schema in `compose-types.ts`. Never rely on `as`.
- **No `console.log` in production paths.** Use structured logging via the orchestrator logger where one is wired. `compose-conversion.ts` and `compose-retention.ts` use plain `console.log` today — that's the existing convention until a structured logger arrives.
- **Prefer explicit `const enum`-less unions.** Zod enums (`z.enum([...])`) are the canonical enum form. See `compose-types.ts:11, 21, 24, 36`.
- **Async everywhere.** No sync FS or DB. `fs/promises` and `mysql2/promise`.
- **Formatting.** `npm run format` runs Prettier (`package.json:16`). Match the existing 2-space indent and trailing commas.
- **Test files sit next to source.** Never a `__tests__/` folder; always `foo.ts` + `foo.test.ts` in the same directory.

## PR checklist

Every Spec Factory PR must satisfy the following before requesting review. Reviewers reject PRs that skip any item.

1. **Types pass.** `npm run type-check` exits clean.
2. **Tests pass.** `npm test -- src/spec-factory/` exits clean. Every new module ships with a sibling `.test.ts` and every guard-touching method has archived-session coverage.
3. **Guards called.** Every new `ComposeService` method that reads or writes session state calls `requireReadableSession`, `requireMutableSession`, `requireStreamableSession`, or `requireHandoffAllowedSession`. Grep before pushing: `grep -c "require.*Session" src/spec-factory/compose-service.ts` should not decrease.
4. **No CamelCase SSE events.** New event types are lowercase dot.case and appear in `durableEventType` (`compose-sse.ts:65`).
5. **Valkey is fanout-only.** Redis-protocol access stays behind `SessionEventFanout`; no token, lease, ordering, or final-output authority moves out of MySQL.
6. **No ad hoc `SPEC_FACTORY_MODE` branching.** Use `resolveSpecFactoryRuntime` and its `SPEC_FACTORY_WORKSPACE_MANAGER` gate.
7. **No direct `composeRepository.getSession` outside the wrappers.** Grep: `grep -n "composeRepository.getSession" src/spec-factory/`.
8. **Plan citations for target-behavior scaffolding.** If the PR lays groundwork for a later phase (e.g., adds `idempotency_key` columns, adds an executor stub, adds an event type reserved for future use), the PR description cites the plan section (`§N.M`) that motivates the shape.
9. **Migration numbering correct.** New migrations pick the next unused integer under `db/migrations/`, use `TIMESTAMP(3)`, named FKs, and `ENGINE=InnoDB` + `utf8mb4_unicode_ci`.
10. **Docs updated.** If the change alters an invariant, the terminology table in [`README`](./README.md), the surface diagram in [architecture](./architecture.md), or the runbooks in [operations](./operations.md) get the same PR.
11. **No emoji in code or docs** unless the surrounding file already uses them (Spec Factory files do not).

## Further reading

- [Architecture](./architecture.md) — process, data, and event topology.
- [Operations](./operations.md) — env vars, alarms, replay, retention.
- [Plan v3](../superpowers/spec-factory/spec_factory_transformation_plan_v3.md) — canonical target design. Cite §N.M for every target-behavior claim.
- `src/spec-factory/session/session-guard.test.ts` — the reference shape for a small, focused test file.
- `src/spec-factory/compose-service.test.ts` — the reference shape for service-level integration tests.
