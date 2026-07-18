# Current State

This file is a time-stamped session snapshot, not a permanent truth table.

If you are reading this later, re-check the state before acting.

## Snapshot date

- Date: `2026-04-06`
- Branch at time of writing: `main`

## Git snapshot at time of writing

- local `HEAD`: `0b0ae30fb3b046fea67d06ec258c9bd3ddf3106a`
- `origin/main`: `0b0ae30fb3b046fea67d06ec258c9bd3ddf3106a`
- local branch state relative to remote: in sync

At the time of writing, the governed-workflow implementation and workflow naming cleanup were already pushed to `main`.

## Local working tree at time of writing

Only unrelated untracked items were present:

- `marketing/`
- `out/product-factory-leadership-slides.md`
- `plans/09-one-shotting-feature-delivery-pipeline.md`

No tracked repo changes were pending when this snapshot was updated.

## What is already implemented on `main`

### Governed Terraform onboarding and activation

The pushed branch already contains:

- merged worker-map Terraform model:
  - built-ins from `local.default_worker_agents`
  - workflow-managed agents from `var.additional_worker_agents`
  - unified `local.all_worker_agents`
- worker resources driven from that merged map:
  - log groups
  - ECR repos
  - task definitions
  - ECS services
  - outputs
- state-migration `moved` blocks in `terraform/moved.tf`
- post-apply registration Lambda in `terraform/agent-registry-lambda.tf`
- manual-only GitHub workflows for:
  - agent onboarding
  - agent activation
  - generic Terraform plan/apply workflow
  - targeted ECS force deployment
  - manual worker image push
  - OIDC smoke testing

### Current workflow inventory and display names

The important manual workflows are now grouped in the Actions UI:

- `Ops / Terraform / Agent Onboard`
- `Ops / Terraform / Agent Activate`
- `Ops / Terraform / Plan Or Apply`
- `Ops / Terraform / OIDC Smoke Test`
- `Ops / ECS / Force New Deployment`
- `Build / Worker / Manual Push`

Legacy per-agent build/push workflows still exist for the built-in fleet, but the new grouped/manual workflows are the relevant path for future agent onboarding and operator actions.

### Current runtime bootstrap behavior

- `src/worker-main.ts` no longer owns a giant hardcoded switch
- `src/orchestrator/workers/runtime.ts` is the worker-resolution source of truth
- new workers can be discovered through naming conventions if the module and export names line up

### Current Terraform input model

The repo now expects:

- committed shared non-secret inputs in `terraform/shared.auto.tfvars`
- optional local overrides in `terraform/terraform.tfvars`
- no workflow dependence on a developer's local `terraform.tfvars`

That change exists because the repo targets a single shared dev account.

### Current repository auth model

- repository metadata still lives in `code_repositories`
- repository default-branch behavior should be stored in `code_repositories.default_branch`
- worker clone auth is intended to come from the shared GitHub token secret injected as `GITHUB_REPO_TOKEN`
- new onboarding runs can optionally upsert a missing `code_repositories` row when a new agent depends on a repo that is not already cataloged

### Current repository analysis model

- `src/orchestrator/RepoAnalyzer.ts` is now the routing point for automatic repo selection into `task_management.related_code`
- the analyzer is no longer purely prompt-driven; it applies deterministic family rules before the Bedrock path
- current rules are:
  - CP-family tickets (`CPDEV`, `CPSUP`, `CPCLIENT`, or referenced `CP*-123` keys) only analyze CP/shared repos
  - MP-family tickets (`MPDEV`, `MPSUP`, `MPCLIENT`, or referenced `MP*-123` keys) only analyze `mp-*` repos when those repos exist in the catalog
  - MP tickets with config-style wording route directly to `mp-product-client-configs`
  - MP tickets with web or release-note wording route directly to `mp-web`
- Harvey-created tasks can still hit these rules if the intake text includes the original JIRA key, even though the synthetic task key is `HARVEY-intake`
- if a new repo family or a new deterministic routing rule is needed, update `RepoAnalyzer` together with the agent feature

### Current AWS auth model for workflows

The intended GitHub Actions configuration is:

- repo secret `AWS_ROLE_ARN`
- value pointing to the shared dev-account OIDC role:
  - `arn:aws:iam::323960442001:role/GitHub-OIDC`
