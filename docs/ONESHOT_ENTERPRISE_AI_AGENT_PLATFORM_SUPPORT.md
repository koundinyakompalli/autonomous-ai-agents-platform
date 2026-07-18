# OneShot Support: Enterprise AI Agent Platform

This guide defines how OneShot should route, plan, and implement work for
`mhk-repos/enterprise-ai-agent-platform`, exposed in Specter/OneShot as
`Ai-agents`.

## Repository Identity

- OneShot repo name: `Ai-agents`
- GitHub repo: `mhk-repos/enterprise-ai-agent-platform`
- Default branch: `master`
- Primary stack: Java 21, Maven, Spring Boot, Docker, Terraform, Python SDK/tools, React/Vite UI
- Platform role: healthcare SaaS AI orchestration platform hosted on AWS

The repo is already OneShot-enabled in `src/oneshot/repo-metadata.ts`. Production
repo routing also requires the profile at `config/repo-profiles/Ai-agents.yaml`.

## When OneShot Should Select This Repo

Route to `Ai-agents` for tickets that mention:

- `enterprise-ai-agent-platform`, AI agent platform, agent hosting, hosted agents
- controller agents, processing agents, workflow/routing/decision/meta controllers
- MCP servers or MCP protocol work, including Atlassian, Document360, code intelligence, internal MCP, external MCP
- orchestration core, code intelligence service, agent registry, workflow configuration
- AWS/Terraform changes for the platform, including ECS/Fargate, SQS queues, IAM, KMS, VPC, ALB, or UI portal deployment

Do not use `Ai-agents` for Specter/OneShot platform implementation itself unless
the ticket explicitly references `cp-autonomous-ai-agents-platform`, Specter,
OneShot runtime, PRISM, SURGE, or the Specter dashboard. Those are separate
platform concerns.

## Mandatory Planning Rules

OneShot plans for this repo must read the target repo's mandatory operating
documents before implementation planning:

- `CLAUDE.md`
- `docs/reference/NEVER-RULES-DETAILED.md`
- `docs/guides/BUILD-AND-DEPLOYMENT.md`

OneShot must also use the relevant documentation under `docs/` for the ticket
scope. For example, architecture work should inspect `docs/architecture` and
`docs/decisions`; security/IAM work should inspect `docs/security` and
`docs/iam-policies`; operations/deployment work should inspect
`docs/operations`, Terraform module docs, and affected workflow docs; new agent
work should inspect `docs/onboarding`, `docs/implementations`, and
`docs/patterns` where applicable.

OneShot should not blindly load every documentation file for every run. It
should use all mandatory docs plus the scoped documentation set needed for the
requested change. If the ticket is broad or ambiguous enough that the relevant
documentation cannot be selected confidently, the run should require human
confirmation before implementation.

The minimum rules OneShot must carry into every plan are:

- Controllers make orchestration decisions; processing agents execute assigned work only.
- Security/auth failures fail closed. Do not add security mocks, fallback permissions, or fake auth.
- Do not log PHI, LLM request/response bodies, credentials, tokens, or raw healthcare payloads.
- Do not hardcode credentials or security config. Use AWS Secrets Manager, environment variables, or existing config mechanisms.
- Production service-to-service traffic must use HTTPS through the approved ALB/certificate pattern.
- Infrastructure and agent hosting changes must stay in Terraform/IaC, not manual console-only changes.
- No direct push to `master`; OneShot must open a PR and require human review.
- Do not report fake success. Missing or unimplemented behavior must fail explicitly.

## Route Cards Added

OneShot route cards now provide repo-specific context for:

- Controller Agent Hosting
- MCP Server / Tool Integration
- Processing Agent Changes
- AWS SaaS Infrastructure

These cards inject reviewed entrypoint hints into planner grounding so OneShot
starts with the right directories instead of broad-scanning the full monorepo.

Some terms intentionally appear in both repo-domain rules and route-card trigger
phrases. Repo-domain rules choose the repository; route-card triggers select
repo-specific guidance after repository resolution. Keep the two lists aligned
when adding hosted-agent, MCP, infrastructure, or UI terms.

## Common Entrypoints

Mandatory docs for every implementation plan:

- `CLAUDE.md`
- `docs/reference/NEVER-RULES-DETAILED.md`
- `docs/guides/BUILD-AND-DEPLOYMENT.md`

Scoped docs to select based on ticket content:

- `docs/architecture`
- `docs/decisions`
- `docs/security`
- `docs/operations`
- `docs/onboarding`
- `docs/implementations`
- `docs/patterns`
- `docs/iam-policies`
- `docs/reference`

Controller agent work:

- `CLAUDE.md`
- `docs/reference/NEVER-RULES-DETAILED.md`
- `agent-orchestration-core/src`
- `controller-agents`
- `terraform/30-controller-agents`
- `shared-libs/ai-orchestration-commons`

MCP work:

- `agent-core-mcp/src`
- `atlassian-mcp-server/src`
- `document360-mcp-server/src`
- `code-intelligence-mcp-server/src`
- `shared-libs/mcp-protocol`
- `terraform/47-internal-mcp-alb`
- `terraform/25-external-mcp-servers`

Processing agent work:

- `processing-agents/java-agents`
- `processing-agents/python-agents`
- `terraform/40-processing-agents`
- `shared-libs/python-sdk`

AWS/SaaS infrastructure work:

- `terraform/00-shared`
- `terraform/10-orchestration-core`
- `terraform/15-internal-services`
- `terraform/30-controller-agents`
- `terraform/40-processing-agents`
- `terraform/70-ui-portal`
- `.github/workflows`

UI portal work:

- `ui-portal/src`
- `ui-portal/package.json`
- `terraform/70-ui-portal`

## Validation Expectations

OneShot should choose the smallest focused validation set that matches touched
files:

- Java backend/module changes: module-scoped Maven tests first, then broader Maven tests when shared libraries or parent POM are touched.
- Java quality/security changes: `mvn spotless:apply` and `mvn spotbugs:check` where feasible.
- Python SDK/agent changes: repository lint script or package-specific Python tests where available.
- UI portal changes: `npm run type-check`, `npm run lint`, `npm test`, and `npm run build` from `ui-portal` where feasible.
- Terraform changes: `terraform fmt`, `terraform validate`, and targeted plan review for the affected module/environment where credentials are available.
- Workflow changes: inspect affected `.github/workflows` and avoid changing deployment behavior without explicit ticket scope.

If local validation cannot run because dependencies, AWS credentials, Docker, or
Terraform backend access are unavailable, OneShot must say exactly what was not
verified and rely on CI/human review.

## Support Boundaries

OneShot can draft implementation PRs for scoped code, Terraform, workflow, and
documentation changes in this repo. It should block or require human confirmation
when a ticket requests:

- production deployment or environment mutation without an approved PR/change record
- broad IAM/VPC/KMS/security group expansion
- disabling healthcare safety rules, auth, audit logging, encryption, or tenant isolation
- changing controller/processing boundaries
- adding PHI-bearing prompts, logs, or artifacts
- direct database writes from ECS services or agent runtime self-registration
- new public networking paths or plaintext service-to-service communication

These boundaries are intentional. This repo hosts healthcare AI infrastructure,
so OneShot support must optimize for safe, reviewable PRs rather than fast but
ambiguous platform changes.
