# Spec Factory Enhancement Checklist

**Goal:** Track follow-up enhancements that make Spec Factory faster, more conversational, more evidence-grounded, and easier to operate after the Compose reliability/UI phases.

**Recommended next phase:** Prioritize chat speed, one-question interview flow, structured readiness/details, and draft preview. These provide the biggest user-facing lift without another broad rewrite.

## P0 - Conversation Speed and Flow

- [x] Make `POST /compose/sessions/:id/messages` return immediately after persisting the user message, then run the agent turn in the background and stream the assistant response through SSE.
- [x] Stream richer progress states during long agent turns, such as `Reading sources`, `Checking repositories`, `Updating brief`, and `Preparing next question`.
- [x] Add queued-turn handling so a user can type a follow-up while the agent is still working, instead of receiving a hard "turn already in progress" error.
- [x] Ask one open question at a time, choosing the highest-value blocker first instead of dumping all open questions into one reply.
- [x] Keep the chat UI focused on conversation: speaker labels above bubbles, clean markdown rendering, and no hidden metadata inside the message body.
- [x] Improve assistant response formatting for headings, bullets, bold text, inline code, and spacing in both chat and preview surfaces.

## P1 - Agent Identity and Session Experience

- [ ] Persist the assigned agent persona on the Compose session instead of deriving it from session id.
- [ ] Add the selected agent name to session export/import so resumed or imported sessions keep the same assistant identity.
- [ ] Add lightweight session activity metadata: last active time, last action, last actor, and whether analysis is currently running.
- [ ] Improve protected-session UX with clearer password modal copy, visible text in all light-theme states, and consistent compact controls.
- [ ] Add session collaboration primitives: owner, participants, last edited by, protected/unprotected status, and an activity timeline.

## P1 - Readiness and Preview Quality

- [ ] Replace preview heuristics with explicit backend readiness fields for module, repositories, files touched, difficulty, LOE hours, story points, confidence, risk, and missing evidence.
- [ ] Add a readiness confidence score and explain what raised or lowered confidence.
- [ ] Split preview into durable sections: Details, Pending Items, Evidence, Risks, Assumptions, and Next Step.
- [ ] Add a deterministic OneShot-readiness validator before handoff that checks repository, scope, acceptance criteria, out-of-scope, test plan, dependencies, and LOE.
- [ ] Convert readiness states into clearer actions: `Generate Draft`, `Draft with Warnings`, and `Needs More Input`.
- [ ] Add a draft preview inside Compose before sending to Spec Board.

## P1 - Source Intelligence

- [ ] Generate a short source summary for every source tile.
- [ ] Extract entities from each source: Jira keys, repositories, systems, files, clients, LOE, dates, and unresolved assumptions.
- [ ] Score source usefulness as high signal, needs clarification, duplicate, missing repo context, or weak requirement detail.
- [ ] Show source contribution to the final brief so users understand which files/tickets/transcripts shaped the draft.
- [ ] Add source versioning so replacing or deleting a source preserves prior markdown and marks the session context as needing re-analysis.
- [ ] Improve source cards so collapsed rows show only source category, compact identifier, short description, status, and actions.

## P1 - Repository Grounding

- [ ] Upgrade the repository picker with search, recently used repos, selected chips, and repository groups by domain.
- [ ] Remember recently selected repos per user and per source type.
- [ ] Let selected repositories feed both analysis and draft generation as first-class evidence.
- [ ] Add repo-context status in the preview: selected, inspected, matched by source evidence, or unresolved.
- [ ] Surface file/path hints found during analysis and let users confirm or reject them.
- [ ] Add explicit warnings when source text names a repo or path that cannot be matched to a known repository.

## P2 - Evidence Traceability

- [ ] Link every generated acceptance criterion back to specific evidence: Jira, Confluence, uploaded document section, transcript excerpt, note, or repository file.
- [ ] Add an evidence drawer for generated drafts showing source refs, repo refs, and reasoning summaries.
- [ ] Include evidence coverage metrics: number of sources used, number ignored, unresolved hints, and repo files inspected.
- [ ] Mark unsupported evidence separately from missing evidence so users know whether to upload more material or fix conversion.
- [ ] Add copy/export for source summaries, context brief, evidence map, and final draft.

## P2 - Incremental Analysis and Backend Efficiency

- [ ] Avoid rebuilding the whole workspace context when only one source changes; re-analyze changed sources plus the existing session context.
- [ ] Cache source summaries and extracted entities per source version.
- [ ] Cache repository metadata and selected repository markdown context per session.
- [ ] Add a smaller fast-path prompt for chat replies when the user is only answering the current open question.
- [ ] Persist a pending-question queue so chat turns do not need to rediscover all blockers every time.
- [ ] Track agent latency by phase: workspace prep, model call, parsing, persistence, and SSE delivery.

## P2 - Source Types and Ingestion

- [ ] Make record-audio a fully supported source type, including recording, upload, transcription, markdown preview, and delete/retry behavior.
- [ ] Improve YouTube ingestion with clear unavailable/private/video-too-long errors.
- [ ] Improve Confluence ingestion with page title, space key, last updated timestamp, and attachment awareness.
- [ ] Improve Jira ingestion with comments, attachments, linked issues, parent/child relationships, and status metadata.
- [ ] Add sketch-pad/manual notes as editable markdown sources that can be revised after creation.
- [ ] Add duplicate source detection for repeated Jira keys, Confluence URLs, and file hashes.

## P2 - Handoff and Spec Board Feedback Loop

- [ ] When a Compose session hands off, show a clear handoff receipt with generated source id, board column, and draft status.
- [ ] Push Spec Board state back into the originating Compose session: drafting, draft ready, approved, not qualified, OneShot submitted, or archived.
- [ ] Add a "Return to Compose session" link from Spec Board generated sources.
- [ ] Let users regenerate a draft from the same Compose session after answering more questions.
- [ ] Track each handoff attempt and prevent duplicate drafts from rapid repeated clicks.

## P3 - Operations and Supportability

- [ ] Add a Compose debug drawer with conversion timings, agent latency, token usage, selected repos, workspace path, Claude session id, and last error.
- [ ] Add admin visibility into stuck conversions, stale agent turns, failed handoffs, and retryable upload failures.
- [ ] Add dashboard health cards for Compose session count, active analyses, conversion queue depth, handoff failures, and draft generation failures.
- [ ] Add a structured event timeline per session for source add/delete, analyze, chat, readiness update, and handoff.
- [ ] Add retention visibility: when a session expires, whether source markdown is archived, and how to export before cleanup.

## P3 - Template Modes

- [ ] Add `Epic from Jira` mode.
- [ ] Add `Epic from transcript` mode.
- [ ] Add `Bug investigation` mode.
- [ ] Add `Config-only change` mode.
- [ ] Add `Research spike` mode.
- [ ] Tailor source prompts, open-question strategy, readiness rules, and draft shape for each mode.
