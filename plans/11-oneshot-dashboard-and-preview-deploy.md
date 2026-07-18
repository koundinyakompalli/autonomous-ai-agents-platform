# Plan 11: OneShot Dashboard and Core-App Preview Deploy

## Status

Ready for implementation.

This plan is the operator/UI follow-on to the existing OneShot backend pipeline in [09-one-shotting-feature-delivery-pipeline.md](./09-one-shotting-feature-delivery-pipeline.md).

## Problem

The OneShot pipeline now exists in the backend, but there is no product surface for operators or developers to answer the questions that matter in practice:

- Which `PFOS` tickets are currently in the OneShot pipeline?
- Which stage is each ticket in right now?
- Which tickets failed qualification before a `oneshot_runs` row was created?
- Does a draft PR exist yet?
- Which `core-app` implementation branch is currently deployed in the preview slot?
- How do we request a preview deploy without giving operators direct AWS access?

There is also no durable deployment control plane for the existing `core-app` preview target. The desired preview behavior is:

- a row-level `Deploy` button on the OneShot board
- manual deploys only
- a single preview slot
- one active deployment at a time
- green/red/amber status lights per row
- no loss of the previous active row while a new rollout is still in flight

## Current baseline

### Dashboard

The current dashboard application already exists at `https://productfactory.mhkdevsandbox.com/` and has:

- a backend Express server in [dashboard/server/index.ts](../dashboard/server/index.ts)
- DB access in [dashboard/server/db.ts](../dashboard/server/db.ts)
- a read-only `state` route in [dashboard/server/routes/state.ts](../dashboard/server/routes/state.ts)
- a single-screen React UI rooted in [dashboard/src/App.tsx](../dashboard/src/App.tsx)
- polling behavior in [dashboard/src/useSpecterAgents.ts](../dashboard/src/useSpecterAgents.ts)

What it does **not** have yet:

- a router
- a OneShot page
- any `/api/oneshot/*` routes
- any authenticated write endpoints
- any deployment control-plane model

### OneShot backend

The OneShot backend already has:

- `QUALIFIER`, `PLANNER`, `REVIEWER`, and `IMPLEMENTER`
- `oneshot_runs`, `oneshot_artifacts`, and `oneshot_notifications`
- durable review/implementation state
- draft PR creation via GitHub in [src/oneshot/github.ts](../src/oneshot/github.ts)

What it does **not** have yet:

- `oneshot_deployments`
- persisted implementation commit SHA
- dashboard read-model normalization for qualification failures
- a deploy request API
- a preview deployment workflow

## Working definition

This feature set adds two tightly related surfaces:

1. A OneShot operations board inside the existing dashboard
2. A controlled preview deployment control plane for `core-app`

The dashboard is the human interface. It is **not** the build executor and it is **not** the AWS mutator.

The deploy path is:

1. operator clicks `Deploy`
2. dashboard backend validates and records a deployment request
3. dashboard backend dispatches a GitHub Actions workflow
4. workflow builds and deploys the exact requested commit
5. workflow reports status back to the dashboard backend
6. dashboard reflects the final deployment state

## Locked decisions

These decisions are already made and the spec pack below assumes them:

- The dashboard lives inside the existing `dashboard/` app.
- The OneShot board is a new route, not a separate app.
- The board must show **all** `PFOS` tickets, including qualification failures.
- `Deploy` is only available for `core-app`.
- Preview deploys are manual.
- There is exactly one preview slot in v1.
- Preview target:
  - ECR: `323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp`
  - ECS cluster: `CLIENT-A`
  - ECS service: `CLIENT-A-cp-dev-mhk-core`
  - task-definition container to replace: `app-container`
- A new deployment does not supersede the old active row until the new rollout succeeds.
- If a new deployment fails, the previous active deployment remains green.
- Deploy identity is `repo + branch + exact commit SHA`, never branch head alone.
- The deploy path must stay auditable and approval-gated.
- Only one in-flight deployment is allowed at a time for the preview slot.

## Goals

