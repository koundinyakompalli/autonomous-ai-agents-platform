# Plan 06: Data Model, Quality, and Testing

## Problem

The durable workflow is one of Specter's strengths, but the schema and quality envelope still show MVP shortcuts.

## Current issues

- `task_management.related_code` stores repo IDs as CSV
- `code_repositories` mixes metadata with credential fields
- `chat_sessions.messages_json` is convenient but hard to analyze and evolve
- the project currently has weak type safety in `tsconfig.json`
- automated test coverage around the async workflow is minimal

## Goals

- normalize the schema where current shortcuts limit safety or queryability
- add integration tests around the durable workflow
- progressively tighten TypeScript strictness

## Proposed target state

Schema changes:

- replace `related_code` CSV with a `task_repositories` join table
- separate repository credentials from repository metadata
- consider a `chat_session_events` table if session analytics or replay become important

Quality changes:

- integration tests for assignment, claiming, completion, posting, and Teams delivery
- a ratcheting TypeScript strictness plan

## Work breakdown

### 1. Normalize repo associations

- add `task_repositories(task_management_id, repository_id, role)`
- backfill from `related_code`
- keep a temporary compatibility reader during migration

### 2. Revisit Harvey session persistence

- keep `messages_json` if needed for short-term continuity
- evaluate whether operational reporting and replay need a normalized event table

### 3. Add integration coverage

Test the flows that matter most:

- orchestrator assignment
- worker claim semantics
- result upload and DB updates
- JIRA posting claim/release logic
- Harvey delivery claim/release logic

### 4. Tighten TypeScript gradually

Start with:

- `noImplicitReturns`
- `noFallthroughCasesInSwitch`
- targeted modules under stricter settings

Then move toward:

- `strict: true` for new or migrated modules

## Deliverables

- schema migrations
- integration test harness
- stricter compiler settings with phased rollout notes

## Success criteria

- task-to-repo relationships are queryable without CSV parsing
- critical async workflows have automated regression coverage
- compiler catches more defects before deployment

## Dependencies

- Plans 01 and 02 should land first because schema and config refactors overlap

## Out of scope

- a full event-sourcing rewrite
