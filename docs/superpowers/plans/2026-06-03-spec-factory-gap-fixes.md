# Spec Factory Gap Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the correctness and reliability gaps found in the June 3 latest-main Spec Factory review.

**Architecture:** Keep fixes scoped to Spec Factory and Compose. Treat Compose workspace materialization as the durable seam: converted sources, notes, `sources-index.md`, `chat.md`, and `context.md` must be visible both to the clarification agent and to the final draft evidence provider. Keep mutation APIs idempotent and route-scoped so retries and concurrent calls do not create duplicate Jira or cross-session state.

**Tech Stack:** Node/TypeScript, MySQL schema/migrations, React/Vite/Vitest, Jira REST integration, S3 presigned uploads, ECS/Terraform.

**Review Baseline:** Latest default branch after fetch was `origin/main@6e3d0d1` (`Fix Compose UI: restore production-grade styling + unblock side-nav (#263)`). The repo has no `origin/master`; `origin/HEAD` points to `origin/main`.

---

## Execution Order

1. P0 evidence/schema/idempotency fixes.
2. P1 Compose route scoping and worker recovery.
3. P2 UX and roadmap follow-through.
4. Full focused test/build verification.

---

## Task 1: Fix Compose Workspace and Evidence Packaging

**Files:**
- Modify: `src/spec-factory/compose-workspace.ts`
- Modify: `src/spec-factory/compose-service.ts`
- Modify: `src/spec-factory/compose-evidence-provider.ts`
- Modify: `src/spec-factory/compose-database.ts` if repository signatures need richer source metadata
- Test: `src/spec-factory/compose-workspace.test.ts`
- Test: `src/spec-factory/compose-service.test.ts`
- Test: `src/spec-factory/compose-evidence-provider.test.ts`

**Checklist:**
- [x] Extend `ComposeWorkspaceManager.prepare` so it can materialize converted source rows into `workspace/sources/*.md`.
- [x] Generate `workspace/sources-index.md` from the materialized source filenames and source ids.
- [x] Ensure note sources are written into `sources/*.md`, not only stored in `compose_session_sources.markdown_content`.
- [x] In `ComposeService.runTurn`, fetch converted session source contents before preparing the workspace and pass them into `prepare`.
- [x] After each assistant reply is persisted, rewrite `chat.md` with the final message list so immediate handoff sees the latest assistant turn.
- [x] When `contextMarkdown` is returned, write/update `context.md` in the same final workspace refresh.
- [x] Update `ComposeEvidenceProvider.collect` to include workspace `context.md`, `sources-index.md`, and `chat.md` in the `EvidenceManifest`.
- [x] Keep converted source bodies in the evidence manifest as well.
- [x] Add a regression test where the operator answers a blocking question in chat, then handoff evidence includes that answer via `chat.md`.
- [x] Add a regression test where a pasted note appears in `sources/*.md` for the clarification agent.
- [x] Add a regression test where `context.md`, `sources-index.md`, `chat.md`, and converted sources are all present in the Compose evidence manifest.

**Verification:**
- [x] `npm test -- src/spec-factory/compose-workspace.test.ts src/spec-factory/compose-service.test.ts src/spec-factory/compose-evidence-provider.test.ts`
- [x] `npm run build`

---

## Task 2: Sync Fresh Schema With Applied Migrations

**Files:**
- Modify: `db/schema.sql`
- Test: `src/spec-factory/database.test.ts` if existing schema assertions cover source states

**Checklist:**
- [x] Add `not_qualified` to `spec_factory_sources.state` in `db/schema.sql`.
- [x] Add `qualification_reasons_json JSON NULL` after `approved_epic_key` in `db/schema.sql`.
- [x] Confirm `db/schema.sql` matches `db/migrations/035_spec_factory_qualification_archive.sql`.
- [x] Add or update a repository/schema test that covers `not_qualified` writes if there is a local schema assertion pattern.

**Verification:**
- [x] `npm test -- src/spec-factory/database.test.ts src/spec-factory/service.test.ts`
- [x] `npm run build`

---

## Task 3: Make `Approve Epic` Idempotent

