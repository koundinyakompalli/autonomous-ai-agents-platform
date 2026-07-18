# Core-App Preview Build Contract

## Purpose

This document freezes the real build contract for preview deployments of:

- `https://github.com/mhk-repos/cp-medhok-monorepo.git`

It exists because the preview workflow must not guess:

- Dockerfile location
- build context
- build args
- asset build steps
- runtime assumptions

This document must be completed before `coreapp-preview-deploy.yml` is implemented.

## Preview target

- ECR: `323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp`
- ECS cluster: `CLIENT-A`
- ECS service: `CLIENT-A-cp-dev-mhk-core`
- task-definition container to replace: `app-container`

## Frozen build inputs

### 1. Dockerfile path

From repository root:

```text
MedicalMgmt/Dockerfile
```

### 2. Docker build context

From repository root:

```text
MedicalMgmt
```

### 3. Required build command

The Docker build is not sufficient by itself. The WAR must already exist in the build context.

Exact Docker build command from repository root:

```text
docker build \
  -f MedicalMgmt/Dockerfile \
  -t 323960442001.dkr.ecr.us-east-2.amazonaws.com/medhok20/medhok-monorepo.coreapp:<tag> \
  MedicalMgmt
```

### 4. Required build arguments

There are no Docker build args required for the current CI build.

| arg | required | source | notes |
|---|---|---|---|
| none | no | n/a | current GitHub and GitLab CI do not pass Docker build args for `core-app` |

### 5. Required secrets during build

No Docker build-time secrets are currently required by the known CI flow.

| secret | source | purpose |
|---|---|---|
| none | n/a | current CI flow does not inject Docker build secrets |

### 6. Pre-build steps

The WAR must exist before `docker build` runs.

Current Maven flow from repository root:

```text
mvn -N -f medhok-parent-java21/pom.xml -s .m2/settings.xml --batch-mode install
mvn -f medhok-parent-java21/pom.xml -s .m2/settings.xml --batch-mode package -P stamped
```

Expected output artifact:

```text
MedicalMgmt/target/medical-mgmt-*.war
```

The preview workflow must fail fast if the WAR is missing after the Maven package step.

### 7. Runtime health contract

Document the signal used to decide the app is healthy enough for ECS steady state.

- container port:
  - `8080` (from current ECS service)
- health endpoint:
  - `TBD`
- expected warm-up time:
  - `TBD`

### 8. Runtime environment assumptions

Document anything the preview service expects that could break branch-specific deploys:

- required env vars
- database expectations
- feature flags
- static asset hosting assumptions

Known assumptions so far:

```text
- the WAR is built by Maven before the Docker build
- the ECS preview service already provides the runtime environment variables and sidecars
```

### 9. Baseline reset source

Define what the reset workflow should deploy:

- immutable baseline tag
- or default branch build

Actual reset source:

```text
master branch build from cp-medhok-monorepo
```

## Completion criteria

This contract is complete when an implementer can build the exact preview image in GitHub Actions without guessing any of the items above.
