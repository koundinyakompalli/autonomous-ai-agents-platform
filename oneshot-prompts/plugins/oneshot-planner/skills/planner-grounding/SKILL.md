---
name: planner-grounding
description: Use for OneShot planning when file discovery and implementation steps must be backed by repository evidence.
---

# Planner Grounding

Use this Skill to keep the OneShot plan tied to inspected repository facts.

## Method

- Start from qualification evidence, deterministic grounding, route cards, and ticket text before broad search.
- Prefer the smallest focused `Glob`, `Grep`, or `Read` path that can confirm the module, class, endpoint, style, configuration, or test pattern.
- Treat candidate files as hypotheses until a repository tool confirms the path and surrounding context.
- Cite target files only when they were provided by trusted grounding or inspected during the planner run.
- If evidence is weak, say what is weak and plan validation that can close the gap.
- Do not keep searching for perfect evidence until the planner stalls; bounded uncertainty belongs in the final structured plan.

## Output Expectations

- Each spec should name concrete files, nearby patterns, and validation steps.
- Implementation notes should separate facts seen in the repo from assumptions.
- Avoid planning edits to generated or shared files unless the repository evidence explains why that is the right target.
- If grounding remains partial, still emit the plan and capture the gap in `assumptions`, `openQuestions`, or `risks`.
