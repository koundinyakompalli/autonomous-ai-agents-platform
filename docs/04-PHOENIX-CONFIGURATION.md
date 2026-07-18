# Phoenix Configuration Reference

This filename is retained for link stability. The active runtime no longer uses the old Phoenix engine. The current configuration surface is the Claude Agent SDK wrapper plus Bedrock environment wiring.

## What replaced Phoenix

Current execution stack:

- `src/claude-sdk/index.ts`
- `src/claude-sdk/config.ts`
- `src/claude-sdk/hooks.ts`

Agents now configure:

- repo IDs and repo roots
- allowed Claude tools
- output schema
- hooks and policy gates
- Bedrock model settings
- budgets, timeout, and turn limits

## Key environment variables

### Bedrock and Claude Code

```bash
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-east-2
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-6
ANTHROPIC_SMALL_FAST_MODEL=us.anthropic.claude-haiku-4-5-20251001-v1:0
CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096
MAX_THINKING_TOKENS=1024
```

### Direct Bedrock callers

Some non-Claude-SDK components still use direct Bedrock calls:

- `TaskDescriptionGenerator`
- `RepoAnalyzer`
- `Harvey IntakeAgent`
- `Harvey AdminQuery`

Those components currently rely on:

```bash
BEDROCK_MODEL_ID=
BEDROCK_MODEL=
AWS_REGION=
```

## `runAgent()` options that matter most

Current high-value options:

- `taskId`
- `taskPrompt`
- `repoIds`
- `agentType`
- `systemAppend`
- `additionalContext`
- `permissionLevel`
- `allowedTools`
- `outputSchema`
- `timeoutMs`
- `maxCallsPerMinute`
- `maxTurns`
- `maxBudgetUsd`
- `readOnly`
- `allowWrite`
- `onProgress`
- `onAuditLog`
- `bedrockConfig`

## Tool configuration

The active tool policy is defined in `TOOL_SETS`:

- `code_exploration`
- `read_only`
- `analysis`
- `patch_proposal`
- `full_autonomy`

Prefer the narrowest set possible.

## Hooks and policy gates

The old Phoenix safety knobs are now mostly expressed as hooks:

- `makeDenyWritesOutsideRepos()`
- `makeDenyDangerousCommands()`
- `makeReadOnlyHook()`
- `makeRateLimitHook()`
- `makeTimeoutHook()`
- `makeAuditLogHook()`
- `makeProgressHook()`
- `buildHooks()`

## Output schemas

Current built-in schemas exist for:

- `darci`
- `scribe`
- `prism`
- `hermes`
- `sentry`
- `beacon`
- `veritas` uses the default schema and prompt-driven markdown
- `custom`

## Mental model mapping

| Old Phoenix concept | Current equivalent |
| --- | --- |
| engine config | `runAgent()` options |
| tool registry | `TOOL_SETS` and `allowedTools` |
| output validator | `outputSchema` |
| safety switches | hooks |
| model config | Bedrock env + `bedrockConfig` |
| prompt config | `AGENT_PROMPTS` + `systemAppend` |

## Recommendation

When you see older docs or comments mentioning Phoenix configuration, translate that to the Claude SDK wrapper in `src/claude-sdk`. That is the current source of truth.
