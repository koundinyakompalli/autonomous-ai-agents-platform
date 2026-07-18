# OneShot Dashboard Phase 2 Design: Deploy Control Plane

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime and dashboard have changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12
**Status**: Ready for implementation
**Parent plan**: `plans/11-oneshot-dashboard-and-preview-deploy.md`
**Phase**: 2 of 4

## Summary

Phase 2 adds the durable deployment control plane behind the OneShot board.

This phase introduces:

- immutable implementation commit capture
- `oneshot_deployments`
- dashboard deploy request API
- GitHub workflow dispatch
- status callbacks
- active/in-flight slot locking

Phase 2 does **not** define the build/deploy workflow internals. That is Phase 3.

## Current implementation gap

Today the implementer persists:

- `implementationBranch`
- `prUrl`

in [src/oneshot/schema/implementation.ts](../../../src/oneshot/schema/implementation.ts), but it does **not** persist the pushed commit SHA.

That means the system cannot yet answer:

- exactly what commit a row would deploy
- whether the active preview deployment matches the current implementation result

Phase 2 starts by fixing that.

## Deliverables

```text
db/migrations/007_oneshot_dashboard_support.sql
db/migrations/008_oneshot_deployments.sql
dashboard/server/routes/oneshot-deployments.ts
dashboard/server/services/oneshotDeployments.ts
dashboard/server/services/githubActionsDispatch.ts
dashboard/server/types/oneshotDeployments.ts
src/oneshot/schema/implementation.ts
src/oneshot/consumers/implementer.ts
src/oneshot/types.ts
src/oneshot/database/runs.ts
```

Optional helper:

```text
dashboard/server/auth/operatorIdentity.ts
```

## 1. Schema change: immutable implementation identity

### 1.1 Implementation artifact schema

Add a required field:

- `implementationCommitSha`

to the implementation artifact schema and output contract.

Required updates:

- [src/oneshot/schema/implementation.ts](../../../src/oneshot/schema/implementation.ts)
- implementer provider output contract
- implementer consumer artifact write path

### 1.2 Denormalize onto `oneshot_runs`

Add two columns:

- `current_implementation_branch`
- `current_implementation_commit_sha`

Reason:

- Phase 1 board queries become simple
- deploy request validation becomes simple
- deploy workflow dispatch can use stable values without re-reading S3

Recommended migration:

- `007_oneshot_dashboard_support.sql`

## 2. Schema change: deployments table

Add a new table:

```sql
CREATE TABLE oneshot_deployments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  oneshot_run_id BIGINT NOT NULL,
  slot_name VARCHAR(100) NOT NULL DEFAULT 'core-app-preview',
  repo_id INT NOT NULL,
  branch_name VARCHAR(255) NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  pr_url VARCHAR(1024) NULL,
  requested_by VARCHAR(255) NULL,
  requested_by_display VARCHAR(255) NULL,
  status VARCHAR(50) NOT NULL,
  workflow_run_id BIGINT NULL,
  workflow_url VARCHAR(1024) NULL,
  image_uri VARCHAR(1024) NULL,
  task_definition_arn VARCHAR(1024) NULL,
  ecs_cluster_name VARCHAR(255) NOT NULL,
  ecs_service_name VARCHAR(255) NOT NULL,
  preview_url VARCHAR(1024) NULL,
  error TEXT NULL,
  superseded_by BIGINT NULL,
  active_slot VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN status = 'active' THEN slot_name
        ELSE NULL
      END
    ) STORED,
  inflight_slot VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('requested', 'awaiting_approval', 'building', 'pushing', 'deploying')
          THEN slot_name
        ELSE NULL
      END
    ) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,

  UNIQUE KEY uk_active_slot (active_slot),
  UNIQUE KEY uk_inflight_slot (inflight_slot),
  CONSTRAINT fk_oneshot_deployments_run FOREIGN KEY (oneshot_run_id) REFERENCES oneshot_runs(id),
  CONSTRAINT fk_oneshot_deployments_repo FOREIGN KEY (repo_id) REFERENCES code_repositories(id),
  INDEX idx_run_id (oneshot_run_id),
  INDEX idx_status (status),
  INDEX idx_slot_name (slot_name)
);
```

Recommended migration:

- `008_oneshot_deployments.sql`

## 3. Deployment status model

Allowed statuses:

- `requested`
- `awaiting_approval`
- `building`
- `pushing`
- `deploying`
- `active`
- `failed`
- `superseded`
- `cancelled`

Ownership:

- dashboard API creates `requested`
- workflow status callback moves through `awaiting_approval`, `building`, `pushing`, `deploying`
- backend transaction marks `active` and supersedes the previous active row
- failures become `failed`