- repo variable `ECR_REGISTRY`
- value:
  - `323960442001.dkr.ecr.us-east-2.amazonaws.com`

The workflow code is OIDC-based. Static AWS keys may still exist in GitHub settings, but the new workflow path should not depend on them.

## Live infrastructure observations captured during the session

These were directly validated during the implementation session and are useful historical context:

- Terraform apply succeeded in the shared dev account and created the `specter-agent-registry` Lambda stack
- orchestrator and worker task-definition updates rolled successfully
- ECS services for the orchestrator and current worker fleet reached steady state after apply
- `specter-agent-registry` became active successfully
- provider-level `ignore_tags` was added so shared-account governance tags do not create perpetual drift
- the Lambda source-hash logic was stabilized so generated zip bytes do not cause false-positive plans
- a later full Terraform plan returned `No changes`

Treat those as a validated baseline, not as a guarantee that live state still matches today.

## Workflow issues discovered and resolved during the session

Future sessions should know this history so they do not rediscover the same problems:

### 1. Missing required Terraform variables in GitHub Actions

Initial workflow runs failed because required root-module inputs were only present in a local `terraform.tfvars`.

That was fixed by committing:

- `terraform/shared.auto.tfvars`

This is now the shared non-secret source of truth for workflow runs.

### 2. GitHub OIDC role could not read EFS

Terraform reads the existing EFS file system through `data.aws_efs_file_system.specter_repo`.

The GitHub OIDC role initially lacked:

- `elasticfilesystem:DescribeFileSystems`

That permission was added out of band to the AWS role policy. Future sessions should check the role if this error reappears.

### 3. False-positive Lambda drift in `terraform plan`

At one point, `terraform plan` showed only:

- `aws_lambda_function.agent_registry`

The cause was unstable Lambda hash behavior.

The fix path was:

- hash tracked source files instead of generated zip bytes
- ignore generated `__pycache__/` and `*.pyc` files

If a future session sees only that Lambda drift again, suspect the hash path first.

### 4. Workflow discoverability in GitHub Actions

Workflow names were normalized with grouped prefixes so the Actions tab is easier to scan.

## What future sessions should assume now

Start from these assumptions unless code or live state proves otherwise:

1. The governed onboarding implementation is already on `main`.
2. The correct path for a new agent is:
   - code first
   - onboarding workflow
   - merge onboarding PR
   - manual worker image push
   - activation workflow
3. The correct path for repo-wide Terraform review or apply without local AWS access is:
   - `Ops / Terraform / Plan Or Apply`
4. The correct path for redeploying an existing ECS service without local AWS access is:
   - `Ops / ECS / Force New Deployment`
5. New workflow-managed agents belong in `terraform/additional-worker-agents.auto.tfvars.json`, not in `local.default_worker_agents`, unless you are intentionally promoting them to built-in fleet status.

## What still needs re-verification in a future session

These are not guaranteed by the repo code alone:

1. GitHub Environment `specter-terraform-apply` still exists and has required reviewers.
2. GitHub Environment `specter-aws-operations` still exists and has required reviewers.
3. GitHub repo secret `AWS_ROLE_ARN` still points to the intended dev-account OIDC role.
4. GitHub repo variable `ECR_REGISTRY` still points to the shared dev-account ECR registry.
5. The OIDC role still includes EFS read permission.
6. The shared GitHub repository token secret still exists at the name expected by `terraform/shared.auto.tfvars`.
7. Old repository secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` have actually been removed, if that cleanup was intended.
8. The latest workflow runs from `main` are still healthy.

## Re-verify commands

Use these commands before making live changes:

```bash
git status -sb
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

For migrated product repositories, verify the actual default branch before assuming `main`.
Several legacy repos still use `master`.

If GitHub CLI access is available:

```bash
gh api repos/mhk-repos/cp-autonomous-ai-agents-platform/environments
gh secret list -R mhk-repos/cp-autonomous-ai-agents-platform
gh variable list -R mhk-repos/cp-autonomous-ai-agents-platform
```

If AWS CLI access is available:

```bash
aws sts get-caller-identity
```

## Meaning of this snapshot

A new session should not start by redesigning governed onboarding. That work is already in the repo.

A new session should start by answering:

1. what code change is actually needed for the next agent
2. whether Terraform needs a real schema/resource change or only catalog/workflow usage
3. whether GitHub/AWS live configuration still matches the documented OIDC and environment expectations
