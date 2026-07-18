# OneShot Dashboard Phase 0 Design: Contracts and Preview Slot Model

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime and dashboard have changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12
**Status**: Ready for implementation
**Parent plan**: `plans/11-oneshot-dashboard-and-preview-deploy.md`
**Phase**: 0 of 4

## Summary

Phase 0 freezes the contracts that every later phase depends on:

- dashboard scope
- preview-slot semantics
- deploy eligibility
- deployment identity
- status-light meaning
- authorization expectations
- exact preview target

No code ships in Phase 0. The purpose is to remove ambiguity before implementation starts.

## Deliverables

```text
docs/superpowers/specs/2026-04-12-oneshot-dashboard-phase0-contracts.md
docs/coreapp-preview-build-contract.md
```

## Existing implementation constraints

These current codebase facts are part of the contract:

- the dashboard backend currently exposes only `/api/state` and `/api/assets` in [dashboard/server/index.ts](../../../dashboard/server/index.ts)
- the dashboard backend currently has only a simple read helper in [dashboard/server/db.ts](../../../dashboard/server/db.ts)
- the dashboard frontend currently has no router in [dashboard/src/App.tsx](../../../dashboard/src/App.tsx)
- OneShot implementation artifacts currently do **not** store commit SHA in [src/oneshot/schema/implementation.ts](../../../src/oneshot/schema/implementation.ts)
- the implementer currently creates a branch and draft PR in [src/oneshot/consumers/implementer.ts](../../../src/oneshot/consumers/implementer.ts)

The later phases must adapt to these constraints instead of assuming a clean-sheet app.

## 1. Dashboard scope contract

The existing dashboard at `https://productfactory.mhkdevsandbox.com/` gains a new route:

- `/oneshot`

This route is the OneShot operations board.

It must show:

- qualified OneShot runs from `oneshot_runs`
- `PFOS` tickets currently under qualification
- `PFOS` tickets that failed qualification before a run was created
- current PR link when one exists
- preview deployment state for eligible `core-app` rows

It does **not** replace the office map at `/`.

## 2. Preview target contract

The preview slot is fixed in v1:

- slot name: `core-app-preview`
- repo gate: `code_repositories.repo_name = 'core-app'`
- repo URL: `https://github.com/mhk-repos/cp-medhok-monorepo.git`
- ECR repo: `323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp`
- ECS cluster: `CLIENT-A`
- ECS service: `CLIENT-A-cp-dev-mhk-core`
- task definition family: `CLIENT-A-cp-dev-mhk-core`
- target container to mutate: `app-container`

No other repo or ECS service is covered by this phase set.

## 3. Single-slot contract

The preview slot is single-slot and single-flight.

At all times there may be:

- zero or one `active` deployment
- zero or one in-flight deployment

There may never be:

- two active deployments
- two in-flight deployments

This rule is enforced in the data model, not just in the UI.

## 4. Deploy eligibility contract

A row is deploy-eligible only when all of the following are true:

- it represents a real `oneshot_runs` row
- the resolved repo is `core-app`
- the run state is `pr_open` or `completed`
- the latest implementation artifact exists for the current implementation version
- the implementation artifact contains:
  - `implementationBranch`
  - `implementationCommitSha`
  - `prUrl`

Rows that do not satisfy every condition must not expose an enabled deploy action.

## 5. Immutable deployment identity contract

Deployment identity is:

- `repo_name`
- `implementation_branch`
- `implementation_commit_sha`

The preview system must not deploy:

- branch head at request time
- mutable `latest` image tags as the ECS task-definition identity
- “whatever commit is currently on the PR branch”

The workflow may publish convenience tags if needed for operators, but the ECS task definition must reference the immutable deployment tag.

Recommended image tag:

```text
oneshot-<run-id>-deploy-<deployment-id>-<short-sha>
```

## 6. Status-light contract

Every row exposes a deployment indicator, even if the deploy button is disabled.

### Light colors

- green:
  - this row is the active deployment for the slot
- amber:
  - this row has an in-flight deployment request
  - statuses: `requested`, `awaiting_approval`, `building`, `pushing`, `deploying`
