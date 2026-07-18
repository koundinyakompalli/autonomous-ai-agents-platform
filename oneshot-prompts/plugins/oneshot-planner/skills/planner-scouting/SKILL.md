---
name: planner-scouting
description: Use when OneShot planner native subagents are enabled or the ticket has weak grounding, broad scope, ambiguous files, or multiple logical concerns.
---

# Planner Scouting

Use this Skill to make native planner subagents deliberate, bounded, and non-blocking.

## Method

- When native subagents are enabled, attempt at least one focused `Agent` scout before the final plan.
- Use the smallest scout that closes the current gap: grounding, decomposition, or MedHOK domain cues.
- Use at most two scout calls total, and give each scout a narrow question plus expected evidence shape.
- Never ask scouts to write files, produce the final plan, create branches, or call nested `Agent` or `Task`.
- Treat scout output as evidence to evaluate, not as authority to copy.
- If a scout errors, times out, exhausts turns, or returns incomplete evidence, continue with direct repository tools and still produce the structured plan.
- Do not wait for scouts to be perfect; a bounded scout attempt is enough to proceed.

## Output Expectations

- Reflect useful scout evidence in `targetFileRationales`, `implementationNotes`, `validationSteps`, or `plannerDiscoveries`.
- Record scout uncertainty or failed scout attempts in `risks` or `openQuestions` when it affects implementation confidence.
- Do not block the final plan only because a scout failed.
- Do not end with only a scout transcript or recommendation; emit the OneShot plan JSON.
