# Operations and Troubleshooting

This file is the quick failure-mode guide for new agent work, especially when Terraform and GitHub workflows are involved.

## Debugging order

When a new agent is not working, debug in this order:

1. code resolution
2. build success
3. Terraform intent
4. DB registration
5. image presence
6. activation state
7. task assignment behavior
8. runtime processing behavior

## Failure: workflow Terraform plan complains about missing required variables

Symptoms:

- `terraform plan` fails in GitHub Actions before producing a real plan
- errors mention variables such as:
  - `existing_rds_security_group_id`
  - `jira_token_secret_name`
  - `harvey_teams_secret_name`

Likely cause:

- the branch does not contain `terraform/shared.auto.tfvars`
- or the workflow is running from an older commit before shared workflow inputs were committed

Fix:

1. verify the branch contains `terraform/shared.auto.tfvars`
2. do not rely on a local `terraform.tfvars`
3. rerun the workflow from current `main`

## Failure: Terraform plan cannot read the EFS file system

Symptoms:

- GitHub workflow fails on `data.aws_efs_file_system.specter_repo`
- AWS error mentions `elasticfilesystem:DescribeFileSystems`

Cause:

- the GitHub OIDC role lacks EFS read permission

Fix:

- add `elasticfilesystem:DescribeFileSystems` to the GitHub OIDC role policy

This is required because Terraform reads the existing EFS file system as a data source.

## Failure: Terraform plan shows only `aws_lambda_function.agent_registry`

Symptoms:

- the plan reports only an in-place update to `aws_lambda_function.agent_registry`
- the diff is primarily `source_code_hash`

Likely causes:

1. the branch predates the stable Lambda hash logic
2. generated files such as `__pycache__/` or `*.pyc` leaked into the hash calculation
3. the repo code is fixed but the live Lambda was not yet updated once to match it

Fix:

1. inspect `terraform/main.tf`
2. confirm the Lambda hash is derived from tracked files under `terraform/lambda/agent_registry`
3. confirm `__pycache__/` and `*.pyc` are excluded
4. if the branch is correct but state is older, apply once and recheck plan

Interpretation:

- this symptom usually indicates packaging/hash drift, not a broader infrastructure issue

## Failure: worker cannot be resolved

Symptoms:

- activation workflow fails at worker source validation
- manual image workflow fails before build
- local `WORKER_TYPE=... npm run worker` crashes early

Likely causes:

- worker file name does not match convention
- export name does not match convention
- `agent_name` is not the actual runtime worker type

Checks:

```bash
python3 .github/scripts/resolve-worker-entry.py --worker-type MY-AGENT
```

Fix:

- rename the file to `MyAgentWorker.ts`
- export `MyAgentWorker` or a default class
- make sure `agent_name` and `WORKER_TYPE` match the DB identity

## Failure: worker starts but exits with "Agent not found"

Symptoms:

- ECS task starts and exits quickly
- local run throws `Agent not found: ...`

Cause:

- `AgentWorker.start()` looks up `agents.name`
- the row does not exist or the name does not match

Fix:

- verify the onboarding workflow completed registration
- verify `agents.name` equals the worker's `agentName`
- verify you are using the correct `agent_name` in workflows

## Failure: onboarding works but activation cannot find the catalog key

Symptoms:

- activation workflow fails in `manage-worker-agent-catalog.py`

Cause:

- the onboarding catalog PR was not merged to `main`

Fix:

- merge the onboarding PR
- rerun activation

The helper intentionally errors with guidance to merge the onboarding PR first.

## Failure: activation cannot find an image in ECR

Symptoms:

- activation fails at `aws ecr describe-images`

Cause:

- no image has been pushed to `specter/<agent_key>-worker`

Fix:

- run `Build / Worker / Manual Push`
- confirm the repository exists
- if the service is already running, run `Ops / ECS / Force New Deployment`
- rerun activation

## Failure: onboarding or activation fails at approval gate

Symptoms:

- workflow blocks unexpectedly
- workflow never becomes approvable

Likely causes:

- `specter-terraform-apply` environment does not exist
- environment has no appropriate reviewers
- branch/environment policy is misconfigured

Fix:

- create the environment
- add required reviewers
- prefer an admin-capable reviewer group rather than a single user

For ECS redeploys, the same class of failure can happen on:

- `specter-aws-operations`

## Failure: Lambda registration or activation fails

Symptoms:

- onboarding apply succeeds but workflow fails on registration
- activation apply succeeds but workflow fails on DB update

Likely causes:

- Lambda cannot reach RDS
- Lambda cannot read Secrets Manager secrets
- DB row values are malformed

Things to inspect:

