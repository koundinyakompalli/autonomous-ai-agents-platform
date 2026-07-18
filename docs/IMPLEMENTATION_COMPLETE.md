# Implementation Complete

This file now serves as a historical checkpoint, not as an authoritative runtime design document.

## Current reality

As of the current codebase:

- the active execution layer is the Claude Agent SDK wrapper in `src/claude-sdk`
- orchestrator, workers, and Harvey are the three runtime surfaces
- integrations are direct, not MCP-based
- task and result payloads are stored in shared S3 buckets

## What this means

If you need the current source of truth, use:

- `docs/02-ARCHITECTURE.md`
- `docs/04-PHOENIX-CONFIGURATION.md`
- `docs/06-MCP-INTEGRATION.md`
- `docs/DEPLOYMENT_GUIDE.md`

Historical migration and implementation notes were condensed so this file no longer describes non-existent runtime components.