**Files:**
- Modify: `src/spec-factory/service.ts`
- Modify: `src/spec-factory/jira-publisher.ts`
- Modify: `src/spec-factory/database.ts` if additional reads are needed for existing approved Epic/children
- Test: `src/spec-factory/service.test.ts`
- Test: `src/spec-factory/jira-publisher.test.ts` if a publisher test file is introduced

**Checklist:**
- [x] Replace the current behavior tested as "always asks the publisher to create a new Epic".
- [x] If `spec_factory_sources.approved_epic_key` already exists, reuse it instead of creating a duplicate Epic.
- [x] If a child already has a Jira key, skip creating that child.
- [x] If the Epic exists but some children are missing, create only missing children and persist each key as soon as it is returned.
- [x] Preserve current partial-failure visibility: failures after some children are created must leave persisted keys for retry.
- [x] Add a retry test for "Epic already exists, all children already exist" where no Jira create calls occur.
- [x] Add a retry test for "Epic exists, one child exists, one child missing" where only the missing child is created.
- [x] Add a partial-failure retry test where the first run persists an Epic and one child, the retry completes the rest.

**Verification:**
- [x] `npm test -- src/spec-factory/service.test.ts`
- [x] `npm run build`

---

## Task 4: Harden `OneShot Now`

**Files:**
- Modify: `src/spec-factory/service.ts`
- Modify: `src/spec-factory/oneshot-submitter.ts` if label/run-request idempotency needs to move down a layer
- Modify: `src/spec-factory/database.ts` if additional child state reads are needed
- Test: `src/spec-factory/service.test.ts`

**Checklist:**
- [x] Reject `oneShotNow` when `listApprovedChildren(sourceId)` returns an empty list.
- [x] Return a clear operator-facing error instead of marking the source `oneshot_submitted`.
- [x] Skip already submitted children where a request id/state already exists.
- [x] Ensure retrying `oneShotNow` does not duplicate PFOS labels or active run requests.
- [x] Add a test that zero children does not call the submitter and does not mark the source submitted.
- [x] Add a retry/idempotency test for already submitted children.

**Verification:**
- [x] `npm test -- src/spec-factory/service.test.ts`
- [x] `npm run build`

---

## Task 5: Scope Compose Source Mutations to Session

**Files:**
- Modify: `src/spec-factory/compose-service.ts`
- Modify: `src/spec-factory/compose-database.ts`
- Modify: `src/spec-factory/compose-routes.ts` only if status mapping needs refinement
- Test: `src/spec-factory/compose-service.test.ts`
- Test: `src/spec-factory/compose-database.test.ts`
- Test: `src/spec-factory/compose-routes.test.ts`

**Checklist:**
- [x] Change `markSourceUploaded` to require `{ sessionId, sourceId }`.
- [x] Update SQL to `WHERE id = ? AND session_id = ? AND conversion_status = 'awaiting_upload'`.
- [x] Return affected row count or throw when no row is updated.
- [x] Change `reconvertSource` to require `{ sessionId, sourceId }`.
- [x] Update SQL to `WHERE id = ? AND session_id = ? AND conversion_status IN ('failed','unsupported')`.
- [x] Map source/session mismatch to a 404 or 409 response instead of silent success.
- [x] Update route/service tests so `/sessions/:sessionId/sources/:sourceId/uploaded` cannot affect another session's source.
- [x] Update route/service tests so reconvert cannot affect another session's source.

**Verification:**
- [x] `npm test -- src/spec-factory/compose-service.test.ts src/spec-factory/compose-database.test.ts src/spec-factory/compose-routes.test.ts`
- [x] `npm run build`

---

## Task 6: Make Compose Handoff Race-Safe

**Files:**
- Modify: `src/spec-factory/compose-service.ts`
- Modify: `src/spec-factory/compose-database.ts`
- Modify: `src/spec-factory/database.ts`
- Modify: `db/schema.sql`
- Add migration under `db/migrations/` if a unique key is needed
- Test: `src/spec-factory/compose-service.test.ts`
- Test: `src/spec-factory/compose-database.test.ts`
- Test: `src/spec-factory/database.test.ts`

