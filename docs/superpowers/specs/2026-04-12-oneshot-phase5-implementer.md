# OneShot Phase 5 Design: Implementer Service

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`  
**Phase**: 5 of 7

## Summary

Phase 5 implements the code-writing stage:

- consume implementation work
- verify branch drift has not invalidated the plan
- create a deterministic branch
- execute the approved plan
- push code
- open a draft PR
- emit the final success or failure notification

## Deliverables

```
src/oneshot/consumers/implementer.ts
src/oneshot/providers/claude-implementer.ts
src/oneshot/github.ts
src/oneshot/pr-body.ts
src/oneshot/workspaces.ts
src/claude-sdk/config.ts
src/claude-sdk/index.ts
terraform/oneshot-ecs.tf
terraform/iam.tf
```

## 1. ECS service contract

Add a dedicated ECS service:

- service name: `IMPLEMENTER`
- desired count: `1` in v1

Required environment:

- `ONESHOT_ROLE=IMPLEMENTER`
- `ONESHOT_IMPLEMENTATION_QUEUE_URL`
- `ONESHOT_ARTIFACT_BUCKET`
- `ONESHOT_ARTIFACT_PREFIX`
- `GITHUB_REPO_TOKEN`
- `GITHUB_WRITE_TOKEN`
- DB env vars

Required mounts:

- existing EFS repo volume

Required IAM:

- SQS receive/delete/change-visibility on implementation queue
- S3 read/write for OneShot artifact paths
- Secrets Manager read for GitHub tokens
- Bedrock access for Claude implementation

## 2. Branch drift check

Before any edits:

1. read current remote head SHA for `branch_name`
2. compare with `base_commit_sha`

If different:

- set run `state = replan_required`
- set `final_disposition = branch_drift`
- create `branch_drift` notification
- do not create branch
- do not open PR

## 3. Workspace behavior

The implementer needs a writable isolated workspace.

### Path

```text
/mnt/efs/specter-repo/oneshot/<run-id>/implementer
```

### Workspace steps

1. ensure shared repo root exists
2. create worktree at `base_commit_sha`
3. create deterministic implementation branch:
   - `oneshot/<jira-key-lower>-run-<run-id>`
4. expose workspace path to the Claude implementer wrapper

## 4. Implementer provider integration

Use Bedrock / Claude with write-capable tool permissions.

Recommended integration:

- add `agentType = 'oneshot_implementer'`
- tool permission set: `patch_proposal`

Allowed tools:

- `Read`
- `Glob`
- `Grep`
- `Edit`
- `Write`
- `Bash`
- `BashOutput`

Implementer prompt must explicitly require:

- adherence to approved plan
- no scope expansion beyond the plan
- tests/checks before completion
- clear reporting of deviations

## 5. GitHub write boundary

Use:

- `GITHUB_REPO_TOKEN` for clone/fetch only
- `GITHUB_WRITE_TOKEN` for:
  - branch push
  - draft PR creation

This keeps repo hydration and write authority separate.

## 6. Implementation flow

1. receive message
2. load run + approved plan artifact
3. claim `queued_for_implementation -> implementing`
4. check token budget
5. perform branch drift check
6. hydrate writable workspace
7. run Claude implementer against the approved plan
8. collect changed files and test outputs
9. if there are changes:
   - commit changes
   - push deterministic branch
10. worker creates draft PR via GitHub REST API
11. write implementation artifact
12. set run `state = pr_open`
13. create final success notification of type `completed`

## 7. Draft PR creation

The worker, not the LLM, creates the PR.

### Branch push

Push branch using `GITHUB_WRITE_TOKEN`.

### API call

`POST /repos/{owner}/{repo}/pulls`

Required payload:

```json
{
  "title": "[PFOS] PROJ-123: ticket summary",
  "head": "oneshot/proj-123-run-42",
  "base": "3.18",
  "body": "...",
  "draft": true
}
```

### PR body source

Construct deterministically from:

- ticket summary
- approved plan summary
- changed files
- test results
- residual risks

## 8. Test behavior

### Tests pass

- open draft PR
- success notification includes validation summary

### Tests fail but code changes exist

- still open draft PR
- success notification and PR body must clearly state failed checks
- run is still considered successful from the pipeline perspective because human review now has a PR to inspect

### No code changes produced

- set run `state = failed`
- create `run_failed` notification

## 9. Retry behavior

### If no remote branch exists

- restart implementation normally

### If remote branch exists and no PR exists

- delete branch
- restart from `base_commit_sha`

### If PR already exists

- do not create a second PR
- recover PR metadata
- set state back to `pr_open`
- create missing `completed` notification if needed

## 10. Canonical implementation artifact

Canonical key:

```text
oneshot/<jira-key>/run-<run-id>/implementation/v<version>/implementation.json
```

Canonical JSON shape:

```json
{
  "implementationBranch": "oneshot/proj-123-run-42",
  "prUrl": "https://github.com/...",
  "changedFiles": ["..."],
  "testCommands": ["npm test"],
  "testResults": [
    {
      "command": "npm test",
      "status": "failed",
      "summary": "2 failing tests"
    }
  ],
  "deviationsFromPlan": ["..."],
  "residualRisks": ["..."],
  "renderedMarkdown": "..."
}
```

## 11. Failure behavior

Persistent failure after local retries:

- set run `state = failed`
- set `last_error`
- create `run_failed` notification

Budget exhaustion:

- set run `state = failed`
- create `budget_exceeded` notification

## 12. Tests

Required tests:

- branch drift stop behavior
- deterministic branch naming
- PR body generation
- success path with passing tests
- success path with failing tests
- no-change failure path
- PR-recovery path when a PR already exists

## 13. Acceptance criteria

- implementer only works from approved plans
- implementer never writes directly to target branch
- every successful run ends in a draft PR
- branch drift always stops and requests replan
- success notification always includes PR URL