- red:
  - this row is deploy-eligible but is not the active deployment
  - statuses include `failed` and `superseded`
- grey:
  - this row is not deploy-eligible

### State precedence

- active always wins and renders green
- in-flight always renders amber
- not-eligible always renders grey
- otherwise eligible inactive rows render red

## 7. Active/superseded transition contract

When a new deployment request is created:

- the currently active row remains active and green
- the new row becomes amber

Only when the new deployment succeeds:

- the new row becomes `active` and green
- the previous active row becomes `superseded` and red

If the new deployment fails:

- the new row becomes `failed` and red
- the previous active row remains `active` and green

This rule is not optional.

## 8. Authorization contract

Read access can continue to use the current dashboard access pattern.

Deploy requests are write actions and require operator identity.

The v1 contract is:

- deploy requests must not be accepted anonymously
- the dashboard backend must stamp `requested_by` and a display value onto the deployment row
- deploy requests are authorized only through trusted upstream identity headers injected by the reverse proxy
- the workflow itself still pauses behind `specter-aws-operations`

This gives two distinct control layers:

1. dashboard-side operator identity
2. GitHub Actions environment approval

## 9. Dashboard auth/header contract

Because the current dashboard has no auth middleware, v1 uses a trusted upstream-header contract for write actions.

Recommended env-driven contract:

- `DASHBOARD_OPERATOR_ID_HEADER`
- `DASHBOARD_OPERATOR_NAME_HEADER`

The dashboard backend treats these headers as trusted only when injected by a reverse proxy. If either is missing in production, write actions remain disabled.

## 10. Preview URL contract

The dashboard should show the preview URL for the active deployment when available.

Do not make the frontend discover this dynamically from AWS.

Recommended backend/workflow env var:

- `COREAPP_PREVIEW_URL`

The active deployment row stores this value when the rollout completes.

## 11. Required schema-extension contract

The current implementer schema is insufficient because it does not persist commit SHA.

Phase 2 must add:

- `implementationCommitSha` to the implementation artifact schema

Recommended denormalized fields on `oneshot_runs`:

- `current_implementation_branch`
- `current_implementation_commit_sha`

This is required to keep Phase 1 and Phase 2 read queries simple and deterministic.

## 12. Required normalized dashboard state contract

The dashboard must expose one normalized row model even though the data comes from two places:

- `oneshot_runs`
- `QUALIFIER` `task_management`

Required synthetic states:

- `qualification_pending`
- `qualification_failed`

All later OneShot states reuse `oneshot_runs.state`.

## 13. Progress-stage contract

The UI uses exactly five primary stages:

1. Qualification
2. Planning
3. Review
4. Implementation
5. PR / Complete

The following are overlays, not separate primary stages:

- `blocked`
- `escalated`
- `replan_required`
- `failed`

## 14. Environment and secret contract

Later phases may not invent these ad hoc. Use the following names unless there is a hard reason to deviate:

Dashboard backend:

- `COREAPP_PREVIEW_URL`
- `GITHUB_ACTIONS_DISPATCH_TOKEN`
- `ONESHOT_DEPLOY_WEBHOOK_SECRET`
- `DASHBOARD_OPERATOR_ID_HEADER`
- `DASHBOARD_OPERATOR_NAME_HEADER`

GitHub workflow:

- `COREAPP_PREVIEW_GITHUB_TOKEN`
- `COREAPP_PREVIEW_URL`

## 15. Preconditions for later phases

Before Phase 2 and Phase 3 start:

- the dashboard read model must include qualification failures
- commit SHA persistence must be part of the implementation artifact contract
- the `core-app` preview target must remain the same ECS service
- the build contract doc for `core-app` must be written before workflow coding starts

## 16. Phase 0 acceptance checklist

Phase 0 is complete when all of the following are unambiguous:

- everyone agrees the board includes qualification failures
- everyone agrees `Deploy` is `core-app` only
- single-slot semantics are frozen
- green/amber/red/grey meanings are frozen
- immutable commit deployment is required
- old-active-until-success semantics are frozen
- the exact preview target resources are frozen
- dashboard write actions are explicitly blocked behind operator identity and GitHub approval
