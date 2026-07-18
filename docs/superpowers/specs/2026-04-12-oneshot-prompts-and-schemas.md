# OneShot Support Design: Prompt and Schema Appendix

> **Historical design note**
> This document is a 2026-04-12 design snapshot. The live OneShot runtime has changed since this spec was written.
> Use [ONESHOT_RUNBOOK.md](../../ONESHOT_RUNBOOK.md), [ONESHOT_PREVIEW_RUNBOOK.md](../../ONESHOT_PREVIEW_RUNBOOK.md), [DEPLOYMENT_GUIDE.md](../../DEPLOYMENT_GUIDE.md), and [terraform/README.md](../../../terraform/README.md) as the current operational source of truth.

**Date**: 2026-04-12  
**Status**: Ready for implementation  
**Parent plan**: `plans/09-one-shotting-feature-delivery-pipeline.md`

## Summary

This appendix defines the structured outputs each OneShot stage should produce and the prompt-shape responsibilities for each agent.

The goal is not to freeze exact prose. The goal is to freeze:

- required input context
- required output schema
- hard behavioral rules

Exact prompt wording can evolve as long as these contracts remain intact.

## 1. QUALIFIER

### Purpose

Decide whether a PFOS ticket is ready for OneShot.

### Required input context

- Jira key
- ticket summary
- ticket description
- ticket comments if available
- resolved repo candidates
- resolved branch candidate
- current branch head SHA if found

### Hard rules

- must not approve multi-repo scope
- must not approve ambiguous repo resolution
- must not approve missing branch resolution
- may allow missing acceptance criteria as a warning, not a blocker
- should prefer deterministic checks over model judgment

### Canonical output schema

```json
{
  "qualified": true,
  "repoId": 8,
  "branchName": "3.18",
  "baseCommitSha": "abc123...",
  "requirementsSummary": ["..."],
  "acceptanceCriteriaPresent": false,
  "blockingReasons": [],
  "nonBlockingWarnings": ["No explicit acceptance criteria"],
  "commentMarkdown": "..."
}
```

### Failure rules

- if `qualified = false`, `blockingReasons` must be non-empty
- `repoId`, `branchName`, and `baseCommitSha` must be null or omitted only when qualification fails

## 2. PLANNER

### Purpose

Produce an executable, spec-driven implementation plan against a frozen code state.

### Required input context

- Jira key
- ticket summary and description
- repo name
- branch name
- base commit SHA
- read-only workspace path
- qualification summary
- if revision:
  - prior plan
  - prior review
  - required changes

### Hard rules

- must plan only within the approved single repo
- must plan against the frozen base SHA
- must name impacted files explicitly
- must not propose hidden exploratory work outside scope
- must include a test strategy

### Canonical output schema

```json
{
  "jiraKey": "PROJ-123",
  "repoName": "core-app",
  "branchName": "3.18",
  "baseCommitSha": "abc123...",
  "summary": "Short plan summary",
  "scope": ["..."],
  "assumptions": ["..."],
  "requirements": ["..."],
  "acceptanceCriteria": ["..."],
  "impactedFiles": ["src/a.ts", "src/b.ts"],
  "proposedChanges": ["..."],
  "implementationSteps": ["..."],
  "testStrategy": ["..."],
  "risks": ["..."],
  "renderedMarkdown": "..."
}
```

### Validation rules

- `impactedFiles` must be non-empty
- `implementationSteps` must be non-empty
- `testStrategy` must be non-empty

## 3. REVIEWER

### Purpose

Review the plan against the referenced code and decide whether it is ready for implementation.

### Required input context

- canonical plan JSON
- impacted file contents
- missing-file findings
- truncation note if context was reduced

### Hard rules

- reviewer may only return:
  - `APPROVED`
  - `NEEDS_CHANGES`
  - `BLOCKED`
- reviewer must not suggest multi-repo expansion in v1
- reviewer must distinguish blocking findings from non-blocking suggestions
- reviewer must be conservative when referenced files do not exist

### Canonical output schema

```json
{
  "decision": "NEEDS_CHANGES",
  "blockingFindings": ["..."],
  "requiredChanges": ["..."],
  "nonBlockingSuggestions": ["..."],
  "confidence": "high",
  "coverageAssessment": "..."
}
```

### Validation rules

- if `decision = NEEDS_CHANGES`, `requiredChanges` must be non-empty
- if `decision = BLOCKED`, `blockingFindings` should be non-empty
- if `decision = APPROVED`, `requiredChanges` must be empty

## 4. IMPLEMENTER

### Purpose

Implement the approved plan in a writable workspace, run checks, and prepare a draft PR.

### Required input context

- approved plan artifact
- repo name
- base branch
- base commit SHA
- writable workspace path
- deterministic branch name

### Hard rules

- must not expand scope beyond the approved plan
- must stop if branch drift is detected by the worker before invocation
- must report deviations from plan explicitly
- must not merge or write directly to target branch
- should run relevant validation commands before completion

### Canonical output schema

```json
{
  "implementationBranch": "oneshot/proj-123-run-42",
  "changedFiles": ["src/a.ts"],
  "testCommands": ["npm test"],
  "testResults": [
    {
      "command": "npm test",
      "status": "passed",
      "summary": "all tests passed"
    }
  ],
  "deviationsFromPlan": [],
  "residualRisks": [],
  "renderedMarkdown": "..."
}
```

### Validation rules

- `changedFiles` may be empty only if the worker converts that outcome into a failure
- `testCommands` may be empty only if the plan explicitly justified no runnable checks

## 5. Prompt-shape guidance

### QUALIFIER prompt sections

- role and goal
- hard pass/fail rules
- resolved repo/branch candidates
- structured output requirement

### PLANNER prompt sections

- role and goal
- frozen repo/branch/base SHA
- plan requirements
- revision context if applicable
- required JSON output

### REVIEWER prompt sections

- role and goal
- independence from planner
- plan JSON
- code context
- verdict rules
- required JSON output

### IMPLEMENTER prompt sections

- role and goal
- approved plan JSON
- no scope expansion rule
- required validation behavior
- required JSON output

## 6. Schema ownership

Recommended file layout:

```text
src/oneshot/schema/qualification.ts
src/oneshot/schema/plan.ts
src/oneshot/schema/review.ts
src/oneshot/schema/implementation.ts
```

Each file should export:

- Zod schema
- TypeScript inferred type
- validation helper

## 7. Acceptance criteria

- every OneShot stage has a canonical JSON schema
- exact freeform prompt wording can evolve without changing contracts
- stage artifacts remain machine-validated before persistence
- stage artifacts remain human-readable through `renderedMarkdown`
