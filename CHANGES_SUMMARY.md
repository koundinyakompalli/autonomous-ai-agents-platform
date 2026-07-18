# Current Platform Change Summary

This file summarizes the major architectural realities of the current Specter codebase. It replaces older migration-era notes that no longer matched the runtime.

## Current-state highlights

### Claude Agent SDK is the execution layer

The active agent runtime is the shared Claude Agent SDK wrapper in `src/claude-sdk`, not the older Phoenix engine described in historical docs.

### Tasks and results use shared buckets

The system now uses:

- one task bucket: `<prefix>-tasks`
- one result bucket: `<prefix>-results`

Result segregation is done by S3 key prefix, not one bucket per agent.

### Harvey is a first-class entrypoint

Teams requests no longer represent a side channel. Harvey creates `task_management` rows through the same durable flow as the orchestrator.

### Workers have two entrypoints

- `src/worker-main.ts`: preferred, includes status API
- `src/orchestrator/workers/index.ts`: older worker-only entrypoint

Documentation now recommends `worker-main.ts` for local runs and status monitoring.

### Terraform deploys more than the original four agents

The current infrastructure includes:

- orchestrator
- workers for DARCI, SCRIBE, PRISM, HERMES, SENTRY, BEACON, BCAT-PLANNER, BCAT-EXECUTOR, VERITAS
- Harvey behind an ALB

### EFS layout expectations are stricter than older docs implied

The worker path assumptions now center on:

```text
/mnt/efs/specter-repo/repositories
/mnt/efs/specter-repo/repositories/tasks/task-<task_management_id>
```

Older examples that used `/mnt/efs/repos` or customer-named task folders were misleading.

## Known technical debt that the docs now call out explicitly

- legacy credential fallbacks still exist in code and schema seeds
- some npm worker scripts still point to the older entrypoint
- the data model still uses CSV repo IDs in `task_management.related_code`

These are current implementation facts, not recommended patterns for new work.
