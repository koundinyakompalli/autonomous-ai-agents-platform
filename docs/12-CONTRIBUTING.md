# Contributing

## Expectations

- keep docs aligned with the runtime you actually changed
- avoid introducing new secrets into code, schema files, or docs
- prefer small, auditable changes over broad speculative refactors

## Before opening a change

Run:

```bash
npm run type-check
npm run build
```

If the touched area has tests, run them. If not, state that clearly in your notes.

## If you add or change an agent

Update all relevant surfaces:

- agent wrapper in `src/agents/`
- Claude SDK prompt, schema, and tool mapping if needed
- worker implementation and worker entrypoint switch
- exports
- DB seed or runtime DB configuration if JIRA routing changes
- Terraform if the agent has its own ECS service
- docs

## Documentation rules

- describe the current runtime, not a planned future runtime
- retain historical filenames only when necessary, and label them clearly
- avoid hardcoded live credentials, IP addresses, or one-off AWS resource IDs

## Operational hygiene

- prefer `npm run worker` plus `WORKER_TYPE=<agent>` for examples
- mention when a script is legacy instead of silently pretending it is current
- call out missing tests or known technical debt plainly