- add a clear operator board for OneShot work
- surface qualification failures instead of hiding them
- expose pipeline stage, progress, PR, and deployment status in one place
- provide a safe manual preview deploy for `core-app`
- keep preview state durable and queryable
- keep deploy execution outside the browser
- preserve a single active preview slot with clean supersession semantics

## Non-goals

- multi-slot preview environments
- deploying arbitrary repos from the dashboard
- auto-deploying every OneShot run
- direct frontend access to AWS, ECR, or ECS APIs
- replacing the current office-map dashboard at `/`
- environment-per-branch automation
- solving general dashboard SSO architecture beyond the minimum operator identity needed for deploy requests

## Architecture overview

### Read model

The OneShot board cannot query only `oneshot_runs`.

It must combine:

- real `oneshot_runs` rows for qualified tickets
- `QUALIFIER` `task_management` rows that never created a run

This is required because qualification failures currently stop before a `oneshot_runs` row exists.

### Preview deploy control plane

Preview deployment requires a new durable model:

- `oneshot_deployments` table
- dashboard write route
- GitHub workflow dispatch
- status callback
- active/in-flight slot locking

### Preview slot

The preview slot is a mutable single-slot surface for `core-app`.

It intentionally behaves differently from normal Terraform-managed service rollout:

- exactly one active deployment
- exactly one in-flight deployment
- old active remains active until replacement succeeds
- ECS image is updated by registering a new task definition revision that only swaps `app-container.image`

## Full implementation spec set

### Parent OneShot specs

- [09-one-shotting-feature-delivery-pipeline.md](./09-one-shotting-feature-delivery-pipeline.md)
- [2026-04-12-oneshot-phase0-contracts.md](../docs/superpowers/specs/2026-04-12-oneshot-phase0-contracts.md)
- [2026-04-12-oneshot-phase1-design.md](../docs/superpowers/specs/2026-04-12-oneshot-phase1-design.md)
- [2026-04-12-oneshot-phase2-qualifier-and-routing.md](../docs/superpowers/specs/2026-04-12-oneshot-phase2-qualifier-and-routing.md)
- [2026-04-12-oneshot-phase3-planner.md](../docs/superpowers/specs/2026-04-12-oneshot-phase3-planner.md)
- [2026-04-12-oneshot-phase4-reviewer.md](../docs/superpowers/specs/2026-04-12-oneshot-phase4-reviewer.md)
- [2026-04-12-oneshot-phase5-implementer.md](../docs/superpowers/specs/2026-04-12-oneshot-phase5-implementer.md)
- [2026-04-12-oneshot-phase6-operations.md](../docs/superpowers/specs/2026-04-12-oneshot-phase6-operations.md)

### Dashboard / preview specs

#### Phase 0: Contracts and slot model

- [2026-04-12-oneshot-dashboard-phase0-contracts.md](../docs/superpowers/specs/2026-04-12-oneshot-dashboard-phase0-contracts.md)

Covers:

- route scope
- deployment eligibility rules
- status-light semantics
- immutable deployment identity
- exact preview target contract
- authorization and approval expectations

#### Phase 1: Read model and UI

- [2026-04-12-oneshot-dashboard-phase1-read-model-and-ui.md](../docs/superpowers/specs/2026-04-12-oneshot-dashboard-phase1-read-model-and-ui.md)

Covers:

- `/api/oneshot/runs`
- union read model for run rows + qualification failures
- frontend route and page composition
- progress bar mapping
- PR button behavior
- deployment-light rendering

#### Phase 2: Deploy control plane

- [2026-04-12-oneshot-dashboard-phase2-deploy-control-plane.md](../docs/superpowers/specs/2026-04-12-oneshot-dashboard-phase2-deploy-control-plane.md)

Covers:

- `oneshot_deployments`
- commit-SHA persistence requirements
- deploy request API
- workflow dispatch
- callback auth and status transitions
- active/superseded transaction rules

#### Phase 3: Core-app preview workflow

