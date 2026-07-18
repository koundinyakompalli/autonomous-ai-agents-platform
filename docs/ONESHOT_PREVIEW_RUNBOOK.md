# OneShot Preview Runbook

## Purpose

This runbook covers the dashboard and preview-deploy surface for OneShot.

It is separate from [ONESHOT_RUNBOOK.md](./ONESHOT_RUNBOOK.md), which focuses on the core OneShot runtime:

- `QUALIFIER`
- `PLANNER`
- `REVIEWER`
- `IMPLEMENTER`
- `CODE_REVIEWER`
- `TESTER`

This runbook covers:

- the `/oneshot` board
- preview deployment rows
- the `core-app` preview slot
- workflow inspection
- ECS drift checks
- reset and recovery

## Scope

Preview target:

- repo: `https://github.com/mhk-repos/cp-medhok-monorepo.git`
- ECR: `323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp`
- ECS cluster: `CLIENT-A`
- ECS service: `CLIENT-A-cp-dev-mhk-core`
- target container: `app-container`
- slot name: `core-app-preview`

## Preconditions

Before using preview deploys:

- the OneShot dashboard route `/oneshot` exists
- `oneshot_deployments` exists
- implementation commit SHA is persisted for deploy-eligible runs
- `coreapp-preview-deploy.yml` exists and is wired to the dashboard backend
- the dashboard backend has:
  - operator identity extraction configured
  - workflow dispatch token configured
  - callback secret configured

## 1. Check OneShot board data

Expected route:

- `/oneshot`

Expected row features:

- Jira key
- repo
- base branch
- implementation branch
- progress bar
- PR link
- deploy light
- deploy button for eligible `core-app` rows

If rows are missing:

1. call `GET /api/oneshot/runs`
2. verify `oneshot_runs`
3. verify orphaned `QUALIFIER` `task_management` rows

## 2. Check deployment rows

```sql
SELECT
  id,
  oneshot_run_id,
  slot_name,
  branch_name,
  commit_sha,
  status,
  image_uri,
  task_definition_arn,
  preview_url,
  workflow_run_id,
  workflow_url,
  error,
  created_at,
  updated_at
FROM oneshot_deployments
ORDER BY created_at DESC;
```

## 3. Check active deployment

```sql
SELECT
  id,
  oneshot_run_id,
  branch_name,
  commit_sha,
  image_uri,
  preview_url,
  updated_at
FROM oneshot_deployments
WHERE status = 'active';
```

There should be at most one row.

## 4. Check in-flight deployment

```sql
SELECT
  id,
  oneshot_run_id,
  branch_name,
  commit_sha,
  status,
  workflow_run_id,
  workflow_url,
  updated_at
FROM oneshot_deployments
WHERE status IN ('requested', 'awaiting_approval', 'building', 'pushing', 'deploying')
ORDER BY updated_at DESC;
```

There should be at most one row.

## 5. Check run eligibility

For a run that should have a deploy button:

```sql
SELECT
  r.id,
  r.jira_key,
  r.state,
  cr.repo_name,
  r.current_implementation_branch,
  r.current_implementation_commit_sha,
  r.current_pr_url
FROM oneshot_runs r
JOIN code_repositories cr ON cr.id = r.repo_id
WHERE r.id = <RUN_ID>;
```

Expected:

- `repo_name = core-app`
- `state IN ('pr_open', 'completed')`
- `current_implementation_branch` present
- `current_implementation_commit_sha` present

Current runtime note:

- most deployable successful runs will be in `pr_open`
- `completed` is allowed by the dashboard and deploy APIs, but is less common in the current implementation

## 6. Check ECS live image

Use AWS CLI to inspect the service and current task definition:

```bash
aws ecs describe-services \
  --cluster CLIENT-A \
  --services CLIENT-A-cp-dev-mhk-core
```

Then inspect the current task definition and verify the `app-container` image.

Compare it to the active deployment row `image_uri`.

If they differ:

- treat as drift
- do not edit DB rows blindly

## 7. Common failure patterns

### Deploy button disabled unexpectedly

Check:

- run repo is `core-app`
- run state is `pr_open` or `completed`
- implementation commit SHA exists
- no other in-flight deployment exists
- trusted operator identity headers are present on the dashboard backend

### Row never turns green

Check:

- workflow conclusion
- callback route success/failure
- ECS service rollout state
- deployment row status

### Previous active row turned red too early

This is a bug.

The old active row must remain green until the new deployment becomes `active`.

### Deploy is stuck amber

Check:

- GitHub environment approval
- workflow run state
- stale thresholds
- callback failures

## 8. Workflow inspection

For a deployment row, inspect:

- `workflow_run_id`
- `workflow_url`

Open the workflow and verify:

- approval gate passed
- build succeeded
- ECR push succeeded
- ECS update succeeded
- callback step succeeded

If callback failed after AWS succeeded, use reconciliation instead of manually editing the row first.

## 9. Drift recovery

If ECS live image does not match the active deployment row:

1. inspect the latest deploy workflow run
2. inspect whether a manual deploy happened outside the control plane
3. decide whether to:
   - repair the DB row through reconciliation
   - or redeploy through the dashboard/workflow path

Do not mark rows active or superseded based on guesswork alone.

## 10. Reset the preview slot

Preferred path:

- run the preview reset workflow

Current reset target:

- rebuild and redeploy the `master` branch of `cp-medhok-monorepo`

Do not manually flip deployment rows in the DB unless you are doing explicit recovery and have already confirmed the live ECS image state.

## 11. Recovery checklist

When a preview deployment fails:

1. confirm previous active row still exists
2. confirm ECS is still serving the previous image or has returned to stable state
3. inspect workflow logs
4. inspect `oneshot_deployments.error`
5. retry only after root cause is understood

When a deployment appears stuck:

1. verify GitHub environment approval
2. verify workflow still running
3. compare stale threshold to current age
4. inspect callback route logs
5. use reconciliation if AWS succeeded but the row did not advance

## 12. Operator guidance

- green: this row is currently deployed in the preview slot
- amber: this row is deploying or awaiting approval
- red: this row is eligible but not active, or it failed
- grey: this row is not eligible for deploy

The dashboard should never imply that two rows are active at once.