**Checklist:**
- [x] Add DB-level uniqueness for the synthetic Compose source key (`COMPOSE-<sessionId>`) if not already guaranteed by `source_jira_key`.
- [x] Consider adding a unique key on `compose_sessions.source_id` for non-null values if needed.
- [x] Make `handoff` handle concurrent calls by re-reading the session/source after duplicate-key conflicts.
- [x] Ensure concurrent handoff returns the existing source id rather than creating duplicates or surfacing a generic 500.
- [x] Ensure draft generation is requested once for the source.
- [x] Add a test for two handoff calls racing after both initially see `sourceId = null`.
- [x] Add a test for duplicate synthetic source key recovery.

**Verification:**
- [x] `npm test -- src/spec-factory/compose-service.test.ts src/spec-factory/compose-database.test.ts src/spec-factory/database.test.ts`
- [x] `npm run build`

---

## Task 7: Add Conversion Lease Recovery

**Files:**
- Modify: `db/schema.sql`
- Add migration under `db/migrations/`
- Modify: `src/spec-factory/compose-database.ts`
- Modify: `src/spec-factory/compose-conversion.ts` if worker config needs a stale threshold
- Test: `src/spec-factory/compose-database.test.ts`
- Test: `src/spec-factory/compose-conversion.test.ts`

**Checklist:**
- [x] Add conversion attempt/lease fields to `compose_session_sources`, such as `conversion_started_at`, `conversion_attempts`, and/or `conversion_lease_expires_at`.
- [x] Update `claimNextPendingSource` to claim `pending` rows and stale `converting` rows whose lease expired.
- [x] Increment attempts when a source is claimed.
- [x] Clear lease fields when source becomes `converted`, `failed`, or `unsupported`.
- [x] Make stale threshold configurable with a safe default.
- [x] Add a test proving a fresh `converting` row is not reclaimed.
- [x] Add a test proving a stale `converting` row is reclaimed.
- [x] Add a test proving failed conversion clears the lease.

**Verification:**
- [x] `npm test -- src/spec-factory/compose-database.test.ts src/spec-factory/compose-conversion.test.ts src/spec-factory/database.test.ts`
- [x] `npm run build`

---

## Task 8: Guard Analyze and Handoff Against Incomplete Sources

