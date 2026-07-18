---
name: root-cause-investigation-planning
description: Use when OneShot planning addresses a bug, test failure, production issue, unexpected behavior, regression, timeout, or broken integration.
---

# Root Cause Investigation Planning

Use this Skill when a OneShot ticket is a bug or failure investigation.

## Method

- Plan investigation before fix selection: reproduce the symptom, read the error or acceptance text carefully, and identify the failing boundary.
- Trace from observed symptom to caller, service, handler, workflow, configuration, or data shape before naming edit targets.
- Compare against nearby working examples in the same repository or module.
- Prefer fixing the source of the bad value or behavior over masking the symptom.
- If reproduction evidence is missing, carry that uncertainty into `openQuestions`, `risks`, or validation notes.
- Keep the implementation plan scoped to the confirmed root-cause path; avoid broad cleanup while investigating.
- If root cause is not fully proven within planner bounds, still emit a structured plan with the next evidence-backed investigation or fix hypothesis.

## Output Expectations

- Bug specs should include an investigation or reproduction note before the edit note.
- Target file rationales should explain why the file is source, caller, boundary, or test coverage for the failure.
- `testingStrategy.plannedAutomatedTests` should include the reproducing test or assertion when a real test surface exists.
- `testingStrategy.coverageGaps` should explain any missing reproduction coverage and the risk of relying on manual checks.
- Validation should prove the original symptom is addressed, not only that edited files compile.
- Do not block final plan output while waiting for perfect reproduction evidence.
