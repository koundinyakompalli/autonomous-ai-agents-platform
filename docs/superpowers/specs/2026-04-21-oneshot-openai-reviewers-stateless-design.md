# OneShot OpenAI Reviewers: Stateless Redesign

## Status

Draft for review.

This document proposes a redesign of the OneShot `REVIEWER` and `CODE_REVIEWER`
stages so they no longer rely on OpenAI Responses API conversation state via
`previous_response_id`.

The goal is to make the reviewer loop compatible with a strict Zero Data
Retention posture while preserving the current user-facing behavior:

- reviewer can inspect a frozen workspace with local repo tools
- reviewer can iterate through tool calls before producing structured JSON
- planner/code-review artifacts and queue transitions stay unchanged

The implementation should also preserve a clean extension point for a future
stateful mode if reviewer/code-reviewer are ever moved onto an OpenAI project
that is allowed to use provider-side continuation state.

---

## Problem

Today the OpenAI reviewer loop is stateful:

- initial request is created in `src/openai-sdk/index.ts`
- when the model emits tool calls, the app executes local repo tools
- continuation requests are sent with `previous_response_id`

Current stateful continuation path:

- `buildContinuationRequest(...)` in `src/openai-sdk/index.ts`
- `previous_response_id` is set there
- `runOpenAiAgent(...)` depends on that response ID for follow-up turns

The current OneShot providers depending on this loop are:

- `src/oneshot/providers/openai-reviewer.ts`
- `src/oneshot/providers/openai-code-reviewer.ts`

Because production treats this continuation pattern as incompatible with the
current Zero Data Retention requirement, both stages are disabled and bypassed
in production config today.

Concrete operational requirement:

- OneShot reviewer and code-reviewer must not depend on provider-side
  conversation state in production.
- This requirement is reflected operationally in the current
  `oneshot_reviewer_enabled = false`,
  `oneshot_code_reviewer_enabled = false`, and corresponding
  `*_bypass_reason` values in `terraform/shared.auto.tfvars`.

This document does **not** propose changing prompts, schemas, verdict logic, or
queue/state transitions. It only changes how the OpenAI loop carries context
across turns.

---

## Goals

1. Remove `previous_response_id` from reviewer/code-reviewer execution.
2. Preserve tool-using multi-turn review behavior.
3. Keep the loop self-contained inside the ECS task and local workspace.
4. Preserve structured JSON outputs and existing stage schemas.
5. Keep token/cost accounting and tool-call accounting intact.
6. Make the OpenAI loop testable without a live OpenAI endpoint via mocks, and
   reproducible given a fixed mocked transcript.
7. Keep p95 reviewer/code-reviewer total input tokens within 2x of the current
   stateful baseline after rollout.
8. Make continuation mode an explicit SDK concept so a future non-ZDR rollout
   can opt into stateful continuation without re-architecting the loop.

---

## Non-goals

1. Do not redesign reviewer prompts or scoring rubrics.
2. Do not change OneShot queue/state semantics.
3. Do not change repo tool capabilities in this pass.
4. Do not switch providers in this pass.
5. Do not solve every OpenAI SDK concern; this is specific to the OpenAI SDK
   continuation strategy used by reviewer/code-reviewer.

---

## Current Architecture

### Current OpenAI agent loop

File: `src/openai-sdk/index.ts`

Current flow:

1. Send initial `responses.create(...)` request with:
   - model
   - instructions
   - input
   - tools
   - JSON schema response format
2. Parse function calls from `response.output`
3. Execute local repo tools
4. Build `function_call_output` items
5. Send another `responses.create(...)` request with:
   - `previous_response_id`
   - tool outputs
   - tools
6. Repeat until there are no function calls

The stateful dependency is step 5.

### Current repo tools

File: `src/openai-sdk/repo-tools.ts`

The repo tools are already local and stateless from the model's perspective:

- directory listing
- glob search
- grep search
- file reads
- diff reads

This is good for the redesign: the state problem is not the tools themselves,
but the continuation strategy.

### Current reviewer providers

Files:

- `src/oneshot/providers/openai-reviewer.ts`
- `src/oneshot/providers/openai-code-reviewer.ts`

These providers do not manage turns themselves. They delegate completely to
`runOpenAiAgent(...)`. That means the stateless redesign should stay mostly
inside `src/openai-sdk/index.ts`.

---

## Proposed Target Design

### Core change

Replace OpenAI provider-side conversation continuation with **client-managed
stateless continuation**.

Architecture note:

