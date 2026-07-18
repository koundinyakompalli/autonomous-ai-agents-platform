# Specter Enhancement Plans

This folder captures the architectural enhancements I recommend for Specter based on the current codebase.

These plans are sequenced. The early ones remove structural risk; the later ones improve maintainability, operability, and iteration speed.

## Priority order

### Immediate

- [01-security-and-secret-management.md](./01-security-and-secret-management.md)
- [02-configuration-and-runtime-alignment.md](./02-configuration-and-runtime-alignment.md)
- [12-meridian-packaged-backend-hardening.md](./12-meridian-packaged-backend-hardening.md)

### Near-term

- [03-workspace-and-repository-runtime.md](./03-workspace-and-repository-runtime.md)
- [04-orchestrator-decomposition.md](./04-orchestrator-decomposition.md)
- [05-ai-platform-consolidation.md](./05-ai-platform-consolidation.md)
- [10-agent-infrastructure-onboarding-and-governed-deployments.md](./10-agent-infrastructure-onboarding-and-governed-deployments.md)

### Medium-term

- [06-data-model-quality-and-testing.md](./06-data-model-quality-and-testing.md)
- [07-observability-and-documentation-governance.md](./07-observability-and-documentation-governance.md)
- [08-harvey-and-admin-surface-hardening.md](./08-harvey-and-admin-surface-hardening.md)

### Ready for Implementation

- [09-one-shotting-feature-delivery-pipeline.md](./09-one-shotting-feature-delivery-pipeline.md)
- [11-oneshot-dashboard-and-preview-deploy.md](./11-oneshot-dashboard-and-preview-deploy.md)

## Why this roadmap exists

The current architecture is worth keeping, but it has concentrated technical debt in a few places:

- secrets and credentials are still mixed into code and schema seeds
- runtime configuration is fragmented across env names, scripts, Dockerfiles, and Terraform
- repository workspace handling is too tightly coupled to worker internals
- the orchestrator owns too many responsibilities in one synchronous assignment path
- AI invocation logic is split between the Claude SDK runner and multiple direct Bedrock callers
- the data model still contains MVP shortcuts that limit queryability and safety
- test coverage and type safety are too thin for a system with this many background workflows
- operations and docs drifted because the runtime surface changed faster than the system contracts

## Recommended sequencing

1. Remove the security and config hazards first.
2. Extract the workspace runtime so worker behavior becomes easier to reason about and test.
3. Split orchestration responsibilities and unify AI access before adding new features.
4. Normalize the schema and add integration tests around the durable workflow.
5. Harden Harvey and observability once the platform contracts are stable.

## Expected outcome

If the full set is executed, Specter should end up with:

- no plaintext secrets in the repo or schema seeds
- one clear runtime configuration model
- one supported worker runtime entrypoint
- a testable workspace abstraction instead of path-heavy worker internals
- an orchestrator composed from smaller idempotent services
- one AI gateway for direct model calls and consistent telemetry
- a normalized schema with better task-to-repo traceability
- stronger integration tests and gradual TypeScript strictness
- tighter operational visibility and lower documentation drift
