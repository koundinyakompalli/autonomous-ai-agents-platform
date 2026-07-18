# OneShot Dashboard Phase 4 Design: Operations, Recovery, and Rollback

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime and dashboard have changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12
**Status**: Ready for implementation
**Parent plan**: `plans/11-oneshot-dashboard-and-preview-deploy.md`
**Phase**: 4 of 4

## Summary

Phase 4 defines the operational model for the OneShot dashboard and preview deploy surface.

This phase covers:

- what to monitor
- how to detect drift
- how to detect stale deployments
- how to recover from callback gaps
- how to reset the preview slot
- how to keep the dashboard honest when the underlying ECS state diverges

Without this phase, the dashboard becomes a control surface with no supported recovery path.

## Deliverables

```text
docs/ONESHOT_PREVIEW_RUNBOOK.md
.github/workflows/coreapp-preview-reset.yml
dashboard/server/routes/oneshot-admin.ts
dashboard/server/services/oneshotDeploymentReconciliation.ts
```

The admin route is optional if reset/recovery should remain workflow-only.

## 1. Objects to monitor

### Dashboard/API

- `GET /api/oneshot/runs` latency and error rate
- `POST /api/oneshot/deployments` error rate
- callback route error rate

### Database

- `oneshot_runs`
- `oneshot_artifacts`
- `oneshot_notifications`
- `oneshot_deployments`

### GitHub Actions

- `coreapp-preview-deploy.yml`
- `coreapp-preview-reset.yml`

### AWS preview slot

- ECR repo `medhok20/medhok-monorepo.coreapp`
- ECS service `CLIENT-A-cp-dev-mhk-core`
- task definition revisions used by the service

## 2. Healthy-state model

Healthy preview state means:

- zero or one active deployment row
- zero or one in-flight deployment row
- dashboard active row image equals ECS live `app-container` image
- the preview URL is reachable

Anything else is drift or stale state.

## 3. Drift detection contract

The system must be able to compare:

- active deployment row
- ECS service current task definition
- `app-container.image`

If the ECS image does not match the active deployment row image:

- mark the preview surface as drifted
- show a warning banner on `/oneshot`
- do not silently mutate DB rows to match AWS

Potential causes:

- manual ECS change outside the control plane
- workflow callback failure
- rollback performed outside the dashboard path

## 4. Stale deployment detection

Any deployment stuck too long in:

- `requested`
- `awaiting_approval`
- `building`
- `pushing`
- `deploying`

must be surfaced as stale.

Recommended thresholds:

- `requested` / `awaiting_approval`: 30 minutes
- `building` / `pushing`: 30 minutes
- `deploying`: 20 minutes

The UI should display a stale warning and link to the workflow if available.

## 5. Callback failure recovery contract

If the workflow succeeded but the callback failed, the system must be repairable without editing rows blindly.

Recommended reconciliation process:

1. load latest non-terminal workflow run for the deployment row
2. load current ECS task definition image
3. compare with expected immutable deployment image
4. if ECS matches the expected image and workflow succeeded:
   - repair row to `active`
5. if ECS does not match:
   - keep row non-active and surface drift

This logic belongs in a small reconciliation service, not in the frontend.

## 6. Reset / rollback contract

The preview slot must support reset.

Recommended path:

- `.github/workflows/coreapp-preview-reset.yml`

Reset modes:

1. deploy last known baseline image
2. redeploy the `master` branch build for `cp-medhok-monorepo`

Rules:

- reset becomes a normal deployment row or reset-specific deployment row
- current active row is superseded only after reset succeeds
- reset failures must not clear the current active row

## 7. UI operational behavior

The `/oneshot` UI must expose enough signal for operators to act without opening AWS first.

Required row-level signals:

- light color
- deploy status label
- workflow link
- image tag
- preview URL when active
- failure message when failed

Required board-level signals:

- global warning when drift is detected
- global warning when a deployment is stale
- global warning when trusted operator identity headers are missing

## 8. Admin guardrails

Recommended rules:

- if a deployment is in flight, disable deploy buttons for all eligible rows
- if drift is detected, still allow deploy only if operators consciously choose to override
- if trusted upstream operator headers are missing, hide write controls entirely

## 9. Observability and metrics

Recommended metrics/logs:

- total OneShot board rows by `displayState`
- total deployments by `status`
- time from deploy request to active
- failed deployment count
- preview drift boolean
- stale deployment count

These can begin as structured logs and SQL-backed admin views before becoming formal dashboards.

## 10. Failure scenarios

### Case A: dispatch failed

- deployment row -> `failed`
- current active row remains active

### Case B: build failed

- deployment row -> `failed`
- current active row remains active

### Case C: push failed

- deployment row -> `failed`
- current active row remains active

### Case D: ECS rollout failed

- deployment row -> `failed`
- current active row remains active

### Case E: workflow succeeded but callback failed

- deployment row appears stale or in-flight
- reconciliation compares workflow and ECS to repair or flag drift

### Case F: manual deploy outside the system

- ECS image differs from DB active row
- dashboard enters drift state
- operator must either normalize through the control plane or explicitly document the manual change

## 11. Suggested tests

Operational tests:

- create a successful deployment and verify active row change
- fail a deployment and verify old active remains green
- simulate callback failure and verify reconciliation can repair
- simulate manual ECS drift and verify dashboard warns
- run reset workflow and verify new baseline becomes active

## 12. Phase 4 acceptance criteria

- operators can tell which row is active without AWS console access
- the dashboard surfaces stale deployments
- the dashboard surfaces drift
- failed deploys do not wipe the previous active indicator
- the preview slot can be reset through a documented path
- there is a supported recovery path for callback gaps
