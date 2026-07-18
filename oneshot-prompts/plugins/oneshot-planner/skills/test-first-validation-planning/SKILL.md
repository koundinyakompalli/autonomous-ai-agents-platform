---
name: test-first-validation-planning
description: Use when OneShot planning includes feature, bugfix, refactor, or behavior-change work with a discoverable automated or structural test surface.
---

# Test-First Validation Planning

Use this Skill to make planner validation prove behavior instead of only describing review.

## Method

- Prefer a failing-test-first path when the repository has a relevant test surface.
- Identify existing test files, naming patterns, fixtures, or structural checks before proposing new validation.
- For bug fixes, plan the reproducing test or assertion before the implementation step when practical.
- For UI, config, generated, or legacy areas without runnable tests, plan a structural validation check and explain why automated test coverage is limited.
- Keep validation commands safe for OneShot execution: no chained shell syntax, no environment assignment prefixes, and no destructive commands.
- Do not invent test frameworks; use inspected package, Maven, Gradle, pytest, Vitest, or repo-local patterns.
- Treat test-first guidance as validation planning, not a reason to defer the final OneShot plan or require an interactive TDD workflow.

## Output Expectations

- Top-level `testingStrategy` is required for code-change plans. Use `mode: test_first` when a real automated test surface exists.
- `testingStrategy.existingTestEvidence` should name inspected test files, fixtures, commands, or explicit no-test-surface evidence.
- `testingStrategy.plannedAutomatedTests` should name exact editable test files, related specs, scenario, assertions, fail-first expectation, command, and synthetic-data notes.
- `testingStrategy.validationCommands` should explain command purpose, expected result, scope, and related specs while `specs[].validationSteps` stays runnable.
- `testingStrategy.traceGuidance` should tell TRACE which functional, regression, or Section C unit cases to generate or emphasize.
- `testingStrategy.coverageGaps` should explain why automation is not suitable and what risk/follow-up remains.
- `fileChangeContract` must mark planned editable test files as `test_required`; example-only tests are `read_only_evidence`.
- `implementationNotes` should mention nearby test patterns or why a structural/manual check is the safer fit.
- `plannerDiscoveries` should capture discovered test command or test pattern only when grounded.
- Always return validation guidance inside the structured plan, not as a separate testing task list.
