# Plan 07: Observability and Documentation Governance

## Problem

The platform exposes useful operational signals, but they are not yet governed as first-class system contracts.

Documentation drift also already happened once because runtime changes were not tied to documentation maintenance.

## Goals

- standardize the supported runtime and monitoring surface
- improve metrics, dashboards, and alerting around durable workflows
- prevent future documentation drift

## Current pain points

- only `worker-main` exposes the full status API, but legacy worker scripts still exist
- logs are useful but not yet organized around a consistent operational scorecard
- docs can drift when scripts, Terraform, or runtime paths change independently

## Proposed target state

- one supported worker runtime path
- dashboards and alerts for queue health, failure spikes, retry churn, and delivery lag
- documentation ownership tied to runtime changes

## Work breakdown

### 1. Standardize the runtime surface

- make `worker-main` the default everywhere
- mark legacy entrypoints as deprecated or remove them

### 2. Define operational KPIs

- tasks assigned per hour
- worker claim lag
- task failure rate by agent
- JIRA posting retries
- Harvey delivery lag
- average token and cost metrics by agent

### 3. Build dashboards and alerts

- CloudWatch dashboards or exported metrics
- alerts for:
  - worker crash loops
  - high retry counts
  - prolonged `assigned` backlog
  - prolonged `task_created` Harvey sessions

### 4. Add doc governance

- update checklist for runtime changes
- link docs from the root README and docs index
- consider lightweight doc drift checks in CI for key filenames and terms

## Deliverables

- runtime surface cleanup
- KPI definitions
- dashboard/alert specs
- documentation maintenance checklist

## Success criteria

- on-call debugging no longer depends on knowing which entrypoint happens to expose status endpoints
- important lag and retry patterns are visible without ad hoc SQL
- architectural docs stay aligned with the deployed runtime

## Dependencies

- this plan becomes more valuable once Plans 02 through 06 stabilize the runtime contracts

## Out of scope

- a full external observability platform migration
