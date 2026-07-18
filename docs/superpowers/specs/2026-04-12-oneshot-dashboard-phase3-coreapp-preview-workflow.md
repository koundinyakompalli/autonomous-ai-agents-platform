# OneShot Dashboard Phase 3 Design: Core-App Preview Deployment Workflow

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime and dashboard have changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12
**Status**: Ready for implementation
**Parent plan**: `plans/11-oneshot-dashboard-and-preview-deploy.md`
**Phase**: 3 of 4

## Summary

Phase 3 defines the actual preview deployment workflow for `core-app`.

The workflow:

- receives a deployment request created by the dashboard
- pauses behind the existing GitHub approval gate
- checks out the exact implementation commit from `cp-medhok-monorepo`
- builds the `core-app` image
- pushes it to the existing ECR repo
- registers a new ECS task-definition revision
- updates the existing preview ECS service
- waits for steady state
- reports status back to the dashboard backend

The workflow is intentionally scoped to a single mutable preview slot.

## Existing infrastructure contract

These AWS targets are fixed inputs to the workflow:

- repo:
  - `https://github.com/mhk-repos/cp-medhok-monorepo.git`
- ECR:
  - `323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp`
- ECS cluster:
  - `CLIENT-A`
- ECS service:
  - `CLIENT-A-cp-dev-mhk-core`
- task definition family:
  - `CLIENT-A-cp-dev-mhk-core`
- container to update:
  - `app-container`

The current task definition contains other containers. The workflow must not mutate those.

## Deliverables

```text
.github/workflows/coreapp-preview-deploy.yml
.github/workflows/coreapp-preview-reset.yml
.github/scripts/coreapp-preview/register-task-definition.py
.github/scripts/coreapp-preview/post-status.py
docs/coreapp-preview-build-contract.md
```

Optional helper:

```text
.github/scripts/coreapp-preview/extract-app-container.py
```

## 1. Precondition: build contract discovery

Before the workflow is coded, the build contract for `core-app` must be frozen in:

- [docs/coreapp-preview-build-contract.md](../../coreapp-preview-build-contract.md)

That document must define:

- Dockerfile path
- build context
- required build args
- required secret inputs
- any asset prebuild or package-manager steps
- health endpoint and startup expectation
- runtime assumptions that affect preview stability

The workflow must not guess these details.

## 2. Trigger model

### Primary trigger

- workflow dispatch from the dashboard backend

### Required inputs

- `deployment_id`
- `oneshot_run_id`
- `repo_url`
- `branch_name`
- `commit_sha`
- `pr_url`
- `slot_name`
- `requested_by`

### Optional manual trigger

Allow `workflow_dispatch` for operators as a fallback, but the primary path remains dashboard-driven.

## 3. Approval model

The workflow must pause before any AWS mutation behind:

- `specter-aws-operations`

Recommended state progression:

1. dashboard creates deployment row as `requested`
2. workflow starts and posts `awaiting_approval`
3. operator approves environment
4. workflow proceeds through:
   - `building`
   - `pushing`
   - `deploying`
   - `active` or `failed`

This keeps the board accurate during the approval wait.

## 4. Required workflow secrets and vars

GitHub Actions secrets:

- `AWS_ROLE_ARN`
- `COREAPP_PREVIEW_GITHUB_TOKEN`
- `ONESHOT_DEPLOY_WEBHOOK_SECRET`

GitHub Actions vars:

- `ECR_REGISTRY`

Workflow env:

- `COREAPP_PREVIEW_URL`
- `COREAPP_PREVIEW_ECR_REPO=medhok20/medhok-monorepo.coreapp`
- `COREAPP_PREVIEW_ECS_CLUSTER=CLIENT-A`
- `COREAPP_PREVIEW_ECS_SERVICE=CLIENT-A-cp-dev-mhk-core`
- `COREAPP_PREVIEW_CONTAINER_NAME=app-container`

## 5. GitHub repo checkout contract

The workflow must:

1. checkout this Specter repo for helper scripts
2. clone `cp-medhok-monorepo` using `COREAPP_PREVIEW_GITHUB_TOKEN`
3. fetch the target commit
4. checkout the exact `commit_sha`

The workflow may verify that the commit exists on `branch_name`, but build identity must still be the exact commit.

## 6. Image tagging contract

The workflow produces an immutable preview image tag:

```text
oneshot-<run-id>-deploy-<deployment-id>-<short-sha>
```

Example:

```text
323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp:oneshot-42-deploy-7-abcd123
```

The workflow may optionally move a convenience tag, but ECS must reference the immutable tag.

## 7. Workflow step contract

### Step 1: Mark awaiting approval

Call dashboard backend status callback with:

- `status = awaiting_approval`
- `workflowRunId`
- `workflowUrl`

### Step 2: Configure AWS

Use:

- GitHub OIDC
- `aws-actions/configure-aws-credentials@v4`

### Step 3: Clone target repo and checkout commit

Use the exact commit SHA supplied by the dashboard.

### Step 4: Mark building

Status callback:

- `status = building`

### Step 5: Build Docker image

Use the frozen build contract from `docs/coreapp-preview-build-contract.md`.

Required v1 build sequence from repo root:

1. Maven bootstrap:

```text
mvn -N -f medhok-parent-java21/pom.xml -s .m2/settings.xml --batch-mode install
```

2. Maven package:

```text
mvn -f medhok-parent-java21/pom.xml -s .m2/settings.xml --batch-mode package -P stamped
```

3. Verify WAR exists:

```text
MedicalMgmt/target/medical-mgmt-*.war
```

4. Docker build:

```text
docker build \
  -f MedicalMgmt/Dockerfile \
  -t 323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp:<tag> \
  MedicalMgmt
```

Current contract:

- Dockerfile path: `MedicalMgmt/Dockerfile`
- Docker context: `MedicalMgmt`
- Docker build args: none

The workflow must fail fast if the WAR is missing before the Docker build step.

### Step 6: Mark pushing

Status callback:

- `status = pushing`

### Step 7: Push to ECR

Push the immutable tag to:

- `323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp`

### Step 8: Mark deploying

Status callback:

- `status = deploying`

### Step 9: Read current task definition

Fetch the current task definition backing:

- `CLIENT-A-cp-dev-mhk-core`

Clone the full definition JSON.

### Step 10: Replace only `app-container.image`

Required mutation:

- replace the image on container named `app-container`

Do not mutate:

- sidecar images
- CPU/memory
- networking
- service desired count
- load balancer configuration
- service discovery

### Step 11: Register new task definition revision

Persist the full ARN for callback reporting.

### Step 12: Update ECS service

Update:

- cluster `CLIENT-A`
- service `CLIENT-A-cp-dev-mhk-core`

### Step 13: Wait for steady state

The workflow must wait until ECS reports stable service state before claiming success.

### Step 14: Mark active

Status callback must include:

- `status = active`
- `workflowRunId`
- `workflowUrl`
- `imageUri`
- `taskDefinitionArn`
- `previewUrl`

## 8. Failure rules

If the workflow fails before ECS update:

- mark deployment `failed`
- leave old active deployment untouched

If the workflow fails after registering a new task definition but before service stability:

- mark deployment `failed`
- leave old active deployment untouched
- do not supersede the previous active row

If the workflow succeeds in AWS but the callback fails:

- Phase 4 reconciliation must be able to repair the deployment row by comparing:
  - workflow conclusion
  - ECS live image
  - latest deployment row

## 9. Callback payload contract

At minimum, callbacks should be sent for:

- `awaiting_approval`
- `building`
- `pushing`
- `deploying`
- `active`
- `failed`

### Success payload

```json
{
  "status": "active",
  "workflowRunId": 24320000000,
  "workflowUrl": "https://github.com/...",
  "imageUri": "323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp:oneshot-42-deploy-7-abcd123",
  "taskDefinitionArn": "arn:aws:ecs:us-east-2:323960442001:task-definition/CLIENT-A-cp-dev-mhk-core:8",
  "previewUrl": "https://<preview-url>"
}
```

### Failure payload

```json
{
  "status": "failed",
  "workflowRunId": 24320000000,
  "workflowUrl": "https://github.com/...",
  "error": "Docker build failed during asset compilation"
}
```

## 10. Drift and Terraform contract

This ECS service may be managed by another Terraform stack or deployment system.

For this feature, treat `CLIENT-A-cp-dev-mhk-core` as a mutable preview slot.

Implications:

- dashboard/workflow owns the image mutation for preview purposes
- later Terraform plans on the owning stack may show drift
- operators must understand that this is intentional preview-slot behavior

This should be documented, not hidden.

## 11. Companion reset workflow

Preview rollback is required.

Implement:

- `.github/workflows/coreapp-preview-reset.yml`

The reset workflow should:

- restore the preview slot to a known baseline image
- or rebuild/deploy the `master` branch baseline for `cp-medhok-monorepo`
- update deployment rows the same way as normal deploy success/failure

## 12. Suggested tests

Workflow/scripting tests:

- task definition rewrite only changes `app-container.image`
- callback payload builder is correct
- immutable tag format is correct

Operational dry runs:

- workflow dispatch with a known good commit
- failed build path
- failed ECS update path
- success path with active/superseded transition

## 13. Phase 3 acceptance criteria

- workflow can build the exact requested `core-app` commit
- workflow pushes an immutable image tag
- workflow updates only `app-container.image`
- workflow waits for ECS steady state
- success marks the new deployment active
- failure leaves the old active deployment untouched
- the dashboard can derive green/amber/red state from deployment rows alone
