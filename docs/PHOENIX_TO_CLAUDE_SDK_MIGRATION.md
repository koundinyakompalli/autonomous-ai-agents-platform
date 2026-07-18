# Phoenix to Claude SDK Migration

This file summarizes the migration outcome at a high level.

## Outcome

The active agent runtime is now the shared Claude Agent SDK wrapper under `src/claude-sdk`.

Key changes that now define the platform:

- agents are thin wrappers around `runAgent()`
- tool policy is expressed through Claude SDK tool sets and hooks
- repo registration and workspace handling moved into shared Claude SDK helpers
- older Phoenix-era documentation is retained only where filenames are still useful for continuity

## What did not change

- MySQL remains the control plane
- S3 remains the payload handoff layer
- EFS remains the shared repository store
- workers still process durable assignments asynchronously

## Where to look now

- `docs/02-ARCHITECTURE.md`
- `docs/04-PHOENIX-CONFIGURATION.md`
- `docs/05-TOOL-REGISTRY.md`