- [2026-04-12-oneshot-dashboard-phase3-coreapp-preview-workflow.md](../docs/superpowers/specs/2026-04-12-oneshot-dashboard-phase3-coreapp-preview-workflow.md)
- [coreapp-preview-build-contract.md](../docs/coreapp-preview-build-contract.md)

Covers:

- GitHub Actions workflow
- external repo checkout
- Docker build contract
- ECR push
- ECS task definition update
- steady-state wait
- preview activation rules

#### Phase 4: Operations and recovery

- [2026-04-12-oneshot-dashboard-phase4-operations.md](../docs/superpowers/specs/2026-04-12-oneshot-dashboard-phase4-operations.md)
- [ONESHOT_PREVIEW_RUNBOOK.md](../docs/ONESHOT_PREVIEW_RUNBOOK.md)

Covers:

- drift detection
- reset/rollback
- stale deployment detection
- operator recovery procedures
- active/in-flight slot verification

## Implementation workstreams

### Workstream A: Board read model

Primary code areas:

- [dashboard/server/index.ts](../dashboard/server/index.ts)
- [dashboard/server/db.ts](../dashboard/server/db.ts)
- [dashboard/server/routes/state.ts](../dashboard/server/routes/state.ts)
- new `dashboard/server/routes/oneshot.ts`
- new `dashboard/server/services/oneshot.ts`
- [dashboard/src/App.tsx](../dashboard/src/App.tsx)
- new OneShot page/hook/components

### Workstream B: Deployment state model

Primary code areas:

- [db/migrations/005_oneshot_schema.sql](../db/migrations/005_oneshot_schema.sql)
- new `db/migrations/007_oneshot_dashboard_support.sql`
- new `db/migrations/008_oneshot_deployments.sql`
- [src/oneshot/schema/implementation.ts](../src/oneshot/schema/implementation.ts)
- [src/oneshot/consumers/implementer.ts](../src/oneshot/consumers/implementer.ts)
- [src/oneshot/types.ts](../src/oneshot/types.ts)
- [src/oneshot/database/runs.ts](../src/oneshot/database/runs.ts)

### Workstream C: Dashboard deploy API

Primary code areas:

- new `dashboard/server/routes/oneshot-deployments.ts`
- new `dashboard/server/services/oneshotDeployments.ts`
- new `dashboard/server/services/githubActionsDispatch.ts`
- dashboard auth/operator identity extraction helper

### Workstream D: Preview deployment workflow

Primary code areas:

- new `.github/workflows/coreapp-preview-deploy.yml`
- new `.github/workflows/coreapp-preview-reset.yml`
- new `.github/scripts/coreapp-preview/*`
- `docs/coreapp-preview-build-contract.md`

### Workstream E: Operations and reconciliation

Primary code areas:

- new deployment reconciliation logic in dashboard backend or operator script
- `/oneshot` warning surfaces
- runbooks

## Required preconditions

Before implementation starts, treat these as fixed inputs:

- OneShot backend remains the system of record for run state.
- The dashboard remains the presentation layer and write coordinator.
- GitHub Actions remains the deploy executor.
- The preview target remains:
  - cluster `CLIENT-A`
  - service `CLIENT-A-cp-dev-mhk-core`
  - container `app-container`
- Preview deploys remain limited to `core-app`.

## Delivery order

1. Phase 0 contracts
2. Phase 1 read model and board UI
3. Phase 2 commit-SHA capture and deploy control-plane schema/API
4. Phase 3 preview workflow and callback wiring
5. Phase 4 operations hardening, reset flow, and drift detection

Do **not** implement Phase 3 before Phase 2. The deploy workflow is not safe until deployment rows and immutable commit identity exist.

## Top-level acceptance criteria

This plan is complete when all of the following are true:

- `/oneshot` exists in the dashboard
- the board shows all `PFOS` work, including qualification failures
- every row shows a stable stage/progress representation
- PR links are visible when available
- `core-app` rows can create deployment requests
- the deploy request is durable and auditable
- only one preview deployment can be active and only one can be in flight
- the active row remains green until a replacement deployment succeeds
- the dashboard can explain failed, superseded, in-flight, and active states without AWS console access
