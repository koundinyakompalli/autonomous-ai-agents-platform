# Plan 01: Security and Secret Management

## Why this is first

This is the highest-risk issue in the repo. The current codebase still mixes credentials into code and schema bootstrap paths.

## Current problems

- `src/orchestrator/database.ts` still contains a local DB password fallback.
- `db/schema.sql` seeds repository credentials directly into `code_repositories`.
- repository metadata and repository authentication are modeled together.
- old operational patterns encourage copying secret material into env files and database rows.

## Goals

- remove plaintext credentials from code and schema
- stop storing repository tokens/passwords directly in `code_repositories`
- move runtime secret resolution to environment injection or Secrets Manager-backed references
- make startup fail fast when required secrets are missing

## Proposed target state

- code contains no real secret defaults
- schema seeds contain metadata only
- repository rows store either:
  - no auth material at all for local-only use, or
  - a `secret_ref` / credential reference, not the secret itself
- orchestrator, workers, and Harvey receive secrets through runtime injection

## Work breakdown

### 1. Remove dangerous defaults

- delete hardcoded DB password fallback from `src/orchestrator/database.ts`
- remove any doc examples that imply real credential values belong in the repo
- add explicit startup validation for required secrets

### 2. Redesign repository auth storage

- change `code_repositories` to separate repo metadata from auth lookup
- prefer `credential_source` plus `credential_ref`
- avoid storing `token`, `username`, and `password` inline for production usage

### 3. Introduce a secret resolution layer

- add a small `SecretProvider` abstraction
- support at least:
  - env-based resolution for local development
  - Secrets Manager-backed resolution for deployed environments

### 4. Migrate existing consumers

- repo clone/update logic
- any direct JIRA token lookups that still come from database rows
- deployment docs and Terraform notes

## Deliverables

- schema migration for repository credential refactoring
- removal of secret defaults from code
- a runtime secret provider
- updated deployment docs

## Success criteria

- no real secrets or secret-like fallbacks remain in tracked files
- local startup fails clearly instead of silently using a default credential
- production flows continue to resolve credentials without DB-stored plaintext secrets

## Risks

- credential migration can break repo access if rollout is half-complete
- local development may need a temporary compatibility mode during migration

## Out of scope

- full enterprise secret rotation automation
- retroactive secret history cleanup from Git history
