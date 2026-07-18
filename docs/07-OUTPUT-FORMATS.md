# Output Formats

Specter outputs are a combination of:

- human-readable markdown
- optional structured JSON-shaped data returned by the agent wrapper

## What gets persisted

Workers upload markdown results to S3:

```text
<prefix>-results/results/<agent>/<reference>/<taskId>-<timestamp>.md
```

That markdown is the artifact used for:

- JIRA comments
- Teams delivery
- debugging and audit review

## Structured outputs

Current built-in schemas exist for:

- `DARCI`
- `SCRIBE`
- `PRISM`
- `HERMES`
- `SENTRY`
- `BEACON`

`VERITAS` mainly relies on prompt-shaped markdown and uses the default schema.

## Current schema intent by agent

| Agent | Structured focus |
| --- | --- |
| `DARCI` | root cause, introducing commit, proposed fix, testing recommendations |
| `SCRIBE` | summary, components, execution flow, examples |
| `PRISM` | requirements, planned changes, steps, testing strategy, risks |
| `HERMES` | config name, location, current value, usage, impact |
| `SENTRY` | SQL validation, safety gates, rollback, risk decision, checklist |
| `BEACON` | validation checklist, models checked, decision, recommendations |
| `VERITAS` | mostly markdown RCA sections |

## Practical rule

The markdown output is the contract that must remain usable even if downstream structured parsing is ignored.

Good result markdown should:

- have a clear title
- lead with the decision or summary
- include actionable findings
- separate evidence from recommendations
- avoid raw JSON dumps unless the target consumer explicitly wants them

## Where schemas live

Schemas are defined in:

```text
src/claude-sdk/config.ts
```

If you add a first-class agent, add or update the schema there.
