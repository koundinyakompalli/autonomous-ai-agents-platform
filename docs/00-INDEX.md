# Specter Documentation Index

This index reflects the current Specter runtime: Claude Agent SDK-based workers, JIRA orchestration, Teams intake through Harvey, shared EFS repositories, and shared S3 task/result buckets.

## Start here

- [../AI_GOVERNANCE_COMPLIANCE.md](../AI_GOVERNANCE_COMPLIANCE.md): first-read governance evidence map for MERIDIAN and Investigation Cockpit
- [01-GETTING-STARTED.md](./01-GETTING-STARTED.md): local setup and first run
- [02-ARCHITECTURE.md](./02-ARCHITECTURE.md): runtime architecture and data flow
- [09-API-REFERENCE.md](./09-API-REFERENCE.md): package exports and entrypoints

## Development

- [03-AGENT-DEVELOPMENT-GUIDE.md](./03-AGENT-DEVELOPMENT-GUIDE.md): add or modify agents and workers
- [05-TOOL-REGISTRY.md](./05-TOOL-REGISTRY.md): Claude SDK tool permission sets
- [07-OUTPUT-FORMATS.md](./07-OUTPUT-FORMATS.md): output schemas and result formats
- [08-BEST-PRACTICES.md](./08-BEST-PRACTICES.md): implementation guidance
- [10-EXAMPLES.md](./10-EXAMPLES.md): concrete usage examples

## Operations

- [AWS_INFRASTRUCTURE.md](./AWS_INFRASTRUCTURE.md): AWS resource model
- [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md): build, push, and deploy flow
- [ONESHOT_RUNBOOK.md](./ONESHOT_RUNBOOK.md): current OneShot runtime, queues, states, and recovery
- [ONESHOT_PREVIEW_RUNBOOK.md](./ONESHOT_PREVIEW_RUNBOOK.md): `/oneshot` board and `core-app` preview deploy operations
- [WATCHDOG_RUNTIME_CONFIG.md](./WATCHDOG_RUNTIME_CONFIG.md): Watchdog runtime knobs, dedicated evidence bucket, and clarification flow
- [AGENT_ONBOARDING_RUNBOOK.md](./AGENT_ONBOARDING_RUNBOOK.md): governed worker onboarding and activation flow
- [STATUS_API.md](./STATUS_API.md): worker status endpoints
- [REAL_TIME_MONITORING.md](./REAL_TIME_MONITORING.md): logs, SSE, WebSocket, and tunnel patterns
- [11-TROUBLESHOOTING.md](./11-TROUBLESHOOTING.md): common failures and fixes

## Enhancement roadmap

- [../plans/README.md](../plans/README.md): recommended implementation roadmap and detailed initiative plans

## Historical filenames retained for continuity

- [04-PHOENIX-CONFIGURATION.md](./04-PHOENIX-CONFIGURATION.md): current Claude SDK/Bedrock configuration guide retained under the older filename
- [06-MCP-INTEGRATION.md](./06-MCP-INTEGRATION.md): explains the current direct-integration model and the absence of MCP in the active runtime
- [PHOENIX_TO_CLAUDE_SDK_MIGRATION.md](./PHOENIX_TO_CLAUDE_SDK_MIGRATION.md): migration summary
- [IMPLEMENTATION_COMPLETE.md](./IMPLEMENTATION_COMPLETE.md): historical note on the current state
- [MCP_IMPLEMENTATION_SUMMARY.md](./MCP_IMPLEMENTATION_SUMMARY.md): historical note on MCP status

## Historical OneShot design docs

- `docs/superpowers/specs/2026-04-12-oneshot-*.md`

Those files capture the original design and rollout phases. Use the runbooks and deployment docs above as the runtime source of truth.

## Agent-focused docs

- [DARCI_DEBUGGING_GUIDE.md](./DARCI_DEBUGGING_GUIDE.md)
- [DARCI_QUICK_REFERENCE.md](./DARCI_QUICK_REFERENCE.md)
- [../agent-docs/README.md](../agent-docs/README.md): deep session handoff docs for implementing and deploying new agents end to end

## Specialist docs that were already current

- `MOANA_API_INTEGRATION_DOCUMENTATION.md`
- `MARKDOWN-TO-ADF-CONVERSION.md`
- `SENTRY_*` design and example docs

Those files cover narrower subsystems and were left in place unless they conflicted with the current runtime.
