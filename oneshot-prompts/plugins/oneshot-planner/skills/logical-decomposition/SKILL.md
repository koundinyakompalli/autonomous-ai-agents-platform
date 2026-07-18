---
name: logical-decomposition
description: Use for OneShot tickets that may need same-repo logical slices while preserving one worktree and one final pull request.
---

# Logical Decomposition

Use this Skill when a OneShot ticket looks broad but still belongs in one repository run.

## Method

- Split work into logical slices only when that makes implementation and review clearer.
- Keep all same-repo slices inside the current physical workspace and one final OneShot plan JSON.
- Treat slices as `specs[]` within the plan, not standalone tasks, tickets, Agent assignments, worktrees, branches, or pull requests.
- Order slices by dependency: contract or data shape first, caller behavior next, UI or workflow updates after that, focused tests last.
- Identify shared-risk files, generated assets, migrations, and cross-module contracts before proposing edits.
- If decomposition is uncertain, keep the plan cohesive and record the uncertainty in `risks`, `assumptions`, or `openQuestions`.

## Output Expectations

- Specs should be small enough for an implementer to execute independently, but still part of one final PR.
- Do not replace the required structured plan with a task list or phased project plan.
- State dependencies between specs explicitly.
- If the ticket truly crosses repositories, describe the repo boundary and keep this plan scoped to the selected repo.
