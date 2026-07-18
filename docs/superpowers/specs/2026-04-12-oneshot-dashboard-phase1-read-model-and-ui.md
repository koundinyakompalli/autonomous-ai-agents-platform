# OneShot Dashboard Phase 1 Design: Read Model and UI

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime and dashboard have changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12
**Status**: Ready for implementation
**Parent plan**: `plans/11-oneshot-dashboard-and-preview-deploy.md`
**Phase**: 1 of 4

## Summary

Phase 1 adds the read-only OneShot board to the existing dashboard service.

This phase establishes:

- the `/oneshot` route
- a normalized backend read model
- visibility for qualification failures
- a stable row schema
- progress-bar rendering
- PR button rendering
- read-only deployment light rendering

Phase 1 intentionally does **not** submit deploy requests yet.

## Current codebase baseline

These current files define the implementation starting point:

- [dashboard/server/index.ts](../../../dashboard/server/index.ts)
  - only mounts `/api/state` and `/api/assets`
- [dashboard/server/db.ts](../../../dashboard/server/db.ts)
  - only exposes `query<T>()` and `getPool()`
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx)
  - single-screen office view, no router
- [dashboard/src/useSpecterAgents.ts](../../../dashboard/src/useSpecterAgents.ts)
  - existing polling pattern worth reusing

The plan assumes we extend this app, not replace it.

## Deliverables

```text
dashboard/server/routes/oneshot.ts
dashboard/server/services/oneshot.ts
dashboard/server/types/oneshot.ts
dashboard/src/App.tsx
dashboard/src/routes/OneShotPage.tsx
dashboard/src/oneshot/OneShotTable.tsx
dashboard/src/oneshot/OneShotRow.tsx
dashboard/src/oneshot/OneShotFilters.tsx
dashboard/src/hooks/useOneShotRuns.ts
```

Package change:

```text
dashboard/package.json
```

Recommended addition:

- `react-router-dom`

## 1. Route and app-shell design

### Route contract

Add:

- `/` -> existing office-map dashboard
- `/oneshot` -> OneShot operations board

### App-shell recommendation

The smallest clean implementation is:

- add `react-router-dom`
- create a lightweight top-nav or tab switch
- preserve the current office view as the default route

This is better than manually switching on `window.location.pathname` inside `App.tsx`.

## 2. Backend read-model contract

### Route

- `GET /api/oneshot/runs`

### Query parameters

Support at least:

- `limit`
- `offset`
- `state`
- `repo`
- `jira_key`
- `deployment`

Suggested values for `deployment`:

- `eligible`
- `active`
- `inflight`

### Response shape

The route returns one normalized row shape regardless of whether the source row came from `oneshot_runs` or `task_management`.

Recommended response:

```json
{
  "runs": [
    {
      "dashboardId": "run-42",
      "jiraKey": "MPDEV-123",
      "title": "Implement PFOS feature flow",
      "sourceTaskManagementId": 1234,
      "oneshotRunId": 42,
      "displayState": "reviewing",
      "progressStage": "review",
      "progressPercent": 60,
      "repoName": "core-app",
      "repoUrl": "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      "baseBranch": "master",
      "baseCommitSha": "abcd1234...",
      "implementationBranch": "oneshot/mpdev-123-run-42",
      "implementationCommitSha": "efgh5678...",
      "reviewLoopCount": 1,
      "maxReviewLoops": 3,
      "currentPrUrl": "https://github.com/...",
      "qualificationSummary": "Repo and branch identified. Requirements clear.",
      "lastError": null,
      "deployment": {
        "eligible": true,
        "light": "red",
        "status": "superseded",
        "active": false,
        "previewUrl": null,
        "workflowUrl": "https://github.com/...",
        "imageUri": "323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp:oneshot-42-deploy-7-abcd123"
      },
      "createdAt": "2026-04-12T20:00:00Z",
      "updatedAt": "2026-04-12T20:10:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

## 3. Read-model sources

### Source A: `oneshot_runs`

For real runs, join:

- `oneshot_runs`
- `code_repositories`
- `task_management`
- `tasks`
- latest implementation artifact metadata
- latest deployment summary row

Required output fields from this source:

- Jira key
- ticket title/summary
- repo name/url
- base branch / base commit
- current implementation branch / commit
- review loop counts
- PR URL
- deployment summary
- timestamps

### Source B: `QUALIFIER` tasks with no run

Use `task_management` rows where:

- `agent_id` resolves to `QUALIFIER`
- no `oneshot_runs.source_task_management_id` exists
- source ticket has the `PFOS` label or was picked by PFOS-only routing

Normalize these rows into dashboard states:

- active `task_management.status`:
  - `assigned`
  - `in_progress`
  - `posting_to_jira`
  => `qualification_pending`
- terminal `task_management.status`:
  - `completed`
  - `posted_to_jira`
  - `failed`
  => `qualification_failed`

For these rows:

- `oneshotRunId = null`
- `repoName = null`
- `implementationBranch = null`
- `implementationCommitSha = null`
- `deployment.eligible = false`

### Qualification-failure retention

The default board should show only the most recent `10` qualification-failure rows.

That limit applies to the default unfiltered board so the `/oneshot` view does not get dominated by stale PFOS tickets that never entered the real run pipeline.

Older qualification-failure rows remain reachable through:

- pagination
- search
- explicit state filtering for `qualification_failed`

## 4. Suggested SQL approach

Do not try to express the entire board in one giant SQL statement on day one.

Recommended backend shape:

1. query real `oneshot_runs`
2. query orphaned `QUALIFIER` tasks
3. normalize each result set in TypeScript
4. merge
5. sort by `updatedAt DESC`
6. apply pagination in service code for v1

This keeps the implementation understandable and easier to test.

If the board becomes slow later, optimize into a DB view after the contract is proven.

## 5. Progress-bar contract

Use five fixed stages:

1. Qualification
2. Planning
3. Review
4. Implementation
5. PR / Complete

### State-to-stage mapping

| display state | stage | progress |
|---|---|---|
| `qualification_pending` | Qualification | 5 |
| `qualification_failed` | Qualification | 10 |
| `queued_for_planning` | Planning | 20 |
| `planning` | Planning | 30 |
| `queued_for_review` | Review | 50 |
| `reviewing` | Review | 60 |
| `needs_revision` | Review | 45 |
| `approved` | Review | 70 |
| `escalated` | Review | 65 |
| `blocked` | Review | 65 |
| `queued_for_implementation` | Implementation | 75 |
| `implementing` | Implementation | 85 |
| `replan_required` | Implementation | 85 |
| `pr_open` | PR / Complete | 95 |
| `completed` | PR / Complete | 100 |
| `failed` | derive from latest known stage |

### Failed-state rule

For `failed`, derive the current stage from:

1. latest artifact stage, if present
2. otherwise previous state transition if available
3. otherwise default to the most advanced known stage for the row

The UI should not display failed rows as if they never progressed.

## 6. Row layout contract

Every row should show:

- Jira key
- ticket summary/title
- repo name
- base branch
- implementation branch, when available
- stage/status badge
- progress bar
- review loop count
- updated time
- PR button
- deployment light
- deploy button placeholder

Recommended row secondary details:

- base commit SHA
- implementation commit SHA
- latest error or qualification failure reason

Use a compact row with an expandable detail section for long summaries.

## 7. PR button contract

The PR button is enabled only when `currentPrUrl` exists.

Behavior:

- label: `Open PR`
- target: new browser tab
- disabled tooltip: `Draft PR not available yet`

## 8. Deploy-light rendering contract

In Phase 1 the light is read-only.

The frontend must not recompute complex deployment logic from raw DB flags. The backend returns:

- `eligible`
- `light`
- `status`
- `active`
- `previewUrl`
- `workflowUrl`

Hover/tooltips:

- green: `Active in preview slot`
- amber: `Deployment in progress`
- red: `Not the active preview deployment`
- grey: `Deploy unavailable for this row`

## 9. Deploy-button contract in Phase 1

Phase 1 is read-only, but the button should still exist so the row contract is stable.

Rules:

- show button only when the row is deploy-eligible
- keep it disabled
- tooltip: `Deploy support is not enabled yet`

This prevents a future UI redesign when Phase 2 lands.

## 10. Filtering and sorting

### Default sort

- `updatedAt DESC`

### Required filters

- all
- active
- blocked
- escalated
- failed
- replan required
- deployment eligible
- deployment active

### Search

Support a single text input across:

- Jira key
- repo name
- branch
- ticket title / summary

Search must work across both sources:

- `oneshot_runs`
- orphaned `QUALIFIER` task rows

## 11. Frontend polling model

Match the existing dashboard pattern:

- poll `/api/oneshot/runs` every 5 seconds

Do not add WebSockets in v1.

The polling hook should expose:

- `data`
- `isLoading`
- `error`
- `refresh()`

## 12. Error and empty states

Required empty states:

- no PFOS activity yet
- no rows match the current filter

Required error state:

- backend query failed

The board must not silently render an empty table on backend failure.

## 13. Pagination contract

Pagination is required in v1.

Recommended backend behavior:

- support `limit` + `offset`
- default `limit = 50`

Recommended frontend behavior:

- next / previous paging controls
- preserve current search and filter state when paging
- show a visible row count or page summary

Qualification-failed rows must participate in the same pagination model as normal OneShot rows.

## 14. Backend implementation notes

The dashboard backend currently only has a generic read helper. Keep Phase 1 clean:

- add `dashboard/server/services/oneshot.ts`
- keep SQL and normalization there
- keep `dashboard/server/routes/oneshot.ts` thin

Do not drop a large multi-join SQL string into `index.ts` or `App.tsx`.

## 15. Suggested tests

Backend:

- qualified run row normalization
- qualification failure row normalization
- progress mapping
- deployment light mapping

Frontend:

- `/oneshot` route renders
- qualification-failure row renders without PR/deploy
- PR button enable/disable logic
- deploy light colors
- filters and search

## 16. Phase 1 acceptance criteria

- `/oneshot` route exists
- office dashboard at `/` still works
- qualified OneShot rows render
- qualification failure rows render
- only the latest 10 qualification-failure rows appear on the default board
- pagination works across the normalized row set
- search works across both real runs and qualification-failure rows
- progress bars render consistently across all states
- PR buttons behave correctly
- deployment lights render from backend summary
- no write action is exposed yet
