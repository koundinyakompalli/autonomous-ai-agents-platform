# Plan 08: Harvey and Admin Surface Hardening

## Problem

Harvey is architecturally valuable, but two parts deserve hardening:

- conversational session persistence and lifecycle behavior
- the hidden `/admin` natural-language-to-SQL surface

## Why this matters

Harvey is the human-facing entrypoint. Weak boundaries here can create operational confusion or unintended data exposure even if the worker pipeline itself is solid.

## Current concerns

- session history is stored as a JSON blob, which limits reporting and auditing
- `/admin` relies on model-generated SQL even with allow-list validation
- admin access is hidden, but hiding is not access control
- result delivery and retry behavior are good, but the operational contract is still implicit

## Goals

- make Harvey session behavior easier to reason about and report on
- harden admin access and auditability
- reduce reliance on free-form NL-to-SQL for common support workflows

## Proposed target state

- explicit admin authorization model
- auditable admin query usage
- predefined operational reports for common questions
- session and delivery lifecycle documented and observable

## Work breakdown

### 1. Lock down admin access

- require explicit allow-list or role check for `/admin`
- record who ran what and when
- rate limit or cap admin operations aggressively

### 2. Replace the most common admin questions with fixed reports

Examples:

- agent backlog summary
- failed tasks in last 24 hours
- Harvey sessions pending delivery
- top retrying JIRA posts

Keep NL-to-SQL as a fallback, not the primary admin surface.

### 3. Improve Harvey session reporting

- expose clearer session lifecycle metrics
- consider normalized events if analytics needs justify it

### 4. Strengthen result delivery operations

- explicit metrics for delivery lag and retry churn
- clear remediation guidance for stuck sessions

## Deliverables

- admin authorization and audit logging
- predefined operational reports
- Harvey lifecycle observability improvements

## Success criteria

- `/admin` is no longer protected only by obscurity
- common operational questions can be answered without model-generated SQL
- Harvey delivery issues are visible and diagnosable from metrics and docs

## Dependencies

- aligns well with Plans 06 and 07

## Out of scope

- replacing Harvey as the user-facing entrypoint
