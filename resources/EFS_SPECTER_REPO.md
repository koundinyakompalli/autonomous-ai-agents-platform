# EFS Repository Layout

This document describes the expected shared EFS layout for Specter. It intentionally avoids hardcoded live AWS resource IDs.

## Purpose

EFS provides a shared filesystem for:

- long-lived repository clones and worktrees
- per-task workspaces created by workers
- shared supporting documents

## Expected mount point

```text
/mnt/efs/specter-repo
```

## Expected directory structure

```text
/mnt/efs/specter-repo/
├── repositories/
│   ├── core-app/
│   ├── client-services/
│   ├── batch-jobs/
│   ├── provider-portal/
│   ├── React-based-new-ui/
│   ├── Ai-agents/
│   ├── Document-ai/
│   ├── mp-web/
│   ├── mp-product-client-configs/
│   └── tasks/
│       └── task-<task_management_id>/
└── documents/
```

## Important runtime assumption

Several current worker and agent paths assume the repository base path is:

```text
/mnt/efs/specter-repo/repositories
```

Do not rely on older documentation that used `/mnt/efs/repos` unless you have explicitly remapped the environment and verified all path assumptions.

## Why task workspaces exist

Workers create task-specific workspace folders so they can:

- assemble branch-specific views
- symlink or stage the relevant repositories
- keep per-task execution isolated from the long-lived shared clones

## Operational guidance

- use full clones or valid worktrees for repositories that need git history
- ensure ECS tasks and debugging hosts can mount the same EFS filesystem
- set `REPOSITORY_PATH` and `DOCUMENTS_PATH` explicitly in deployment config
- `resources/setup-repos.sh` now expects `GITHUB_APP_INSTALLATION_TOKEN` from the shell environment instead of embedding repository credentials in the script itself
