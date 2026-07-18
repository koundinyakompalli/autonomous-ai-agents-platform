# Plan 03: Workspace and Repository Runtime

## Problem

Repository preparation and workspace management are currently spread through worker internals and agent-specific code.

The most problematic traits are:

- hardcoded EFS path assumptions
- worktree and workspace logic living inside `AgentWorker`
- special-case repo discovery logic in agents like VERITAS
- limited local testability because the filesystem contract is implicit

## Goals

- extract repository and workspace lifecycle into a dedicated runtime service
- make paths fully config-driven
- support the same behavior in local, ECS, and test environments
- eliminate duplicate repo/workspace logic across workers and agents

## Proposed target state

Introduce a `WorkspaceManager` or `RepoRuntime` layer that owns:

- repo root resolution
- task workspace creation
- worktree creation or reuse
- symlink/materialization strategy
- cleanup policy
- metadata describing what repos are mounted into a task workspace

## Work breakdown

### 1. Define the abstraction

- input: task id, customer branch, repo selections
- output: a typed workspace descriptor

### 2. Extract from `AgentWorker`

- move path joining and EFS assumptions out of the worker base class
- keep `AgentWorker` responsible only for workflow coordination

### 3. Reuse in agents with custom repo discovery

- VERITAS repo discovery
- any future multi-repo evidence collection flows

### 4. Add local and test implementations

- filesystem-backed local runtime
- fake or temporary-directory runtime for integration tests

## Deliverables

- new workspace runtime module
- worker refactor to consume it
- reduced path logic inside agents
- tests for workspace creation, reuse, and cleanup behavior

## Success criteria

- no hardcoded `/mnt/efs/specter-repo/repositories` logic remains buried in worker behavior
- workspace creation is testable without a full ECS/EFS environment
- repo selection and workspace preparation are observable as typed data, not implicit side effects

## Dependencies

- Plan 02 should establish canonical path config first

## Out of scope

- moving away from EFS entirely
