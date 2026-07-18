# Tool Registry

Specter's active tool policy is defined in `src/claude-sdk/config.ts`. The runtime uses Claude Agent SDK built-in tools, grouped into permission sets.

## Permission sets

### `code_exploration`

Tools:

- `Read`
- `Glob`
- `Grep`

Use for:

- SCRIBE
- PRISM
- SENTRY
- BEACON
- most custom read-only agents

### `read_only`

Tools:

- `Read`
- `Glob`
- `Grep`
- `Bash`
- `BashOutput`

Use for:

- HERMES

Why:

- HERMES sometimes needs safe shell exploration for config discovery

### `analysis`

Tools:

- `Read`
- `Glob`
- `Grep`
- `Bash`
- `BashOutput`
- `Task`
- `TodoWrite`

Use for:

- DARCI
- VERITAS

Why:

- git investigation
- shell-based repo inspection
- long-form investigative flows

### `patch_proposal`

Adds write-capable tools:

- `Edit`
- `Write`

Use only when a task truly needs to propose or stage code changes.

### `full_autonomy`

Largest set. Includes:

- write tools
- shell tools
- web tools
- notebook edits
- skills

This should be rare and heavily guarded.

## Explicitly disallowed tools

The current runtime blocks:

- `AskUserQuestion`
- `ExitPlanMode`
- `ListMcpResources`
- `ReadMcpResource`

## Hook-based safety

Tool permissions are necessary but not sufficient. Hooks add stronger policy enforcement:

- deny writes outside registered repo roots
- block dangerous shell commands
- force read-only mode
- rate-limit tool use
- enforce timeouts
- emit audit and progress events

## Agent mapping

| Agent type | Tool set |
| --- | --- |
| `darci` | `analysis` |
| `scribe` | `code_exploration` |
| `prism` | `code_exploration` |
| `hermes` | `read_only` |
| `sentry` | `code_exploration` |
| `beacon` | `code_exploration` |
| `veritas` | `analysis` |
| `custom` | `code_exploration` |

## Guidance

- default to the narrowest tool set
- prefer repo registration plus hook enforcement over raw unrestricted paths
- do not give write tools to an agent that only needs to read code
