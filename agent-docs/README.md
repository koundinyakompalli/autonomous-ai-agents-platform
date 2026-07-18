# Agent Session Knowledge Base

This folder is the working memory bank for future agent sessions that need to understand Specter quickly and then add or modify agents end to end.

The goal is simple: a fresh session should be able to read this folder and recover the same context that an engineer would otherwise rebuild by inspecting `src/`, `terraform/`, `.github/workflows/`, `db/schema.sql`, and the existing runbooks.

## Read order

Read these files in order:

1. `00-MEMORYBANK.md`
2. `01-CURRENT-STATE.md`
3. `02-ARCHITECTURE.md`
4. `03-FEATURES-AND-CONVENTIONS.md`
5. `04-IMPLEMENTING-A-NEW-AGENT.md`
6. `05-DEPLOYMENT-AND-REGISTRATION.md`
7. `06-OPERATIONS-AND-TROUBLESHOOTING.md`
8. `07-END-TO-END-CHECKLISTS.md`

## What this folder covers

- durable architecture facts
- current pushed `main` branch state
- which live setup steps were already validated in session work versus what still needs re-verification
- existing agent inventory and patterns
- naming conventions that must line up across code, Terraform, and the database
- how to add a new agent in code
- how to write Terraform changes safely in this repo's map-driven model
- how to onboard and activate a new agent through workflows
- how to use the operator workflows when the developer does not have direct AWS access
- how registration in the `agents` table works
- what is operationally true right now versus only historically observed
- common failure modes and recovery paths

## What this folder does not replace

This folder is not a substitute for the source files themselves. When changing code, always confirm the details in:

- `src/orchestrator/AgentWorker.ts`
- `src/orchestrator/workers/runtime.ts`
- `src/worker-main.ts`
- `src/claude-sdk/config.ts`
- `src/claude-sdk/index.ts`
- `.github/workflows/*.yml`
- `terraform/*.tf`
- `db/schema.sql`

## Source-of-truth rule

When the markdown in this folder and the code disagree, the code wins.

When the code and live GitHub or AWS state disagree, the live state wins.

`01-CURRENT-STATE.md` is intentionally time-stamped and expected to age. Re-verify before making live changes.

## Legacy note

Historically, `agent-docs/` contained PNG images for some agents. Those are not the maintained source of truth for the platform. The markdown files in this folder are now the authoritative session handoff.
