# Plan 04: Orchestrator Decomposition

## Problem

The orchestrator currently owns too many synchronous responsibilities inside one assignment path.

One flow effectively does all of this:

- JIRA fetch
- customer resolution
- repository selection
- task description generation
- S3 upload
- task assignment persistence

This makes retry behavior, testing, and future change isolation harder than it should be.

## Goals

- split orchestration into smaller idempotent services
- make each stage independently testable
- reduce the blast radius of failures in repo analysis or task generation
- preserve the durable `task_management` backbone

## Proposed target state

Separate services or modules for:

- issue discovery
- issue enrichment
- assignment persistence
- result posting

The first pass can stay in-process. This does not require introducing a queue immediately.

## Suggested module split

- `IssueDiscoveryService`
- `IssueEnrichmentService`
- `AssignmentService`
- `ResultPostingService`

Potential shared collaborators:

- `JiraClient`
- `CustomerResolver`
- `RepoSelectionService`
- `TaskStagingService`

## Work breakdown

### 1. Carve out pure collaborators

- customer extraction/resolution
- repo selection adapter
- task markdown staging

### 2. Shrink `assignIssueToAgent()`

- make it a coordinator over extracted services
- preserve existing DB semantics and duplicate handling

### 3. Split result posting similarly

- claiming
- payload download
- comment rendering/posting
- release/retry behavior

### 4. Add contract tests

- assignment path
- duplicate issue path
- posting retry path

## Deliverables

- orchestrator service decomposition
- smaller methods with clearer contracts
- better isolated retry boundaries

## Success criteria

- assignment can be tested without invoking every collaborator end-to-end
- failures in repo selection or task generation are easier to classify and retry
- orchestrator files are smaller and responsibilities are clearer

## Dependencies

- Plan 03 reduces workspace-related coupling on the worker side, which complements this plan

## Out of scope

- introducing Kafka/SQS/event buses unless decomposition alone proves insufficient