**Files:**
- Modify: `src/spec-factory/compose-service.ts`
- Modify: `dashboard/src/spec-factory/compose/SourcesPanel.tsx`
- Modify: `dashboard/src/spec-factory/compose/PreviewPanel.tsx`
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`
- Test: `src/spec-factory/compose-service.test.ts`
- Test: `dashboard/src/spec-factory/compose/SourcesPanel.test.tsx`
- Test: `dashboard/src/spec-factory/compose/PreviewPanel.test.tsx`
- Test: `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`

**Checklist:**
- [x] Backend: reject `analyze` when any source is `awaiting_upload`, `pending`, or `converting`.
- [x] Backend: reject `handoff` when any source is `awaiting_upload`, `pending`, `converting`, `failed`, or `unsupported`, unless the intended product behavior allows draft-anyway with failed sources.
- [x] Backend: return a clear error listing which source statuses block the action.
- [x] Dashboard: disable Analyze while sources are still uploading/converting.
- [x] Dashboard: disable or clearly warn on Generate/Draft Anyway when incomplete sources remain.
- [x] Dashboard: keep polling while any source is `awaiting_upload`, `pending`, or `converting`.
- [x] Add tests covering disabled Analyze for in-flight sources.
- [x] Add tests covering backend rejection for handoff with incomplete sources.

**Verification:**
- [x] `npm test -- src/spec-factory/compose-service.test.ts`
- [x] `cd dashboard && npm test -- src/spec-factory/compose/SourcesPanel.test.tsx src/spec-factory/compose/PreviewPanel.test.tsx src/spec-factory/compose/ComposeWorkspace.test.tsx`
- [x] Root `npm run build`
- [x] Dashboard `npm run build`

---

## Task 9: Improve Compose Upload UX

**Files:**
- Modify: `dashboard/src/spec-factory/compose/AddSourceModal.tsx`
- Modify: `dashboard/src/spec-factory/compose/SourcesPanel.tsx`
- Modify: `dashboard/src/spec-factory/compose/ComposeWorkspace.tsx`
- Modify: `dashboard/src/spec-factory/SpecFactoryPage.css`
- Test: `dashboard/src/spec-factory/compose/AddSourceModal.test.tsx`
- Test: `dashboard/src/spec-factory/compose/SourcesPanel.test.tsx`
- Test: `dashboard/src/spec-factory/compose/ComposeWorkspace.test.tsx`

**Checklist:**
- [x] Add two more source tiles to the add-source modal: Jira and Confluence.
- [x] Do not close the add-source modal until file upload request, S3 PUT, and upload confirmation have all succeeded.
- [x] Show per-file upload progress or at least per-file uploading/error states.
- [x] Surface presigned PUT failures in the modal instead of only the top-level workspace alert.
- [x] Add retry for failed browser upload before conversion starts.
- [x] Keep existing converted-source retry behavior for conversion failures.
- [x] Add tests for failed S3 PUT keeping the modal open and showing an error.
- [x] Add tests for successful upload closing the modal and refreshing sources.

**Verification:**
- [x] `cd dashboard && npm test -- src/spec-factory/compose/AddSourceModal.test.tsx src/spec-factory/compose/SourcesPanel.test.tsx src/spec-factory/compose/ComposeWorkspace.test.tsx`
- [x] Dashboard `npm run build`

---

## Task 10: Config and Cleanup Follow-Ups

**Files:**
- Modify: `terraform/terraform.tfvars.example`
- Modify: `terraform/shared.auto.tfvars` only if deployed default needs changing
- Modify: `docs/superpowers/specs/2026-06-02-compose-sessions-design.md` if design notes need status updates
- Add cleanup job/code only after deciding the retention policy

**Checklist:**
- [x] Reconcile `spec_factory_repo_deep_dive_enabled` between `terraform.tfvars.example` and shared deployed config.
- [x] Document why the example defaults differ from shared config if they intentionally differ.
- [x] Define retention policy for Compose EFS workspaces.
- [x] Decide whether archive should delete workspace files, move them to S3, or mark them for periodic cleanup.
- [x] Add a cleanup ticket/plan if the policy needs a separate implementation.
- [x] Track URL ingestion hardening as a security follow-up: allowed schemes, private network protection, timeout/size limits.

**Verification:**
- [x] `terraform fmt -check terraform` (direct `terraform fmt -check terraform/terraform.tfvars.example` is unsupported because the file extension is `.example`)
- [x] `git diff --check`

---

## Existing Separate Roadmap Plan

Phase 4 audio/video transcription already has its own implementation plan:

- `docs/superpowers/plans/2026-06-03-compose-sessions-phase-4-audio.md`

Do not duplicate that work here. Execute that plan after P0/P1 correctness fixes unless product priority says audio/video should move first.

---

## Final Verification Gate

- [x] Backend focused tests:
  `npm test -- src/spec-factory/compose-evidence-provider.test.ts src/spec-factory/compose-service.test.ts src/spec-factory/compose-conversion.test.ts src/spec-factory/service.test.ts src/spec-factory/compose-routes.test.ts src/spec-factory/compose-sse.test.ts src/spec-factory/compose-workspace.test.ts src/spec-factory/compose-database.test.ts src/spec-factory/compose-uploads.test.ts`
- [x] Dashboard focused tests:
  `cd dashboard && npm test -- src/spec-factory/SpecFactoryPage.test.tsx src/spec-factory/compose/composeApi.test.ts src/spec-factory/compose/ComposeWorkspace.test.tsx src/spec-factory/compose/SourcesPanel.test.tsx src/spec-factory/compose/ChatPanel.test.tsx src/spec-factory/compose/PreviewPanel.test.tsx src/spec-factory/compose/SessionModal.test.tsx src/spec-factory/compose/AddSourceModal.test.tsx src/spec-factory/compose/useComposeStream.test.ts src/spec-factory/compose/composeTypes.test.ts`
- [x] Root build: `npm run build`
- [x] Dashboard build: `cd dashboard && npm run build`
- [ ] Manual browser smoke test against local or sandbox dashboard:
  - Create Compose session.
  - Add a pasted note.
  - Upload a file.
  - Analyze.
  - Answer an open question in chat.
  - Handoff/generate draft.
  - Verify the generated Spec Board draft includes note content, chat answers, and context.
