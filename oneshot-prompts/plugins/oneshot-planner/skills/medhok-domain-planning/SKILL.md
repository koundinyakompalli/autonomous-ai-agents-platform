---
name: medhok-domain-planning
description: Use for lightweight MedHOK and core-app planning guidance sourced only from existing OneShot prompt and repository evidence.
---

# MedHOK Domain Planning

Use this Skill to make OneShot plans more precise for MedHOK repositories without inventing domain facts.

## Method

- Use only the ticket, qualification artifact, route cards, deterministic grounding, prompt knowledge, and inspected files.
- For core-app UI work, check whether the evidence points to SmartGWT widget code, theme SCSS, generated CSS, or shared style constants.
- For workflow or case work, identify the route, workspace, handler, or service boundary before choosing target files.
- For service or integration work, distinguish API contract changes, server behavior, generated documentation, and downstream consumers.
- If a term is ambiguous, carry it as an open question or validation note rather than treating it as confirmed.
- Domain uncertainty should narrow or qualify the plan, not prevent final plan output.

## Output Expectations

- Name the MedHOK module or layer only when evidence supports it.
- Include focused validation for both behavior and affected domain contract.
- Avoid broad modernization or cleanup unless the Jira explicitly requires it.
- Keep MedHOK guidance inside the final OneShot plan; do not invent separate domain-analysis deliverables.
