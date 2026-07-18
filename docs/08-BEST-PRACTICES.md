# Best Practices

## Prefer durable async boundaries

- keep routing and state in MySQL
- keep large payloads in S3
- keep repo state on EFS
- do not add direct worker/orchestrator RPC unless the design truly changes

## Keep agents thin

Agent wrappers should mostly do three things:

- register or resolve repos
- call `runAgent()`
- shape the result into markdown plus optional structured data

Avoid embedding orchestration logic inside the agent wrapper.

## Use the smallest tool set

- start with `code_exploration`
- move to `read_only` only if shell exploration is required
- use `analysis` only when git or sub-task delegation matters
- do not give write access to read-only agents

## Treat paths as security boundaries

- prefer repo IDs over raw paths
- register customer workspaces explicitly
- keep write access inside repo roots or per-task workspaces

## Be honest about historical docs and comments

If the runtime is Claude SDK-based, do not describe it as Phoenix-based just because an old filename remains. When a historical filename is retained, say so explicitly.

## Keep operational docs generic

- document variable names, not internal passwords
- document resource patterns, not live account-specific IDs
- avoid hardcoded bastion IPs and specific task private IPs in permanent docs

## Build before you declare success

At minimum:

```bash
npm run type-check
npm run build
```

If tests exist for the touched area, run them. If no tests exist, say so.

## Document the real runtime, not the intended runtime

Examples:

- if only `worker-main.ts` exposes the status API, say that plainly
- if Terraform deploys Harvey and nine worker families, do not document four workers
- if the result bucket is shared, do not document per-agent buckets