- Lambda log group:
  - `/aws/lambda/specter-agent-registry`
- Terraform outputs:
  - `agent_registry_lambda_name`
  - `agent_registry_lambda_arn`
- security group path to RDS
- secret names:
  - DB credentials secret
  - shared JIRA token secret

Important workflow behavior:

- the workflows now fail if `aws lambda invoke` reports `FunctionError`
- read-back verification is also required after write operations

## Failure: repository clone or pull fails

Symptoms:

- worker starts but fails during repository setup
- logs show `git clone`, `git fetch`, `git pull`, or auth failures
- a newly onboarded agent never gets a usable workspace

Likely causes:

- the shared GitHub repository token secret is missing or rotated
- `GITHUB_REPO_TOKEN` is not being injected into the worker task definition
- the `code_repositories` row is missing or has the wrong GitHub URL
- the repo needs special branch handling that is not covered by the current runtime map

Checks:

- verify the shared GitHub repository token secret still exists at the name from `terraform/shared.auto.tfvars`
- verify the worker task definition includes `GITHUB_REPO_TOKEN`
- verify the `code_repositories` row exists and the `repo_url` is a GitHub HTTPS clone URL
- verify the repo name is one the runtime already knows how to branch correctly, or update the branch logic if it is a new versioned repo
- inspect worker logs for the exact branch candidate that failed

## Failure: service is active but receives no work

Symptoms:

- ECS task stays healthy
- agent appears idle forever

Likely causes:

- `agents.is_active` is still false
- `jql` does not match any issues
- orchestrator is not running
- no tasks are being assigned to that agent

Checks:

- verify the DB row is active
- verify the agent JQL is valid
- verify orchestrator health and logs
- inspect `task_management` for assigned rows

Important nuance:

- an inactive DB row can still let a worker start
- inactivity primarily blocks orchestration and routing, not the worker bootstrap itself

## Failure: service starts but immediately crash-loops

Symptoms:

- ECS repeatedly restarts the task

Likely causes:

- import error inside the worker module
- missing runtime env var
- code built locally but not pushed into the image used by ECS
- DB row missing

Checks:

- CloudWatch log group: `/ecs/specter/<agent_key>-worker`
- confirm the image was pushed after the latest code change
- confirm the task definition points to `:latest` and a new task was started after the image push

## Failure: Terraform drift or confusing plan

Symptoms:

- plan shows unexpected worker changes
- apply wants to manage agents you did not intend

Likely causes:

- `terraform/additional-worker-agents.auto.tfvars.json` is out of sync with `main`
- onboarding or activation PRs were not merged
- someone hand-edited the catalog

Fix:

- inspect the catalog file in `main`
- inspect open PRs from the onboarding/activation workflows
- run `Ops / Terraform / Plan Or Apply` in `plan-only` mode if you need a reviewed repo-vs-state view without local AWS access
- reconcile source control before re-running Terraform

## Failure: local Terraform complains about missing Lambda ZIP

Symptoms:

- local `terraform plan` or `terraform apply` fails on the Lambda archive path

Fix:

```bash
bash .github/scripts/package-agent-registry-lambda.sh
```

## Failure: OIDC workflow auth fails

Symptoms:

- `configure-aws-credentials` fails
- STS call fails
- ECR login or Terraform init fails because credentials were never configured

Likely causes:

- `AWS_ROLE_ARN` secret missing
- `AWS_ROLE_ARN` points to the wrong role
- `ECR_REGISTRY` repo variable missing or wrong
- role trust policy not configured for the repo/workflow context
- workflow changes not pushed to GitHub yet

Current known-good values:

- `AWS_ROLE_ARN = arn:aws:iam::323960442001:role/GitHub-OIDC`
- `ECR_REGISTRY = 323960442001.dkr.ecr.us-east-2.amazonaws.com`

First check:

- run `Ops / Terraform / OIDC Smoke Test`
- then try `Ops / Terraform / Plan Or Apply` in `plan-only` mode

## Failure: agent uses Claude but behaves like a generic default

Symptoms:

- wrong tool access
- missing schema shaping
- no agent-specific prompt behavior

Likely causes:

- `AgentType` not updated
- `getToolSet()` missing branch
- `getOutputSchema()` missing branch
- `AGENT_PROMPTS` missing new prompt

## Persistent repo-level caveats

These are not one-off issues:

1. schema seed state does not fully reflect deployed-worker reality
2. some scripts still use the older worker entrypoint
3. legacy credentials remain in the schema file
4. legacy per-agent build workflows still coexist with the newer generic/manual workflow path
5. manual redeploys and Terraform operations depend on GitHub environments and OIDC being configured correctly