- continuation mode should become an explicit internal concept:
  - `stateless`
  - `stateful`
- initial implementation and rollout only enable `stateless`
- `stateful` remains a future extension point for non-ZDR projects
- the first implementation should not keep two fully active production paths

Instead of:

- request 1
- tool calls
- request 2 with `previous_response_id`

Use:

- request 1
- capture enough output items from response 1
- tool calls
- request 2 with explicit input items containing:
  - relevant prior assistant output items
  - prior reasoning items needed for continuation
  - tool outputs

The loop remains multi-turn, but each request becomes self-contained.

### Context model

Maintain an in-memory transcript inside `runOpenAiAgent(...)`:

- original user prompt
- prior assistant items from the Responses API
- prior reasoning items needed for continuation
- tool outputs produced by the local tool executor

At each iteration:

1. append the latest response items to the transcript
2. append `function_call_output` items for executed tools
3. send the next request with the transcript as explicit `input`
4. never set `previous_response_id`

### Reasoning continuity

Support reasoning-model continuation in stateless mode by including encrypted
reasoning content in each request and carrying forward reasoning items returned
by the Responses API.

Implementation expectation:

- initial request includes `include: ["reasoning.encrypted_content"]`
- continuation requests also include the same
- only `reasoning` items that contain `encrypted_content` are carried into the
  next request
- plain summary-only reasoning items are dropped

Fallback behavior:

- if the initial request with `include: ["reasoning.encrypted_content"]` is
  rejected, retry exactly once without the `include` parameter and mark the
  session as `encryptedReasoningUnavailable`
- if that retry succeeds, continue in degraded stateless mode for the rest of
  the run without reasoning carry-forward
- if the retry without `include` also fails, fail the run rather than retrying
  indefinitely or silently masking a broader request-shape problem
- if the request is accepted but the response does not return any reasoning
  items with `encrypted_content`, continue in degraded stateless mode for the
  rest of the run without reasoning carry-forward
- this fallback should log once at `info` when encrypted reasoning is accepted,
  and once at `warn` when it is unavailable and the loop is degrading to
  non-reasoning carry-forward mode

This preserves reasoning continuity without provider-side conversation state.

### Request-building model

Split request building into two explicit phase-1 paths:

1. `buildInitialResponseRequest(options, tools, continuationMode)`
2. `buildStatelessContinuationRequest(options, transcriptItems, tools)`

Remove:

- the current generic `buildContinuationRequest(...)` with `previous_response_id`

Target shape:

- the generic SDK has an explicit continuation-mode boundary
- phase 1 implements only the `stateless` branch
- `ContinuationMode` may still expose `stateful` at the type/config boundary,
  but selecting it must fail fast because there is no phase-1 stateful builder
- a future non-ZDR rollout can add a real
  `buildStatefulContinuationRequest(...)` implementation without redesigning
  the stateless path

### Response item retention strategy

Keep the loop conservative and explicit:

- retain `message` items
- retain `reasoning` items only when they contain `encrypted_content`
- retain `function_call` items
- retain `function_call_output` items

Do **not** attempt transcript summarization or compaction in phase 1.

That keeps the first stateless version simple and makes behavior easier to
diff against the current implementation.

Explicitly:

- do **not** carry arbitrary provider annotations or unsupported item types
- do **not** attempt item-type inference beyond the allowlist above

---

## Detailed Patch Plan

### Phase 1: Introduce stateless transcript primitives

File: `src/openai-sdk/index.ts`

Add helper functions:

- `extractOutputItems(payload): Array<Record<string, unknown>>`
- `filterContinuationItems(items): Array<Record<string, unknown>>`
- `buildInitialResponseRequest(options, tools): Record<string, unknown>`
- `buildStatelessContinuationRequest(options, transcriptItems, tools): Record<string, unknown>`

Rules:

- `filterContinuationItems(...)` should keep only:
  - `message`
  - `reasoning` with `encrypted_content`
  - `function_call`
  - `function_call_output`
- `reasoning` items without `encrypted_content` should be dropped
- unsupported output item types should be dropped
- item filtering should be logged at debug level by item type count

Also add a first-call encrypted-reasoning probe:

- discover encrypted-reasoning availability lazily on the first real reviewer
  request in a run, not via separate startup preflight
- initial request asks for `include: ["reasoning.encrypted_content"]`
- if the API rejects that request shape, retry once without the `include`
  parameter and mark the session as `encryptedReasoningUnavailable`
- log this downgrade once so it is visible in rollout diagnostics

Also add continuation-mode configuration validation:

