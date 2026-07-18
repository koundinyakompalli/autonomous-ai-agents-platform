---
name: plan-quality-gate
description: Use when a OneShot planner is about to finalize a structured implementation plan or when a plan may contain vague files, validation, risks, or assumptions.
---

# Plan Quality Gate

Use this Skill as the final self-review before emitting OneShot plan JSON.

## Method

- Check every ticket requirement or acceptance criterion maps to at least one spec.
- Keep each spec independently reviewable: clear objective, concrete target files, focused acceptance criteria, implementation notes, and validation steps.
- Confirm `testingStrategy` is present for code-change plans and includes inspected test evidence, planned automated/manual coverage, validation command intent, TRACE guidance, and explicit coverage gaps.
- Confirm `guardrailReport.coreChecks[]` includes every required core guardrail id exactly: `generated-cache-exclusion`, `security-secrets`, `phi-pii`, `backward-compatibility`, `performance-n-plus-one`, `error-handling`, `testing-adequacy`, `scope-discipline`.
- Treat `fileChangeContract` as the canonical edit-scope and adjacent-file rationale contract. Every new adjacent non-test target file must have an editable contract entry with the right role, concise rationale, and `supportingEvidence` naming an inspected same-pattern file by exact path or unique basename.
- Use `targetFileRationales` only as optional compatibility detail; never make it the only place where a new adjacent file is justified.
- The structured OneShot plan JSON is mandatory; if planning is incomplete, emit the best valid plan and put blockers in `openQuestions`, `assumptions`, or `risks`.
- Use exact repository paths only when they came from grounding, inspected files, or trusted qualification evidence.
- Replace vague instructions such as "update logic", "handle edge cases", or "verify manually" with concrete implementation and validation guidance.
- Put uncertainty in `targetFileRationales`, `assumptions`, `openQuestions`, or `risks`; do not hide it in confident wording.
- Keep unrelated modernization, cleanup, generated files, and broad refactors out of scope unless Jira explicitly asks for them.

## Output Expectations

- No placeholders, future TODOs, or unsupported file claims.
- Validation steps name the command, file check, or behavioral evidence expected.
- Planned automated test files appear in `fileChangeContract` as editable `test_required` entries, or the plan explains the coverage gap.
- Risks distinguish implementation risk from scout or grounding uncertainty.
- Never end with prose-only analysis, a scout summary, or a task breakdown instead of the final plan JSON.