## 4. Deploy request API

### Route

- `POST /api/oneshot/deployments`

### Request body

```json
{
  "oneshotRunId": 42
}
```

The client does **not** submit:

- repo URL
- branch
- commit SHA
- PR URL

The server derives all of those from durable OneShot state.

### Validation rules

Reject the request if:

- the run does not exist
- the repo is not `core-app`
- the run state is not `pr_open` or `completed`
- `current_implementation_branch` is missing
- `current_implementation_commit_sha` is missing
- another deployment is already in flight

Recommended response codes:

- `400` invalid request
- `403` missing/invalid operator identity
- `404` run not found
- `409` deploy already in progress

## 5. Operator identity contract

The dashboard backend must stamp:

- `requested_by`
- `requested_by_display`

onto every deployment row.

Recommended extraction:

- read configured trusted headers from the reverse proxy
- reject write requests if identity is absent

## 6. GitHub workflow dispatch

The dashboard backend dispatches a GitHub Actions workflow in this repo.

Recommended workflow:

- `.github/workflows/coreapp-preview-deploy.yml`

Recommended dispatch API:

- GitHub REST `workflow_dispatch`

Required dashboard backend secret:

- `GITHUB_ACTIONS_DISPATCH_TOKEN`

Keep `GITHUB_ACTIONS_DISPATCH_TOKEN` as a distinct dashboard/backend config name.

For v1, it may point to the same underlying GitHub token value currently used for OneShot PR creation, as long as that token has workflow dispatch permission for this repo.

The config names should still remain separate so dispatch and runtime write capabilities can be split later without code changes.

## 7. Dispatch payload contract

Recommended inputs:

- `deployment_id`
- `oneshot_run_id`
- `repo_url`
- `branch_name`
- `commit_sha`
- `pr_url`
- `slot_name`
- `requested_by`

The backend creates the DB row first, then dispatches the workflow.

If dispatch fails:

- mark deployment `failed`
- persist the error
- leave any current active row untouched

## 8. Workflow callback contract

The workflow must report status changes back to the dashboard backend.

### Route

- `POST /api/oneshot/deployments/:id/status`

### Auth

Use a shared secret header, for example:

- `X-Deploy-Webhook-Secret`

Required dashboard backend env var:

- `ONESHOT_DEPLOY_WEBHOOK_SECRET`

### Payload

```json
{
  "status": "deploying",
  "workflowRunId": 24320000000,
  "workflowUrl": "https://github.com/...",
  "imageUri": "323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp:oneshot-42-deploy-7-abcd123",
  "taskDefinitionArn": "arn:aws:ecs:...",
  "previewUrl": "https://<preview-url>",
  "error": null
}
```

The callback route must enforce valid state transitions. It must not accept arbitrary jumps from `requested` to `active` from an unauthenticated caller.

## 9. Active/superseded transaction

When the workflow reports `active`, the backend performs one DB transaction:

1. load current active deployment for the slot
2. mark that row `superseded` and set `superseded_by`
3. mark the new row `active`
4. set `completed_at`

If no previous active row exists, step 2 is skipped.

This transaction is required to preserve the single-slot contract.

## 10. Read-model extension

`GET /api/oneshot/runs` must include deployment summary fields per row:

- `deployment.eligible`
- `deployment.light`
- `deployment.status`
- `deployment.active`
- `deployment.previewUrl`
- `deployment.workflowUrl`
- `deployment.imageUri`
- `deployment.deployedCommitSha`

The frontend should not join deployment rows itself.

## 11. Required code updates outside the dashboard

Before Phase 2 is complete, also update:

- [src/oneshot/schema/implementation.ts](../../../src/oneshot/schema/implementation.ts)
- [src/oneshot/consumers/implementer.ts](../../../src/oneshot/consumers/implementer.ts)
- [src/oneshot/types.ts](../../../src/oneshot/types.ts)
- [src/oneshot/database/runs.ts](../../../src/oneshot/database/runs.ts)

The implementer must persist both:

- branch name
- commit SHA

immediately after commit creation and before PR creation.

## 12. Suggested tests

DB/service tests:

- deploy request validation
- duplicate in-flight request rejection
- active/superseded transaction behavior
- invalid callback transition rejection

API tests:

- unauthorized deploy request rejected
- dispatch failure marks row failed
- status callback updates persisted fields

## 13. Phase 2 acceptance criteria

- implementation commit SHA is persisted
- `oneshot_deployments` exists
- dashboard backend can create a deployment row for an eligible `core-app` run
- duplicate in-flight requests are rejected
- workflow dispatch is durable and auditable
- callback updates are authenticated
- active deployment supersession is transactional