- introduce an explicit config concept such as `OPENAI_CONTINUATION_MODE`
- supported values should be:
  - `stateless`
  - `stateful`
- initial rollout only implements `stateless`
- if `stateful` is ever enabled in the future while the project remains under
  the production ZDR requirement, startup/config validation should fail fast
- in phase 1, selecting `stateful` should fail immediately rather than routing
  into dead or partially implemented continuation code

### Phase 2: Replace `previous_response_id` loop

File: `src/openai-sdk/index.ts`

Refactor `runOpenAiAgent(...)`:

Current:

- create first response
- on tool calls, send continuation with `previous_response_id`

Target:

- create first response
- accumulate retained response items in `conversationItems`
- after tool execution, append `function_call_output` items
- call `responses.create(...)` with:
  - `instructions`
  - `input: conversationItems`
  - `tools`
  - `text.format`
  - `reasoning`
  - `include: ["reasoning.encrypted_content"]`

Constraints:

- do not mutate the original `userPrompt`
- preserve current token accounting accumulation
- preserve `toolCallCount`
- do not ship a feature-flagged fallback to `previous_response_id`

Hard constraint:

- stateless continuation replaces the old path completely
- there is no production-supported stateful continuation mode in the initial
  rollout of this redesign

Rationale:

- reviewer/code-reviewer are already disabled in prod today
- maintaining two code paths adds unnecessary policy ambiguity and review burden
- the ZDR-driven constraint should be enforced structurally, not optionally

Refinement:

- the code structure should still preserve a future stateful extension point at
  the type/config boundary
- phase 1 does **not** implement `buildStatefulContinuationRequest(...)`
- if `stateful` is selected in phase 1, the SDK should fail fast with a clear
  “not implemented for ZDR rollout” error rather than maintaining a hidden
  alternate code path

### Phase 3: Keep final-output semantics unchanged

File: `src/openai-sdk/index.ts`

Do not change:

- `extractResponseText(...)`
- `extractUsage(...)`
- success/failure return shape
- the cost-calculation function itself

Expected nuance:

- the calculation function stays the same
- its inputs will likely be higher in stateless mode because prior turn items
  are resent explicitly

Expected result:

- callers in `openai-reviewer.ts` and `openai-code-reviewer.ts` do not need
  logic changes beyond possible comments and extra tests

### Phase 4: Add loop diagnostics

File: `src/openai-sdk/index.ts`

Add debug/info logging for:

- stateless mode enabled
- continuation item count per turn
- item types retained per turn
- reasoning item count retained
- tool output count appended
- encrypted reasoning available vs. degraded mode
- transcript growth sentinel:
  - `itemCount`
  - `estimatedInputTokens`
  - `turn`
  - log tag: `[OPENAI_TRANSCRIPT_GROWTH]`

Do not log raw reasoning content.

### Phase 5: Keep providers unchanged except comments/tests

Files:

- `src/oneshot/providers/openai-reviewer.ts`
- `src/oneshot/providers/openai-code-reviewer.ts`

Changes should be minimal:

- no change to prompt composition
- no change to schema parsing

No provider-specific “stateless” comments are required. If documentation is
added, prefer a single load-bearing module comment in
`src/openai-sdk/index.ts`.

---

## Test Plan

### Unit tests for OpenAI stateless loop

File: `src/openai-sdk/index.test.ts`

Add tests for:

1. **single-turn final response**
   - unchanged behavior

2. **tool-call continuation without `previous_response_id`**
   - mock first response with function call
   - verify second request does **not** include `previous_response_id`
   - verify second request includes explicit `input` items from prior turn

3. **reasoning item carry-forward**
   - mock first response containing reasoning items with encrypted content
   - verify next request includes those reasoning items in `input`
   - verify plain summary-only reasoning items are dropped

4. **tool error carry-forward**
   - existing behavior preserved
   - tool error is encoded as `function_call_output`
   - no `previous_response_id`

5. **multi-tool / multi-turn continuation**
   - at least two continuation turns
   - verify transcript accumulates correctly

6. **token accounting unchanged**
   - usage aggregation still sums all turns correctly
   - concrete assertion:
     - if turn 1 reports `input_tokens = A`
     - and turn 2 reports `input_tokens = X`, `cached_input_tokens = Y`
     - then aggregated `totalInputTokens` should equal `A + X`
     - it must **not** equal `A + X + Y`
     - it must **not** equal `A + (X - Y)`

7. **encrypted reasoning unavailable fallback**
   - first request with `include: ["reasoning.encrypted_content"]` fails
   - second attempt retries without that `include`
   - if the retry succeeds, the loop continues statelessly without reasoning
     carry-forward for the rest of the run
   - if the retry also fails, the run fails explicitly

8. **idempotency / retry stability**
   - run the same mocked transcript twice
   - assert verdict category / decision class matches
   - do not require identical prose

### Regression tests for reviewer providers

Files:

- `src/oneshot/providers/openai-reviewer.test.ts`
- `src/oneshot/providers/openai-code-reviewer.test.ts`

Add or extend tests to verify:

- reviewer still parses valid structured output
- code-reviewer still parses valid structured output
- no provider contract changes are needed

### Negative tests

Add cases for:

- response missing output items needed for continuation
- malformed reasoning item payloads
- max tool iterations still enforced
- transcript growth sentinel logging on each continuation turn

---

## Rollout Plan

### Step 1: Land stateless loop as the only OpenAI continuation path

There is no feature flag in the initial rollout.

Reasons:

- the old path is already operationally dead in production because reviewer
  stages are bypassed
- a temporary dual-path rollout adds maintenance burden without meaningful
  benefit
- the ZDR-driven constraint should be enforced structurally, not optionally

However, the code should still introduce a formal continuation-mode concept so
future work can add `stateful` back cleanly if reviewer/code-reviewer ever move
to a non-ZDR OpenAI project.

### Step 2: Validate in lower environment

Validate:

- reviewer completes with repo tool calls
- code-reviewer completes with repo tool calls
- no `previous_response_id` is sent
- responses remain valid against current schemas
- token usage/cost remain within expected range
- dry-run against 2-3 real tickets before production enablement
- verify output structure:
  - JSON parses
  - score field present
  - no refusal/plain-text fallback messages leaking into output

### Step 3: Re-enable OneShot reviewer stages

After stateless validation:

- set `oneshot_reviewer_enabled = true`
- set `oneshot_code_reviewer_enabled = true`

Files likely affected operationally:

- `terraform/shared.auto.tfvars`

Operational guardrails:

- first 24h after re-enable, monitor per-run reviewer/code-reviewer cost
- define an alert threshold before rollout; initial target should be based on
  current reviewer/code-reviewer expected cost envelope
- specifically watch `[OPENAI_TRANSCRIPT_GROWTH]` logs for runaway input size
- if p95 total input tokens exceeds the 2x baseline target in the first 24h,
  do not treat rollout as complete; open a follow-up for selective compaction
  of older `function_call_output` items before broadening the rollout
- if transcript growth also breaches the per-run cost alert threshold, be ready
  to re-disable reviewer/code-reviewer until that follow-up lands

### Step 4: Remove bypass language after successful rollout

Once reviewers are re-enabled and stable:

- remove the temporary ZDR bypass reasons from Terraform/docs

---

## Open Questions For Review

1. Do we want to support transcript compaction in this same redesign, or keep
   the first implementation intentionally unoptimized and only add compaction
   as a follow-up if the 2x token-growth target is missed?

Deferred future-mode question:

- when a future `stateful` mode is scheduled, we still need to decide whether
  it is selected purely by env or also gated by an explicit project capability
  check at startup; that decision is non-blocking for this stateless rollout

---

## Success Criteria

1. Reviewer and code-reviewer can execute multi-turn tool-using review loops
   without `previous_response_id`.
2. Structured JSON outputs remain unchanged.
3. Provider call sites stay stable.
4. The loop is compatible with the current production ZDR requirement because
   no provider-side continuation state is required.
5. Production can re-enable both review stages and remove the current bypass.
6. p95 total input tokens per reviewer run stays within 2x of the current
   stateful baseline after rollout.
7. The SDK exposes continuation mode explicitly enough that a future non-ZDR
   stateful implementation can be added without redesigning the public
   reviewer/provider contracts.

---

## Reviewer Checklist

- Does the stateless transcript model preserve enough context for reliable
  multi-turn review?
- Are reasoning items handled correctly for reasoning models, including the
  “encrypted_content unavailable” fallback?
- Is the proposed first implementation intentionally simple enough to de-risk
  rollout?
- Is it acceptable that this ships as a generic OpenAI SDK change for all
  callers, given OneShot reviewer/code-reviewer are the only current callers?
- Is the continuation-mode boundary designed cleanly enough that `stateful`
  could be added later without reopening the stateless/ZDR rollout?
- Is there any missing test coverage around tool-call chaining or structured
  output parsing?
